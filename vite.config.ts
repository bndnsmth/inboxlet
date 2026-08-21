import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: ["dist/**", "site/dist/**", "worker-configuration.d.ts"],
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "typescript/no-floating-promises": "error",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
  pack: {
    entry: {
      index: "src/index.ts",
      inboxlet: "bin/inboxlet.ts",
    },
    dts: true,
    format: ["esm"],
    platform: "node",
    fixedExtension: false,
    outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
    sourcemap: false,
    outDir: "dist",
    clean: true,
    deps: {
      neverBundle: ["@modelcontextprotocol/server", "agents", "postal-mime", "wrangler", "zod"],
    },
  },
});
