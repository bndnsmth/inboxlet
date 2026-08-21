import { DurableObject } from "cloudflare:workers";
import type { InboxAttachment, InboxMessage, InboxStatus } from "../../src/types";
import { digestBase64Url, secureDigestEqual, sha256 } from "./crypto";
import type {
  InboundMessageInput,
  InboxStatusResult,
  InitializeInboxInput,
  MessageResult,
  MessagesResult,
  OperationResult,
  OutboundMessageInput,
  ReadMessagesResult,
  ReplyInput,
} from "./protocol";
import { validEmail } from "./http";

type MetaRow = {
  inboxId: string;
  address: string;
  tokenDigest: ArrayBuffer;
  createdAt: number;
  expiresAt: number;
  nextSeq: number;
  messageCount: number;
  maxMessages: number;
};

type MessageRow = {
  id: string;
  seq: number;
  direction: "inbound" | "outbound";
  status: "received" | "pending" | "sent" | "failed";
  fromAddress: string;
  toAddress: string;
  headerFrom: string | null;
  replyTo: string | null;
  subject: string;
  textBody: string;
  htmlBody: string;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  referencesHeader: string | null;
  providerMessageId: string | null;
  error: string | null;
  rawSize: number;
  attachmentsJson: string;
  createdAt: number;
  idempotencyKey: string | null;
  requestFingerprint: string | null;
};

type ReplyTargetRow = {
  toAddress: string;
  subject: string;
  rfcMessageId: string | null;
  referencesHeader: string | null;
};

const EMAIL_SEND_FAILED_MESSAGE = "Email delivery failed";
const EMAIL_SEND_PENDING_MESSAGE = "Email delivery is still pending";

function failure<T>(status: number, code: string, message: string): OperationResult<T> {
  return { ok: false, status, code, message };
}

function publicStatus(meta: MetaRow): InboxStatus {
  return {
    id: meta.inboxId,
    address: meta.address,
    createdAt: new Date(meta.createdAt).toISOString(),
    expiresAt: new Date(meta.expiresAt).toISOString(),
    messageCount: meta.messageCount,
    maxMessages: meta.maxMessages,
  };
}

function parseAttachments(value: string): InboxAttachment[] {
  try {
    return JSON.parse(value) as InboxAttachment[];
  } catch {
    return [];
  }
}

