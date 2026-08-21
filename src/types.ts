export type InboxMessageDirection = "inbound" | "outbound";
export type InboxMessageStatus = "received" | "pending" | "sent" | "failed";

export interface InboxAttachment {
  filename: string;
  mimeType: string;
  size: number;
}

export interface InboxMessage {
  id: string;
  seq: number;
  direction: InboxMessageDirection;
  status: InboxMessageStatus;
  from: string;
  to: string;
  headerFrom?: string;
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
  rfcMessageId?: string;
  inReplyTo?: string;
  references?: string;
  providerMessageId?: string;
  error?: string;
  rawSize: number;
  attachments: InboxAttachment[];
  createdAt: string;
}

export interface InboxDescriptor {
  id: string;
  address: string;
  createdAt: string;
  expiresAt: string;
}

export interface InboxStatus extends InboxDescriptor {
  messageCount: number;
  maxMessages: number;
}

export interface InboxCredentials extends InboxDescriptor {
  token: string;
  endpoint: string;
}

export type DurationInput = number | `${bigint}${"s" | "m" | "h" | "d"}`;

export interface InboxClientOptions {
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
}

export interface CreateInboxOptions extends InboxClientOptions {
  apiKey?: string;
  ttl?: DurationInput;
  maxMessages?: number;
  signal?: AbortSignal;
}

export interface InboxletConfiguration {
  endpoint: string;
  apiKey: string;
}

export interface ReadInboxOptions {
  after?: number;
  limit?: number;
  waitSeconds?: number;
  signal?: AbortSignal;
}

export interface WaitForMessageOptions {
  after?: number;
  timeout?: DurationInput;
  signal?: AbortSignal;
}

export type MessageBodyInput = { text: string; html?: string } | { text?: string; html: string };

export type SendMessageInput = MessageBodyInput & {
  to: string;
  subject: string;
  idempotencyKey?: string;
};

export type ReplyMessageInput = MessageBodyInput & {
  idempotencyKey?: string;
};

export interface ReadInboxResult {
  messages: InboxMessage[];
  nextCursor: number;
}
