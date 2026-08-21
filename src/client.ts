import { durationToSeconds } from "./duration";
import type {
  CreateInboxOptions,
  InboxClientOptions,
  InboxCredentials,
  InboxDescriptor,
  InboxletConfiguration,
  InboxMessage,
  InboxStatus,
  ReadInboxOptions,
  ReadInboxResult,
  ReplyMessageInput,
  SendMessageInput,
  WaitForMessageOptions,
} from "./types";

let defaultConfiguration: InboxletConfiguration | undefined;

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
  };
}

interface CreateResponse extends InboxStatus {
  token: string;
}

export class InboxletError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, options: { code?: string; status?: number } = {}) {
    super(message);
    this.name = "InboxletError";
    this.code = options.code ?? "INBOXLET_ERROR";
    this.status = options.status ?? 0;
  }
}

export class InboxletTimeoutError extends InboxletError {
  constructor() {
    super("Timed out waiting for an inbox message", { code: "WAIT_TIMEOUT", status: 408 });
    this.name = "InboxletTimeoutError";
  }
}

function normalizeEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Inboxlet endpoint must use http or https");
  }
  if (url.username || url.password || /^[a-z][a-z\d+.-]*:\/\/[^/?#]*@/i.test(endpoint.trim())) {
    throw new Error("Inboxlet endpoint must not include credentials");
  }
  if (url.search || url.hash || url.href.includes("?") || url.href.includes("#")) {
    throw new Error("Inboxlet endpoint must not include a query or fragment");
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new Error("Inboxlet endpoint must use https unless it is localhost or loopback");
  }

  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function endpointUrl(endpoint: string, path: string): string {
  return new URL(path.replace(/^\/+/, ""), `${endpoint}/`).toString();
}

function getFetch(implementation?: typeof globalThis.fetch): typeof globalThis.fetch {
  const resolved = implementation ?? globalThis.fetch;
  if (typeof resolved !== "function") {
    throw new Error("A fetch implementation is required");
  }
  return resolved;
}

async function responseError(response: Response): Promise<InboxletError> {
  let body: ApiErrorBody = {};

  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    // A proxy or upstream may return a non-JSON error response.
  }

  return new InboxletError(body.error?.message ?? `Inboxlet request failed (${response.status})`, {
    code: body.error?.code ?? "HTTP_ERROR",
    status: response.status,
  });
}

export class Inbox {
  readonly id: string;
  readonly address: string;
  readonly token: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly endpoint: string;

  private readonly fetchImplementation: typeof globalThis.fetch;
  private cursor = 0;

  private constructor(credentials: InboxCredentials, options: InboxClientOptions = {}) {
    this.id = credentials.id;
    this.address = credentials.address;
    this.token = credentials.token;
    this.createdAt = credentials.createdAt;
    this.expiresAt = credentials.expiresAt;
    this.endpoint = normalizeEndpoint(options.endpoint ?? credentials.endpoint);
    this.fetchImplementation = getFetch(options.fetch);
  }

  static async create(options: CreateInboxOptions = {}): Promise<Inbox> {
    const endpointValue = options.endpoint ?? defaultConfiguration?.endpoint;
    const apiKey = options.apiKey ?? defaultConfiguration?.apiKey;
    if (!endpointValue || !apiKey) {
      throw new Error(
        "Inboxlet is not configured. Call Inbox.configure({ endpoint, apiKey }) or pass both to Inbox.create()",
      );
    }
    const endpoint = normalizeEndpoint(endpointValue);
    const fetchImplementation = getFetch(options.fetch);
    const body: Record<string, number> = {};

    if (options.ttl !== undefined) {
      body.ttlSeconds = durationToSeconds(options.ttl);
    }
    if (options.maxMessages !== undefined) {
      body.maxMessages = options.maxMessages;
    }

    const headers = new Headers({
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    });

    const response = await fetchImplementation(endpointUrl(endpoint, "v1/inboxes"), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    });
    if (!response.ok) {
      throw await responseError(response);
    }

