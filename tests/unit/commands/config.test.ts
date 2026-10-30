// `synapse config` (SYN-182): show with keys redacted, set-key with
// verification, keys/revoke against a stubbed API. HOME and cwd are
// redirected so the developer's real config is never touched.

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-config-home-"));
const TMP_GLOBAL_DIR = path.join(TMP_HOME, ".synapse");

vi.mock("../../../src/config/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/config/paths.js")>();
  return {
    ...actual,
    GLOBAL_SYNAPSE_DIR: TMP_GLOBAL_DIR,
    GLOBAL_CONFIG_PATH: path.join(TMP_GLOBAL_DIR, "config.json"),
  };
});

const prompts = vi.hoisted(() => ({
  canPrompt: true,
  secret: "",
  confirm: false,
  confirmMessages: [] as string[],
}));
vi.mock("../../../src/ui/prompt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/ui/prompt.js")>();
  return {
    ...actual,
    canPrompt: () => prompts.canPrompt,
    askSecret: async () => prompts.secret,
    askConfirm: async (o: { message: string }) => {
      prompts.confirmMessages.push(o.message);
      return prompts.confirm;
    },
  };
});

const { runConfigShow, runConfigSetKey, runConfigKeys, runConfigRevoke } = await import(
  "../../../src/commands/config.js"
);
const { resolveApiKeyWithSource, setGlobalApiKey, setProjectApiKey, loadGlobalConfig } =
  await import("../../../src/config/manager.js");

const GOOD = "syn-api-goodkey0001xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const NEW = "syn-api-newkey00002xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const OTHER_PREFIX = "syn-api-otherkey00";

const saved = {
  key: process.env.SYNAPSE_API_KEY,
  api: process.env.SYNAPSE_API_URL,
  telemetry: process.env.SYNAPSE_TELEMETRY,
};
const dirs: string[] = [];
let cwd: string;
let printed: string[];
let requests: Array<{ method: string; url: string; auth: string }>;
let deleted: string[];

/** Stub the API: /quota accepts `validKeys`; /api-keys lists two keys. */
function stubApi(opts: { validKeys?: string[]; quotaDown?: boolean } = {}): void {
  requests = [];
  deleted = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const auth = ((init.headers ?? {}) as Record<string, string>).Authorization ?? "";
      const method = init.method ?? "GET";
      requests.push({ method, url: String(url), auth });
      const bearer = auth.replace(/^Bearer /, "");
      if (String(url).endsWith("/quota")) {
        if (opts.quotaDown) throw new TypeError("fetch failed");
        return new Response("{}", { status: (opts.validKeys ?? [GOOD, NEW]).includes(bearer) ? 200 : 401 });
      }
      if (String(url).endsWith("/api-keys") && method === "GET") {
        return new Response(
          JSON.stringify({
            api_keys: [
              { id: "id-good", key_prefix: GOOD.slice(0, 18), name: "laptop", created_at: "2026-10-01T00:00:00" },
              { id: "id-other", key_prefix: OTHER_PREFIX, name: "ci", created_at: "2026-10-02T00:00:00" },
            ],
          }),
          { status: 200 },
        );
      }
      const m = String(url).match(/\/api-keys\/([^/]+)$/);
      if (m && method === "DELETE") {
        deleted.push(decodeURIComponent(m[1]));
        return new Response(JSON.stringify({ message: "API key revoked successfully" }), { status: 200 });
      }
      return new Response(null, { status: 200 });
    }),
  );
}

function out(): string {
  return printed.join("\n").replace(/[│╭╮╰╯─]/g, " ").replace(/[ \t]+/g, " ");
}

