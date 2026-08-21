import PostalMime from "postal-mime";
import type { InboxAttachment } from "../../src/types";
import { htmlToPlainText } from "./body";
import { digestBase64Url, secureTokenEqual, sha256 } from "./crypto";
import {
  apiError,
  bearer,
  corsPreflight,
  idempotencyKey,
  json,
  readJsonRecord,
  RequestError,
  requireEmail,
  stringField,
  validEmail,
} from "./http";
import { envInteger, inboxStub, provisionInbox } from "./inbox-service";
import { InboxObject } from "./inbox-object";
import { INBOX_ID_PATTERN, inboxIdFromAddress } from "./identity";
import { validatedBodies } from "./message-input";
import { handleMcpRequest } from "./mcp";
import type { InboundMessageInput, OperationResult } from "./protocol";

export { InboxObject };

function enabled(value: string): boolean {
  return value === "true";
}

function hostnameValid(hostname: string): boolean {
  return (
    hostname.length <= 253 &&
    hostname
      .split(".")
      .every(
        (label) =>
          label.length > 0 &&
          label.length <= 63 &&
          /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
      )
  );
}

function examplePlaceholder(hostname: string): boolean {
  return /(^|\.)example(?:\.(?:com|net|org))?$/i.test(hostname);
}

function hostnameConfigurationIssues(name: string, value: string, single = false): string[] {
  if (single && value !== value.trim()) {
    return [`${name} must not contain leading or trailing whitespace`];
  }
  const hostnames = value
    ?.split(",")
    .map((hostname) => hostname.trim())
    .filter(Boolean);
  if (!hostnames?.length) {
    return [`${name} is not configured`];
  }
  if (single && hostnames.length !== 1) {
    return [`${name} must be one hostname`];
  }

  const issues: string[] = [];
  for (const hostname of hostnames) {
    if (!hostnameValid(hostname)) issues.push(`${name} contains an invalid hostname`);
    if (examplePlaceholder(hostname)) issues.push(`${name} contains an example placeholder`);
  }
  return issues;
}

function configurationIssues(env: Env): string[] {
  const issues = [
    ...hostnameConfigurationIssues("MAIL_DOMAIN", env.MAIL_DOMAIN, true),
    ...hostnameConfigurationIssues("MCP_ALLOWED_HOSTNAMES", env.MCP_ALLOWED_HOSTNAMES),
    ...hostnameConfigurationIssues(
      "MCP_ALLOWED_ORIGIN_HOSTNAMES",
      env.MCP_ALLOWED_ORIGIN_HOSTNAMES,
    ),
  ];
  if (!env.API_KEY?.trim()) issues.push("API_KEY is not configured");

  const limits = [
    ["MIN_TTL_SECONDS", env.MIN_TTL_SECONDS],
    ["DEFAULT_TTL_SECONDS", env.DEFAULT_TTL_SECONDS],
    ["MAX_TTL_SECONDS", env.MAX_TTL_SECONDS],
    ["DEFAULT_MAX_MESSAGES", env.DEFAULT_MAX_MESSAGES],
    ["MAX_MESSAGES", env.MAX_MESSAGES],
    ["MAX_RAW_BYTES", env.MAX_RAW_BYTES],
    ["MAX_BODY_BYTES", env.MAX_BODY_BYTES],
  ] as const;
  const values = new Map<string, number>();
  for (const [name, raw] of limits) {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
      issues.push(`${name} must be a positive integer`);
    } else {
      values.set(name, value);
    }
  }
  const minTtl = values.get("MIN_TTL_SECONDS");
  const defaultTtl = values.get("DEFAULT_TTL_SECONDS");
  const maxTtl = values.get("MAX_TTL_SECONDS");
  if (minTtl && defaultTtl && maxTtl && !(minTtl <= defaultTtl && defaultTtl <= maxTtl)) {
    issues.push("DEFAULT_TTL_SECONDS must be between MIN_TTL_SECONDS and MAX_TTL_SECONDS");
  }
  const defaultMessages = values.get("DEFAULT_MAX_MESSAGES");
  const maxMessages = values.get("MAX_MESSAGES");
  if (defaultMessages && maxMessages && defaultMessages > maxMessages) {
    issues.push("DEFAULT_MAX_MESSAGES must not exceed MAX_MESSAGES");
  }
  const rawBytes = values.get("MAX_RAW_BYTES");
  const bodyBytes = values.get("MAX_BODY_BYTES");
  if (rawBytes && bodyBytes && bodyBytes > rawBytes) {
    issues.push("MAX_BODY_BYTES must not exceed MAX_RAW_BYTES");
  }
  for (const [name, value] of [
    ["ENABLE_TEST_INGRESS", env.ENABLE_TEST_INGRESS],
    ["MOCK_EMAIL", env.MOCK_EMAIL],
  ] as const) {
    const configured = String(value);
    if (configured !== "true" && configured !== "false") {
      issues.push(`${name} must be true or false`);
    }
  }
  return issues;
}

