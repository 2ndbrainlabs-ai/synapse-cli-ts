import chalk from "chalk";
import { t, sectionHeader } from "./theme.js";

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

export async function selectEndpoints(
  candidates: EndpointCandidate[],
): Promise<{ selected: EndpointCandidate[]; customSelected: boolean }> {
  if (candidates.length === 0) {
    return { selected: [], customSelected: true };
  }

  const CUSTOM_VALUE = "__CUSTOM__";

  // Split into ready (recommended/good) vs requires_wrapper
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

  // Sort each group by confidence descending
  ready.sort((a, b) => b.c.confidence - a.c.confidence);
  wrappers.sort((a, b) => b.c.confidence - a.c.confidence);

  function makeChoice(c: EndpointCandidate, idx: number) {
    let badge: string;
    if (c.confidence >= 0.7) badge = chalk.hex("#4ade80")("Recommended");
    else if (c.confidence >= 0.5) badge = chalk.hex("#fbbf24")("Good match");
    else badge = chalk.hex("#73726c")("May need refinement");

    return {
      name: `${chalk.hex("#d97757").bold(c.name + "()")} ${t.dim("—")} ${t.text(c.humanTitle || c.name)}  ${badge}  ${t.muted(c.filePath)}`,
      value: String(idx),
      checked: false,
    };
  }

  // Build choices: custom first, then ready, then wrappers
  const choices: Array<{ name: string; value: string; checked: boolean }> = [];

  choices.push({
    name: `${chalk.hex("#a5b4fc").bold("Custom requirement")} ${t.dim("— describe what you need")}`,
    value: CUSTOM_VALUE,
    checked: false,
  });

  for (const { c, idx } of ready) {
    choices.push(makeChoice(c, idx));
  }

  if (wrappers.length > 0) {
    for (const { c, idx } of wrappers) {
      const choice = makeChoice(c, idx);
      choice.name += `  ${t.dim("(needs wrapper)")}`;
      choices.push(choice);
    }
  }

  sectionHeader("Select Endpoints");
  console.log();

  try {
    const { checkbox } = await import("@inquirer/prompts");

    const selected = await checkbox<string>({
      message: t.brand("Choose endpoints to expose as MCP tools:"),
      choices,
      loop: false,
    });

    const customSelected = selected.includes(CUSTOM_VALUE);
    const selectedEndpoints = selected
      .filter((v) => v !== CUSTOM_VALUE)
      .map((v) => candidates[parseInt(v, 10)]);

    return { selected: selectedEndpoints, customSelected };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(`\n  ${t.warn("!")} ${t.dim(`Interactive selector unavailable: ${msg}`)}`);
    console.log(`  ${t.dim("Selecting all recommended endpoints.")}`);

    const recommended = candidates.filter((c) => c.confidence >= 0.7);
    return {
      selected: recommended.length > 0 ? recommended : candidates,
      customSelected: false,
    };
  }
}
