import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  idempotencyKey,
  integer,
  readJsonRecord,
  RequestError,
  requireEmail,
} from "../worker/src/http";

test("reads bounded JSON objects", async () => {
  const request = new Request("https://example.test", {
    method: "POST",
    body: JSON.stringify({ ttlSeconds: 300 }),
  });
  assert.deepEqual(await readJsonRecord(request), { ttlSeconds: 300 });

  await assert.rejects(
    readJsonRecord(
      new Request("https://example.test", {
        method: "POST",
        body: JSON.stringify({ large: "x".repeat(100) }),
      }),
      20,
    ),
    RequestError,
  );
});

test("validates integer, email, and idempotency fields", () => {
  assert.equal(integer(5, "value", { min: 1, max: 10, fallback: 2 }), 5);
  assert.equal(integer(undefined, "value", { min: 1, max: 10, fallback: 2 }), 2);
  assert.throws(() => integer(undefined, "value", { min: 1, max: 10, fallback: 20 }), RequestError);
  assert.equal(requireEmail("Person@example.com", "to"), "person@example.com");
  assert.throws(() => requireEmail("not-an-email", "to"), RequestError);
  assert.equal(
    idempotencyKey(
      new Request("https://example.test", { headers: { "idempotency-key": "stable-key" } }),
    ),
    "stable-key",
  );
});
