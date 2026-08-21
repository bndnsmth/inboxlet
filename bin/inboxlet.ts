#!/usr/bin/env node

import { run } from "../src/cli";

run(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`inboxlet: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
