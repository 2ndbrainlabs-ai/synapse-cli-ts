// src/commands/v2/build-v2.ts
//
// v2 entry point for `synapse build --engine v2`. Runs the SurfaceExtractor
// deterministically (with the Aho-Corasick prefilter + JSONL session ledger),
// then dispatches to Auto or Custom track based on the mode picker or flags.
//
// Session manager owns the AbortController so:
//   - Ctrl-C appends `session_paused{reason:'sigint'}` and exits 0
//   - `--max-time` fires at the deadline, appends `session_paused{reason:'time_cap'}`, exits 0
//   - `--resume` picks the most recent unfinished ledger for this repo and
//     replays its SHA cache, so we re-parse only files whose bytes changed
//
// Keeps v1 (`runBuild` in ../build.ts) untouched for backwards compat.

import { isInitialized, resolveApiKey } from "../../config/manager.js";
import { extractSurfaceStreamed } from "../../extractors/core/extractor.js";
import { pickBuildMode, type BuildMode } from "./mode-picker.js";
import { runAutoFlow } from "./auto-flow.js";
import { runCustomFlow } from "./custom-flow.js";
import { t, sectionHeader, stepInfo, stepWarn, stepOk } from "../../ui/theme.js";
import { roundedBox } from "../../ui/box.js";
import { Spinner } from "../../ui/spinner.js";
import { SessionManager } from "../../session/session-manager.js";
import {
  buildResumeState,
  findResumable,
  readLedger,
} from "../../session/ledger.js";
import { computeRepoHash, newSessionId } from "../../session/session-id.js";

export interface BuildV2Options {
  auto?: boolean;
  custom?: boolean;
  query?: string;
  baseUrl?: string;
  serverName?: string;
  /** Attempt to resume the most recent unfinished session for this repo. */
  resume?: boolean;
  /** Soft wall-clock cap (minutes). Default 15. */
  maxTimeMinutes?: number;
  /** Enable deeper Custom-mode ranking (top-500 instead of top-200). */
  deep?: boolean;
}

function parseMaxTimeMs(opts: BuildV2Options): number {
  const minutes = opts.maxTimeMinutes ?? 15;
  return Math.max(30_000, Math.round(minutes * 60_000));
}

function cliVersion(): string {
  try {
    // Best effort — the version is baked in at build time or resolved via
    // package.json when running with tsx.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (globalThis as any).__SYNAPSE_CLI_VERSION__ ?? process.env.npm_package_version ?? "dev";
  } catch {
    return "dev";
  }
}

