# Contributing

## Development

Use Node.js 22.18 or newer and npm 11.
The checked-in `.dev.vars` contains safe local-only bindings, so no setup is required.

```bash
npm install
npm run check
npm test
npm run build
```

Run `npm run test:e2e` before changing API routing, Durable Object storage, authentication, or message delivery behavior.

The static marketing site is deployed independently from the application Worker:

```bash
npm run site:dev
npm run site:build
```

## Pull requests

- Keep public API changes documented in `README.md` and `docs/openapi.yaml`.
- Add tests for new SDK, CLI, protocol, and identity behavior.
- Never commit `.dev.vars`, API keys, capability tokens, or real inbox content.
- Keep the SDK usable with injected `fetch` so consumers can test without a network.
