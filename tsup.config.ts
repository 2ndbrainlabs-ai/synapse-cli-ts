import { defineConfig } from "tsup";

// Two entry points:
//   - src/index.ts               → dist/index.js       (CLI, gets #!/usr/bin/env node)
//   - src/extractors/core/parse-worker.ts → dist/parse-worker.js
//     (Node worker_threads entry, NO shebang — it's spawned as a module).
export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    target: "node18",
    outDir: "dist",
    clean: true,
    splitting: true,
    sourcemap: true,
    dts: false,
    banner: { js: "#!/usr/bin/env node" },
    external: [/^[^./]/],
  },
  {
    entry: { "parse-worker": "src/extractors/core/parse-worker.ts" },
    format: ["esm"],
    target: "node18",
    outDir: "dist",
    clean: false,
    splitting: false,
    sourcemap: true,
    dts: false,
    external: [/^[^./]/],
  },
]);
