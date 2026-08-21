const encoder = new TextEncoder();

export async function sha256(value: string | ArrayBuffer): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", typeof value === "string" ? encoder.encode(value) : value);
}

export function base64Url(value: ArrayBuffer | Uint8Array): string {
  let binary = "";
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function secureTokenEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([sha256(left), sha256(right)]);
  return secureDigestEqual(leftDigest, rightDigest);
}

export function secureDigestEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return difference === 0;
}
