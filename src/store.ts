import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { InboxCredentials, InboxletConfiguration } from "./types";

interface InboxStoreData {
  version: 1;
  defaultInbox?: string;
  inboxes: Record<string, InboxCredentials>;
}

interface ConfigurationData extends InboxletConfiguration {
  version: 1;
}

const DATA_HOME = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
const CONFIG_HOME = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
export const INBOX_STORE_PATH = join(DATA_HOME, "inboxlet", "inboxes.json");
export const CONFIG_PATH = join(CONFIG_HOME, "inboxlet", "config.json");

function emptyStore(): InboxStoreData {
  return { version: 1, inboxes: {} };
}

function isCredentials(value: unknown): value is InboxCredentials {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<InboxCredentials>;
  return [
    candidate.id,
    candidate.address,
    candidate.token,
    candidate.createdAt,
    candidate.expiresAt,
    candidate.endpoint,
  ].every((field) => typeof field === "string" && field.length > 0);
}

function isConfiguration(value: unknown): value is InboxletConfiguration {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<InboxletConfiguration>;
  return Boolean(candidate.endpoint && candidate.apiKey);
}

function isExpired(credentials: InboxCredentials): boolean {
  const expiresAt = Date.parse(credentials.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now();
}

function newestActiveInbox(inboxes: Iterable<InboxCredentials>): InboxCredentials | undefined {
  return [...inboxes]
    .filter((inbox) => !isExpired(inbox))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

async function readInboxStore(): Promise<InboxStoreData> {
  try {
    const parsed = JSON.parse(await readFile(INBOX_STORE_PATH, "utf8")) as Partial<InboxStoreData>;
    if (parsed.version !== 1 || !parsed.inboxes || typeof parsed.inboxes !== "object") {
      throw new Error("unsupported data format");
    }

    const inboxes = Object.fromEntries(
      Object.entries(parsed.inboxes).filter((entry) => isCredentials(entry[1])),
    );
    return {
      version: 1,
      inboxes,
      ...(parsed.defaultInbox && inboxes[parsed.defaultInbox]
        ? { defaultInbox: parsed.defaultInbox }
        : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyStore();
    }
    throw new Error(
      `Could not read ${INBOX_STORE_PATH}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

async function withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = join(dirname(path), ".write-lock");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 5_000;

  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      try {
        const lock = await stat(lockPath);
        if (Date.now() - lock.mtimeMs > 30_000) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw lockError;
        }
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting to update ${path}`);
      }
      await delay(25);
    }
  }

  try {
    return await operation();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

export async function saveInbox(credentials: InboxCredentials): Promise<void> {
  await withFileLock(INBOX_STORE_PATH, async () => {
    const store = await readInboxStore();
    store.inboxes[credentials.id] = credentials;
    store.defaultInbox = credentials.id;
    await writeJson(INBOX_STORE_PATH, store);
  });
}

export async function saveConfiguration(configuration: InboxletConfiguration): Promise<void> {
  await withFileLock(CONFIG_PATH, async () => {
    await writeJson(CONFIG_PATH, { version: 1, ...configuration } satisfies ConfigurationData);
  });
}

export async function getConfiguration(): Promise<InboxletConfiguration> {
  try {
    const configuration = JSON.parse(
      await readFile(CONFIG_PATH, "utf8"),
    ) as Partial<ConfigurationData>;
    if (configuration.version !== 1 || !isConfiguration(configuration)) {
      throw new Error("unsupported data format");
    }
    return { endpoint: configuration.endpoint, apiKey: configuration.apiKey };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `Could not read ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw new Error(
      "Inboxlet is not configured. Run 'inboxlet config --endpoint <url> --api-key <key>'",
    );
  }
}

export async function listInboxes(): Promise<InboxCredentials[]> {
  const store = await readInboxStore();
  return Object.values(store.inboxes)
    .filter((inbox) => !isExpired(inbox))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function resolveInbox(reference?: string): Promise<InboxCredentials> {
  const store = await readInboxStore();
  const normalized = reference?.trim().toLowerCase();
  if (!normalized) {
    const fallback = store.defaultInbox ? store.inboxes[store.defaultInbox] : undefined;
    if (fallback && !isExpired(fallback)) {
      return fallback;
    }
    const activeInbox = newestActiveInbox(Object.values(store.inboxes));
    if (activeInbox) {
      return activeInbox;
    }
    throw new Error("No saved inbox. Run 'inboxlet create' first or pass --inbox");
  }

  const direct = store.inboxes[normalized];
  if (direct) {
    return direct;
  }
  const matches = Object.values(store.inboxes).filter(
    (inbox) => inbox.address.toLowerCase() === normalized || inbox.id.startsWith(normalized),
  );
  if (matches.length === 1 && matches[0]) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new Error(`Inbox reference '${reference}' is ambiguous`);
  }
  throw new Error(`Inbox '${reference}' is not saved in ${INBOX_STORE_PATH}`);
}

export async function forgetInbox(inboxId: string): Promise<void> {
  await withFileLock(INBOX_STORE_PATH, async () => {
    const store = await readInboxStore();
    delete store.inboxes[inboxId];
    if (store.defaultInbox === inboxId) {
      store.defaultInbox = newestActiveInbox(Object.values(store.inboxes))?.id;
    }
    await writeJson(INBOX_STORE_PATH, store);
  });
}
