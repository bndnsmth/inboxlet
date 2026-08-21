import { htmlToPlainText } from "./body";
import { RequestError, stringField } from "./http";

export function validatedBodies(
  body: Record<string, unknown>,
  maximumBytes: number,
): { text: string; html: string } {
  const suppliedText = stringField(body.text, "text", {
    max: maximumBytes,
    optional: true,
  });
  const html = stringField(body.html, "html", { max: maximumBytes, optional: true });
  if (!suppliedText && !html) {
    throw new RequestError("INVALID_ARGUMENT", "Provide text, html, or both");
  }
  const text = suppliedText || htmlToPlainText(html);
  if (!text) {
    throw new RequestError("INVALID_ARGUMENT", "HTML body must contain readable text");
  }
  if (
    new TextEncoder().encode(text).byteLength + new TextEncoder().encode(html).byteLength >
    maximumBytes
  ) {
    throw new RequestError(
      "BODY_TOO_LARGE",
      `Combined text and HTML bodies exceed ${maximumBytes} UTF-8 bytes`,
      413,
    );
  }
  return { text, html };
}
