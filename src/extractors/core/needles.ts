// src/extractors/core/needles.ts
//
// Per-language marker needle tables used by the Aho-Corasick prefilter.
//
// Adding a new language = drop a NEEDLE_TABLE entry here + register its
// extractor in extractors/languages/<lang>-streamed.ts. The prefilter core
// (prefilter.ts) is language-agnostic — it just looks up needles by key.

import type { SupportedLanguage } from "./surface-manifest.js";

export interface NeedleSet {
  /** Route markers — files without any are pure library code, no HTTP surface. */
  route: readonly string[];
  /** Function/class markers — used in Custom mode to include files with
   *  public callables even when no route decorator is present. */
  callable: readonly string[];
}

const PY: NeedleSet = {
  route: [
    "@app.", "@router.", "@blueprint.", "@bp.",
    ".route(", ".api_route(", "add_url_rule",
    "path(", "re_path(", "url(",
    "router.add_get", "router.add_post", "router.add_put",
    "router.add_delete", "router.add_patch",
    "MethodView", "RequestHandler", "Resource",
    "@get(", "@post(", "@put(", "@patch(", "@delete(",
  ],
  callable: ["def ", "async def ", "class "],
};

// Reserved slots for future language packs. Empty needle lists mean the
// prefilter still runs (and drops everything) until a real pack is filled in.
const TS: NeedleSet = { route: [], callable: [] };
const JS: NeedleSet = { route: [], callable: [] };
const JAVA: NeedleSet = { route: [], callable: [] };
const CSHARP: NeedleSet = { route: [], callable: [] };
const GO: NeedleSet = { route: [], callable: [] };
const RUST: NeedleSet = { route: [], callable: [] };

export const NEEDLE_TABLE: Record<SupportedLanguage, NeedleSet> = {
  python: PY,
  typescript: TS,
  javascript: JS,
  java: JAVA,
  csharp: CSHARP,
  go: GO,
  rust: RUST,
};

export function getNeedles(language: SupportedLanguage): NeedleSet {
  return NEEDLE_TABLE[language];
}
