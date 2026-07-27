/**
 * Ember success screen — plain flowing "MCP Server Ready" block.
 *
 * No outer bounding box, no nested code fence — long absolute paths in the
 * JSON args were tearing the alignment on real screens. The metadata reads
 * fine as plain indented content, the JSON prints as a plain indented
 * block, and the `✦ Ready.` line terminates the section.
 *
 * Layout:
 *
 *   ✓  MCP Server Ready
 *   custom-mode tool
 *
 *   Tool       get_user_analytics
 *   Language   python
 *   Output     ./mcp_server.py
 *   Session    sess_9f21
 *
 *   Required env vars:
 *     !  OPENAI_API_KEY
 *
 *   Add to your MCP client:
 *
 *     {
 *       "mcpServers": {
 *         "get-user-analytics": {
 *           "command": "python",
 *           "args": ["/abs/path/..."]
 *         }
 *       }
 *     }
 *
 *   →  pip install mcp
 *   →  python ./mcp_server.py
 *
 *   ✦  Ready. Point your client at the config above.
 */

import { t } from "./theme.js";
import { SPARK, ARROW_R, OK } from "./icons.js";

export interface SuccessMcpArgs {
  toolName: string;
  language: string;               // 'python' | 'typescript' | 'go' | ...
  outputPath: string;             // absolute or repo-relative
  sessionId?: string;
  envVars?: string[];
  mcpConfig?: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
  /** Optional short subtitle rendered under the title, e.g. "custom-mode tool". */
  subtitle?: string;
}

// ---------------------------------------------------------------------------
// Language-aware next steps
// ---------------------------------------------------------------------------

const NEXT_STEPS: Record<string, (outputPath: string) => string[]> = {
  python:     (out) => ["pip install mcp", `python ${out}`],
  typescript: (out) => ["npm install @modelcontextprotocol/sdk", `tsx ${out}`],
  javascript: (out) => ["npm install @modelcontextprotocol/sdk", `node ${out}`],
  go:         (out) => [`go run ${out}`],
  rust:       (out) => [`cargo run --manifest-path ${out}`],
};

function nextStepsFor(language: string, outputPath: string): string[] {
  const gen = NEXT_STEPS[language.toLowerCase()] ?? NEXT_STEPS.python;
  return gen(outputPath);
}

// ---------------------------------------------------------------------------
// Public entry — plain lines, no boxes.
// ---------------------------------------------------------------------------

const INDENT = "  ";

export function renderSuccessMcp(args: SuccessMcpArgs): void {
  const kv = (label: string, value: string): string =>
    `${INDENT}${t.bold(label.padEnd(11))} ${t.warm(value)}`;

  // Header — colored glyph + bold title, no box.
  console.log("");
  console.log(`${INDENT}${t.ok(OK)}  ${t.bold(t.primary("MCP Server Ready"))}`);
  if (args.subtitle) {
    console.log(`${INDENT}${t.italic(t.subtle(args.subtitle))}`);
  }
  console.log("");

  // Metadata
  console.log(kv("Tool",     args.toolName));
  console.log(kv("Language", args.language));
  console.log(kv("Output",   args.outputPath));
  if (args.sessionId) console.log(kv("Session", args.sessionId));

  // Env vars
  if (args.envVars && args.envVars.length > 0) {
    console.log("");
    console.log(`${INDENT}${t.bold("Required env vars:")}`);
    for (const v of args.envVars) {
      console.log(`${INDENT}  ${t.warn("!")}  ${t.warm(v)}`);
    }
  }

  // MCP client config — printed as a plain 4-space-indented block, syntax
  // colored. No nested box → long paths in `args` no longer misalign.
  if (args.mcpConfig) {
    console.log("");
    console.log(`${INDENT}${t.warm("Add to your MCP client:")}`);
    console.log("");
    for (const line of renderMcpJsonLines(args.toolName, args.mcpConfig)) {
      console.log(`${INDENT}  ${line}`);
    }
  }

  // Language-aware next steps
  console.log("");
  for (const step of nextStepsFor(args.language, args.outputPath)) {
    console.log(`${INDENT}${t.brand(ARROW_R)}  ${t.warm(step)}`);
  }

  // ✦ Ready — the terminator glyph
  console.log("");
  console.log(`${INDENT}${t.brand(SPARK)}  ${t.warm("Ready. Point your client at the config above.")}`);
  console.log("");
}

// ---------------------------------------------------------------------------
// JSON pretty-print with syntax coloring — plain lines, no bounding chars.
// ---------------------------------------------------------------------------

function renderMcpJsonLines(
  toolName: string,
  config: NonNullable<SuccessMcpArgs["mcpConfig"]>,
): string[] {
  const serverKey = toolName.replace(/_/g, "-");
  const raw = JSON.stringify(
    { mcpServers: { [serverKey]: config } },
    null,
    2,
  );

  return raw.split("\n").map((rawLine) => {
    // Keys: `  "keyName": ...`
    let colored = rawLine.replace(
      /"([^"]+)"(\s*:)/g,
      (_m, k, colon) => `${t.warm(`"${k}"`)}${colon}`,
    );
    // String values: `: "value"` or `: "value",`
    colored = colored.replace(
      /:\s*"([^"]*)"/g,
      (_m, v) => `: ${t.ok(`"${v}"`)}`,
    );
    // Highlight the server key itself in brand — the eye-catcher.
    colored = colored.replace(
      new RegExp(t.warm(`"${serverKey}"`).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      t.brand(`"${serverKey}"`),
    );
    return colored;
  });
}
