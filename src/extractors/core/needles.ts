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

const TS: NeedleSet = {
  route: [
    ".get(", ".post(", ".put(", ".patch(", ".delete(",
    "router.get", "router.post", "router.put", "router.patch", "router.delete",
    "app.get(", "app.post(", "app.put(", "app.patch(", "app.delete(",
    "server.route(", ".route(",
    "@Get(", "@Post(", "@Put(", "@Patch(", "@Delete(",
    "@Controller(", "@Controller()",
    "NextApiRequest", "NextApiResponse",
  ],
  callable: ["export function", "export async function", "export class", "export const"],
};
const JS: NeedleSet = {
  route: [
    ".get(", ".post(", ".put(", ".patch(", ".delete(",
    "router.get", "app.get(", "app.post(", "server.route(", ".route(",
  ],
  callable: ["module.exports", "exports.", "function ", "const "],
};
const JAVA: NeedleSet = {
  route: [
    "@GetMapping", "@PostMapping", "@PutMapping", "@PatchMapping", "@DeleteMapping",
    "@RequestMapping", "@GET", "@POST", "@PUT", "@PATCH", "@DELETE",
    "@Path(", "@Get(", "@Post(", "@Put(", "@Delete(",
    "router.get(", "router.post(",
  ],
  callable: ["public ", "protected ", "ResponseEntity"],
};
const CSHARP: NeedleSet = {
  route: [
    "[HttpGet", "[HttpPost", "[HttpPut", "[HttpPatch", "[HttpDelete",
    "[Route(", "[ApiController",
    "MapGet(", "MapPost(", "MapPut(", "MapPatch(", "MapDelete(",
    "app.Map", "endpoints.Map",
  ],
  callable: ["public ", "static ", "async Task", "IActionResult"],
};
const GO: NeedleSet = {
  route: [
    "r.GET(", "r.POST(", "r.PUT(", "r.PATCH(", "r.DELETE(",
    "router.GET(", "router.POST(", "engine.GET(",
    "e.GET(", "e.POST(", "g.GET(", "g.POST(",
    "r.Get(", "r.Post(", "app.Get(", "app.Post(",
    "http.HandleFunc(", "http.Handle(",
    "mux.HandleFunc(", "mux.Handle(", ".HandleFunc(",
    "beego.Router(",
  ],
  callable: ["func ", "func("],
};
const RUST: NeedleSet = {
  route: [
    "#[get(", "#[post(", "#[put(", "#[patch(", "#[delete(", "#[route(",
    "web::get()", "web::post()", ".route(\"",
    "Router::new()", "#[handler]", "warp::path(",
    "#[actix_web::get", "#[actix_web::post",
  ],
  callable: ["pub fn ", "pub async fn ", "fn ", "async fn "],
};

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
