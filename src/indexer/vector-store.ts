let lancedb: any = null;

async function getLanceDb(): Promise<any> {
  if (lancedb) return lancedb;
  lancedb = await import("@lancedb/lancedb");
  return lancedb;
}

export interface ChunkRecord {
  vector: number[]; // 384-dim
  filePath: string;
  fileName: string;
  type: string;
  name: string;
  signature: string;
  code: string;
  startLine: number;
  endLine: number;
}

export interface SearchResult extends ChunkRecord {
  score: number;
}

export class VectorStore {
  private db: any = null;
  private table: any = null;
  private tableName: string;

  private constructor(tableName: string) {
    this.tableName = tableName;
  }

  static async open(dbPath: string, tableName = "code_context"): Promise<VectorStore> {
    const store = new VectorStore(tableName);
    const lance = await getLanceDb();
    store.db = await lance.connect(dbPath);

    // Check if table exists
    const tableNames = await store.db.tableNames();
    if (tableNames.includes(tableName)) {
      store.table = await store.db.openTable(tableName);
    }

    return store;
  }

  async tableExists(): Promise<boolean> {
    return this.table !== null;
  }

  async createTable(records: ChunkRecord[]): Promise<void> {
    if (records.length === 0) return;

    // Drop existing table if any
    try {
      await this.db.dropTable(this.tableName);
    } catch {
      /* table doesn't exist yet */
    }

    this.table = await this.db.createTable(this.tableName, records);
  }

  async upsert(records: ChunkRecord[]): Promise<void> {
    if (!this.table || records.length === 0) return;
    await this.table.add(records);
  }

  async search(queryVector: number[], topK: number): Promise<SearchResult[]> {
    if (!this.table) return [];

    const results = await this.table
      .search(queryVector)
      .distanceType("cosine")
      .limit(topK)
      .toArray();

    return results.map((r: any) => ({
      vector: r.vector,
      filePath: r.filePath,
      fileName: r.fileName,
      type: r.type,
      name: r.name,
      signature: r.signature,
      code: r.code,
      startLine: r.startLine,
      endLine: r.endLine,
      score: 1 - ((r._distance ?? 0) / 2), // cosine distance [0,2] → similarity [0,1]
    }));
  }

  async deleteByFilePath(filePath: string): Promise<void> {
    if (!this.table) return;
    await this.table.delete(`filePath = '${filePath.replace(/'/g, "''")}'`);
  }

  async dropTable(): Promise<void> {
    try {
      await this.db.dropTable(this.tableName);
      this.table = null;
    } catch {
      /* table doesn't exist */
    }
  }

  async countRows(): Promise<number> {
    if (!this.table) return 0;
    return await this.table.countRows();
  }

  async getAllItems(limit = 100): Promise<ChunkRecord[]> {
    if (!this.table) return [];

    // Use query() for a full scan without a vector search
    try {
      const allResults = await this.table.query().limit(limit).toArray();
      return allResults.map((r: any) => ({
        vector: r.vector,
        filePath: r.filePath,
        fileName: r.fileName,
        type: r.type,
        name: r.name,
        signature: r.signature,
        code: r.code,
        startLine: r.startLine,
        endLine: r.endLine,
      }));
    } catch {
      return [];
    }
  }
}
