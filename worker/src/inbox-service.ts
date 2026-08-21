import type { InboxStatus } from "../../src/types";
import { sha256 } from "./crypto";
import { integer } from "./http";
import { INBOX_ID_PATTERN, inboxIdFromAddress, randomCapability, randomInboxId } from "./identity";
import { InboxObject } from "./inbox-object";
import type { OperationResult } from "./protocol";

export interface ProvisionInboxInput {
  ttlSeconds?: number;
  maxMessages?: number;
}

export interface ProvisionedInbox extends InboxStatus {
  token: string;
}

export function envInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function inboxStub(env: Env, inboxId: string): DurableObjectStub<InboxObject> {
  return env.INBOXES.getByName(inboxId) as DurableObjectStub<InboxObject>;
}

export function inboxIdFromReference(reference: string, env: Env): string | null {
  const normalized = reference.trim().toLowerCase();
  if (INBOX_ID_PATTERN.test(normalized)) {
    return normalized;
  }
  return inboxIdFromAddress(normalized, env.MAIL_DOMAIN.trim());
}

export async function provisionInbox(
  env: Env,
  input: ProvisionInboxInput,
): Promise<OperationResult<ProvisionedInbox>> {
  const ttlSeconds = integer(input.ttlSeconds, "ttlSeconds", {
    min: envInteger(env.MIN_TTL_SECONDS, "MIN_TTL_SECONDS"),
    max: envInteger(env.MAX_TTL_SECONDS, "MAX_TTL_SECONDS"),
    fallback: envInteger(env.DEFAULT_TTL_SECONDS, "DEFAULT_TTL_SECONDS"),
  });
  const maxMessages = integer(input.maxMessages, "maxMessages", {
    min: 1,
    max: envInteger(env.MAX_MESSAGES, "MAX_MESSAGES"),
    fallback: envInteger(env.DEFAULT_MAX_MESSAGES, "DEFAULT_MAX_MESSAGES"),
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const id = randomInboxId();
    const token = randomCapability();
    const createdAt = Date.now();
    const result = await inboxStub(env, id).initialize({
      id,
      address: `${id}@${env.MAIL_DOMAIN.trim().toLowerCase()}`,
      tokenDigest: await sha256(token),
      createdAt,
      expiresAt: createdAt + ttlSeconds * 1_000,
      maxMessages,
    });
    if (result.ok) {
      return { ok: true, value: { ...result.value, token } };
    }
    if (result.code !== "INBOX_EXISTS") {
      return result;
    }
  }

  return {
    ok: false,
    status: 503,
    code: "CREATE_COLLISION",
    message: "Could not allocate an inbox identifier",
  };
}
