import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { durationToSeconds } from "../../src/duration";
import type { DurationInput } from "../../src/types";
import { secureTokenEqual, sha256 } from "./crypto";
import { bearer, RequestError, requireEmail, stringField, validateIdempotencyKey } from "./http";
import { envInteger, inboxIdFromReference, inboxStub, provisionInbox } from "./inbox-service";
import { validatedBodies } from "./message-input";
import type { OperationResult } from "./protocol";

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(error: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: error instanceof Error ? error.message : String(error),
      },
    ],
    isError: true,
  };
}

async function toolResult<T>(action: () => T | Promise<T>) {
  try {
    return textResult(await action());
  } catch (error) {
    return errorResult(error);
  }
}

function unwrap<T>(result: OperationResult<T>): T {
  if (!result.ok) {
    throw new RequestError(result.code, result.message, result.status);
  }
  return result.value;
}

async function authorizedCapability(env: Env, inbox: string, capability: string) {
  const id = inboxIdFromReference(inbox, env);
  if (!id) {
    throw new RequestError("INVALID_INBOX_ID", "Invalid inbox ID or address");
  }

  return { stub: inboxStub(env, id), digest: await sha256(capability) };
}

function waitDuration(value: string): number {
  const seconds = durationToSeconds(value as DurationInput);
  if (seconds > 300) {
    throw new RequestError("INVALID_ARGUMENT", "MCP waits are limited to 5 minutes");
  }
  return seconds;
}

function hostnameList(value: string): string[] {
  return value
    .split(",")
    .map((hostname) => hostname.trim())
    .filter(Boolean);
}

function createInboxletMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: "inboxlet", version: "0.1.0" });
  const capabilityFields = {
    inbox: z.string().min(1).describe("Inbox ID or full email address"),
    capability: z.string().min(1).describe("Capability token returned by inbox_create"),
  };

  server.registerTool(
    "inbox_create",
    {
      description: "Create a new ephemeral email inbox and return its capability token.",
      inputSchema: z.object({
        ttl: z
          .string()
          .regex(/^\d+[smhd]$/)
          .optional()
          .describe("Lifetime such as 30m, 2h, or 1d"),
        maxMessages: z.number().int().positive().optional(),
      }),
    },
    async ({ ttl, maxMessages }) =>
      toolResult(async () =>
        unwrap(
          await provisionInbox(env, {
            ...(ttl ? { ttlSeconds: durationToSeconds(ttl as DurationInput) } : {}),
            ...(maxMessages ? { maxMessages } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "inbox_status",
    {
      description: "Read metadata and usage for an inbox.",
      inputSchema: z.object(capabilityFields),
      annotations: { readOnlyHint: true },
    },
    async ({ inbox, capability }) =>
      toolResult(async () => {
        const auth = await authorizedCapability(env, inbox, capability);
        return unwrap(await auth.stub.status(auth.digest));
      }),
  );

  server.registerTool(
    "inbox_read",
    {
      description: "Read inbox messages in ascending sequence order.",
      inputSchema: z.object({
        ...capabilityFields,
        after: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(100).default(50),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ inbox, capability, after, limit }) =>
      toolResult(async () => {
        const auth = await authorizedCapability(env, inbox, capability);
        return unwrap(await auth.stub.read(auth.digest, after, limit, 0));
      }),
  );

  server.registerTool(
    "inbox_wait",
    {
      description:
        "Wait for the first message after a sequence cursor. Pass the last seen message sequence as after.",
      inputSchema: z.object({
        ...capabilityFields,
        after: z.number().int().nonnegative().default(0),
        timeout: z
          .string()
          .regex(/^\d+[smhd]$/)
          .default("1m"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ inbox, capability, after, timeout }, context) =>
      toolResult(async () => {
        const auth = await authorizedCapability(env, inbox, capability);
        const deadline = Date.now() + waitDuration(timeout) * 1_000;

        while (Date.now() < deadline) {
          if (context.mcpReq.signal.aborted) {
            throw (
              context.mcpReq.signal.reason ?? new DOMException("Request cancelled", "AbortError")
            );
          }
          const waitMilliseconds = Math.min(25_000, Math.max(1, deadline - Date.now()));
          const result = unwrap(await auth.stub.read(auth.digest, after, 1, waitMilliseconds));
          const message = result.messages[0];
          if (message) {
            return message;
          }
        }

        throw new RequestError("WAIT_TIMEOUT", "Timed out waiting for an inbox message", 408);
      }),
  );

  server.registerTool(
    "inbox_send",
    {
      description: "Send an email from an inbox.",
      inputSchema: z.object({
        ...capabilityFields,
        to: z.email(),
        subject: z.string().min(1).max(500),
        text: z.string().min(1).optional(),
        html: z.string().min(1).optional(),
        idempotencyKey: z.string().min(1).max(128).optional(),
      }),
    },
    async ({ inbox, capability, to, subject, text, html, idempotencyKey }) =>
      toolResult(async () => {
        const auth = await authorizedCapability(env, inbox, capability);
        return unwrap(
          await auth.stub.send(auth.digest, {
            to: requireEmail(to, "to"),
            subject: stringField(subject, "subject", { min: 1, max: 500 }),
            ...validatedBodies({ text, html }, envInteger(env.MAX_BODY_BYTES, "MAX_BODY_BYTES")),
            idempotencyKey: validateIdempotencyKey(idempotencyKey),
          }),
        );
      }),
  );

  server.registerTool(
    "inbox_reply",
    {
      description: "Reply to an inbound message using its sender and thread headers.",
      inputSchema: z.object({
        ...capabilityFields,
        messageId: z.uuid(),
        text: z.string().min(1).optional(),
        html: z.string().min(1).optional(),
        idempotencyKey: z.string().min(1).max(128).optional(),
      }),
    },
    async ({ inbox, capability, messageId, text, html, idempotencyKey }) =>
      toolResult(async () => {
        const auth = await authorizedCapability(env, inbox, capability);
        return unwrap(
          await auth.stub.reply(auth.digest, {
            messageId,
            ...validatedBodies({ text, html }, envInteger(env.MAX_BODY_BYTES, "MAX_BODY_BYTES")),
            idempotencyKey: validateIdempotencyKey(idempotencyKey),
          }),
        );
      }),
  );

  server.registerTool(
    "inbox_delete",
    {
      description: "Permanently delete an inbox and all of its messages.",
      inputSchema: z.object({
        ...capabilityFields,
        confirm: z.literal(true).describe("Must be true to confirm permanent deletion"),
      }),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ inbox, capability }) =>
      toolResult(async () => {
        const auth = await authorizedCapability(env, inbox, capability);
        return unwrap(await auth.stub.delete(auth.digest));
      }),
  );

  return server;
}

function unauthorized(): Response {
  return Response.json(
    { error: { code: "INVALID_API_KEY", message: "Missing or invalid API key" } },
    {
      status: 401,
      headers: {
        "access-control-allow-origin": "*",
        "content-type": "application/json; charset=utf-8",
        "www-authenticate": 'Bearer realm="inboxlet-mcp"',
      },
    },
  );
}

export async function handleMcpRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const handler = createMcpHandler(() => createInboxletMcpServer(env), {
    route: "/mcp",
    allowedHostnames: hostnameList(env.MCP_ALLOWED_HOSTNAMES),
    allowedOriginHostnames: hostnameList(env.MCP_ALLOWED_ORIGIN_HOSTNAMES),
    legacy: "stateless",
    responseMode: "auto",
    onerror(error) {
      console.error(JSON.stringify({ message: "MCP request failed", error: error.message }));
    },
  });

  if (request.method !== "OPTIONS") {
    const apiKey = bearer(request);
    if (!apiKey || !env.API_KEY || !(await secureTokenEqual(apiKey, env.API_KEY))) {
      return unauthorized();
    }
  }

  return handler(request, env, ctx);
}
