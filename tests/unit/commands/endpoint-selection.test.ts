// `build --auto` endpoint selection without a terminal (SYN-314).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { HttpEndpoint } from "../../../src/extractors/core/surface-manifest.js";
import { matchEndpoints, selectEndpoints } from "../../../src/commands/v2/endpoint-picker.js";
import { BuildFailure } from "../../../src/commands/v2/build-outcome.js";

function ep(method: HttpEndpoint["method"], path: string, tool: string): HttpEndpoint {
  return {
    method,
    path,
    handler_module: "app.main",
    handler_qualname: tool,
    description: "",
    payload_example: null,
    headers_hint: [],
    suggested_tool_name: tool,
    file_path: "app/main.py",
    start_line: 1,
    end_line: 2,
  };
}

const ENDPOINTS = [
  ep("GET", "/patients", "list_patients"),
  ep("POST", "/patients", "create_patient"),
  ep("GET", "/patients/{id}", "get_patient"),
  ep("DELETE", "/patients/{id}", "delete_patient"),
];

describe("matchEndpoints", () => {
  it("matches method + path, case-insensitively on the method", () => {
    const { selected, unmatched } = matchEndpoints(ENDPOINTS, "get /patients, POST  /patients");
    expect(selected.map((e) => e.suggested_tool_name)).toEqual(["list_patients", "create_patient"]);
    expect(unmatched).toEqual([]);
  });

  it("matches a bare path across methods, and tool names", () => {
    const { selected } = matchEndpoints(ENDPOINTS, "/patients/{id},list_patients");
    expect(selected.map((e) => e.suggested_tool_name)).toEqual([
      "list_patients",
      "get_patient",
      "delete_patient",
    ]);
  });

  it("reports entries that match nothing and drops duplicates", () => {
    const { selected, unmatched } = matchEndpoints(ENDPOINTS, "list_patients,GET /patients,/nope");
    expect(selected).toHaveLength(1);
    expect(unmatched).toEqual(["/nope"]);
  });
});

describe("selectEndpoints", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.SYNAPSE_NON_INTERACTIVE;
    process.env.SYNAPSE_NON_INTERACTIVE = "1";
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (saved === undefined) delete process.env.SYNAPSE_NON_INTERACTIVE;
    else process.env.SYNAPSE_NON_INTERACTIVE = saved;
  });

  it("--all-endpoints selects everything without prompting", async () => {
    await expect(selectEndpoints(ENDPOINTS, { allEndpoints: true })).resolves.toHaveLength(4);
  });

  it("--endpoints selects the listed endpoints", async () => {
    const got = await selectEndpoints(ENDPOINTS, { endpoints: "DELETE /patients/{id}" });
    expect(got.map((e) => e.suggested_tool_name)).toEqual(["delete_patient"]);
  });

  it("fails when an --endpoints entry matches nothing", async () => {
    await expect(selectEndpoints(ENDPOINTS, { endpoints: "GET /nope" })).rejects.toMatchObject({
      code: "ENDPOINTS_NOT_MATCHED",
    });
  });

  it("fails on both flags at once", async () => {
    await expect(
      selectEndpoints(ENDPOINTS, { allEndpoints: true, endpoints: "/patients" }),
    ).rejects.toBeInstanceOf(BuildFailure);
  });

  it("fails without a terminal and without a flag instead of selecting nothing", async () => {
    await expect(selectEndpoints(ENDPOINTS, {})).rejects.toMatchObject({
      code: "ENDPOINT_SELECTION_REQUIRED",
    });
    const printed = (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
    expect(printed).toMatch(/--all-endpoints/);
  });
});
