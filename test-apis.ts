import { parseJavaFile }       from './src/extractors/languages/java-parse.js';
import { parseRustFile }       from './src/extractors/languages/rust-parse.js';
import { parseGoFile }         from './src/extractors/languages/go-parse.js';
import { parseCsharpFile }     from './src/extractors/languages/csharp-parse.js';
import { parseTypescriptFile } from './src/extractors/languages/typescript-parse.js';
import { readFileSync }        from 'node:fs';

const tests = [
  { lang: 'Java',       fn: parseJavaFile,       file: '/tmp/synapse-test-apis/java/UserController.java' },
  { lang: 'Rust',       fn: parseRustFile,       file: '/tmp/synapse-test-apis/rust/main.rs' },
  { lang: 'Go',         fn: parseGoFile,         file: '/tmp/synapse-test-apis/go/main.go' },
  { lang: 'C#',         fn: parseCsharpFile,     file: '/tmp/synapse-test-apis/csharp/InvoiceController.cs' },
  { lang: 'TypeScript', fn: parseTypescriptFile, file: '/tmp/synapse-test-apis/typescript/routes.ts' },
];

let allPassed = true;
for (const { lang, fn, file } of tests) {
  const source = readFileSync(file, 'utf-8');
  const result = (fn as any)({ source, relPath: file, module: 'test' });
  const ok = result.parseOk && result.endpoints.length === 5;
  allPassed = allPassed && ok;
  console.log((ok ? '✅' : '❌') + ' ' + lang + ': ' + result.endpoints.length + '/5');
  for (const ep of result.endpoints) {
    console.log('     ' + ep.method.padEnd(7) + ep.path.padEnd(35) + '→ ' + ep.suggested_tool_name);
  }
  if (!ok) console.log('   ^ MISSING', 5 - result.endpoints.length);
}
console.log(allPassed ? '\n🎉 ALL PASS' : '\n💥 SOME FAILED');
