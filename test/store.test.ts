import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { onTestFinished, test } from "vite-plus/test";

const execFileAsync = promisify(execFile);

test("preserves concurrent credential writes from separate processes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inboxlet-store-"));
  const dataHome = join(directory, "data");
  const configHome = join(directory, "config");
  const environment = {
    ...process.env,
    XDG_DATA_HOME: dataHome,
    XDG_CONFIG_HOME: configHome,
  };
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  await Promise.all(
    Array.from({ length: 8 }, async (_, index) => {
      const id = `test-inbox-${index}`;
      const code = `
        import { saveInbox } from "./src/store.ts";
        await saveInbox({
          id: ${JSON.stringify(id)},
          address: ${JSON.stringify(`${id}@inbox.test`)},
          token: ${JSON.stringify(`token-${index}`)},
          createdAt: ${JSON.stringify(new Date(index * 1_000).toISOString())},
          expiresAt: ${JSON.stringify(new Date(60_000 + index * 1_000).toISOString())},
          endpoint: "https://inbox.test"
        });
      `;
      await execFileAsync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", code],
        {
          cwd: process.cwd(),
          env: environment,
        },
      );
    }),
  );

  const stored = JSON.parse(await readFile(join(dataHome, "inboxlet", "inboxes.json"), "utf8")) as {
    inboxes: Record<string, unknown>;
    configuration?: unknown;
  };
  assert.equal(Object.keys(stored.inboxes).length, 8);
  assert.equal(stored.configuration, undefined);

  await execFileAsync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      'import { saveConfiguration } from "./src/store.ts"; await saveConfiguration({ endpoint: "https://inbox.test", apiKey: "secret" });',
    ],
    { cwd: process.cwd(), env: environment },
  );
  const configuration = JSON.parse(
    await readFile(join(configHome, "inboxlet", "config.json"), "utf8"),
  ) as { endpoint: string; apiKey: string; inboxes?: unknown };
  assert.equal(configuration.inboxes, undefined);
  assert.deepEqual(configuration, {
    version: 1,
    endpoint: "https://inbox.test",
    apiKey: "secret",
  });
});

test("filters expired inboxes and resolves an active fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inboxlet-store-"));
  const dataHome = join(directory, "data");
  const storePath = join(dataHome, "inboxlet", "inboxes.json");
  const environment = { ...process.env, XDG_DATA_HOME: dataHome };
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(dataHome, "inboxlet"), { recursive: true });
  await writeFile(
    storePath,
    JSON.stringify({
      version: 1,
      defaultInbox: "expired",
      inboxes: {
        expired: {
          id: "expired",
          address: "expired@inbox.test",
          token: "expired-token",
          createdAt: "2026-08-20T00:00:00.000Z",
          expiresAt: "2000-01-01T00:00:00.000Z",
          endpoint: "https://inbox.test",
        },
        active: {
          id: "active",
          address: "active@inbox.test",
          token: "active-token",
          createdAt: "2026-08-19T00:00:00.000Z",
          expiresAt: "2999-01-01T00:00:00.000Z",
          endpoint: "https://inbox.test",
        },
      },
    }),
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      'import { listInboxes, resolveInbox } from "./src/store.ts"; console.log(JSON.stringify({ listed: (await listInboxes()).map(({ id }) => id), resolved: (await resolveInbox()).id }));',
    ],
    { cwd: process.cwd(), env: environment },
  );

  assert.deepEqual(JSON.parse(stdout), { listed: ["active"], resolved: "active" });
});

test("does not select an expired inbox as the default after forgetting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inboxlet-store-"));
  const dataHome = join(directory, "data");
  const storePath = join(dataHome, "inboxlet", "inboxes.json");
  const environment = { ...process.env, XDG_DATA_HOME: dataHome };
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(dataHome, "inboxlet"), { recursive: true });
  const inbox = (id: string, createdAt: string, expiresAt: string) => ({
    id,
    address: `${id}@inbox.test`,
    token: `${id}-token`,
    createdAt,
    expiresAt,
    endpoint: "https://inbox.test",
  });
  await writeFile(
    storePath,
    JSON.stringify({
      version: 1,
      defaultInbox: "removed",
      inboxes: {
        removed: inbox("removed", "2026-08-20T00:00:00.000Z", "2999-01-01T00:00:00.000Z"),
        expired: inbox("expired", "2026-08-19T00:00:00.000Z", "2000-01-01T00:00:00.000Z"),
        active: inbox("active", "2026-08-18T00:00:00.000Z", "2999-01-01T00:00:00.000Z"),
      },
    }),
  );

  await execFileAsync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      'import { forgetInbox } from "./src/store.ts"; await forgetInbox("removed");',
    ],
    { cwd: process.cwd(), env: environment },
  );

  const stored = JSON.parse(await readFile(storePath, "utf8")) as { defaultInbox?: string };
  assert.equal(stored.defaultInbox, "active");
});
