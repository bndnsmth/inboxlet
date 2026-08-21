import type { InboxAttachment, InboxMessage, InboxStatus, ReadInboxResult } from "../../src/types";

export type OperationResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string };

export interface InitializeInboxInput {
  id: string;
  address: string;
  tokenDigest: ArrayBuffer;
  createdAt: number;
  expiresAt: number;
  maxMessages: number;
}

export interface InboundMessageInput {
  id: string;
  dedupeKey: string;
  from: string;
  to: string;
  headerFrom: string;
  replyTo: string;
  subject: string;
  text: string;
  html: string;
  rfcMessageId: string;
  references: string;
  rawSize: number;
  attachments: InboxAttachment[];
  createdAt: number;
}

export interface OutboundMessageInput {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
}

export interface ReplyInput {
  messageId: string;
  text: string;
  html: string;
  idempotencyKey: string;
}

export type InboxStatusResult = OperationResult<InboxStatus>;
export type MessageResult = OperationResult<InboxMessage>;
export type MessagesResult = OperationResult<ReadInboxResult>;