export async function runBuildV2(opts: BuildV2Options): Promise<void> {
  const workingDir = process.cwd();

  if (!isInitialized(workingDir)) {
    roundedBox("Not Initialized", "✖", t.err, [
      "Synapse is not initialized in this directory.",
      "",
      `Run ${t.cmd("synapse init")} first.`,
    ]);
    return;
  }

  const apiKey = resolveApiKey(workingDir);
  if (!apiKey) {
    roundedBox("Missing API Key", "✖", t.err, [
      "No API key found.",
      "",
      `Run ${t.cmd("synapse init")} or set ${t.cmd("SYNAPSE_API_KEY")}.`,
    ]);
    return;
  }

  sectionHeader("Build MCP Server (v2)", "🏗️");

  const repoHash = computeRepoHash(workingDir);
  const maxTimeMs = parseMaxTimeMs(opts);

  // ---------------------------------------------------------------------------
  // Resume attempt — pick the most recent unfinished session for this repo.
  // ---------------------------------------------------------------------------
  let sessionId: string;
  let resumeState = undefined;
  if (opts.resume) {
    const resumable = findResumable(workingDir, repoHash);
    if (resumable.length === 0) {
      roundedBox("Nothing to Resume", "✖", t.err, [
        "No unfinished discover session found for this repo.",
      ]);
      return;
    }
    const latest = resumable[0];
    sessionId = latest.sessionId;
    resumeState = buildResumeState(readLedger(workingDir, sessionId));
    stepInfo(
      "Resuming",
      `${sessionId} — ${latest.filesScanned} file(s) already scanned`,
    );
  } else {
    // Non-interactive nudge: if there's an unfinished session for this repo,
    // surface it without prompting.
    const resumable = findResumable(workingDir, repoHash);
    if (resumable.length > 0) {
      stepInfo(
        "Note",
        `Found ${resumable.length} resumable session(s) — pass ${t.cmd("--resume")} to continue`,
      );
    }
    sessionId = newSessionId(repoHash);
  }

  // ---------------------------------------------------------------------------
  // Mode: Auto vs Custom — needed to decide whether to include function needles.
  // ---------------------------------------------------------------------------
  let mode: BuildMode;
  try {
    mode = await pickBuildMode({ autoFlag: opts.auto, customFlag: opts.custom });
  } catch {
    stepWarn("Cancelled", "no mode selected");
    return;
  }

  // ---------------------------------------------------------------------------
  // Streamed extraction with SessionManager + Spinner progress ticker.
  // ---------------------------------------------------------------------------
  const session = new SessionManager({
    workingDir,
    sessionId,
    mode,
    repoHash,
    cliVersion: cliVersion(),
    maxTimeMs,
    resumeFrom: resumeState,
  });

  const spinner = new Spinner("orbital");
  spinner.start("Scanning codebase");
  session.onProgress((p) => {
    spinner.updateMeta({
      extra: `${p.filesSeen} scanned · ${p.filesMatched} matched · ${p.endpointsFound} ep · ${p.functionsFound} fn`,
    });
  });

  let manifest: Awaited<ReturnType<typeof extractSurfaceStreamed>>;
  try {
    manifest = await extractSurfaceStreamed({
      workingDir,
      session,
      captureFunctions: mode === "custom",
    });
  } catch (e) {
    spinner.fail("Extraction failed", String(e));
    session.recordError({
      code: "EXTRACTOR_FAILED",
      stage: "extract",
      message: "Couldn't extract the codebase surface.",
      technical: String(e),
      hint: "Check that the repo has valid Python source. If this repeats, share the ledger via `synapse logs`.",
    });
    session.dispose();
    return;
  }

  if (session.aborted) {
    // Session was paused (sigint or time_cap). Report gracefully.
    spinner.complete("Scan paused — partial results captured");
    const stats = (manifest as any).stats ?? {};
    const filesParsed = stats.filesParsed ?? 0;
    const filesSeen = stats.filesSeen ?? 0;
    roundedBox("Session Paused", "⚠", t.warn, [
      `Scanned ${filesParsed} / ${filesSeen} matched files before pause.`,
      `${manifest.endpoints.length} endpoint(s) and ${manifest.functions.length} function(s) captured.`,
      "",
      `Resume with: ${t.cmd("synapse build --resume")}`,
    ]);
    session.dispose();
    return;
  }

  spinner.complete(
    `Extracted ${manifest.endpoints.length} endpoint(s) and ${manifest.functions.length} function(s)`,
  );
  stepOk("Session", sessionId);

  stepInfo(
    "Language",
    `${manifest.language}${manifest.framework ? ` / ${manifest.framework}` : ""}`,
  );

  // ---------------------------------------------------------------------------
  // Dispatch — Auto or Custom.
  // ---------------------------------------------------------------------------
  try {
    if (mode === "auto") {
      await runAutoFlow({
        workingDir,
        manifest,
        serverName: opts.serverName,
        baseUrl: opts.baseUrl,
        sessionId,
      });
    } else {
      await runCustomFlow({
        workingDir,
        manifest,
        intent: opts.query,
        sessionId,
        signal: session.signal,
        deep: opts.deep,
        session,
      });
    }
  } finally {
    session.dispose();
  }
}
