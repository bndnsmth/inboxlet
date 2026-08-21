import { readFile } from "node:fs/promises";
import packageMetadata from "../package.json" with { type: "json" };
import { Inbox, InboxletError } from "./client";
import { durationToSeconds } from "./duration";
import {
  forgetInbox,
  CONFIG_PATH,
  getConfiguration,
  INBOX_STORE_PATH,
  listInboxes,
  resolveInbox,
  saveConfiguration,
  saveInbox,
} from "./store";
import type { DurationInput, InboxMessage, MessageBodyInput } from "./types";

type Command =
  | "create"
  | "config"
  | "delete"
  | "help"
  | "list"
  | "read"
  | "reply"
  | "send"
  | "version";

export interface CLIOptions {
  command: Command;
  after?: number;
  apiKey?: string;
  endpoint?: string;
  html?: string;
  htmlFile?: string;
  inbox?: string;
  json?: boolean;
  limit?: number;
  maxMessages?: number;
  messageId?: string;
  subject?: string;
  text?: string;
  timeout?: string;
  to?: string;
  ttl?: string;
  yes?: boolean;
}

const HELP = `inboxlet - little inboxes for agents and automation

Usage:
  inboxlet config --endpoint https://inbox.example.com --api-key <key>
  inboxlet create [--ttl 1h] [--max-messages 100] [--json]
  inboxlet list [--json]
  inboxlet read [inbox] [--after cursor] [--limit 50] [--wait 30s] [--json]
  inboxlet send --to email --subject subject [--text body] [--html markup] [--inbox inbox] [--json]
  inboxlet reply <message-id> [--text body] [--html markup] [--inbox inbox] [--json]
  inboxlet delete [inbox] --yes

Options:
      --inbox <id|address>   Use a saved inbox (defaults to the newest)
      --endpoint <url>       Server API origin (config command)
      --api-key <key>        Server inbox-creation key (config command)
      --html <markup>        HTML message body
      --html-file <path>     Read the HTML message body from a file
      --json                 Print machine-readable output
  -h, --help                 Show help
  -v, --version              Show version

Provide --text, --html, or both. Text is generated from HTML when omitted.
Plain text can also be piped through stdin.
Server configuration is stored with mode 0600 in ${CONFIG_PATH}.
Saved inbox capabilities are stored with mode 0600 in ${INBOX_STORE_PATH}.
`;

function optionValue(args: string[], index: number, option: string): [string, number] {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return [value, index + 1];
}

export function parseArgs(argv: string[]): CLIOptions {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return { command: "help" };
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    return { command: "version" };
  }

  const command = argv[0] as Command;
  if (!["config", "create", "delete", "list", "read", "reply", "send"].includes(command)) {
    throw new Error(`Unknown command: ${argv[0]}`);
  }

  const options: CLIOptions = { command, json: false, yes: false };
  const positionals: string[] = [];

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--yes") {
      options.yes = true;
    } else if (arg === "--endpoint") {
      [options.endpoint, index] = optionValue(argv, index, arg);
    } else if (arg === "--api-key") {
      [options.apiKey, index] = optionValue(argv, index, arg);
    } else if (arg === "--inbox") {
      [options.inbox, index] = optionValue(argv, index, arg);
    } else if (arg === "--ttl") {
      [options.ttl, index] = optionValue(argv, index, arg);
    } else if (arg === "--wait") {
      [options.timeout, index] = optionValue(argv, index, arg);
    } else if (arg === "--to") {
      [options.to, index] = optionValue(argv, index, arg);
    } else if (arg === "--subject") {
      [options.subject, index] = optionValue(argv, index, arg);
    } else if (arg === "--text") {
      [options.text, index] = optionValue(argv, index, arg);
    } else if (arg === "--html") {
      [options.html, index] = optionValue(argv, index, arg);
    } else if (arg === "--html-file") {
      [options.htmlFile, index] = optionValue(argv, index, arg);
    } else if (arg === "--max-messages") {
      const [value, nextIndex] = optionValue(argv, index, arg);
      options.maxMessages = Number(value);
      index = nextIndex;
    } else if (arg === "--after") {
      const [value, nextIndex] = optionValue(argv, index, arg);
      options.after = Number(value);
      index = nextIndex;
    } else if (arg === "--limit") {
      const [value, nextIndex] = optionValue(argv, index, arg);
      options.limit = Number(value);
      index = nextIndex;
    } else if (arg?.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (arg) {
      positionals.push(arg);
    }
  }

  if ((command === "read" || command === "delete") && positionals.length <= 1) {
    if (positionals[0] && options.inbox) {
      throw new Error(`${command} accepts either a positional inbox or --inbox, not both`);
    }
    options.inbox = options.inbox ?? positionals[0];
  } else if (command === "reply" && positionals.length === 1) {
    options.messageId = positionals[0];
  } else if (positionals.length > 0) {
    throw new Error(`${command} received unexpected positional arguments`);
  }
  if (command !== "config" && (options.endpoint || options.apiKey)) {
    throw new Error("--endpoint and --api-key are only accepted by 'inboxlet config'");
  }

  return options;
}

async function messageBody(options: CLIOptions): Promise<MessageBodyInput> {
  if (options.html && options.htmlFile) {
    throw new Error("Use either --html or --html-file, not both");
  }

  const html = options.htmlFile ? await readFile(options.htmlFile, "utf8") : options.html;
  if (html !== undefined && !html.trim()) {
    throw new Error("HTML message body cannot be empty");
  }
  if (options.text !== undefined) {
    return html ? { text: options.text, html } : { text: options.text };
  }
  if (html) {
    return { html };
  }
  if (process.stdin.isTTY) {
    throw new Error("Provide --text, --html, --html-file, or piped plain text");
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    throw new Error("Message text cannot be empty");
  }
  return { text };
}

