/**
 * Endpoint + use-case pickers.
 *
 * Multi-line rows with star badges — inspired by the Python CLI's Rich preview
 * panels, adapted to work inside `@inquirer/prompts` checkbox limits.
 *
 * @inquirer/prompts renders each choice as a single line, so we pack the three
 * pieces (name/stars, description, file:line) into one wide line with visible
 * separators. When the terminal is wide enough this reads cleanly.
 */

import { t } from "./theme.js";
import { sectionHeader } from "./theme.js";
import { STAR } from "./icons.js";

// ---------------------------------------------------------------------------
// Endpoint picker
// ---------------------------------------------------------------------------

export interface EndpointCandidate {
  name: string;
  filePath: string;
  confidence: number;
  humanTitle: string;
  humanDescription: string;
  conversionType: string;
  clientDependencyJson: string;
  subcategory: string;
  signature: string;
  docstring: string;
  lineNumber: number;
}

/**
 * Star badge based on confidence:
 *   ≥ 0.75 → ★★★ gold
 *   ≥ 0.5  → ★★  orange
 *   else   → ★   tan
 */
function starBadge(confidence: number): string {
  if (confidence >= 0.75) return t.num(STAR.repeat(3));
  if (confidence >= 0.5) return t.brand(STAR.repeat(2));
  return t.path(STAR);
}

export async function selectEndpoints(
  candidates: EndpointCandidate[],
): Promise<{ selected: EndpointCandidate[]; customSelected: boolean }> {
  if (candidates.length === 0) {
    return { selected: [], customSelected: true };
  }

  const CUSTOM_VALUE = "__CUSTOM__";

  const ready: Array<{ c: EndpointCandidate; idx: number }> = [];
  const wrappers: Array<{ c: EndpointCandidate; idx: number }> = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c.conversionType === "requires_wrapper") {
      wrappers.push({ c, idx: i });
    } else {
      ready.push({ c, idx: i });
    }
  }
  ready.sort((a, b) => b.c.confidence - a.c.confidence);
  wrappers.sort((a, b) => b.c.confidence - a.c.confidence);

  function makeChoice(c: EndpointCandidate, idx: number, needsWrapper = false) {
    const title = c.humanTitle || c.name;
    const wrapperTag = needsWrapper ? `  ${t.warn("(needs wrapper)")}` : "";
    const line =
      `${t.brandBold(c.name + "()")}` +
      `  ${starBadge(c.confidence)}` +
      `  ${t.dim("—")} ${t.text(title)}` +
      `  ${t.path(`${c.filePath}:${c.lineNumber}`)}` +
      wrapperTag;
    return { name: line, value: String(idx), checked: false };
  }

  const choices: Array<{ name: string; value: string; checked: boolean }> = [];
  choices.push({
    name: `${t.suggest("Custom requirement")}  ${t.dim("— describe what you need")}`,
    value: CUSTOM_VALUE,
    checked: false,
  });
  for (const { c, idx } of ready) choices.push(makeChoice(c, idx));
  for (const { c, idx } of wrappers) choices.push(makeChoice(c, idx, true));

  sectionHeader("Select Endpoints");
  console.log(`  ${t.dim(`${candidates.length} candidates • sorted by confidence`)}`);
  console.log();

  try {
    const { checkbox } = await import("@inquirer/prompts");
    const selected = await checkbox<string>({
      message: t.brand("Choose endpoints to expose as MCP tools"),
      choices,
      loop: false,
      pageSize: 15,
    });
    const customSelected = selected.includes(CUSTOM_VALUE);
    const selectedEndpoints = selected
      .filter((v) => v !== CUSTOM_VALUE)
      .map((v) => candidates[parseInt(v, 10)]);
    return { selected: selectedEndpoints, customSelected };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(`\n  ${t.warn("⚠")}  ${t.dim(`Interactive selector unavailable: ${msg}`)}`);
    console.log(`  ${t.dim("Selecting all recommended endpoints.")}`);
    const recommended = candidates.filter((c) => c.confidence >= 0.7);
    return {
      selected: recommended.length > 0 ? recommended : candidates,
      customSelected: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Use case picker (agentic discovery output)
// ---------------------------------------------------------------------------

export interface UseCaseChoice {
  title: string;
  description: string;
  functions: string[];
  module?: string;
}

export interface UseCaseSelection {
  selected: UseCaseChoice[];
  customSelected: boolean;
}

export async function selectUseCases(
  useCases: UseCaseChoice[],
): Promise<UseCaseSelection> {
  if (useCases.length === 0) {
    return { selected: [], customSelected: true };
  }

  const CUSTOM_VALUE = "__CUSTOM__";
  const choices: Array<{ name: string; value: string; checked: boolean }> = [];

  choices.push({
    name: `${t.suggest("Custom requirement")}  ${t.dim("— describe what you need")}`,
    value: CUSTOM_VALUE,
    checked: false,
  });

  for (let i = 0; i < useCases.length; i++) {
    const uc = useCases[i];
    const toolCount = uc.functions.length;
    const countBadge = t.num(`${toolCount} ${toolCount === 1 ? "tool" : "tools"}`);
    const moduleTag = uc.module ? `  ${t.path(uc.module)}` : "";
    const line =
      `${t.brandBold(uc.title)}` +
      `  ${countBadge}` +
      `  ${t.dim("—")} ${t.text(uc.description)}` +
      moduleTag;
    choices.push({ name: line, value: String(i), checked: false });
  }

  sectionHeader("Select Use Cases");
  console.log(`  ${t.dim(`${useCases.length} use cases discovered`)}`);
  console.log();

  try {
    const { checkbox } = await import("@inquirer/prompts");
    const selected = await checkbox<string>({
      message: t.brand("Choose use cases to build as MCP tools"),
      choices,
      loop: false,
      pageSize: 15,
    });
    const customSelected = selected.includes(CUSTOM_VALUE);
    const selectedUseCases = selected
      .filter((v) => v !== CUSTOM_VALUE)
      .map((v) => useCases[parseInt(v, 10)]);
    return { selected: selectedUseCases, customSelected };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(`\n  ${t.warn("⚠")}  ${t.dim(`Interactive selector unavailable: ${msg}`)}`);
    return { selected: useCases, customSelected: false };
  }
}
