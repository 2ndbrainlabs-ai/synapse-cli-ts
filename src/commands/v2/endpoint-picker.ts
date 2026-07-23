// src/commands/v2/endpoint-picker.ts
//
// Checkbox picker for extracted HTTP endpoints in Auto mode.
// Groups by handler_module so the user can toggle whole route files.

import { checkbox } from "@inquirer/prompts";
import type { HttpEndpoint } from "../../extractors/core/surface-manifest.js";

export async function pickEndpoints(
  endpoints: HttpEndpoint[],
): Promise<HttpEndpoint[]> {
  if (endpoints.length === 0) return [];

  const choices = endpoints.map((e, idx) => ({
    name: `${e.method.padEnd(6)} ${e.path.padEnd(38)} → ${e.suggested_tool_name}`,
    value: idx,
    checked: true, // default: all selected
  }));

  const chosen = await checkbox<number>({
    message: `Select the endpoints to expose as MCP tools (${endpoints.length} detected):`,
    choices,
    pageSize: 15,
    loop: false,
  });

  return chosen.map((i) => endpoints[i]);
}
