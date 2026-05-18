let extractor: any = null;

const EMBEDDING_DIM = 384;

async function getExtractor(): Promise<any> {
  if (extractor) return extractor;

  // @xenova/transformers is ESM-compatible
  const { pipeline: createPipeline } = await import("@xenova/transformers");

  const chalk = (await import("chalk")).default;
  console.log(`  ${chalk.hex("#d97757")(">")} Loading embedding model ${chalk.hex("#73726c")("(first run may download ~350MB)")}`);
  extractor = await createPipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
    quantized: false,
  });

  return extractor;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const ext = await getExtractor();
  const results: number[][] = [];

  // Process in batches to avoid memory issues
  const batchSize = 32;
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const output = await ext(batch, { pooling: "mean", normalize: true });

    for (let j = 0; j < batch.length; j++) {
      // output.data is a flat Float32Array, each embedding is EMBEDDING_DIM dims
      const start = j * EMBEDDING_DIM;
      const embedding = Array.from(output.data.slice(start, start + EMBEDDING_DIM)) as number[];
      results.push(embedding);
    }
  }

  return results;
}

export async function embedText(text: string): Promise<number[]> {
  const results = await embedTexts([text]);
  return results[0];
}
