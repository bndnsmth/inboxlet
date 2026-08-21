import { convert } from "html-to-text";

export function htmlToPlainText(html: string): string {
  return convert(html, {
    wordwrap: 100,
    selectors: [
      {
        selector: "a",
        options: { hideLinkHrefIfSameAsText: true },
      },
    ],
  }).trim();
}
