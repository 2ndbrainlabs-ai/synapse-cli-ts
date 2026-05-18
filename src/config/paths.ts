import os from "node:os";
import path from "node:path";

export const GLOBAL_SYNAPSE_DIR = path.join(os.homedir(), ".synapse");
export const GLOBAL_CONFIG_PATH = path.join(GLOBAL_SYNAPSE_DIR, "config.json");

export function getProjectSynapseDir(workingDir: string): string {
  return path.join(workingDir, ".synapse");
}

export function getProjectConfigPath(workingDir: string): string {
  return path.join(getProjectSynapseDir(workingDir), "config.json");
}

export function getProjectSchemaPath(workingDir: string): string {
  return path.join(getProjectSynapseDir(workingDir), "project_schema.txt");
}

export function getStatisticsPath(workingDir: string): string {
  return path.join(getProjectSynapseDir(workingDir), "statistics.json");
}

export function getIndexMetadataPath(workingDir: string): string {
  return path.join(getProjectSynapseDir(workingDir), "index_metadata.json");
}

export function getEndpointsCachePath(workingDir: string): string {
  return path.join(getProjectSynapseDir(workingDir), "endpoints_cache.json");
}

export function getVectorStorePath(workingDir: string): string {
  return path.join(getProjectSynapseDir(workingDir), "code_context.lance");
}

export function getContextMdPath(workingDir: string): string {
  return path.join(getProjectSynapseDir(workingDir), "CONTEXT.md");
}
