// src/commands/removed.ts
//
// Messages for options and commands that were removed with the legacy v1
// engine (SYN-257). Scripts that still pass them get a clear explanation
// and a non-zero exit instead of commander's "unknown option/command".

import { t } from "../ui/theme.js";
import { roundedBox } from "../ui/box.js";

/** The release that removed the v1 engine and `synapse analyze`. */
export const V1_REMOVED_IN = "0.2.0";

/** Options of `synapse build` that were removed with the v1 engine. */
export interface RemovedBuildOptions {
  engine?: string;
  output?: string;
  generate?: boolean;
  /** commander maps `--no-validate` to `validate: false`. */
  validate?: boolean;
  /** commander maps `--no-docs` to `docs: false`. */
  docs?: boolean;
}

/**
 * Check the hidden v1-era options of `synapse build`. With none of them (or
 * `--engine v2`) the build carries on; otherwise this prints why and sets a
 * non-zero exit code.
 *
 * @returns true when the build should run.
 */
export function checkRemovedBuildOptions(opts: RemovedBuildOptions): boolean {
  const { engine } = opts;
  if (engine !== undefined && engine !== "v2") {
    process.exitCode = 1;
    if (engine === "v1") {
      roundedBox("v1 engine removed", "✖", t.err, [
        `The v1 engine was removed in ${V1_REMOVED_IN}. v2 is the only engine.`,
        "",
        `Run ${t.cmd("synapse build")} without --engine.`,
      ]);
    } else {
      roundedBox("Unknown engine", "✖", t.err, [
        `Unknown engine "${engine}". v2 is the only engine.`,
        "",
        `Run ${t.cmd("synapse build")} without --engine.`,
      ]);
    }
    return false;
  }

  const used: string[] = [];
  if (opts.output !== undefined) used.push("-o/--output");
  if (opts.generate) used.push("-g/--generate");
  if (opts.validate === false) used.push("--no-validate");
  if (opts.docs === false) used.push("--no-docs");
  if (used.length === 0) return true;

  process.exitCode = 1;
  roundedBox("Option removed", "✖", t.err, [
    `${used.join(", ")} ${used.length === 1 ? "was a v1-only option" : "were v1-only options"}, removed in ${V1_REMOVED_IN} with the v1 engine.`,
    "",
    `Run ${t.cmd("synapse build")} without ${used.length === 1 ? "it" : "them"}. v2 names its own output file.`,
  ]);
  return false;
}

/** `synapse analyze` was only needed by the v1 engine. */
export function runAnalyzeRemoved(): void {
  process.exitCode = 1;
  roundedBox("analyze removed", "✖", t.err, [
    `${t.cmd("synapse analyze")} was removed in ${V1_REMOVED_IN} with the v1 engine.`,
    `${t.cmd("synapse build")} scans your code itself, so there is nothing to run first.`,
  ]);
}
