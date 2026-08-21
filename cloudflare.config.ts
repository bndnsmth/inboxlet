import { bindings, defineWorker, exports as workerExports } from "wrangler/experimental-config";

const workerName = "inboxlet";
const workerDomain = process.env.WORKER_DOMAIN?.trim();

export default defineWorker({
  name: workerName,
  entrypoint: "./worker/src/index.ts",
  compatibilityDate: "2026-08-20",
  compatibilityFlags: ["nodejs_compat"],
  workersDev: !workerDomain,
  ...(workerDomain ? { domains: [workerDomain] } : {}),
  env: {
    INBOXES: bindings.durableObject({
      workerName,
      exportName: "InboxObject",
    }),
    EMAIL: bindings.sendEmail(),
    API_KEY: bindings.secret(),
    MAIL_DOMAIN: bindings.text(process.env.MAIL_DOMAIN ?? "mail.example.com"),
    MCP_ALLOWED_HOSTNAMES: bindings.text(
      process.env.MCP_ALLOWED_HOSTNAMES ?? "inboxlet.example.com",
    ),
    MCP_ALLOWED_ORIGIN_HOSTNAMES: bindings.text(
      process.env.MCP_ALLOWED_ORIGIN_HOSTNAMES ??
        "inboxlet.example.com,playground.ai.cloudflare.com",
    ),
    DEFAULT_TTL_SECONDS: bindings.text(process.env.DEFAULT_TTL_SECONDS ?? "3600"),
    MIN_TTL_SECONDS: bindings.text(process.env.MIN_TTL_SECONDS ?? "60"),
    MAX_TTL_SECONDS: bindings.text(process.env.MAX_TTL_SECONDS ?? "604800"),
    DEFAULT_MAX_MESSAGES: bindings.text(process.env.DEFAULT_MAX_MESSAGES ?? "100"),
    MAX_MESSAGES: bindings.text(process.env.MAX_MESSAGES ?? "500"),
    MAX_RAW_BYTES: bindings.text(process.env.MAX_RAW_BYTES ?? "10485760"),
    MAX_BODY_BYTES: bindings.text(process.env.MAX_BODY_BYTES ?? "524288"),
    ENABLE_TEST_INGRESS: bindings.text(process.env.ENABLE_TEST_INGRESS ?? "false"),
    MOCK_EMAIL: bindings.text(process.env.MOCK_EMAIL ?? "false"),
  },
  exports: {
    InboxObject: workerExports.durableObject({ storage: "sqlite" }),
  },
  observability: {
    enabled: true,
    logs: {
      headSamplingRate: 1,
    },
    traces: {
      enabled: true,
      headSamplingRate: 0.01,
    },
  },
});
