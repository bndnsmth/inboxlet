import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import type { InboxMessage } from "../src/types";
import type { OperationResult, OutboundMessageInput } from "../worker/src/protocol";
import { digestBase64Url, sha256 } from "../worker/src/crypto";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const { InboxObject } = await import("../worker/src/inbox-object");

type ReplayRow = {
  id: string;
  seq: number;
  direction: "outbound";
  status: "pending" | "sent" | "failed";
  fromAddress: string;
  toAddress: string;
  headerFrom: null;
  replyTo: null;
  subject: string;
  textBody: string;
  htmlBody: string;
  rfcMessageId: null;
  inReplyTo: string;
  referencesHeader: string;
  providerMessageId: string | null;
  error: string | null;
  rawSize: number;
  attachmentsJson: string;
  createdAt: number;
  idempotencyKey: string;
  requestFingerprint: string;
};

type DeliveryHarness = {
  deliver(
    meta: { messageCount: number; maxMessages: number },
    input: OutboundMessageInput,
  ): Promise<OperationResult<InboxMessage>>;
  messageByIdempotencyKey(key: string): ReplayRow | undefined;
};

const input: OutboundMessageInput = {
  to: "recipient@example.com",
  subject: "Launch",
  text: "Ready",
  html: "<p>Ready</p>",
  idempotencyKey: "launch-send",
};

async function replay(status: ReplayRow["status"]): Promise<OperationResult<InboxMessage>> {
  const requestFingerprint = digestBase64Url(
    await sha256(JSON.stringify([input.to, input.subject, input.text, input.html, "", ""])),
  );
  const row: ReplayRow = {
    id: "0f952178-bad5-4db3-a932-b15e7942fc67",
    seq: 1,
    direction: "outbound",
    status,
    fromAddress: "inbox@example.com",
    toAddress: input.to,
    headerFrom: null,
    replyTo: null,
    subject: input.subject,
    textBody: input.text,
    htmlBody: input.html,
    rfcMessageId: null,
    inReplyTo: "",
    referencesHeader: "",
    providerMessageId: status === "sent" ? "provider-id" : null,
    error: status === "failed" ? "sensitive provider rejection details" : null,
    rawSize: 0,
    attachmentsJson: "[]",
    createdAt: Date.UTC(2026, 7, 21),
    idempotencyKey: input.idempotencyKey,
    requestFingerprint,
  };
  const object = Object.create(InboxObject.prototype) as DeliveryHarness;
  object.messageByIdempotencyKey = () => row;
  return object.deliver({ messageCount: 1, maxMessages: 10 }, input);
}

test("replays a sent outbound message successfully", async () => {
  const result = await replay("sent");

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.id, "0f952178-bad5-4db3-a932-b15e7942fc67");
    assert.equal(result.value.status, "sent");
  }
});

test("replays a failed outbound message as a generic stable failure", async () => {
  const result = await replay("failed");

  assert.deepEqual(result, {
    ok: false,
    status: 502,
    code: "EMAIL_SEND_FAILED",
    message: "Email delivery failed",
  });
  assert.doesNotMatch(JSON.stringify(result), /provider rejection/i);
});

test("replays a pending outbound message as retryable non-success", async () => {
  const result = await replay("pending");

  assert.deepEqual(result, {
    ok: false,
    status: 503,
    code: "EMAIL_SEND_PENDING",
    message: "Email delivery is still pending",
  });
});
