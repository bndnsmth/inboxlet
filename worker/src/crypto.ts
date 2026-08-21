const encoder = new TextEncoder();

export async function sha256(value: string | ArrayBuffer): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", typeof value === "string" ? encoder.encode(value) : value);
}

export function digestBase64Url(digest: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(digest)) {
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
  let difference = leftBytes.byteLength ^ rightBytes.byteLength;
  const length = Math.max(leftBytes.byteLength, rightBytes.byteLength);

  for (let index = 0; index < length; index += 1) {
    difference |=
      (leftBytes[index % leftBytes.byteLength] ?? 0) ^
      (rightBytes[index % rightBytes.byteLength] ?? 0);
  }

  return difference === 0;
}