    const created = (await response.json()) as CreateResponse;
    return new Inbox(
      {
        id: created.id,
        address: created.address,
        token: created.token,
        createdAt: created.createdAt,
        expiresAt: created.expiresAt,
        endpoint,
      },
      { fetch: fetchImplementation },
    );
  }

  static from(credentials: InboxCredentials, options: InboxClientOptions = {}): Inbox {
    return new Inbox(credentials, options);
  }

  static configure(configuration: InboxletConfiguration): void {
    if (!configuration.apiKey) {
      throw new Error("Inboxlet API key cannot be empty");
    }
    defaultConfiguration = {
      endpoint: normalizeEndpoint(configuration.endpoint),
      apiKey: configuration.apiKey,
    };
  }

  credentials(): InboxCredentials {
    return {
      id: this.id,
      address: this.address,
      token: this.token,
      createdAt: this.createdAt,
      expiresAt: this.expiresAt,
      endpoint: this.endpoint,
    };
  }

  async status(options: { signal?: AbortSignal } = {}): Promise<InboxStatus> {
    return this.request<InboxStatus>(`v1/inboxes/${encodeURIComponent(this.id)}`, {
      signal: options.signal,
    });
  }

  async read(options: ReadInboxOptions = {}): Promise<ReadInboxResult> {
    const after = options.after ?? 0;
    const limit = options.limit ?? 50;
    const query = new URLSearchParams({ after: String(after), limit: String(limit) });

    if (options.waitSeconds !== undefined) {
      query.set("wait", String(options.waitSeconds));
    }

    const result = await this.request<ReadInboxResult>(
      `v1/inboxes/${encodeURIComponent(this.id)}/messages?${query}`,
      { signal: options.signal },
    );
    this.cursor = Math.max(this.cursor, result.nextCursor);
    return result;
  }

  async wait(options: WaitForMessageOptions = {}): Promise<InboxMessage> {
    const after = options.after ?? this.cursor;
    const timeoutSeconds =
      options.timeout === undefined ? undefined : durationToSeconds(options.timeout);
    const deadline =
      timeoutSeconds === undefined ? Number.POSITIVE_INFINITY : Date.now() + timeoutSeconds * 1000;

    while (Date.now() < deadline) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
      }

      const remainingMilliseconds = deadline - Date.now();
      const waitSeconds = Math.min(25, Math.max(1, Math.ceil(remainingMilliseconds / 1_000)));
      const requestTimeout = Number.isFinite(remainingMilliseconds)
        ? Math.max(1, Math.min(30_000, remainingMilliseconds))
        : 30_000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeout);
      const signal = options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal;
      let result: ReadInboxResult;

      try {
        result = await this.read({ after, limit: 1, waitSeconds, signal });
      } catch (error) {
        if (options.signal?.aborted) {
          throw options.signal.reason ?? error;
        }
        if (controller.signal.aborted) {
          if (Date.now() >= deadline) {
            throw new InboxletTimeoutError();
          }
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }

      const message = result.messages[0];
      if (message) {
        this.cursor = Math.max(this.cursor, message.seq);
        return message;
      }
    }

    throw new InboxletTimeoutError();
  }

  async send(
    input: SendMessageInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<InboxMessage> {
    const message = await this.request<InboxMessage>(
      `v1/inboxes/${encodeURIComponent(this.id)}/messages`,
      {
        method: "POST",
        signal: options.signal,
        headers: {
          "content-type": "application/json",
          "idempotency-key": input.idempotencyKey ?? crypto.randomUUID(),
        },
        body: JSON.stringify(input),
      },
    );
    this.cursor = Math.max(this.cursor, message.seq);
    return message;
  }

  async reply(
    message: string | Pick<InboxMessage, "id">,
    input: ReplyMessageInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<InboxMessage> {
    const messageId = typeof message === "string" ? message : message.id;
    const reply = await this.request<InboxMessage>(
      `v1/inboxes/${encodeURIComponent(this.id)}/messages/${encodeURIComponent(messageId)}/reply`,
      {
        method: "POST",
        signal: options.signal,
        headers: {
          "content-type": "application/json",
          "idempotency-key": input.idempotencyKey ?? crypto.randomUUID(),
        },
        body: JSON.stringify(input),
      },
    );
    this.cursor = Math.max(this.cursor, reply.seq);
    return reply;
  }

  async delete(options: { signal?: AbortSignal } = {}): Promise<void> {
    await this.request<{ deleted: true }>(`v1/inboxes/${encodeURIComponent(this.id)}`, {
      method: "DELETE",
      signal: options.signal,
    });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    headers.set("accept", "application/json");

    const response = await this.fetchImplementation(endpointUrl(this.endpoint, path), {
      ...init,
      headers,
    });
    if (!response.ok) {
      throw await responseError(response);
    }

    return (await response.json()) as T;
  }
}

export function inboxCredentials(
  descriptor: InboxDescriptor,
  token: string,
  endpoint: string,
): InboxCredentials {
  return { ...descriptor, token, endpoint: normalizeEndpoint(endpoint) };
}
