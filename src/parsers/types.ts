// src/parsers/types.ts

export interface ChunkInfo {
  filePath: string;
  fileName: string;
  type: "function" | "class";
  name: string;
  signature: string;
  code: string;
  startLine: number;
  endLine: number;
}

export interface FunctionInfo {
  name: string;
  filePath: string; // relative to working dir
  signature: string;
  docstring: string;
  returnType: string;
  isAsync: boolean;
  lineNumber: number;
  paramNames: string[];
  paramTypes: string[];
  paramDefaults: (string | null)[];
  endpointType: string; // "fastapi" | "flask" | "method" | "function"
}

export interface AnalyzerFunctionInfo {
  name: string;
  lineNumber: number;
  signature: string;
  docstring: string;
  isAsync: boolean;
  parameters: string[];
  returnType: string;
}

export interface ClassInfo {
  name: string;
  lineNumber: number;
  docstring: string;
  methods: AnalyzerFunctionInfo[];
  bases: string[];
}

export interface ModuleInfo {
  filePath: string;
  moduleName: string;
  imports: string[];
  classes: ClassInfo[];
  functions: AnalyzerFunctionInfo[];
}

export interface LanguageParser {
  readonly extensions: string[];
  readonly language: string;
  extractChunks(filePath: string, source: Buffer): ChunkInfo[];
  extractFunctions(
    filePath: string,
    source: string,
    relPath: string,
  ): FunctionInfo[];
  parseModule(filePath: string, source: string): ModuleInfo;
}
