# Security

## Reporting

Please report security vulnerabilities privately through GitHub Security Advisories for `bndnsmth/inboxlet`. Do not open a public issue until a fix is available.

## Capability model

An inbox capability grants full control of one inbox: read, send, reply, and delete. Store it like an API key. Inboxlet does not provide token recovery or rotation in v0.1.0.

The deployment `API_KEY` controls only inbox allocation. It does not grant access to inbox contents. Store it in the gitignored `.deploy.secrets` file loaded by `npm run worker:deploy`, and configure trusted clients with the same value.

The remote MCP transport also requires `API_KEY` in its HTTP Authorization header. Inbox-specific MCP tools additionally require the inbox capability in their arguments. Capabilities can therefore appear in MCP client, model-provider, and observability logs; use short inbox lifetimes and do not reuse capabilities outside their inbox.

## Deployment guidance

- Configure rate limits for inbox creation and outbound send routes even though creation is API-key protected.
- Keep TTL and message limits low for untrusted clients.
- Enable Email Sending only for domains dedicated to transactional automation.
- Monitor Worker logs, Email Service suppressions, send failures, and quota errors.
- Do not render inbound HTML without a separate sanitizer and restrictive CSP.
- Treat sender headers as untrusted. `message.from` is the SMTP envelope sender; `headerFrom` and `replyTo` can be spoofed.
- Attachments are parsed for metadata but their bodies are discarded.
- Expiry and explicit deletion call `deleteAll()`, but Cloudflare platform backups and point-in-time recovery may remain subject to Cloudflare's platform retention behavior.
