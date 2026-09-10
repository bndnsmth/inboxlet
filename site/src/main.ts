import "./style.css";

const snippets = {
  cli: {
    language: "shell",
    value: `npm install -g inboxlet

inboxlet config \\
  --endpoint https://your-inboxlet.workers.dev \\
  --api-key "$INBOXLET_API_KEY"

inboxlet create --ttl 1h
# Use the returned address in your workflow.
inboxlet read --wait 5m`,
  },
  typescript: {
    language: "typescript",
    value: `import { Inbox } from "inboxlet";

Inbox.configure({
  endpoint: "https://your-inboxlet.workers.dev",
  apiKey: process.env.INBOXLET_API_KEY!,
});

const inbox = await Inbox.create({ ttl: "1h" });
// Use this address in your sign-up or test flow.
console.log(inbox.address);
const message = await inbox.wait({ timeout: "5m" });
console.log(message);`,
  },
  mcp: {
    language: "opencode.jsonc",
    value: `{
  "mcp": {
    "inboxlet": {
      "type": "remote",
      "url": "https://your-inboxlet.workers.dev/mcp",
      "oauth": false,
      "headers": {
        "Authorization": "Bearer {env:INBOXLET_API_KEY}"
      }
    }
  }
}`,
  },
} as const;

type SnippetName = keyof typeof snippets;

const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".code-tab"));
const codeWindow = document.querySelector<HTMLElement>(".code-window");
const code = codeWindow?.querySelector<HTMLElement>("code");
const language = codeWindow?.querySelector<HTMLElement>(".code-language");
const copyButton = codeWindow?.querySelector<HTMLButtonElement>(".copy-button");

function showSnippet(name: SnippetName): void {
  const snippet = snippets[name];
  if (!codeWindow || !code || !language) return;

  codeWindow.classList.remove("is-switching");
  void codeWindow.offsetWidth;
  code.textContent = snippet.value;
  language.textContent = snippet.language;
  codeWindow.classList.add("is-switching");

  for (const tab of tabs) {
    const selected = tab.dataset.code === name;
    tab.classList.toggle("is-active", selected);
    tab.setAttribute("aria-selected", String(selected));
    if (selected) codeWindow.setAttribute("aria-labelledby", tab.id);
  }
}

for (const tab of tabs) {
  tab.addEventListener("click", () => showSnippet(tab.dataset.code as SnippetName));
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const currentIndex = tabs.indexOf(tab);
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const nextTab = tabs[(currentIndex + direction + tabs.length) % tabs.length];
    nextTab?.focus();
    nextTab?.click();
  });
}

copyButton?.addEventListener("click", async () => {
  if (!code || !copyButton) return;
  await navigator.clipboard.writeText(code.textContent ?? "");
  copyButton.textContent = "Copied";
  copyButton.classList.add("is-copied");
  window.setTimeout(() => {
    copyButton.textContent = "Copy";
    copyButton.classList.remove("is-copied");
  }, 1600);
});

const revealObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        revealObserver.unobserve(entry.target);
      }
    }
  },
  { threshold: 0.14 },
);

for (const element of document.querySelectorAll(".reveal")) revealObserver.observe(element);

const mascotWrap = document.querySelector<HTMLElement>(".mascot-wrap");
if (mascotWrap && window.matchMedia("(pointer: fine)").matches) {
  window.addEventListener("pointermove", (event) => {
    const x = (event.clientX / window.innerWidth - 0.5) * 8;
    const y = (event.clientY / window.innerHeight - 0.5) * 8;
    mascotWrap.style.setProperty("--pointer-x", `${x}px`);
    mascotWrap.style.setProperty("--pointer-y", `${y}px`);
  });
}

document.querySelector<HTMLElement>("#year")!.textContent = String(new Date().getFullYear());
showSnippet("cli");
