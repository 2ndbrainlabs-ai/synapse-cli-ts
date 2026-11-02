// src/commands/v2/build-v2.ts
//
// v2 entry point for `synapse build --engine v2`. Runs the SurfaceExtractor
// deterministically (with the Aho-Corasick prefilter + JSONL session ledger),
// then dispatches to Auto or Custom track based on the mode picker or flags.
//
// Session manager owns the AbortController so:
//   - Ctrl-C appends `session_paused{reason:'sigint'}`
//   - `--max-time` fires at the deadline, appends `session_paused{reason:'time_cap'}`
//   - `--resume` picks the most recent unfinished ledger for this repo and
//     replays its SHA cache, so we re-parse only files whose bytes changed
//
// Discovery cache (SYN-8): the first build in a repo discovers and saves the
// result to `.synapse/surface_cache.json`. Later builds reuse it without
// scanning and print when it was discovered; `--discover` rescans (re-parsing
// only files whose bytes changed) and refreshes it. `--resume` wins over the
// cache: it finishes the unfinished session's scan, then refreshes the cache.
//
// Exit status (SYN-314): every failed, aborted or paused build exits non-zero.
// Flows throw BuildFailure after showing the error; runBuildV2 sets
// process.exitCode and sends one `build` telemetry event with the outcome.
//
// Keeps v1 (`runBuild` in ../build.ts) untouched for backwards compat.

import {
  isInitialized,
  resolveApiKey,
  resolveEffectiveMode,
} from "../../config/manager.js";
import { resolveLlm, type ResolvedLlm } from "../../config/llm-config.js";
import { extractSurfaceStreamed } from "../../extractors/core/extractor.js";
import type { SurfaceManifest } from "../../extractors/core/surface-manifest.js";
import { pickBuildMode, type BuildMode } from "./mode-picker.js";
import { runAutoFlow } from "./auto-flow.js";
import { runLocalAutoFlow } from "./local-auto-flow.js";
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
import { readCliVersion } from "../../utils/version.js";
import { hasSelectionFlags } from "./endpoint-picker.js";
import { BuildFailure, OUTCOME_CODES, type BuildReport } from "./build-outcome.js";
import { getProjectSynapseDir } from "../../config/paths.js";
import {
  reportIndexedLines,
  showQuotaExceeded,
  type LinesReport,
} from "../shared/lines-delta.js";
import {
  buildSurfaceCache,
  cacheToManifest,
  cacheToResumeScanned,
  formatDiscoveredAt,
  isCacheUsable,
  readSurfaceCache,
  surfaceCacheKey,
  writeSurfaceCache,
} from "../../session/surface-cache.js";

export interface BuildV2Options {
  auto?: boolean;
  custom?: boolean;
  query?: string;
  baseUrl?: string;
  serverName?: string;
  /** v2 auto: read handler source (+ readme context) to name/describe tools
   *  from real behavior instead of route + docstring alone. */
  smartNames?: boolean;
  /** Attempt to resume the most recent unfinished session for this repo. */
  resume?: boolean;
  /** Soft wall-clock cap (minutes). Default 15. */
  maxTimeMinutes?: number;
  /** Enable deeper Custom-mode ranking (top-500 instead of top-200). */
  deep?: boolean;
  /** One-shot local-mode override for this invocation. */
  local?: boolean;
  /** One-shot provider override for --local (see `synapse model`). */
  provider?: string | null;
  /** One-shot model override for --local — pins every pipeline stage. */
  model?: string | null;
  /** One-shot endpoint override for --local (self-hosted / gateway). */
  llmBaseUrl?: string | null;
  /** One-shot inference key for --local, any provider. */
  llmApiKey?: string | null;
  llmRegion?: string | null;
  llmProject?: string | null;
  /** Back-compat alias for --api-key when the provider is Anthropic. */
  anthropicKey?: string | null;
  /** Auto: expose every detected endpoint without the picker. */
  allEndpoints?: boolean;
  /** Auto: comma-separated endpoints to expose ("GET /x", "/x" or tool names). */
  endpoints?: string;
  /** Auto (hosted): create a new server instead of updating this repo's one. */
  newServer?: boolean;
  /** Re-scan for new/changed files instead of reusing the last discovery result. */
  discover?: boolean;
}

function parseMaxTimeMs(opts: BuildV2Options): number {
  const minutes = opts.maxTimeMinutes ?? 15;
  return Math.max(30_000, Math.round(minutes * 60_000));
}