function publicMessage(row: MessageRow): InboxMessage {
  return {
    id: row.id,
    seq: row.seq,
    direction: row.direction,
    status: row.status,
    from: row.fromAddress,
    to: row.toAddress,
    ...(row.headerFrom ? { headerFrom: row.headerFrom } : {}),
    ...(row.replyTo ? { replyTo: row.replyTo } : {}),
    subject: row.subject,
    text: row.textBody,
    html: row.htmlBody,
    ...(row.rfcMessageId ? { rfcMessageId: row.rfcMessageId } : {}),
    ...(row.inReplyTo ? { inReplyTo: row.inReplyTo } : {}),
    ...(row.referencesHeader ? { references: row.referencesHeader } : {}),
    ...(row.providerMessageId ? { providerMessageId: row.providerMessageId } : {}),
    ...(row.error
      ? {
          error:
            row.direction === "outbound" && row.status === "failed"
              ? EMAIL_SEND_FAILED_MESSAGE
              : row.error,
        }
      : {}),
    rawSize: row.rawSize,
    attachments: parseAttachments(row.attachmentsJson),
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function enabled(value: string): boolean {
  return value === "true";
}

export class InboxObject extends DurableObject<Env> {
  private readonly waiters = new Set<() => void>();
  private inFlightDeliveries = 0;
  private initialized = false;
  private purged = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.initialized = (await ctx.storage.get<boolean>("initialized")) ?? false;
      if (this.initialized) {
        this.migrate();
      }
    });
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const version = this.ctx.storage.sql
      .exec<{ version: number }>(
        "SELECT COALESCE(MAX(id), 0) AS version FROM _sql_schema_migrations",
      )
      .one().version;

    if (version < 1) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE inbox_meta (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          inbox_id TEXT NOT NULL UNIQUE,
          address TEXT NOT NULL UNIQUE,
          token_digest BLOB NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          next_seq INTEGER NOT NULL DEFAULT 1 CHECK (next_seq > 0),
          message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
          max_messages INTEGER NOT NULL CHECK (max_messages > 0)
        );
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          seq INTEGER NOT NULL UNIQUE,
          direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
          status TEXT NOT NULL CHECK (status IN ('received', 'pending', 'sent', 'failed')),
          from_address TEXT NOT NULL,
          to_address TEXT NOT NULL,
          header_from TEXT,
          reply_to TEXT,
          subject TEXT NOT NULL,
          text_body TEXT NOT NULL,
          html_body TEXT NOT NULL,
          rfc_message_id TEXT,
          in_reply_to TEXT,
          references_header TEXT,
          provider_message_id TEXT,
          error TEXT,
          raw_size INTEGER NOT NULL DEFAULT 0 CHECK (raw_size >= 0),
          attachments_json TEXT NOT NULL DEFAULT '[]',
          idempotency_key TEXT,
          dedupe_key TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX idx_messages_idempotency_key
          ON messages(idempotency_key) WHERE idempotency_key IS NOT NULL;
        CREATE UNIQUE INDEX idx_messages_dedupe_key
          ON messages(dedupe_key) WHERE dedupe_key IS NOT NULL;
        CREATE INDEX idx_messages_seq ON messages(seq);
        INSERT INTO _sql_schema_migrations (id) VALUES (1);
      `);
    }

    if (version < 2) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE messages ADD COLUMN request_fingerprint TEXT;
        INSERT INTO _sql_schema_migrations (id) VALUES (2);
      `);
    }
  }

  private meta(): MetaRow | undefined {
    if (!this.initialized || this.purged) {
      return undefined;
    }
    return this.ctx.storage.sql
      .exec<MetaRow>(`
        SELECT inbox_id AS inboxId, address, token_digest AS tokenDigest,
          created_at AS createdAt, expires_at AS expiresAt, next_seq AS nextSeq,
          message_count AS messageCount, max_messages AS maxMessages
        FROM inbox_meta WHERE id = 1
      `)
      .toArray()[0];
  }

  private async activeMeta(): Promise<MetaRow | undefined> {
    const meta = this.meta();
    if (meta && meta.expiresAt <= Date.now()) {
      await this.purge();
      return undefined;
    }
    return meta;
  }

  private async authorize(tokenDigest: ArrayBuffer): Promise<OperationResult<MetaRow>> {
    const meta = await this.activeMeta();
    if (!meta) {
      return failure(404, "INBOX_NOT_FOUND", "Inbox not found or expired");
    }
    if (!secureDigestEqual(meta.tokenDigest, tokenDigest)) {
      return failure(403, "INVALID_CAPABILITY", "Invalid inbox capability token");
    }
    return { ok: true, value: meta };
  }

  private messageByIdempotencyKey(key: string): MessageRow | undefined {
    return this.ctx.storage.sql
      .exec<MessageRow>(`${this.messageSelect()} WHERE idempotency_key = ? LIMIT 1`, key)
      .toArray()[0];
  }

  private messageById(id: string): MessageRow | undefined {
    return this.ctx.storage.sql
      .exec<MessageRow>(`${this.messageSelect()} WHERE id = ? LIMIT 1`, id)
      .toArray()[0];
  }

  private messageSelect(): string {
    return `SELECT id, seq, direction, status, from_address AS fromAddress,
      to_address AS toAddress, header_from AS headerFrom, reply_to AS replyTo,
      subject, text_body AS textBody, html_body AS htmlBody,
      rfc_message_id AS rfcMessageId, in_reply_to AS inReplyTo,
      references_header AS referencesHeader, provider_message_id AS providerMessageId,
      error, raw_size AS rawSize, attachments_json AS attachmentsJson,
      created_at AS createdAt, idempotency_key AS idempotencyKey,
      request_fingerprint AS requestFingerprint FROM messages`;
  }

  private nextSequence(): number {
    return this.ctx.storage.sql
      .exec<{ seq: number }>(`
        UPDATE inbox_meta
        SET next_seq = next_seq + 1, message_count = message_count + 1
        WHERE id = 1
        RETURNING next_seq - 1 AS seq
      `)
      .one().seq;
  }

  private notifyWaiters(): void {
    for (const resolve of this.waiters) {
      resolve();
    }
    this.waiters.clear();
  }

  private async waitForChange(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(wake);
        resolve();
      }, milliseconds);
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.add(wake);
    });
  }

  private async purge(): Promise<boolean> {
    if (this.inFlightDeliveries > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
      return false;
    }

    this.initialized = false;
    this.purged = true;
    this.notifyWaiters();
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    return true;
  }

  async initialize(input: InitializeInboxInput): Promise<InboxStatusResult> {
    if (this.initialized || this.purged) {
      return failure(409, "INBOX_EXISTS", "Inbox identifier is already in use");
    }

    this.migrate();
    this.ctx.storage.sql.exec(
      `INSERT INTO inbox_meta (
        id, inbox_id, address, token_digest, created_at, expires_at, max_messages
      ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.address,
      input.tokenDigest,
      input.createdAt,
      input.expiresAt,
      input.maxMessages,
    );
    this.initialized = true;
    await Promise.all([
      this.ctx.storage.put("initialized", true),
      this.ctx.storage.setAlarm(input.expiresAt),
    ]);
    const meta = this.meta();
    if (!meta) {
      return failure(500, "INITIALIZATION_FAILED", "Inbox initialization failed");
    }
    return { ok: true, value: publicStatus(meta) };
  }

  async status(tokenDigest: ArrayBuffer): Promise<InboxStatusResult> {
    const authorized = await this.authorize(tokenDigest);
    return authorized.ok ? { ok: true, value: publicStatus(authorized.value) } : authorized;
  }

  async read(
    tokenDigest: ArrayBuffer,
    after: number,
    limit: number,
    waitMilliseconds: number,
  ): Promise<MessagesResult> {
    let authorized = await this.authorize(tokenDigest);
    if (!authorized.ok) {
      return authorized;
    }

    let result = this.readRows(after, limit);
    if (result.messages.length === 0 && waitMilliseconds > 0) {
      if (this.waiters.size >= 100) {
        return failure(429, "TOO_MANY_WAITERS", "Inbox has too many concurrent waiters");
      }
      await this.waitForChange(Math.min(waitMilliseconds, 25_000));
      authorized = await this.authorize(tokenDigest);
      if (!authorized.ok) {
        return authorized;
      }
      result = this.readRows(after, limit);
    }

    return { ok: true, value: result };
  }

  private readRows(after: number, limit: number): ReadMessagesResult {
    const rows = this.ctx.storage.sql
      .exec<MessageRow>(
        `${this.messageSelect()} WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
        after,
        limit,
      )
      .toArray();
    const messages = rows.map(publicMessage);
    return { messages, nextCursor: messages.at(-1)?.seq ?? after };
  }

  async receive(input: InboundMessageInput): Promise<MessageResult> {
    const meta = await this.activeMeta();
    if (!meta) {
      return failure(404, "INBOX_NOT_FOUND", "Inbox not found or expired");
    }

    const duplicate = this.ctx.storage.sql
      .exec<MessageRow>(`${this.messageSelect()} WHERE dedupe_key = ? LIMIT 1`, input.dedupeKey)
      .toArray()[0];
    if (duplicate) {
      return { ok: true, value: publicMessage(duplicate) };
    }
    if (meta.messageCount >= meta.maxMessages) {
      return failure(429, "INBOX_FULL", "Inbox message limit reached");
    }

    const seq = this.nextSequence();
    this.ctx.storage.sql.exec(
      `INSERT INTO messages (
        id, seq, direction, status, from_address, to_address, header_from, reply_to,
        subject, text_body, html_body, rfc_message_id, references_header,
        raw_size, attachments_json, dedupe_key, created_at
      ) VALUES (?, ?, 'inbound', 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      seq,
      input.from,
      input.to,
      input.headerFrom,
      input.replyTo,
      input.subject,
      input.text,
      input.html,
      input.rfcMessageId,
      input.references,
      input.rawSize,
      JSON.stringify(input.attachments),
      input.dedupeKey,
      input.createdAt,
    );
    this.notifyWaiters();
    const row = this.messageById(input.id);
    return row
      ? { ok: true, value: publicMessage(row) }
      : failure(500, "STORE_FAILED", "Message storage failed");
  }

  async acceptsInbound(): Promise<boolean> {
    return Boolean(await this.activeMeta());
  }

  async send(tokenDigest: ArrayBuffer, input: OutboundMessageInput): Promise<MessageResult> {
    const authorized = await this.authorize(tokenDigest);
    if (!authorized.ok) {
      return authorized;
    }
    return this.deliver(authorized.value, input);
  }

  async reply(tokenDigest: ArrayBuffer, input: ReplyInput): Promise<MessageResult> {
    const authorized = await this.authorize(tokenDigest);
    if (!authorized.ok) {
      return authorized;
    }

    const original = this.ctx.storage.sql
      .exec<ReplyTargetRow>(
        `
        SELECT COALESCE(NULLIF(reply_to, ''), from_address) AS toAddress,
          subject, rfc_message_id AS rfcMessageId,
          references_header AS referencesHeader
        FROM messages WHERE id = ? AND direction = 'inbound' LIMIT 1
      `,
        input.messageId,
      )
      .toArray()[0];
    if (!original) {
      return failure(404, "MESSAGE_NOT_FOUND", "Inbound message not found");
    }
    if (!validEmail(original.toAddress)) {
      return failure(422, "NO_REPLY_ADDRESS", "Original sender has no valid reply address");
    }

    const subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;
    const references = [original.referencesHeader, original.rfcMessageId]
      .filter(Boolean)
      .join(" ")
      .slice(-1_800);

    return this.deliver(
      authorized.value,
      {
        to: original.toAddress,
        subject,
        text: input.text,
        html: input.html,
        idempotencyKey: input.idempotencyKey,
      },
      {
        inReplyTo: original.rfcMessageId ?? "",
        references,
      },
    );
  }

  private async deliver(
    meta: MetaRow,
    input: OutboundMessageInput,
    thread: { inReplyTo: string; references: string } = { inReplyTo: "", references: "" },
  ): Promise<MessageResult> {
    const requestFingerprint = digestBase64Url(
      await sha256(
        JSON.stringify([
          input.to,
          input.subject,
          input.text,
          input.html,
          thread.inReplyTo,
          thread.references,
        ]),
      ),
    );
    const existing = this.messageByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        return failure(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "Idempotency key was already used for a different message",
        );
      }
      if (existing.status === "sent") {
        return { ok: true, value: publicMessage(existing) };
      }
      if (existing.status === "failed") {
        return failure(502, "EMAIL_SEND_FAILED", EMAIL_SEND_FAILED_MESSAGE);
      }
      if (existing.status === "pending") {
        // The provider may have accepted a stale delivery before the final state update.
        // Retrying it here would risk sending the same email twice.
        return failure(503, "EMAIL_SEND_PENDING", EMAIL_SEND_PENDING_MESSAGE);
      }
      return failure(500, "INVALID_DELIVERY_STATE", "Outbound delivery has invalid state");
    }
    if (meta.messageCount >= meta.maxMessages) {
      return failure(429, "INBOX_FULL", "Inbox message limit reached");
    }

    const id = crypto.randomUUID();
    const seq = this.nextSequence();
    const createdAt = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO messages (
        id, seq, direction, status, from_address, to_address, subject,
        text_body, html_body, in_reply_to, references_header,
        raw_size, attachments_json, idempotency_key, request_fingerprint, created_at
      ) VALUES (?, ?, 'outbound', 'pending', ?, ?, ?, ?, ?, ?, ?, 0, '[]', ?, ?, ?)`,
      id,
      seq,
      meta.address,
      input.to,
      input.subject,
      input.text,
      input.html,
      thread.inReplyTo,
      thread.references,
      input.idempotencyKey,
      requestFingerprint,
      createdAt,
    );

    this.inFlightDeliveries += 1;
    try {
      const headers: Record<string, string> = {};
      if (thread.inReplyTo) {
        headers["In-Reply-To"] = thread.inReplyTo;
      }
      if (thread.references) {
        headers.References = thread.references;
      }

      const result = enabled(this.env.MOCK_EMAIL)
        ? { messageId: `mock-${crypto.randomUUID()}` }
        : await this.env.EMAIL.send({
            to: input.to,
            from: { email: meta.address, name: "Inboxlet" },
            replyTo: meta.address,
            subject: input.subject,
            text: input.text,
            html:
              input.html ||
              `<div style="font:16px/1.6 sans-serif;white-space:pre-wrap">${escapeHtml(input.text)}</div>`,
            headers,
          });
      this.ctx.storage.sql.exec(
        "UPDATE messages SET status = 'sent', provider_message_id = ? WHERE id = ?",
        result.messageId,
        id,
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message.slice(0, 1_000)
          : "Email provider rejected the message";
      this.ctx.storage.sql.exec(
        "UPDATE messages SET status = 'failed', error = ? WHERE id = ?",
        message,
        id,
      );
      this.notifyWaiters();
      return failure(502, "EMAIL_SEND_FAILED", EMAIL_SEND_FAILED_MESSAGE);
    } finally {
      this.inFlightDeliveries -= 1;
    }

    this.notifyWaiters();
    const row = this.messageById(id);
    return row
      ? { ok: true, value: publicMessage(row) }
      : failure(500, "STORE_FAILED", "Outbound message record was not found");
  }

  async delete(tokenDigest: ArrayBuffer): Promise<OperationResult<{ deleted: true }>> {
    const authorized = await this.authorize(tokenDigest);
    if (!authorized.ok) {
      return authorized;
    }
    if (this.inFlightDeliveries > 0) {
      return failure(409, "INBOX_BUSY", "Inbox has an email delivery in progress");
    }
    await this.purge();
    return { ok: true, value: { deleted: true } };
  }

  async alarm(): Promise<void> {
    await this.purge();
  }
}
