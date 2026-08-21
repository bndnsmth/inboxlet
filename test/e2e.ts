import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Inbox } from "../src/client";

const port = 8_900 + (process.pid % 500);
const origin = `http://127.0.0.1:${port}`;
const createToken = "inboxlet-e2e-create-token";
const wrangler = spawn(
  process.execPath,
  [
    join("node_modules", "wrangler", "bin", "wrangler.js"),
    "dev",
    "--experimental-new-config",
    "--local",
    "--port",
    String(port),
    "--var",
    "MAIL_DOMAIN:mail.inboxlet.test",
    "--var",
    "MCP_ALLOWED_HOSTNAMES:localhost,127.0.0.1",
    "--var",
    "MCP_ALLOWED_ORIGIN_HOSTNAMES:localhost,127.0.0.1,playground.ai.cloudflare.com",
    "--var",
    "MIN_TTL_SECONDS:1",
    "--var",
    "ENABLE_TEST_INGRESS:true",
    "--var",
    "MOCK_EMAIL:true",
    "--var",
    `API_KEY:${createToken}`,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);

let output = "";
wrangler.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
wrangler.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

async function waitForWorker(): Promise<Response> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (wrangler.exitCode !== null) {
      throw new Error(`Wrangler exited before startup:\n${output}`);
    }
    try {
      const response = await fetch(`${origin}/v1/health`);
      if (response.status === 200) {
        return response;
      }
    } catch {
      // Keep polling during startup.
    }
    await delay(200);
  }
  throw new Error(`Timed out starting Wrangler:\n${output}`);
}

function toolJson(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const content = result.content?.find((item) => item.type === "text");
  assert.ok(content && content.type === "text", "Tool response did not include JSON text");
  assert.equal(result.isError, undefined, content.text);
  return JSON.parse(content.text) as Record<string, unknown>;
}

try {
  const health = await waitForWorker();
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    status: "ok",
    service: "inboxlet",
    mailDomain: "mail.inboxlet.test",
    issues: [],
  });
  const unauthorized = await fetch(`${origin}/mcp`, { method: "POST", body: "{}" });
  assert.equal(unauthorized.status, 401);

  const mcpClient = new Client(
    { name: "inboxlet-e2e", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  const mcpTransport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    authProvider: { token: async () => createToken },
  });
  let mcpInbox: { id: string; address: string; token: string } | undefined;
  try {
    await mcpClient.connect(mcpTransport);
    const tools = await mcpClient.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "inbox_create",
      "inbox_delete",
      "inbox_read",
      "inbox_reply",
      "inbox_send",
      "inbox_status",
      "inbox_wait",
    ]);

    const created = toolJson(
      await mcpClient.callTool({
        name: "inbox_create",
        arguments: { ttl: "1m", maxMessages: 10 },
      }),
    );
    mcpInbox = {
      id: String(created.id),
      address: String(created.address),
      token: String(created.token),
    };
    const status = toolJson(
      await mcpClient.callTool({
        name: "inbox_status",
        arguments: { inbox: mcpInbox.id, capability: mcpInbox.token },
      }),
    );
    assert.equal(status.address, mcpInbox.address);

    const waiting = mcpClient.callTool({
      name: "inbox_wait",
      arguments: {
        inbox: mcpInbox.id,
        capability: mcpInbox.token,
        after: 0,
        timeout: "5s",
      },
    });
    await delay(100);
    const injected = await fetch(`${origin}/v1/test/inboxes/${mcpInbox.id}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${mcpInbox.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from: "sender@example.com", subject: "MCP", text: "Remote MCP" }),
    });
    assert.equal(injected.status, 201, await injected.text());
    assert.equal(toolJson(await waiting).text, "Remote MCP");

    const sent = toolJson(
      await mcpClient.callTool({
        name: "inbox_send",
        arguments: {
          inbox: mcpInbox.id,
          capability: mcpInbox.token,
          to: "person@example.com",
          subject: "Remote HTML",
          html: "<p>Remote <strong>HTML</strong></p>",
        },
      }),
    );
    assert.match(String(sent.text), /Remote HTML/);

    const invalid = await mcpClient.callTool({
      name: "inbox_read",
      arguments: { inbox: mcpInbox.id, capability: "wrong-capability" },
    });
    assert.equal(invalid.isError, true);
  } finally {
    if (mcpInbox) {
      await mcpClient
        .callTool({
          name: "inbox_delete",
          arguments: { inbox: mcpInbox.id, capability: mcpInbox.token, confirm: true },
        })
        .catch(() => {});
    }
    await mcpClient.close().catch(() => {});
  }

  await assert.rejects(Inbox.create({ endpoint: origin, apiKey: "wrong-key", ttl: 60 }));
  const inbox = await Inbox.create({
    endpoint: origin,
    apiKey: createToken,
    ttl: 60,
    maxMessages: 10,
  });
  assert.match(inbox.address, /@mail\.inboxlet\.test$/);

  const waiting = inbox.wait({ timeout: "5s" });
  await delay(100);
  const injected = await fetch(`${origin}/v1/test/inboxes/${inbox.id}/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${inbox.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ from: "sender@example.com", subject: "Code", text: "123456" }),
  });
  assert.equal(injected.status, 201, await injected.text());

  const incoming = await waiting;
  assert.equal(incoming.text, "123456");

  const sent = await inbox.send({
    to: "person@example.com",
    subject: "Hello",
    html: "<h1>Hello</h1><p>Rich <strong>HTML</strong> message.</p>",
    idempotencyKey: "e2e-send",
  });
  assert.equal(sent.status, "sent");
  assert.match(sent.text, /Rich HTML message/);
  const replayed = await inbox.send({
    to: "person@example.com",
    subject: "Hello",
    html: "<h1>Hello</h1><p>Rich <strong>HTML</strong> message.</p>",
    idempotencyKey: "e2e-send",
  });
  assert.equal(replayed.id, sent.id);
  await assert.rejects(
    inbox.send({
      to: "other@example.com",
      subject: "Different",
      text: "Different",
      idempotencyKey: "e2e-send",
    }),
  );

  const reply = await inbox.reply(incoming, { html: "<p><strong>Thanks</strong></p>" });
  assert.equal(reply.inReplyTo, incoming.rfcMessageId);
  assert.match(reply.text, /Thanks/);
  assert.equal((await inbox.status()).messageCount, 3);

  await inbox.delete();
  await assert.rejects(inbox.status());
  console.log("Inboxlet local end-to-end test passed");
} finally {
  wrangler.kill("SIGTERM");
  if (wrangler.exitCode === null) {
    await once(wrangler, "exit");
  }
}