/** What runBuildV2 needs to report the outcome, filled in as the build runs. */
interface BuildContext {
  apiKey: string;
  effectiveMode: "hosted" | "local";
  language?: string;
  report: BuildReport;
}

function isUserAbort(err: unknown): boolean {
  const e = err as { name?: string; code?: string } | null;
  return e?.name === "ExitPromptError" || e?.code === "ABORT_ERR";
}

export async function runBuildV2(opts: BuildV2Options): Promise<void> {
  const startedAt = Date.now();
  const ctx: BuildContext = {
    apiKey: "",
    effectiveMode: "hosted",
    report: { toolCount: 0, candidateCount: 0 },
  };

  let errorCode: string | undefined;
  let rethrow: unknown;
  try {
    await buildV2(opts, ctx);
  } catch (err) {
    if (err instanceof BuildFailure) {
      errorCode = err.code;
    } else {
      // Prompt cancellation and real crashes are handled by the top-level
      // handlers in index.ts — record the outcome, then let them through.
      errorCode = isUserAbort(err) ? OUTCOME_CODES.CANCELLED : OUTCOME_CODES.UNEXPECTED;
      rethrow = err;
    }
  }

  if (errorCode) process.exitCode = 1;
  sendBuildTelemetry(ctx, Date.now() - startedAt, errorCode);
  if (rethrow) throw rethrow;
}

/** Fire-and-forget — telemetry is never allowed to break or delay the build. */
function sendBuildTelemetry(ctx: BuildContext, durationMs: number, errorCode?: string): void {
  void import("../../grpc/telemetry.js")
    .then(({ trackEvent }) =>
      trackEvent(
        "build",
        ctx.apiKey,
        process.cwd(),
        /* linesCount */ 0,
        ctx.report.toolCount,
        ctx.report.candidateCount,
        durationMs,
        ctx.effectiveMode,
        { success: !errorCode, errorCode, language: ctx.language },
      ),
    )
    .catch(() => {});
}