function initProject(): void {
  fs.mkdirSync(path.join(cwd, ".synapse"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".synapse", "config.json"),
    JSON.stringify({ initialized: true, version: "1.0.0", mode: "hosted" }),
  );
}

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-config-proj-"));
  dirs.push(cwd);
  fs.rmSync(TMP_GLOBAL_DIR, { recursive: true, force: true });
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  printed = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  });
  delete process.env.SYNAPSE_API_KEY;
  process.env.SYNAPSE_API_URL = "https://api.example.test";
  process.env.SYNAPSE_TELEMETRY = "0";
  prompts.canPrompt = true;
  prompts.secret = "";
  prompts.confirm = false;
  prompts.confirmMessages = [];
  process.exitCode = undefined;
  stubApi();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
  for (const [k, v] of [
    ["SYNAPSE_API_KEY", saved.key],
    ["SYNAPSE_API_URL", saved.api],
    ["SYNAPSE_TELEMETRY", saved.telemetry],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

afterAll(() => {
  for (const d of [...dirs, TMP_HOME]) fs.rmSync(d, { recursive: true, force: true });
});

describe("synapse config (show)", () => {
  it("works outside an initialized project and never prints the key", () => {
    setGlobalApiKey(GOOD);
    runConfigShow();
    const o = out();
    expect(o).toMatch(/syn-a\*+/);
    expect(o).toMatch(/global config/);
    expect(o).toMatch(/Initialized No/);
    expect(o).toMatch(/https:\/\/api\.example\.test/);
    expect(o).toMatch(/synapse model set/);
    expect(printed.join("\n")).not.toContain(GOOD);
    expect(fs.existsSync(path.join(cwd, ".synapse"))).toBe(false);
  });

  it("names SYNAPSE_API_KEY as the key in use when it overrides a saved key", () => {
    setGlobalApiKey(GOOD);
    process.env.SYNAPSE_API_KEY = NEW;
    runConfigShow();
    expect(out()).toMatch(/SYNAPSE_API_KEY environment variable/);
    expect(out()).toMatch(/saved keys are ignored/);
    expect(printed.join("\n")).not.toContain(NEW);
  });
});

describe("synapse config set-key", () => {
  it("verifies, then saves the key globally without creating a project", async () => {
    await runConfigSetKey({ key: GOOD });
    expect(requests.some((r) => r.url.endsWith("/quota") && r.auth === `Bearer ${GOOD}`)).toBe(true);
    expect(resolveApiKeyWithSource(cwd)).toEqual({ key: GOOD, source: "global" });
    expect(fs.existsSync(path.join(cwd, ".synapse"))).toBe(false);
    expect(out()).toMatch(/API key verified/);
    expect(process.exitCode).toBeUndefined();
  });

  it("refuses a key the backend rejects and keeps the current one", async () => {
    setGlobalApiKey(GOOD);
    await runConfigSetKey({ key: "syn-api-rejected" });
    expect(out()).toMatch(/API Key Rejected/);
    expect(resolveApiKeyWithSource(cwd)?.key).toBe(GOOD);
    expect(process.exitCode).toBe(1);
  });

  it("saves with a warning when the backend can't be reached", async () => {
    stubApi({ quotaDown: true });
    await runConfigSetKey({ key: NEW });
    expect(out()).toMatch(/Couldn't reach Synapse/);
    expect(resolveApiKeyWithSource(cwd)?.key).toBe(NEW);
  }, 20_000);

  it("rotates this project's saved key too, so the old one doesn't shadow it", async () => {
    initProject();
    setProjectApiKey(cwd, GOOD);
    setGlobalApiKey(GOOD);
    await runConfigSetKey({ key: NEW });
    expect(resolveApiKeyWithSource(cwd)).toEqual({ key: NEW, source: "project" });
    expect(loadGlobalConfig().api_key_prefix).toBe(NEW.slice(0, 5));
    expect(out()).toMatch(/saved for this project and globally/);
  });

  it("--global leaves the project key alone and says it still wins here", async () => {
    initProject();
    setProjectApiKey(cwd, GOOD);
    await runConfigSetKey({ key: NEW, globalScope: true });
    expect(resolveApiKeyWithSource(cwd)).toEqual({ key: GOOD, source: "project" });
    expect(resolveApiKeyWithSource(undefined)).toEqual({ key: NEW, source: "global" });
    expect(out()).toMatch(/own saved key/);
  });

  it("prompts for the key when none is given", async () => {
    prompts.secret = `  ${NEW}  `;
    await runConfigSetKey({});
    expect(resolveApiKeyWithSource(cwd)?.key).toBe(NEW);
  });

  it("fails without a key when it can't prompt", async () => {
    prompts.canPrompt = false;
    await runConfigSetKey({});
    expect(out()).toMatch(/Missing API Key/);
    expect(process.exitCode).toBe(1);
    expect(fs.existsSync(path.join(TMP_GLOBAL_DIR, "config.json"))).toBe(false);
  });

  it("warns that SYNAPSE_API_KEY overrides the saved key", async () => {
    process.env.SYNAPSE_API_KEY = GOOD;
    await runConfigSetKey({ key: NEW });
    expect(out()).toMatch(/SYNAPSE_API_KEY is set and overrides saved keys/);
  });
});

describe("synapse config keys", () => {
  it("lists the account's keys and marks the one in use", async () => {
    setGlobalApiKey(GOOD);
    await runConfigKeys();
    const o = out();
    expect(o).toMatch(/id-good/);
    expect(o).toMatch(/id-other/);
    expect(o).toMatch(/laptop \(in use\)/);
    expect(printed.join("\n")).not.toContain(GOOD);
  });

  it("fails clearly with no key configured", async () => {
    await runConfigKeys();
    expect(out()).toMatch(/No API Key/);
    expect(process.exitCode).toBe(1);
    expect(requests).toHaveLength(0);
  });
});

describe("synapse config revoke", () => {
  beforeEach(() => setGlobalApiKey(GOOD));

  it("revokes another key after confirmation", async () => {
    prompts.confirm = true;
    await runConfigRevoke("id-other", {});
    expect(deleted).toEqual(["id-other"]);
    expect(prompts.confirmMessages[0]).toMatch(/Revoke "ci"/);
    expect(out()).toMatch(/Revoked "ci"/);
  });

  it("does nothing when the prompt is declined", async () => {
    prompts.confirm = false;
    await runConfigRevoke("id-other", {});
    expect(deleted).toEqual([]);
    expect(out()).toMatch(/Nothing was revoked/);
  });

  it("warns before and after revoking the key in use", async () => {
    prompts.confirm = true;
    await runConfigRevoke("id-good", {});
    expect(prompts.confirmMessages[0]).toMatch(/key this CLI uses/);
    expect(deleted).toEqual(["id-good"]);
    expect(out()).toMatch(/That was the key in use/);
  });

  it("--yes skips the prompt", async () => {
    await runConfigRevoke("id-other", { yes: true });
    expect(prompts.confirmMessages).toEqual([]);
    expect(deleted).toEqual(["id-other"]);
  });

  it("needs --yes when it can't prompt", async () => {
    prompts.canPrompt = false;
    await runConfigRevoke("id-other", {});
    expect(deleted).toEqual([]);
    expect(out()).toMatch(/--yes/);
    expect(process.exitCode).toBe(1);
  });

  it("rejects an id that isn't an active key on the account", async () => {
    await runConfigRevoke("nope", { yes: true });
    expect(deleted).toEqual([]);
    expect(out()).toMatch(/Key Not Found/);
    expect(process.exitCode).toBe(1);
  });
});
