// src/commands/v2/endpoint-picker.ts
//
// Ember endpoint picker: grouped by handler_module with visible group
// separators, HTTP verb color-coded (GET=info, POST=ok, DELETE=err, etc.),
// NONE pre-checked (safer — Enter no longer submits everything).
//
// Falls back to the plain askCheckbox behavior; the Separator API from
// @inquirer/prompts renders our group headers.
//
// Without a terminal (CI, pipes, --yes) the picker can't be answered, so
// `--all-endpoints` / `--endpoints <list>` select endpoints instead
// (selectEndpoints). Without either flag a non-interactive run fails.

import { Separator } from "@inquirer/prompts";
import { askCheckbox, canPrompt } from "../../ui/prompt.js";
import { t } from "../../ui/theme.js";
import { roundedBox } from "../../ui/box.js";
import type { HttpEndpoint } from "../../extractors/core/surface-manifest.js";
import { BuildFailure, OUTCOME_CODES } from "./build-outcome.js";

export interface EndpointSelectionFlags {
  /** --all-endpoints: expose every detected endpoint. */
  allEndpoints?: boolean;
  /** --endpoints <list>: comma-separated "METHOD /path", "/path" or tool names. */
  endpoints?: string;
}

/** True when the user asked for a non-interactive endpoint selection. */
export function hasSelectionFlags(flags: EndpointSelectionFlags): boolean {
  return Boolean(flags.allEndpoints) || Boolean(flags.endpoints?.trim());
}

/**
 * Resolve an `--endpoints` list against the detected endpoints. Each entry
 * matches one of:
 *   - "GET /patients"   method + path (method is case-insensitive)
 *   - "/patients"       every method on that path
 *   - "list_patients"   the suggested tool name
 * Detection order is kept and duplicates are dropped.
 */
export function matchEndpoints(
  endpoints: HttpEndpoint[],
  spec: string,
): { selected: HttpEndpoint[]; unmatched: string[] } {
  const picked = new Set<number>();
  const unmatched: string[] = [];
  const tokens = spec
    .split(",")
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean);

  for (const token of tokens) {
    let hits: number[];
    const mp = /^([A-Za-z]+) (\/\S*)$/.exec(token);
    if (mp) {
      const method = mp[1].toUpperCase();
      hits = indexesWhere(endpoints, (e) => e.method.toUpperCase() === method && e.path === mp[2]);
    } else if (token.startsWith("/")) {
      hits = indexesWhere(endpoints, (e) => e.path === token);
    } else {
      const name = token.toLowerCase();
      hits = indexesWhere(endpoints, (e) => e.suggested_tool_name.toLowerCase() === name);
    }
    if (hits.length === 0) unmatched.push(token);
    for (const i of hits) picked.add(i);
  }

  return {
    selected: endpoints.filter((_, i) => picked.has(i)),
    unmatched,
  };
}

function indexesWhere(endpoints: HttpEndpoint[], pred: (e: HttpEndpoint) => boolean): number[] {
  const out: number[] = [];
  endpoints.forEach((e, i) => {
    if (pred(e)) out.push(i);
  });
  return out;
}

function endpointList(endpoints: HttpEndpoint[]): string[] {
  const shown = endpoints
    .slice(0, 12)
    .map((e) => `  ${e.method.padEnd(6)} ${e.path.padEnd(30)} ${t.subtle(e.suggested_tool_name)}`);
  if (endpoints.length > 12) shown.push(t.subtle(`  … and ${endpoints.length - 12} more`));
  return shown;
}

/**
 * Pick the endpoints to expose: from the flags when given, otherwise with
 * the interactive picker. Renders a box and throws BuildFailure when nothing
 * can be selected — so the build exits non-zero instead of "aborting" with 0.
 */
export async function selectEndpoints(
  endpoints: HttpEndpoint[],
  flags: EndpointSelectionFlags,
): Promise<HttpEndpoint[]> {
  if (flags.allEndpoints && flags.endpoints?.trim()) {
    roundedBox("Conflicting Flags", "✖", t.err, [
      `Use either ${t.cmd("--all-endpoints")} or ${t.cmd("--endpoints <list>")}, not both.`,
    ]);
    throw new BuildFailure(OUTCOME_CODES.ENDPOINT_SELECTION_REQUIRED, "conflicting endpoint flags");
  }

  if (flags.allEndpoints) return endpoints;

  if (flags.endpoints?.trim()) {
    const { selected, unmatched } = matchEndpoints(endpoints, flags.endpoints);
    if (unmatched.length > 0 || selected.length === 0) {
      roundedBox("Endpoints Not Found", "✖", t.err, [
        unmatched.length > 0
          ? `No detected endpoint matches: ${unmatched.join(", ")}`
          : "No endpoints selected.",
        "",
        `Use ${t.cmd('"METHOD /path"')}, ${t.cmd('"/path"')} or a tool name. Detected:`,
        ...endpointList(endpoints),
      ]);
      throw new BuildFailure(OUTCOME_CODES.ENDPOINTS_NOT_MATCHED, `unmatched: ${unmatched.join(", ")}`);
    }
    return selected;
  }

  if (!canPrompt()) {
    roundedBox("Endpoint Selection Required", "✖", t.err, [
      "There's no terminal to pick endpoints in, so nothing was selected.",
      "",
      "Select endpoints with a flag instead:",
      `  ${t.cmd("synapse build --auto --all-endpoints")}`,
      `  ${t.cmd('synapse build --auto --endpoints "GET /patients,POST /patients"')}`,
    ]);
    throw new BuildFailure(OUTCOME_CODES.ENDPOINT_SELECTION_REQUIRED, "no TTY and no selection flag");
  }

  const selected = await pickEndpoints(endpoints);
  if (selected.length === 0) {
    roundedBox("No Endpoints Selected", "✖", t.err, [
      "Nothing to build — no endpoints were selected.",
    ]);
    throw new BuildFailure(OUTCOME_CODES.NO_ENDPOINTS_SELECTED);
  }
  return selected;
}

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