function printMessage(message: InboxMessage): void {
  console.log(`[${message.seq}] ${message.direction} ${message.status}`);
  console.log(`From: ${message.from}`);
  console.log(`To: ${message.to}`);
  console.log(`Subject: ${message.subject}`);
  console.log(`Date: ${message.createdAt}`);
  console.log(`ID: ${message.id}`);
  if (message.text) {
    console.log("");
    console.log(message.text);
  }
}

async function selectedInbox(reference?: string): Promise<Inbox> {
  return Inbox.from(await resolveInbox(reference));
}

async function create(options: CLIOptions): Promise<void> {
  if (
    options.maxMessages !== undefined &&
    (!Number.isSafeInteger(options.maxMessages) || options.maxMessages <= 0)
  ) {
    throw new Error("--max-messages must be a positive integer");
  }
  if (options.ttl) {
    durationToSeconds(options.ttl as DurationInput);
  }

  const configuration = await getConfiguration();
  const inbox = await Inbox.create({
    ...configuration,
    ...(options.ttl ? { ttl: options.ttl as DurationInput } : {}),
    ...(options.maxMessages ? { maxMessages: options.maxMessages } : {}),
  });
  await saveInbox(inbox.credentials());

  if (options.json) {
    console.log(JSON.stringify(inbox.credentials()));
  } else {
    console.log(inbox.address);
    console.error(`Saved as the default inbox until ${inbox.expiresAt}`);
  }
}

async function configure(options: CLIOptions): Promise<void> {
  if ((options.endpoint && !options.apiKey) || (!options.endpoint && options.apiKey)) {
    throw new Error("config requires both --endpoint and --api-key");
  }

  if (options.endpoint && options.apiKey) {
    const configuration = { endpoint: options.endpoint, apiKey: options.apiKey };
    Inbox.configure(configuration);
    await saveConfiguration(configuration);
  }

  const configuration = await getConfiguration();
  console.log(
    options.json
      ? JSON.stringify({ endpoint: configuration.endpoint, apiKeyConfigured: true })
      : `${configuration.endpoint}\nAPI key: configured`,
  );
}

async function list(options: CLIOptions): Promise<void> {
  const inboxes = await listInboxes();
  if (options.json) {
    console.log(JSON.stringify(inboxes.map(({ token: _, ...inbox }) => inbox)));
    return;
  }
  if (inboxes.length === 0) {
    console.log("No saved inboxes.");
    return;
  }
  for (const inbox of inboxes) {
    console.log(`${inbox.address}\t${inbox.expiresAt}`);
  }
}

async function read(options: CLIOptions): Promise<void> {
  if (options.after !== undefined && (!Number.isSafeInteger(options.after) || options.after < 0)) {
    throw new Error("--after must be a non-negative integer");
  }
  if (
    options.limit !== undefined &&
    (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100)
  ) {
    throw new Error("--limit must be an integer from 1 to 100");
  }

  const inbox = await selectedInbox(options.inbox);
  if (options.timeout) {
    const message = await inbox.wait({
      after: options.after,
      timeout: options.timeout as DurationInput,
    });
    return options.json ? console.log(JSON.stringify(message)) : printMessage(message);
  }

  const result = await inbox.read({ after: options.after, limit: options.limit });
  if (options.json) {
    console.log(JSON.stringify(result));
    return;
  }
  for (const [index, message] of result.messages.entries()) {
    if (index > 0) {
      console.log("\n---\n");
    }
    printMessage(message);
  }
}

async function send(options: CLIOptions): Promise<void> {
  if (!options.to || !options.subject) {
    throw new Error("send requires --to and --subject");
  }
  const inbox = await selectedInbox(options.inbox);
  const message = await inbox.send({
    to: options.to,
    subject: options.subject,
    ...(await messageBody(options)),
  });
  console.log(options.json ? JSON.stringify(message) : message.id);
}

async function reply(options: CLIOptions): Promise<void> {
  if (!options.messageId) {
    throw new Error("reply requires a message ID");
  }
  const inbox = await selectedInbox(options.inbox);
  const message = await inbox.reply(options.messageId, await messageBody(options));
  console.log(options.json ? JSON.stringify(message) : message.id);
}

async function remove(options: CLIOptions): Promise<void> {
  if (!options.yes) {
    throw new Error("delete permanently removes the inbox; pass --yes to confirm");
  }
  const credentials = await resolveInbox(options.inbox);
  try {
    await Inbox.from(credentials).delete();
  } catch (error) {
    if (!(error instanceof InboxletError) || error.code !== "INBOX_NOT_FOUND") {
      throw error;
    }
  }
  await forgetInbox(credentials.id);
  console.log(
    options.json ? JSON.stringify({ deleted: true, id: credentials.id }) : credentials.id,
  );
}

export async function run(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  if (options.command === "help") {
    console.log(HELP);
  } else if (options.command === "version") {
    console.log(packageMetadata.version);
  } else if (options.command === "create") {
    await create(options);
  } else if (options.command === "config") {
    await configure(options);
  } else if (options.command === "list") {
    await list(options);
  } else if (options.command === "read") {
    await read(options);
  } else if (options.command === "send") {
    await send(options);
  } else if (options.command === "reply") {
    await reply(options);
  } else if (options.command === "delete") {
    await remove(options);
  }
}