async function buildV2(opts: BuildV2Options, ctx: BuildContext): Promise<void> {
  const workingDir = process.cwd();

  // --local is a one-shot override for this invocation only — no project
  // config can pin mode to local (see resolveEffectiveMode).
  const effectiveMode = resolveEffectiveMode(opts.local ?? false);
  ctx.effectiveMode = effectiveMode;

  // Local one-shot builds don't require prior `synapse init`.
  if (!isInitialized(workingDir) && effectiveMode !== "local") {
    roundedBox("Not Initialized", "✖", t.err, [
      "Synapse is not initialized in this directory.",
      "",
      `Run ${t.cmd("synapse init")} first, or pass ${t.cmd("--local")} to build with your own model.`,
    ]);
    throw new BuildFailure(OUTCOME_CODES.NOT_INITIALIZED);
  }

  // Resolve the credentials we'll actually use downstream.
  let apiKey = "";
  let llm: ResolvedLlm | null = null;

  if (effectiveMode === "local") {
    llm = resolveLlm(workingDir, {
      provider: opts.provider,
      model: opts.model,
      baseUrl: opts.llmBaseUrl,
      apiKey: opts.llmApiKey,
      region: opts.llmRegion,
      project: opts.llmProject,
      anthropicKey: opts.anthropicKey,
    });

    for (const warning of llm.warnings) stepWarn(warning);

    if (llm.problems.length > 0) {
      roundedBox(`${llm.label} not ready`, "✖", t.err, [
        ...llm.problems,
        "",
        `Inspect or change it with ${t.cmd("synapse model")}.`,
      ]);
      throw new BuildFailure(OUTCOME_CODES.LLM_NOT_READY);
    }

    stepInfo(
      `Local codegen on ${llm.label} — ` +
        `${llm.models.generate} (generate), ${llm.models.triage} (triage)`,
    );
  } else {
    const resolved = resolveApiKey(workingDir);
    if (!resolved) {
      roundedBox("Missing API Key", "✖", t.err, [
        "No API key found.",
        "",
        `Run ${t.cmd("synapse init")} or set ${t.cmd("SYNAPSE_API_KEY")}.`,
        "",
        `Or run this build in local mode: ${t.cmd("synapse build --local")}`,
      ]);
      throw new BuildFailure(OUTCOME_CODES.MISSING_API_KEY);
    }
    apiKey = resolved;
    ctx.apiKey = apiKey;

    // Pre-flight quota check (mirrors v1 build.ts). Fails open: an
    // unreachable quota endpoint never blocks the build. Runs even with
    // SYNAPSE_TELEMETRY=0 — that flag only turns off analytics events.
    // The block is thrown outside the try so the fail-open catch can't
    // swallow it.
    let quotaExceeded = false;
    let quotaMessage = "";
    try {
      const { checkQuota } = await import("../../grpc/telemetry.js");
      [quotaExceeded, quotaMessage] = await checkQuota(apiKey);
    } catch {
      /* fail open */
    }
    if (quotaExceeded) {
      showQuotaExceeded(quotaMessage);
      throw new BuildFailure(OUTCOME_CODES.QUOTA_EXCEEDED);
    }
  }

  sectionHeader("Build MCP Server (v2)", "🏗️");

  const repoHash = computeRepoHash(workingDir);
  const maxTimeMs = parseMaxTimeMs(opts);
  const cacheKey = surfaceCacheKey(workingDir);
  const surfaceCache = readSurfaceCache(workingDir, cacheKey);

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
      throw new BuildFailure(OUTCOME_CODES.NOTHING_TO_RESUME);
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
  // Local mode uses the same picker as hosted; --auto here discovers HTTP
  // endpoints and generates a passthrough server file (no LLM call, nothing
  // leaves the machine) instead of pushing config to the hosted backend.
  // ---------------------------------------------------------------------------
  // --all-endpoints / --endpoints only make sense for Auto, so they imply it.
  const selection = { allEndpoints: opts.allEndpoints, endpoints: opts.endpoints };
  const autoFlag = opts.auto || (!opts.custom && hasSelectionFlags(selection));

  let mode: BuildMode;
  try {
    mode = await pickBuildMode({ autoFlag, customFlag: opts.custom });
  } catch {
    stepWarn("Cancelled", "no mode selected");
    throw new BuildFailure(OUTCOME_CODES.CANCELLED);
  }
  if (effectiveMode === "local") {
    stepInfo("Mode", `local — ${mode} flow`);
  }

  // ---------------------------------------------------------------------------
  // Streamed extraction with SessionManager + Spinner progress ticker.
  // ---------------------------------------------------------------------------
  const session = new SessionManager({
    workingDir,
    sessionId,
    mode,
    repoHash,
    cliVersion: readCliVersion(),
    maxTimeMs,
    resumeFrom: resumeState,
  });

  // Precedence: --resume (finish the unfinished scan) > --discover (rescan)
  // > a usable cache (reuse, no scan) > first-time discovery.
  const captureFunctions = mode === "custom";
  const cacheCompatible = !!surfaceCache && (!captureFunctions || surfaceCache.captured_functions);
  const skipDiscovery =
    !opts.resume && !opts.discover && isCacheUsable(surfaceCache, captureFunctions);

  let manifest: SurfaceManifest;

  if (skipDiscovery) {
    // Fast path: reuse the last completed discovery result untouched — no
    // prefilter scan, no parsing. Pass --discover to force a re-scan.
    // Source changes since then are not picked up (that would need the scan
    // this skips); the hint tells the user how to rescan.
    manifest = cacheToManifest(surfaceCache!, { captureFunctions });
    // Close the session right away: nothing to resume, and an open ledger
    // would show up as "resumable" on the next build.
    session.markDone(manifest.endpoints.length, manifest.functions.length);
    stepOk("Session", sessionId);
    const found = captureFunctions
      ? `${manifest.endpoints.length} endpoint(s), ${manifest.functions.length} function(s)`
      : `${manifest.endpoints.length} endpoint(s)`;
    stepInfo(
      "Discover",
      `Using the endpoints discovered on ${formatDiscoveredAt(surfaceCache!.updated_at)} (${found}). ` +
        `Run ${t.cmd("synapse build --discover")} to rescan.`,
    );
    stepInfo(
      "Language",
      `${manifest.language}${manifest.framework ? ` / ${manifest.framework}` : ""}`,
    );
  } else {
    if (!opts.resume && surfaceCache) {
      if (cacheCompatible) {
        // Seed the same SHA-based skip/merge cache the streamed extractors
        // already consult for `--resume` — files whose bytes are unchanged
        // are replayed from the cache instead of re-parsed.
        for (const [relPath, record] of cacheToResumeScanned(surfaceCache)) {
          session.resume.scanned.set(relPath, record);
        }
      } else {
        stepInfo(
          "Discover",
          "Cached discovery doesn't include function data needed for Custom mode — running a full scan.",
        );
      }
    }

    const spinner = new Spinner("orbital");
    spinner.start("Scanning codebase");
    session.onProgress((p) => {
      spinner.updateMeta({
        extra: `${p.filesSeen} scanned · ${p.filesMatched} matched · ${p.endpointsFound} ep · ${p.functionsFound} fn`,
      });
    });

    let extracted: Awaited<ReturnType<typeof extractSurfaceStreamed>>;
    try {
      extracted = await extractSurfaceStreamed({
        workingDir,
        session,
        captureFunctions,
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
      throw new BuildFailure(OUTCOME_CODES.EXTRACTOR_FAILED);
    }

    if (session.aborted) {
      // Session was paused (sigint or time_cap). Report gracefully.
      spinner.complete("Scan paused — partial results captured");
      const stats = (extracted as any).stats ?? {};
      const filesParsed = stats.filesParsed ?? 0;
      const filesSeen = stats.filesSeen ?? 0;
      roundedBox("Session Paused", "⚠", t.warn, [
        `Scanned ${filesParsed} / ${filesSeen} matched files before pause.`,
        `${extracted.endpoints.length} endpoint(s) and ${extracted.functions.length} function(s) captured.`,
        "",
        `Resume with: ${t.cmd("synapse build --resume")}`,
      ]);
      session.dispose();
      throw new BuildFailure(OUTCOME_CODES.SESSION_PAUSED);
    }

    manifest = extracted;
    // Framework comes from parse hits; if every file was unchanged and
    // replayed from the cache, nothing was parsed, so keep the cached one.
    if (!manifest.framework && cacheCompatible && !opts.resume) {
      manifest.framework = surfaceCache!.framework;
    }

    spinner.complete(
      `Extracted ${manifest.endpoints.length} endpoint(s) and ${manifest.functions.length} function(s)`,
    );
    stepOk("Session", sessionId);

    stepInfo(
      "Language",
      `${manifest.language}${manifest.framework ? ` / ${manifest.framework}` : ""}`,
    );

    // Persist the discovery result so future `synapse build` runs can skip
    // this step entirely until `--discover` is passed again.
    const nextCache = buildSurfaceCache({
      repoHash: cacheKey,
      manifest,
      ledgerRecords: readLedger(workingDir, sessionId),
      previous: surfaceCache,
      captureFunctions,
    });
    writeSurfaceCache(workingDir, nextCache);
  }
  ctx.language = manifest.language;

  // ---------------------------------------------------------------------------
  // Lines-indexed quota (hosted only — local builds never count against it).
  // Send the lines above the repo's baseline (shared with `synapse analyze`,
  // so lines already charged there are not charged again), BEFORE any
  // code generation, so a 429 stops the build. Other failures (401, 5xx,
  // timeout) fail open: the build continues and the same lines are resent
  // next time because the baseline only moves on success (SYN-315).
  // A reused discovery cache carries the lines_scanned of the scan that made
  // it, so a reuse normally sends nothing (delta 0). It only sends when that
  // scan's lines were never accepted (failed send or quota block), so a
  // rebuild can't skip the quota by reusing the cache.
  // ---------------------------------------------------------------------------
  if (effectiveMode === "hosted") {
    let report: LinesReport | undefined;
    try {
      report = await reportIndexedLines({
        apiKey,
        workingDir,
        synapseDir: getProjectSynapseDir(workingDir),
        totalLines: manifest.lines_scanned ?? 0,
      });
    } catch {
      /* fail open — accounting must never crash the build */
    }
    if (report?.kind === "quota_exceeded") {
      session.dispose();
      showQuotaExceeded(report.message);
      throw new BuildFailure(OUTCOME_CODES.QUOTA_EXCEEDED);
    }
  }

  // ---------------------------------------------------------------------------
  // Dispatch — Auto or Custom.
  // ---------------------------------------------------------------------------
  try {
    if (mode === "auto" && effectiveMode === "local") {
      await runLocalAutoFlow({
        workingDir,
        manifest,
        serverName: opts.serverName,
        baseUrl: opts.baseUrl,
        sessionId,
        llm,
        smartNames: opts.smartNames,
        selection,
        report: ctx.report,
      });
    } else if (mode === "auto") {
      await runAutoFlow({
        workingDir,
        manifest,
        serverName: opts.serverName,
        baseUrl: opts.baseUrl,
        sessionId,
        smartNames: opts.smartNames,
        selection,
        report: ctx.report,
        newServer: opts.newServer,
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
        effectiveMode,
        llm,
        report: ctx.report,
      });
    }
  } finally {
    session.dispose();
  }
}
