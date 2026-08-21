const API_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "content-type",
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
} as const;

export class RequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "RequestError";
    this.code = code;
    this.status = status;
  }
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: API_HEADERS });
}

export function apiError(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}

export function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-headers": "authorization,content-type,idempotency-key",
      "access-control-allow-methods": "DELETE,GET,OPTIONS,POST",
      "access-control-allow-origin": "*",
      "access-control-max-age": "86400",
    },
  });
}

export function bearer(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

export async function readJsonRecord(
  request: Request,
  maxBytes = 64 * 1024,
): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RequestError("PAYLOAD_TOO_LARGE", `JSON body exceeds ${maxBytes} bytes`, 413);
  }

  if (!request.body) {
    return {};
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      total += value.byteLength;
      if (total > maxBytes) {
        throw new RequestError("PAYLOAD_TOO_LARGE", `JSON body exceeds ${maxBytes} bytes`, 413);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new RequestError("INVALID_JSON", "JSON body must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RequestError) {
      throw error;
    }
    throw new RequestError("INVALID_JSON", "Request body is not valid JSON");
  }
}

export function integer(
  value: unknown,
  name: string,
  options: { min: number; max: number; fallback: number },
): number {
  const resolved = value === undefined ? options.fallback : value;
  if (
    !Number.isSafeInteger(resolved) ||
    (resolved as number) < options.min ||
    (resolved as number) > options.max
  ) {
    throw new RequestError(
      "INVALID_ARGUMENT",
      `${name} must be an integer from ${options.min} to ${options.max}`,
    );
  }
  return resolved as number;
}

export function stringField(
  value: unknown,
  name: string,
  options: { min?: number; max: number; optional?: boolean } = { max: 1_000 },
): string {
  if (value === undefined && options.optional) {
    return "";
  }
  if (typeof value !== "string") {
    throw new RequestError("INVALID_ARGUMENT", `${name} must be a string`);
  }

  const normalized = value.trim();
  if (normalized.length < (options.min ?? 0) || normalized.length > options.max) {
    throw new RequestError(
      "INVALID_ARGUMENT",
      `${name} must be between ${options.min ?? 0} and ${options.max} characters`,
    );
  }
  return normalized;
}

export function validEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
}

export function requireEmail(value: unknown, name: string): string {
  const email = stringField(value, name, { min: 3, max: 254 }).toLowerCase();
  if (!validEmail(email)) {
    throw new RequestError("INVALID_ARGUMENT", `${name} must be a valid email address`);
  }
  return email;
}

export function idempotencyKey(request: Request): string {
  return validateIdempotencyKey(request.headers.get("idempotency-key") ?? undefined);
}

export function validateIdempotencyKey(input?: string): string {
  const value = input?.trim() || crypto.randomUUID();
  if (!/^[\x21-\x7e]{1,128}$/.test(value)) {
    throw new RequestError(
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must contain 1 to 128 visible ASCII characters",
    );
  }
  return value;
}
