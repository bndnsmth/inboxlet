import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { Inbox, InboxletError, InboxletTimeoutError } from "../src/client";
import type { InboxMessage } from "../src/types";

const descriptor = {
  id: "keen-otter-abcdefghij",
  address: "keen-otter-abcdefghij@inbox.example.com",
  createdAt: "2026-08-20T00:00:00.000Z",
  expiresAt: "2026-08-20T01:00:00.000Z",
  messageCount: 0,
  maxMessages: 100,
};

const message: InboxMessage = {
  id: "11111111-1111-4111-8111-111111111111",
  seq: 1,
  direction: "inbound",
  status: "received",
  from: "sender@example.com",
  to: descriptor.address,
  subject: "Verification code",
  text: "123456",
  html: "",
  rawSize: 100,
  attachments: [],
  createdAt: "2026-08-20T00:01:00.000Z",
};

test("creates an inbox and sends authenticated requests", async () => {
  const requests: Request[] = [];
  const signals: (AbortSignal | null | undefined)[] = [];
  const responses = [
    Response.json({ ...descriptor, token: "ibl_secret" }, { status: 201 }),
    Response.json({ messages: [message], nextCursor: 1 }),
    Response.json({ ...message, direction: "outbound", status: "sent" }),
  ];
  const fakeFetch: typeof fetch = async (input, init) => {
    signals.push(init?.signal);
    requests.push(new Request(input, init));
    return (
      responses.shift() ??
      Response.json({ error: { code: "NO_RESPONSE", message: "No response" } }, { status: 500 })
    );
  };
  const controller = new AbortController();

  const inbox = await Inbox.create({
    endpoint: "https://api.example/base///",
    apiKey: "create-key",
    ttl: "1h",
    fetch: fakeFetch,
    signal: controller.signal,
  });
  assert.equal(inbox.address, descriptor.address);
  assert.equal((await inbox.read()).messages[0]?.text, "123456");
  await inbox.send({
    to: "person@example.com",
    subject: "Hello",
    html: "<p>Hi</p>",
  });

  assert.equal(requests[0]?.url, "https://api.example/base/v1/inboxes");
  assert.equal(
    requests[1]?.url,
    "https://api.example/base/v1/inboxes/keen-otter-abcdefghij/messages?after=0&limit=50",
  );
  assert.equal(signals[0], controller.signal);
  assert.equal(requests[0]?.headers.get("authorization"), "Bearer create-key");
  assert.equal(requests[1]?.headers.get("authorization"), "Bearer ibl_secret");
  assert.ok(requests[2]?.headers.get("idempotency-key"));
  assert.deepEqual(await requests[2]?.json(), {
    to: "person@example.com",
    subject: "Hello",
    html: "<p>Hi</p>",
  });
});

test("surfaces structured API errors", async () => {
  const inbox = Inbox.from(
    { ...descriptor, token: "ibl_secret", endpoint: "https://api.example" },
    {
      fetch: async () =>
        Response.json({ error: { code: "INBOX_NOT_FOUND", message: "Gone" } }, { status: 404 }),
    },
  );

  await assert.rejects(inbox.status(), (error: unknown) => {
    assert.ok(error instanceof InboxletError);
    assert.equal(error.code, "INBOX_NOT_FOUND");
    assert.equal(error.status, 404);
    return true;
  });
});

test("enforces wait timeouts when the transport stalls", async () => {
  const inbox = Inbox.from(
    { ...descriptor, token: "ibl_secret", endpoint: "https://api.example" },
    {
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            {
              once: true,
            },
          );
        }),
    },
  );

  await assert.rejects(inbox.wait({ timeout: "1s" }), InboxletTimeoutError);
});

test("advances the implicit wait cursor after sending", async () => {
  const urls: string[] = [];
  const outbound = {
    ...message,
    id: "22222222-2222-4222-8222-222222222222",
    seq: 2,
    direction: "outbound" as const,
  };
  const incoming = { ...message, id: "33333333-3333-4333-8333-333333333333", seq: 3 };
  const responses = [
    Response.json(outbound),
    Response.json({ messages: [incoming], nextCursor: 3 }),
  ];
  const inbox = Inbox.from(
    { ...descriptor, token: "ibl_secret", endpoint: "https://api.example" },
    {
      fetch: async (input) => {
        urls.push(
          input instanceof Request ? input.url : input instanceof URL ? input.toString() : input,
        );
        return responses.shift() ?? Response.json({ messages: [], nextCursor: 3 });
      },
    },
  );

  await inbox.send({ to: "person@example.com", subject: "Hello", text: "Hi" });
  assert.equal((await inbox.wait({ timeout: "1s" })).seq, 3);
  assert.match(urls[1] ?? "", /after=2/);
});

test("uses the configured endpoint and API key", async () => {
  Inbox.configure({ endpoint: "https://configured.example", apiKey: "configured-key" });
  let request: Request | undefined;
  const inbox = await Inbox.create({
    fetch: async (input, init) => {
      request = new Request(input, init);
      return Response.json({ ...descriptor, token: "ibl_secret" }, { status: 201 });
    },
  });

  assert.equal(inbox.endpoint, "https://configured.example");
  assert.equal(request?.headers.get("authorization"), "Bearer configured-key");
});

test("rejects unsafe endpoints while allowing local HTTP endpoints", () => {
  const credentials = { ...descriptor, token: "ibl_secret", endpoint: "https://api.example" };
  const fakeFetch: typeof fetch = async () => Response.json({});

  for (const endpoint of [
    "ftp://api.example",
    "http://api.example",
    "https://user:password@api.example",
    "https://:@api.example",
    "https://api.example?tenant=one",
    "https://api.example#fragment",
  ]) {
    assert.throws(() => Inbox.from({ ...credentials, endpoint }, { fetch: fakeFetch }));
  }

  assert.equal(
    Inbox.from({ ...credentials, endpoint: "http://localhost:8787/" }, { fetch: fakeFetch })
      .endpoint,
    "http://localhost:8787",
  );
  assert.equal(
    Inbox.from({ ...credentials, endpoint: "http://127.0.0.2/" }, { fetch: fakeFetch }).endpoint,
    "http://127.0.0.2",
  );
  assert.equal(
    Inbox.from({ ...credentials, endpoint: "http://[::1]/" }, { fetch: fakeFetch }).endpoint,
    "http://[::1]",
  );
});

test("reports a missing fetch implementation before creating an inbox", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: undefined });

  try {
    await assert.rejects(
      Inbox.create({ endpoint: "https://api.example", apiKey: "create-key" }),
      /A fetch implementation is required/,
    );
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, "fetch", descriptor);
    } else {
      delete (globalThis as { fetch?: typeof fetch }).fetch;
    }
  }
});