function operationResponse<T>(result: OperationResult<T>, successStatus = 200): Response {
  return result.ok
    ? json(result.value, successStatus)
    : apiError(result.code, result.message, result.status);
}

async function tokenDigest(request: Request): Promise<ArrayBuffer | Response> {
  const token = bearer(request);
  return token
    ? sha256(token)
    : apiError("MISSING_CAPABILITY", "Missing inbox capability token", 401);
}

async function creationAllowed(request: Request, env: Env): Promise<boolean> {
  const supplied = bearer(request);
  return Boolean(supplied && (await secureTokenEqual(supplied, env.API_KEY)));
}

function contentSize(value: string | ArrayBuffer | Uint8Array | undefined): number {
  if (!value) {
    return 0;
  }
  return typeof value === "string" ? new TextEncoder().encode(value).byteLength : value.byteLength;
}

function truncateUtf8(value: string, maxBytes: number, fromEnd = false): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) {
    return value;
  }

  let low = 0;
  let high = value.length;
  while (low < high) {
    const length = Math.ceil((low + high) / 2);
    const candidate = fromEnd ? value.slice(-length) : value.slice(0, length);
    if (encoder.encode(candidate).byteLength <= maxBytes) {
      low = length;
    } else {
      high = length - 1;
    }
  }
  return fromEnd ? value.slice(-low) : value.slice(0, low);
}

function extractAddress(value: string | null): string {
  if (!value) {
    return "";
  }
  const bracketed = /<([^<>]+)>/.exec(value)?.[1];
  const candidate = (bracketed ?? value).trim().toLowerCase();
  return validEmail(candidate) ? candidate : "";
}

