# Inboxlet SDK

The TypeScript SDK creates and controls ephemeral inboxes from Node.js or any runtime with Fetch and Web Crypto APIs.

## Install

```bash
npm install inboxlet
```

## Configure

Configure shared defaults once at application startup:

```ts
import { Inbox } from "inboxlet";

Inbox.configure({
  endpoint: "https://inbox.example.com",
  apiKey: process.env.INBOXLET_API_KEY!,
});
```

The API key authorizes inbox creation. Each new inbox receives a separate capability token for all later operations.

For isolated jobs or multiple Inboxlet deployments, pass configuration to `Inbox.create()` instead:

```ts
const inbox = await Inbox.create({
  endpoint: "https://inbox.example.com",
  apiKey: process.env.INBOXLET_API_KEY!,
  ttl: "30m",
  maxMessages: 20,
});
```

Durations accept seconds or strings such as `30m`, `2h`, and `1d`.

## Wait for a verification email

```ts
import { Inbox } from "inboxlet";

const inbox = await Inbox.create({ ttl: "15m", maxMessages: 5 });

try {
  console.log(`Use ${inbox.address} for the signup`);

  const message = await inbox.wait({ timeout: "5m" });
  const code = message.text.match(/\b\d{6}\b/)?.[0];

  if (!code) throw new Error("Verification code not found");
  console.log(code);
} finally {
  await inbox.delete();
}
```

`wait()` long-polls the service and reconnects automatically until a message arrives or the timeout expires.

## Extract a sign-in link

```ts
const message = await inbox.wait({ timeout: "5m" });
const signInUrl = message.text.match(/https:\/\/\S+/)?.[0];

if (!signInUrl) throw new Error("Sign-in link not found");
```

Inspect `message.html` when the link is only present in the HTML body. Inbound messages also include sender, recipient, subject, thread headers, attachment metadata, and delivery timestamps.

## Send an email and wait for the reply

```ts
const workflowId = "approval-123";
const sent = await inbox.send({
  to: "person@example.com",
  subject: "Can you approve this?",
  text: "Reply yes to approve.",
  idempotencyKey: `approval:${workflowId}`,
});

const reply = await inbox.wait({ after: sent.seq, timeout: "1h" });
console.log(reply.from, reply.text);
```

The SDK generates an idempotency key when one is not supplied. Use a stable application key when the surrounding job may retry.

## Reply in the original thread

Pass either an `InboxMessage` or its ID:

```ts
const incoming = await inbox.wait({ timeout: "10m" });

await inbox.reply(incoming, {
  text: "Approved. Thank you.",
});
```

Inboxlet uses the stored sender and thread headers to construct the reply.

## Send HTML

```ts
await inbox.send({
  to: "person@example.com",
  subject: "Build complete",
  html: "<p>Your build is <strong>ready</strong>.</p>",
});
```

Every send and reply requires `text`, `html`, or both. When only HTML is provided, Inboxlet generates and stores a plain-text fallback.

## Process messages with cursors

Use `read()` when processing batches or persisting progress outside the SDK:

```ts
let cursor = Number(await loadCursor(inbox.id)) || 0;

const result = await inbox.read({ after: cursor, limit: 50 });

for (const message of result.messages) {
  await processMessage(message);
  cursor = message.seq;
  await saveCursor(inbox.id, cursor);
}
```

Messages are returned in ascending sequence order. `nextCursor` is the last returned sequence, or the unchanged `after` cursor when no messages are returned.

The SDK also maintains an in-memory cursor. Calls to `read()`, `send()`, `reply()`, and `wait()` advance it, so a later `wait()` without `after` waits for a newer message.

## Persist and restore an inbox

Store the complete credentials when a workflow spans jobs or processes:

```ts
const serialized = JSON.stringify(inbox.credentials());
await saveSecret(serialized);
```

Restore them without the creation API key:

```ts
import { Inbox, type InboxCredentials } from "inboxlet";

const credentials = JSON.parse(await loadSecret()) as InboxCredentials;
const inbox = Inbox.from(credentials);
```

The credentials contain the inbox capability token. Store them as secrets and delete them after the inbox expires or is removed.

## Cancellation and timeouts

```ts
import { InboxletTimeoutError } from "inboxlet";

const controller = new AbortController();

try {
  const message = await inbox.wait({
    timeout: "5m",
    signal: controller.signal,
  });
  console.log(message.subject);
} catch (error) {
  if (error instanceof InboxletTimeoutError) {
    console.log("No message arrived before the deadline");
  } else if (controller.signal.aborted) {
    console.log("Wait cancelled");
  } else {
    throw error;
  }
}
```

`status()`, `read()`, `send()`, `reply()`, and `delete()` also accept an `AbortSignal`.

## Handle API errors

```ts
import { InboxletError } from "inboxlet";

try {
  await inbox.status();
} catch (error) {
  if (error instanceof InboxletError) {
    console.error(error.code, error.status, error.message);
  } else {
    throw error;
  }
}
```

`InboxletError` exposes the API error `code` and HTTP `status`. A wait deadline throws the more specific `InboxletTimeoutError`.

## Use a custom Fetch implementation

Pass `fetch` when your runtime does not provide a global implementation or when requests need custom instrumentation:

```ts
const inbox = await Inbox.create({
  endpoint: "https://inbox.example.com",
  apiKey: process.env.INBOXLET_API_KEY!,
  fetch: instrumentedFetch,
});
```

The same option is accepted by `Inbox.from(credentials, { fetch })`.

## API reference

### Static methods

- `Inbox.configure({ endpoint, apiKey })`
- `Inbox.create({ endpoint?, apiKey?, ttl?, maxMessages?, fetch? })`
- `Inbox.from(credentials, { endpoint?, fetch? })`

### Inbox methods

- `credentials()` returns serializable inbox credentials
- `status()` returns expiry and usage metadata
- `read({ after?, limit?, waitSeconds?, signal? })` reads messages
- `wait({ after?, timeout?, signal? })` waits for one message
- `send(input, { signal? })` starts a new email thread
- `reply(message, input, { signal? })` replies to a stored message
- `delete({ signal? })` permanently deletes the inbox

See [`openapi.yaml`](openapi.yaml) for the underlying REST contract.
