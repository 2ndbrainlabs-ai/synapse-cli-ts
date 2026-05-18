/**
 * Tool Executor for local tool execution on CLI side.
 *
 * When the backend needs to read/write files or search the codebase,
 * it sends a ToolCallRequest. This executor handles those requests
 * and returns the results.
 *
 * Ported from Python grpc_client/tool_executor.py.
 */

export interface ToolResult {
  success: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

export class ToolExecutor {
  private workingDir: string;
  private tools: Record<
    string,
    (params: Record<string, unknown>) => Promise<Record<string, unknown>>
  >;

  constructor(workingDir: string) {
    this.workingDir = workingDir;
    this.tools = {
      read_file: this.executeReadFile.bind(this),
      write_file: this.executeWriteFile.bind(this),
      replace_file: this.executeReplaceFile.bind(this),
      insert_file: this.executeInsertFile.bind(this),
      codebase_context_search: this.executeContextSearch.bind(this),
    };
  }

  /**
   * Execute a tool by name with the given parameters.
   *
   * Returns a ToolResult with success/result/error fields matching
   * the Python version's contract.
   */
  async execute(
    toolName: string,
    parameters: Record<string, unknown>,
  ): Promise<ToolResult> {
    const toolFunc = this.tools[toolName];
    if (!toolFunc) {
      return { success: false, error: `Unknown tool: ${toolName}` };
    }
    try {
      const result = await toolFunc(parameters);
      return { success: true, result };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, error: message };
    }
  }

  private async executeReadFile(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { readFile } = await import("../tools/read-file.js");

    const targetFile = (params.target_file as string) ?? "";
    const startLine =
      (params.start_line_one_indexed as number) || undefined;
    const endLine =
      (params.end_line_one_indexed_inclusive as number) || undefined;

    const [content, success] = readFile(targetFile, startLine, endLine);
    if (!success) throw new Error(content);
    return { content };
  }

  private async executeWriteFile(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { writeFile } = await import("../tools/write-file.js");

    const targetFile = (params.target_file as string) ?? "";
    const content = (params.content as string) ?? "";
    return writeFile(targetFile, content);
  }

  private async executeReplaceFile(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { replaceFile } = await import("../tools/replace-file.js");

    const targetFile = (params.target_file as string) ?? "";
    const startLine = (params.start_line as number) ?? 1;
    const endLine = (params.end_line as number) ?? 1;
    const content = (params.content as string) ?? "";

    const [result, success] = replaceFile(
      targetFile,
      startLine,
      endLine,
      content,
    );
    if (!success) throw new Error(result);
    return { message: result };
  }

  private async executeInsertFile(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { insertFile } = await import("../tools/insert-file.js");

    const targetFile = (params.target_file as string) ?? "";
    const content = (params.content as string) ?? "";
    const lineNumber = (params.line_number as number) || undefined;

    const [result, success] = insertFile(targetFile, content, lineNumber);
    if (!success) throw new Error(result);
    return { message: result };
  }

  private async executeContextSearch(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const workingDir = (params.working_dir as string) || this.workingDir;
    const query = (params.query as string) || "";
    const maxResults = (params.max_results as number) || 5;

    const { searchCodebaseContext, formatContextResults } = await import(
      "../builder/context-search.js"
    );
    const results = await searchCodebaseContext(query, workingDir, maxResults);
    return {
      results,
      formatted_output: formatContextResults(results),
    };
  }
}
