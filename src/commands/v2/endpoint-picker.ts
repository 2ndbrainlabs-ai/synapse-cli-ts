// src/commands/v2/endpoint-picker.ts
//
// Ember endpoint picker: grouped by handler_module with visible group
// separators, HTTP verb color-coded (GET=info, POST=ok, DELETE=err, etc.),
// NONE pre-checked (safer — Enter no longer submits everything).
//
// Falls back to the plain askCheckbox behavior; the Separator API from
// @inquirer/prompts renders our group headers.

import { Separator } from "@inquirer/prompts";
import { askCheckbox } from "../../ui/prompt.js";
import { t } from "../../ui/theme.js";
import type { HttpEndpoint } from "../../extractors/core/surface-manifest.js";

const VERB_COLOR: Record<string, (s: string) => string> = {
  GET:    t.info,
  POST:   t.ok,
  PUT:    t.warn,
  PATCH:  t.warn,
  DELETE: t.err,
};

function colorVerb(method: string): string {
  const c = VERB_COLOR[method.toUpperCase()] ?? t.warm;
  return c(method.padEnd(6));
}

export async function pickEndpoints(
  endpoints: HttpEndpoint[],
): Promise<HttpEndpoint[]> {
  if (endpoints.length === 0) return [];

  // Group by handler_module so the picker reads like a small table-of-contents.
  const byModule = new Map<string, HttpEndpoint[]>();
  for (const ep of endpoints) {
    const mod = ep.handler_module || "root";
    if (!byModule.has(mod)) byModule.set(mod, []);
    byModule.get(mod)!.push(ep);
  }

  // Build inquirer choices list interleaved with Separators.
  type Choice = { name: string; value: number; checked?: boolean };
  const items: Array<Choice | InstanceType<typeof Separator>> = [];

  let flatIdx = 0;
  const flat: HttpEndpoint[] = [];
  for (const [mod, eps] of byModule) {
    items.push(new Separator(t.subtle(`── ${mod} ──`)));
    for (const ep of eps) {
      const verb = colorVerb(ep.method);
      const path = t.warm(ep.path.padEnd(36));
      const tool = t.subtle(`→ ${ep.suggested_tool_name}`);
      items.push({
        name: `${verb}${path} ${tool}`,
        value: flatIdx,
        checked: false, // Ember: no pre-check
      });
      flat.push(ep);
      flatIdx++;
    }
  }

  const chosen = await askCheckbox<number>({
    message: `Select the endpoints to expose as MCP tools (${endpoints.length} detected):`,
    choices: items as unknown as Array<{ name: string; value: number; checked?: boolean }>,
    pageSize: 15,
  });

  return chosen.map((i) => flat[i]);
}
