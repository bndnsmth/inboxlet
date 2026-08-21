<p align="center">
  <img src="site/public/avatar.png" alt="Inboxlet avatar" width="180" />
</p>

<h1 align="center">inboxlet</h1>

<p align="center"><strong>A little inbox for agents.</strong></p>

<p align="center">
  Ephemeral email identity as a primitive for automation.<br />
  <a href="https://inboxlet.dev">inboxlet.dev</a>
</p>

Inboxlet gives agents short-lived email inboxes for verification codes, sign-in links, notifications, approvals, and replies. Each inbox is an isolated SQLite Durable Object with its own capability token and automatic deletion.

## Quick start

```bash
npm install --global inboxlet
inboxlet config --endpoint https://inbox.example.com --api-key "$INBOXLET_API_KEY"
inboxlet create --ttl 1h
inboxlet send --to you@example.com --subject "Hello, world!" --text "Sent from Inboxlet."
```

Node.js 22.18 or newer is required.

## Why Inboxlet

- Friendly, unguessable email addresses
- One isolated Durable Object per inbox
- Capability tokens instead of accounts or passwords
- Wait for new mail without polling loops
- Inbound MIME parsing and threaded replies
- CLI, remote MCP server, SDK, and REST API
- Alarm-driven hard deletion with `storage.deleteAll()`
- No global registry or shared inbox database

## CLI

```bash
inboxlet config --endpoint https://inbox.example.com --api-key "$INBOXLET_API_KEY"
inboxlet create --ttl 1h
inboxlet read --wait 5m
inboxlet send --to person@example.com --subject "Hello" --text "Hi there"
inboxlet reply <message-id> --text "Thanks"
inboxlet list
inboxlet delete --yes
```

Configuration is stored under `~/.config/inboxlet`; inbox capabilities are stored under `~/.local/share/inboxlet`.

## MCP

Inboxlet exposes a Streamable HTTP MCP server at `https://inbox.example.com/mcp`.

```json
{
  "mcpServers": {
    "inboxlet": {
      "url": "https://inbox.example.com/mcp",
      "headers": {
        "Authorization": "Bearer replace-with-your-api-key"
      }
    }
  }
}
```

The HTTP transport requires the server API key. Inbox-specific operations also require the capability returned by `inbox_create`.

| Tool           | Purpose                                   |
| -------------- | ----------------------------------------- |
| `inbox_create` | Create an inbox and return its capability |
| `inbox_status` | Read inbox metadata and usage             |
| `inbox_read`   | Read messages after a sequence cursor     |
| `inbox_wait`   | Wait for the next message                 |
| `inbox_send`   | Send a new email                          |
| `inbox_reply`  | Reply in the original thread              |
| `inbox_delete` | Permanently delete an inbox               |

## SDK

```bash
npm install inboxlet
```

```ts
import { Inbox } from "inboxlet";

Inbox.configure({
  endpoint: "https://inbox.example.com",
  apiKey: process.env.INBOXLET_API_KEY!,
});

const inbox = await Inbox.create({ ttl: "2h" });
const message = await inbox.wait({ timeout: "5m" });

await inbox.reply(message, { text: "Got it. Thanks!" });
await inbox.delete();
```

Use `inbox.read({ after })` for incremental reads and `inbox.send()` to start a new thread. Sends use idempotency keys automatically. Provide `text`, `html`, or both; Inboxlet generates a plain-text fallback when only HTML is provided.

Persist `inbox.credentials()` and restore it later with `Inbox.from(credentials)`. Treat the capability token as a secret: anyone holding it can use that inbox until it expires.

See the [SDK guide](docs/sdk.md) for workflow examples, cursor handling, persistence, cancellation, and error handling.

## REST API

`POST /v1/inboxes` uses the server API key. All other inbox routes use that inbox's capability token. Read requests support sequence cursors and long polling.

See [`docs/openapi.yaml`](docs/openapi.yaml) for the complete API contract.

## Deploy on Cloudflare

Deploy from a repository checkout with Wrangler:

```bash
git clone https://github.com/bndnsmth/inboxlet.git
cd inboxlet
npm install
cp .deploy.vars.example .deploy.vars
cp .deploy.secrets.example .deploy.secrets
# Set real hostnames in .deploy.vars and the API key in .deploy.secrets.
npm run worker:deploy
```

Before deploying:

1. Define `MAIL_DOMAIN` and the MCP hostnames in `.deploy.vars`.
2. Define `API_KEY` in `.deploy.secrets`.
3. Optionally define `WORKER_DOMAIN` in `.deploy.vars`; omit it to use `workers.dev`.
4. Enable [Cloudflare Email Routing](https://developers.cloudflare.com/email-service/get-started/route-emails/) on the apex domain.
5. Enable [Email Sending](https://developers.cloudflare.com/email-service/get-started/send-emails/) for the mail domain.
6. Route the inbox subdomain's catch-all address to the Inboxlet Worker.
7. Configure clients with the deployed endpoint and `API_KEY`.

The typed Cloudflare config reads `.deploy.vars` through Wrangler's `--env-file`. When `WORKER_DOMAIN` is absent, deployment uses the account's `workers.dev` hostname; use that generated hostname for the MCP allowlists. Typed configuration currently uses Wrangler's experimental new-config flag, which the npm scripts set automatically.

## Security and retention

- Inbox capabilities use 256 bits of randomness; only SHA-256 digests are stored.
- The creation API key is stored as a Cloudflare secret.
- Expiry alarms permanently delete inbox storage.
- Request sizes, message counts, TTLs, and long polls are bounded.
- Raw MIME and attachment bodies are not retained.
- Inboxlet is for transactional automation, not bulk or marketing email.

See [`SECURITY.md`](SECURITY.md) for reporting and deployment guidance.

## License

MIT
