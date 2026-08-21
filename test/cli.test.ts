import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { parseArgs } from "../src/cli";

test("parses create and read commands", () => {
  assert.deepEqual(
    parseArgs(["config", "--endpoint", "https://inbox.test", "--api-key", "secret"]),
    {
      command: "config",
      endpoint: "https://inbox.test",
      apiKey: "secret",
      json: false,
      yes: false,
    },
  );
  assert.deepEqual(parseArgs(["create", "--ttl", "2h", "--max-messages", "25", "--json"]), {
    command: "create",
    ttl: "2h",
    maxMessages: 25,
    json: true,
    yes: false,
  });
  assert.deepEqual(parseArgs(["read", "keen-otter-abcdefghij", "--wait", "30s"]), {
    command: "read",
    inbox: "keen-otter-abcdefghij",
    timeout: "30s",
    json: false,
    yes: false,
  });
  assert.deepEqual(
    parseArgs([
      "send",
      "--to",
      "person@example.com",
      "--subject",
      "Hello",
      "--html-file",
      "message.html",
    ]),
    {
      command: "send",
      to: "person@example.com",
      subject: "Hello",
      htmlFile: "message.html",
      json: false,
      yes: false,
    },
  );
});

test("rejects unknown options and extra arguments", () => {
  assert.throws(() => parseArgs(["create", "--wat"]), /Unknown option/);
  assert.throws(() => parseArgs(["send", "unexpected"]), /unexpected positional/);
  assert.throws(
    () => parseArgs(["delete", "first", "--inbox", "second", "--yes"]),
    /either a positional inbox or --inbox/,
  );
});
