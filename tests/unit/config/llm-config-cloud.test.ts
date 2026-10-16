// Resolution for the cloud providers (Bedrock, Vertex AI): region / project /
// profile precedence, Bedrock's geography-prefixed defaults, and the guarantee
// that no Synapse-stored key is ever involved.

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-llm-cloud-home-"));
const TMP_GLOBAL_DIR = path.join(TMP_HOME, ".synapse");
const TMP_GLOBAL_CONFIG = path.join(TMP_GLOBAL_DIR, "config.json");

vi.mock("../../../src/config/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/config/paths.js")>();
  return { ...actual, GLOBAL_SYNAPSE_DIR: TMP_GLOBAL_DIR, GLOBAL_CONFIG_PATH: TMP_GLOBAL_CONFIG };
});

const { resolveLlm, bedrockGeo, LlmSettingsSchema, llmKeyDisplay } = await import(
  "../../../src/config/llm-config.js"
);

const ENV = [
  "SYNAPSE_LLM_PROVIDER", "SYNAPSE_LLM_MODEL", "SYNAPSE_LLM_REGION", "SYNAPSE_LLM_PROJECT",
  "SYNAPSE_LLM_API_KEY", "AWS_REGION", "AWS_DEFAULT_REGION", "GOOGLE_CLOUD_PROJECT",
  "ANTHROPIC_VERTEX_PROJECT_ID", "GCLOUD_PROJECT", "CLOUDSDK_CORE_PROJECT",
  "GOOGLE_CLOUD_LOCATION", "CLOUD_ML_REGION", "VERTEX_LOCATION",
];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const tmpDirs: string[] = [];

function makeProject(llm?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-llm-cloud-proj-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, ".synapse"));
  fs.writeFileSync(
    path.join(dir, ".synapse", "config.json"),
    JSON.stringify({ initialized: true, version: "1.0.0", ...(llm ? { llm } : {}) }),
  );
  return dir;
}

beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  fs.rmSync(TMP_GLOBAL_CONFIG, { force: true });
});

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("Bedrock", () => {
  it("is ready with no key — credentials come from the AWS chain", () => {
    const r = resolveLlm(makeProject({ provider: "bedrock" }));
    expect(r.problems).toEqual([]);
    expect(r.apiKey).toBeNull();
    expect(r.region).toBe("us-east-1");
    expect(llmKeyDisplay(r)).toMatch(/AWS credential chain/);
  });

  it("ignores SYNAPSE_LLM_API_KEY rather than pretending it's an AWS credential", () => {
    process.env.SYNAPSE_LLM_API_KEY = "not-aws";
    expect(resolveLlm(makeProject({ provider: "bedrock" })).apiKey).toBeNull();
  });

  it("derives the inference-profile geography from the region", () => {
    expect(resolveLlm(makeProject({ provider: "bedrock" })).models.generate).toBe(
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    );
    expect(resolveLlm(makeProject({ provider: "bedrock", region: "eu-west-1" })).models.triage).toBe(
      "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
    );
    expect(bedrockGeo("ap-southeast-2")).toBe("apac");
    expect(bedrockGeo("us-gov-west-1")).toBe("us-gov");
    expect(bedrockGeo("ca-central-1")).toBe("us");
    expect(bedrockGeo("sa-east-1")).toBe("global");
  });

  it("an explicit model id is used verbatim, with no geography substitution", () => {
    const r = resolveLlm(makeProject({ provider: "bedrock", region: "eu-west-1" }), {
      model: "us.amazon.nova-pro-v1:0",
    });
    expect(r.models.generate).toBe("us.amazon.nova-pro-v1:0");
  });

  it("region precedence: flag > SYNAPSE_LLM_REGION > stored > AWS_REGION > default", () => {
    const dir = makeProject({ provider: "bedrock", region: "eu-central-1" });
    process.env.AWS_REGION = "ap-south-1";
    expect(resolveLlm(dir).region).toBe("eu-central-1");
    process.env.SYNAPSE_LLM_REGION = "us-west-2";
    expect(resolveLlm(dir).region).toBe("us-west-2");
    expect(resolveLlm(dir, { region: "eu-west-3" }).region).toBe("eu-west-3");
    expect(resolveLlm(makeProject({ provider: "bedrock" }), {}).region).toBe("us-west-2");
    delete process.env.SYNAPSE_LLM_REGION;
    expect(resolveLlm(makeProject({ provider: "bedrock" })).region).toBe("ap-south-1");
  });

  it("carries a stored AWS profile, and a flag overrides it", () => {
    const dir = makeProject({ provider: "bedrock", aws_profile: "work" });
    expect(resolveLlm(dir).profile).toBe("work");
    expect(resolveLlm(dir, { profile: "other" }).profile).toBe("other");
    expect(llmKeyDisplay(resolveLlm(dir))).toContain('profile "work"');
  });

  it("never reports a base URL", () => {
    expect(resolveLlm(makeProject({ provider: "bedrock" })).baseUrl).toBeNull();
  });
});

describe("Vertex AI", () => {
  it("needs a project and says how to set it", () => {
    const r = resolveLlm(makeProject({ provider: "vertex" }));
    expect(r.problems.join(" ")).toMatch(/GCP project.*GOOGLE_CLOUD_PROJECT/);
  });

  it("is ready with a project from env, defaulting to the global location", () => {
    process.env.GOOGLE_CLOUD_PROJECT = "env-proj";
    const r = resolveLlm(makeProject({ provider: "vertex" }));
    expect(r.problems).toEqual([]);
    expect(r.project).toBe("env-proj");
    expect(r.region).toBe("global");
    expect(r.models.generate).toBe("claude-sonnet-4-5@20250929");
    expect(llmKeyDisplay(r)).toMatch(/Application Default Credentials/);
  });

  it("project precedence: flag > SYNAPSE_LLM_PROJECT > stored > GOOGLE_CLOUD_PROJECT", () => {
    process.env.GOOGLE_CLOUD_PROJECT = "env-proj";
    const dir = makeProject({ provider: "vertex", project: "stored-proj" });
    expect(resolveLlm(dir).project).toBe("stored-proj");
    process.env.SYNAPSE_LLM_PROJECT = "synapse-env-proj";
    expect(resolveLlm(dir).project).toBe("synapse-env-proj");
    expect(resolveLlm(dir, { project: "flag-proj" }).project).toBe("flag-proj");
  });

  it("reads the location from GOOGLE_CLOUD_LOCATION", () => {
    process.env.GOOGLE_CLOUD_PROJECT = "p";
    process.env.GOOGLE_CLOUD_LOCATION = "europe-west1";
    expect(resolveLlm(makeProject({ provider: "vertex" })).region).toBe("europe-west1");
  });

  it("does not ask non-cloud providers for a region or project", () => {
    process.env.GOOGLE_CLOUD_PROJECT = "p";
    const r = resolveLlm(makeProject({ provider: "groq" }));
    expect(r.region).toBeNull();
    expect(r.project).toBeNull();
  });
});

describe("schema", () => {
  it("accepts region, project and aws_profile", () => {
    expect(
      LlmSettingsSchema.safeParse({ provider: "vertex", region: "us-east5", project: "p" }).success,
    ).toBe(true);
    expect(LlmSettingsSchema.safeParse({ provider: "bedrock", aws_profile: "work" }).success).toBe(true);
  });
});
