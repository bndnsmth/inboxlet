import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { durationToSeconds } from "../src/duration";

test("parses supported duration units", () => {
  assert.equal(durationToSeconds(30), 30);
  assert.equal(durationToSeconds("30s"), 30);
  assert.equal(durationToSeconds("5m"), 300);
  assert.equal(durationToSeconds("2h"), 7_200);
  assert.equal(durationToSeconds("1d"), 86_400);
});

test("rejects invalid durations", () => {
  assert.throws(() => durationToSeconds("1.5h" as "1h"));
  assert.throws(() => durationToSeconds(0));
});
