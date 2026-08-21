import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  INBOX_ID_PATTERN,
  inboxIdFromAddress,
  randomCapability,
  randomInboxId,
} from "../worker/src/identity";

test("generates friendly unguessable inbox identifiers", () => {
  const identifiers = new Set(Array.from({ length: 100 }, () => randomInboxId()));
  assert.equal(identifiers.size, 100);
  for (const identifier of identifiers) {
    assert.match(identifier, INBOX_ID_PATTERN);
  }
});

test("extracts inbox identifiers only from the configured domain", () => {
  const id = randomInboxId();
  assert.equal(inboxIdFromAddress(`${id}@inbox.example.com`, "inbox.example.com"), id);
  assert.equal(inboxIdFromAddress(`${id}@elsewhere.example`, "inbox.example.com"), null);
  assert.equal(inboxIdFromAddress("not-an-inbox@inbox.example.com", "inbox.example.com"), null);
});

test("generates opaque capability tokens", () => {
  const first = randomCapability();
  const second = randomCapability();
  assert.match(first, /^ibl_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
});
