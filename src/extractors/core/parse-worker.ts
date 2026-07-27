// src/extractors/core/parse-worker.ts
//
// Worker entry: receives parse jobs over the parentPort message channel and
// runs tree-sitter without blocking the CLI main thread. One worker owns one
// tree-sitter Parser (they're not thread-safe).
//
// Messages:
//   from main → worker:  { id, kind: 'parse_python', source, relPath, module }
//                        { id, kind: 'shutdown' }
//   from worker → main:  { id, ok: true, result: PythonParseOutput }
//                        { id, ok: false, error: string }

import { parentPort } from "node:worker_threads";
import { parsePythonFile } from "../languages/python-parse.js";

interface ParsePythonJob {
  id: number;
  kind: "parse_python";
  source: string;
  relPath: string;
  module: string;
}
interface ShutdownJob {
  id: number;
  kind: "shutdown";
}
type WorkerJob = ParsePythonJob | ShutdownJob;

if (!parentPort) {
  // Worker entry must always run under worker_threads.
  throw new Error("parse-worker.ts must be launched via new Worker(...)");
}

parentPort.on("message", (msg: WorkerJob) => {
  if (msg.kind === "shutdown") {
    process.exit(0);
  }
  if (msg.kind === "parse_python") {
    try {
      const result = parsePythonFile({
        source: msg.source,
        relPath: msg.relPath,
        module: msg.module,
      });
      parentPort!.postMessage({ id: msg.id, ok: true, result });
    } catch (e) {
      parentPort!.postMessage({
        id: msg.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
});