function parseCursor(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RequestError("INVALID_ARGUMENT", `${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

async function createInbox(request: Request, env: Env): Promise<Response> {
  if (!env.API_KEY) {
    return apiError("SERVER_NOT_CONFIGURED", "Server administrator must configure API_KEY", 503);
  }
  if (!(await creationAllowed(request, env))) {
    return apiError("INVALID_API_KEY", "Missing or invalid API key", 401);
  }

  const body = await readJsonRecord(request);
  return operationResponse(
    await provisionInbox(env, {
      ttlSeconds: body.ttlSeconds as number | undefined,
      maxMessages: body.maxMessages as number | undefined,
    }),
    201,
  );
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    return corsPreflight();
  }
  if (request.method === "GET" && url.pathname === "/v1/health") {
    const issues = configurationIssues(env);
    const ok = issues.length === 0;
    return json(
      {
        ok,
        status: ok ? "ok" : "degraded",
        service: "inboxlet",
        mailDomain: env.MAIL_DOMAIN ?? "",
        issues,
      },
      ok ? 200 : 503,
    );
  }
  if (request.method === "POST" && url.pathname === "/v1/inboxes") {
    return createInbox(request, env);
  }

  const inboxMatch = /^\/v1\/inboxes\/([^/]+)$/.exec(url.pathname);
  if (inboxMatch) {
    const inboxId = inboxMatch[1] ?? "";
    if (!INBOX_ID_PATTERN.test(inboxId)) {
      return apiError("INVALID_INBOX_ID", "Invalid inbox identifier", 400);
    }
    const digest = await tokenDigest(request);
    if (digest instanceof Response) {
      return digest;
    }
    const stub = inboxStub(env, inboxId);
    if (request.method === "GET") {
      return operationResponse(await stub.status(digest));
    }
    if (request.method === "DELETE") {
      return operationResponse(await stub.delete(digest));
    }
    return apiError("METHOD_NOT_ALLOWED", "Method not allowed", 405);
  }

  const messagesMatch = /^\/v1\/inboxes\/([^/]+)\/messages$/.exec(url.pathname);
  if (messagesMatch) {
    const inboxId = messagesMatch[1] ?? "";
    if (!INBOX_ID_PATTERN.test(inboxId)) {
      return apiError("INVALID_INBOX_ID", "Invalid inbox identifier", 400);
    }
    const digest = await tokenDigest(request);
    if (digest instanceof Response) {
      return digest;
    }
    const stub = inboxStub(env, inboxId);

    if (request.method === "GET") {
      const after = parseCursor(url, "after", 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = parseCursor(url, "limit", 50, 1, 100);
      const waitSeconds = parseCursor(url, "wait", 0, 0, 25);
      return operationResponse(await stub.read(digest, after, limit, waitSeconds * 1_000));
    }

    if (request.method === "POST") {
      const body = await readJsonRecord(request, 600 * 1024);
      const bodies = validatedBodies(body, envInteger(env.MAX_BODY_BYTES, "MAX_BODY_BYTES"));
      const result = await stub.send(digest, {
        to: requireEmail(body.to, "to"),
        subject: stringField(body.subject, "subject", { min: 1, max: 500 }),
        ...bodies,
        idempotencyKey: idempotencyKey(request),
      });
      return operationResponse(result, 201);
    }
    return apiError("METHOD_NOT_ALLOWED", "Method not allowed", 405);
  }

  const replyMatch = /^\/v1\/inboxes\/([^/]+)\/messages\/([0-9a-f-]{36})\/reply$/.exec(
    url.pathname,
  );
  if (replyMatch) {
    const inboxId = replyMatch[1] ?? "";
    const messageId = replyMatch[2] ?? "";
    if (!INBOX_ID_PATTERN.test(inboxId)) {
      return apiError("INVALID_INBOX_ID", "Invalid inbox identifier", 400);
    }
    if (request.method !== "POST") {
      return apiError("METHOD_NOT_ALLOWED", "Method not allowed", 405);
    }
    const digest = await tokenDigest(request);
    if (digest instanceof Response) {
      return digest;
    }
    const body = await readJsonRecord(request, 550 * 1024);
    const bodies = validatedBodies(body, envInteger(env.MAX_BODY_BYTES, "MAX_BODY_BYTES"));
    return operationResponse(
      await inboxStub(env, inboxId).reply(digest, {
        messageId,
        ...bodies,
        idempotencyKey: idempotencyKey(request),
      }),
      201,
    );
  }

  const testMatch = /^\/v1\/test\/inboxes\/([^/]+)\/messages$/.exec(url.pathname);
  if (testMatch && request.method === "POST") {
    if (!enabled(env.ENABLE_TEST_INGRESS)) {
      return apiError("NOT_FOUND", "Not found", 404);
    }
    const inboxId = testMatch[1] ?? "";
    if (!INBOX_ID_PATTERN.test(inboxId)) {
      return apiError("INVALID_INBOX_ID", "Invalid inbox identifier", 400);
    }
    const digest = await tokenDigest(request);
    if (digest instanceof Response) {
      return digest;
    }
    const authorized = await inboxStub(env, inboxId).status(digest);
    if (!authorized.ok) {
      return operationResponse(authorized);
    }
    const body = await readJsonRecord(request);
    const from = requireEmail(body.from, "from");
    const { text } = validatedBodies(body, envInteger(env.MAX_BODY_BYTES, "MAX_BODY_BYTES"));
    const input: InboundMessageInput = {
      id: crypto.randomUUID(),
      dedupeKey: crypto.randomUUID(),
      from,
      to: authorized.value.address,
      headerFrom: from,
      replyTo: from,
      subject: stringField(body.subject ?? "Test message", "subject", { min: 1, max: 500 }),
      text,
      html: "",
      rfcMessageId: `<test-${crypto.randomUUID()}@inboxlet.local>`,
      references: "",
      rawSize: new TextEncoder().encode(text).byteLength,
      attachments: [],
      createdAt: Date.now(),
    };
    return operationResponse(await inboxStub(env, inboxId).receive(input), 201);
  }

  return apiError("NOT_FOUND", "Not found", 404);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/mcp") {
        return await handleMcpRequest(request, env, ctx);
      }
      if (url.pathname === "/" && request.method === "GET") {
        return json({
          name: "inboxlet",
          description: "Ephemeral email inboxes for agents and automation.",
          health: "/v1/health",
          mcp: "/mcp",
        });
      }
      if (url.pathname.startsWith("/v1/")) {
        return await handleApi(request, env);
      }
      return apiError("NOT_FOUND", "Not found", 404);
    } catch (error) {
      if (error instanceof RequestError) {
        return apiError(error.code, error.message, error.status);
      }
      console.error(
        JSON.stringify({
          message: "request failed",
          path: new URL(request.url).pathname,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return apiError("INTERNAL_ERROR", "Internal server error", 500);
    }
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const maximumRawBytes = envInteger(env.MAX_RAW_BYTES, "MAX_RAW_BYTES");
    if (message.rawSize > maximumRawBytes) {
      message.setReject(`Message exceeds the ${maximumRawBytes} byte inbox limit`);
      return;
    }

    const inboxId = inboxIdFromAddress(message.to, env.MAIL_DOMAIN.trim());
    if (!inboxId) {
      message.setReject("Mailbox unavailable");
      return;
    }

    try {
      const stub = inboxStub(env, inboxId);
      if (!(await stub.acceptsInbound())) {
        message.setReject("Mailbox unavailable");
        return;
      }
      const raw = await new Response(message.raw).arrayBuffer();
      const parsed = await PostalMime.parse(raw);
      const maximumBodyBytes = envInteger(env.MAX_BODY_BYTES, "MAX_BODY_BYTES");
      const html = truncateUtf8(String(parsed.html || ""), Math.floor(maximumBodyBytes / 2));
      const attachments: InboxAttachment[] = (parsed.attachments ?? [])
        .slice(0, 100)
        .map((attachment) => ({
          filename: truncateUtf8(String(attachment.filename || "attachment"), 300),
          mimeType: truncateUtf8(String(attachment.mimeType || "application/octet-stream"), 200),
          size: contentSize(attachment.content),
        }));
      const result = await stub.receive({
        id: crypto.randomUUID(),
        dedupeKey: digestBase64Url(await sha256(raw)),
        from: message.from.toLowerCase(),
        to: message.to.toLowerCase(),
        headerFrom: parsed.from?.address?.toLowerCase() || message.from.toLowerCase(),
        replyTo: extractAddress(message.headers.get("reply-to")) || message.from.toLowerCase(),
        subject: String(parsed.subject || message.headers.get("subject") || "(no subject)").slice(
          0,
          500,
        ),
        text: truncateUtf8(
          String(parsed.text || "") || htmlToPlainText(html),
          Math.floor(maximumBodyBytes / 2),
        ),
        html,
        rfcMessageId: truncateUtf8(String(message.headers.get("message-id") || ""), 500),
        references: truncateUtf8(String(message.headers.get("references") || ""), 1_500, true),
        rawSize: message.rawSize,
        attachments,
        createdAt: Date.now(),
      });
      if (!result.ok) {
        if ([404, 410, 429].includes(result.status)) {
          message.setReject(result.message);
          return;
        }
        throw new Error(result.message);
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "inbound email failed",
          from: message.from,
          to: message.to,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;
