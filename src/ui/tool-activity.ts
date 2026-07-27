/**
 * Human-readable summary of tool calls seen so far in a build/discover run.
 *
 * Groups the ~10 backend tool names into a small number of activity categories
 * ("reads", "searches", "edits", "symbols") and renders them the way Claude
 * Code does: "Reading 3 files · 2 searches · 1 edit". Zero-count categories
 * are omitted, and singular/plural forms are handled per category so it never
 * reads like a robot ("Read 1 files").
 *
 * Usage:
 *   const activity = new ToolActivity();
 *   activity.record("read_file");
 *   activity.record("grep");
 *   spinner.updateMeta({ extra: activity.format() });
 *   //   → "Reading 1 file · 1 search"
 */

type Category = "reads" | "searches" | "edits" | "symbols" | "other";

// Map every backend tool name to the human activity bucket it represents.
// If a new tool is added on the backend and not listed here, it falls through
// to "other" and shows as "N tool calls" — safe default, never crashes.
const TOOL_CATEGORY: Record<string, Category> = {
  read_file: "reads",
  find_files: "reads",
  grep: "searches",
  codebase_context_search: "searches",
  find_definition: "searches",
  find_usages: "searches",
  list_symbols: "symbols",
  write_file: "edits",
  replace_file: "edits",
  insert_file: "edits",
};

// Category → (singular label, plural label). Verbs are Claude-Code-style,
// present-participle when the run is in flight ("Reading" not "Reads").
const CATEGORY_LABEL: Record<Category, { one: string; many: string }> = {
  reads:    { one: "Reading 1 file",       many: "Reading %d files" },
  searches: { one: "1 search",             many: "%d searches" },
  edits:    { one: "1 edit",               many: "%d edits" },
  symbols:  { one: "1 symbol lookup",      many: "%d symbol lookups" },
  other:    { one: "1 tool call",          many: "%d tool calls" },
};

// Order matters — reads first (most common early), then searches, then
// symbols, then edits (which typically only appear late in a build).
const RENDER_ORDER: Category[] = ["reads", "searches", "symbols", "edits", "other"];

export class ToolActivity {
  private counts: Record<Category, number> = {
    reads: 0,
    searches: 0,
    edits: 0,
    symbols: 0,
    other: 0,
  };
  private total = 0;

  /** Record a completed tool call. Unknown tool names fall into "other". */
  record(toolName: string): void {
    const category = TOOL_CATEGORY[toolName] ?? "other";
    this.counts[category]++;
    this.total++;
  }

  /** Total number of tool calls seen. */
  get count(): number {
    return this.total;
  }

  /**
   * Render the activity summary as a dot-separated string:
   *   "Reading 3 files · 2 searches · 1 edit"
   * Returns an empty string when nothing has been recorded yet.
   */
  format(): string {
    const parts: string[] = [];
    for (const category of RENDER_ORDER) {
      const n = this.counts[category];
      if (n <= 0) continue;
      const label = CATEGORY_LABEL[category];
      parts.push(n === 1 ? label.one : label.many.replace("%d", String(n)));
    }
    return parts.join(" · ");
  }
}
