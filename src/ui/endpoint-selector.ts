/**
 * Endpoint + use-case pickers — Claude CLI inspired design.
 *
 * Each choice is a single truncated line that never wraps, using a shared
 * @inquirer/checkbox theme: ◆ prefix, ❯ cursor, ◉/○ icons, styled nav bar.
 *
 * Layout per item:
 *   Title  ·  N tools  ·  Description truncated to fit…   filename
 */

import { t } from "./theme.js";
import { sectionHeader } from "./theme.js";
import { STAR } from "./icons.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Truncate a plain string to maxWidth columns, appending "…" if cut. */
function truncate(str: string, maxWidth: number): string {
  if (str.length <= maxWidth) return str;
  return str.slice(0, Math.max(0, maxWidth - 1)) + "…";
}

/**
 * Shared @inquirer/checkbox theme — Claude CLI inspired.
 *
 * Icons are plain characters (no ANSI). Inquirer v7 measures icon width using
 * raw .length, not display-width — ANSI-colored icon strings inflate the
 * measured width and corrupt checkbox alignment, breaking space-key selection.
 * Plain chars keep the measurement correct while remaining visually distinct.
 */
const CHECKBOX_THEME = {
  icon: {
    checked:   "◉",   // plain — visually distinct from ○, width = 1
    unchecked: "○",   // plain
    cursor:    "❯",   // plain
  },
  style: {
    message: (text: string) => t.brandBold(text),
    // Render the collapsed answer as a clean comma-separated title list.
    // Without this, inquirer concatenates the full ANSI `name` strings,
    // producing garbled output with all the · separators and file paths.
    renderSelectedChoices: <T>(
      selectedChoices: ReadonlyArray<{ short?: string; name?: string; value: T }>,
    ) =>
      t.dim(
        selectedChoices
          .map((c) => String(c.short ?? c.name ?? ""))
          .join(", "),
      ),
  },
  helpMode: "always" as const,
};

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
 *   ≥ 0.5  → ★★  brand
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
    const badge    = starBadge(c.confidence);
    const badgeRaw = c.confidence >= 0.75 ? "★★★" : c.confidence >= 0.5 ? "★★" : "★";
    const title    = c.humanTitle || c.name;
    const wrapTag  = needsWrapper ? `  ${t.warn("(needs wrapper)")}` : "";
    const modStr   = `${c.filePath}:${c.lineNumber}`;

    // Truncate title to prevent wrapping
    const cols      = (process.stdout.columns || 100) - 8;
    const fixedLen  = (c.name + "()").length + 5 + badgeRaw.length + 5 + modStr.length + 3;
    const titleAvail = Math.max(10, cols - fixedLen);

    const name =
      t.brandBold(c.name + "()") +
      t.subtle("  ·  ") +
      badge +
      t.subtle("  ·  ") +
      t.dim(truncate(title, titleAvail)) +
      `   ${t.path(modStr)}` +
      wrapTag;

    return { name, value: String(idx), checked: false, short: c.humanTitle || c.name };
  }

  // Build endpoint choices (no custom item here — added inside try with Separator)
  const choices: Array<{ name: string; value: string; checked: boolean }> = [];
  for (const { c, idx } of ready) choices.push(makeChoice(c, idx));
  for (const { c, idx } of wrappers) choices.push(makeChoice(c, idx, true));

  sectionHeader("Select Endpoints");
  console.log(`  ${t.dim(`${candidates.length} endpoints discovered`)}`);
  console.log();

  try {
    const { checkbox, Separator } = await import("@inquirer/prompts");

    const customItem = {
      name:
        `${t.accentBold("✦")}  ${t.accentBold("Write a custom query")}` +
        `${t.accent("  ·  ")}${t.accent("describe your own requirements")}`,
      value: CUSTOM_VALUE,
      checked: false,
      short: "Custom query",
    };

    const sepLine = t.subtle("  " + "─".repeat(Math.min(72, (process.stdout.columns || 80) - 4)));

    const allChoices = [
      customItem,
      new Separator(sepLine),
      ...choices,
    ];

    const selected = await checkbox<string>({
      message:  "Choose endpoints to expose as MCP tools",
      choices:  allChoices,
      loop:     false,
      pageSize: 12,
      required: true,
      theme:    CHECKBOX_THEME,
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
  // Build use-case choices only (custom item added inside try with Separator)
  const choices: Array<{ name: string; value: string; checked: boolean }> = [];

  for (let i = 0; i < useCases.length; i++) {
    const uc       = useCases[i];
    const toolCount = uc.functions.length;
    const badge    = `${toolCount} ${toolCount === 1 ? "tool" : "tools"}`;
    const modStr   = uc.module ?? "";

    // Truncate description to prevent terminal wrapping
    const cols      = (process.stdout.columns || 100) - 8;
    const fixedLen  = uc.title.length + 5 + badge.length + 5 + (modStr ? modStr.length + 3 : 0);
    const descAvail = Math.max(10, cols - fixedLen);

    const name =
      t.brandBold(uc.title) +
      t.subtle("  ·  ") +
      t.num(badge) +
      t.subtle("  ·  ") +
      t.dim(truncate(uc.description, descAvail)) +
      (modStr ? `   ${t.path(modStr)}` : "");

    choices.push({ name, value: String(i), checked: false, short: uc.title });
  }

  sectionHeader("Select Use Cases");
  console.log(`  ${t.dim(`${useCases.length} use cases discovered`)}`);
  console.log();

  try {
    const { checkbox, Separator } = await import("@inquirer/prompts");

    // Custom item — full accent gold so it visually stands apart from terracotta items
    const customItem = {
      name:
        `${t.accentBold("✦")}  ${t.accentBold("Write a custom query")}` +
        `${t.accent("  ·  ")}${t.accent("describe your own requirements")}`,
      value: CUSTOM_VALUE,
      checked: false,
      short: "Custom query",
    };

    // Separator between the custom option and the discovered use-case list
    const sepLine = t.subtle("  " + "─".repeat(Math.min(72, (process.stdout.columns || 80) - 4)));

    const allChoices = [
      customItem,
      new Separator(sepLine),
      ...choices,  // the discovered use-case choices built above
    ];

    const selected = await checkbox<string>({
      message:  "Choose use cases to build as MCP tools",
      choices:  allChoices,
      loop:     false,
      pageSize: 12,
      required: true,   // prevents silent empty submission → shows inline error instead
      theme:    CHECKBOX_THEME,
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
