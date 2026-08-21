import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { htmlToPlainText } from "../worker/src/body";

test("generates a readable plain-text fallback from HTML", () => {
  const text = htmlToPlainText(`
    <html>
      <head><style>p { color: red }</style></head>
      <body>
        <h1>Hello agent</h1>
        <p>Visit <a href="https://example.com/docs">the docs</a>.</p>
        <script>stealSecrets()</script>
      </body>
    </html>
  `);

  assert.match(text, /hello agent/i);
  assert.match(text, /the docs \[https:\/\/example\.com\/docs\]/i);
  assert.doesNotMatch(text, /color: red|stealSecrets/);
});
