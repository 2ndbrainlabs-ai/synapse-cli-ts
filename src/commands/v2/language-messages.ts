// src/commands/v2/language-messages.ts
//
// Build messages that depend on the detected language. "No route
// decorators" only makes sense for Python; a Go repo registers routes with
// router calls, Java with annotations, and so on (SYN-353).

import type { SupportedLanguage } from "../../extractors/core/surface-manifest.js";

const LANGUAGE_NAMES: Record<SupportedLanguage, string> = {
  python: "Python",
  typescript: "TypeScript",
  javascript: "JavaScript",
  java: "Java",
  csharp: "C#",
  go: "Go",
  rust: "Rust",
};

/** What each extractor looks for, phrased for the user. */
const ROUTE_STYLES: Record<SupportedLanguage, string> = {
  python: "route decorators (FastAPI, Flask, Django)",
  typescript: "route registrations (Express, Fastify, NestJS, Koa, Hono, ...)",
  javascript: "route registrations (Express, Fastify, Koa, ...)",
  java: "route annotations (Spring, JAX-RS, Micronaut, ...)",
  csharp: "ASP.NET routes (controller attributes or MapGet/MapPost)",
  go: "router calls (net/http HandleFunc, gin, echo, chi, fiber, gorilla/mux, ...)",
  rust: "route macros or router calls (actix-web, axum, rocket, ...)",
};

export function languageName(language: SupportedLanguage | string): string {
  return LANGUAGE_NAMES[language as SupportedLanguage] ?? language;
}

/** First lines of the "No Endpoints Found" box. */
export function noEndpointsLines(language: SupportedLanguage | string): string[] {
  const style = ROUTE_STYLES[language as SupportedLanguage] ?? "HTTP route definitions";
  return [
    `Detected language: ${languageName(language)}.`,
    `The ${languageName(language)} extractor didn't find any HTTP ${style}.`,
  ];
}
