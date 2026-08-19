// Minimal ambient declarations for tree-sitter grammar packages that don't
// ship their own TypeScript types. The actual runtime values are loaded via
// require() or dynamic import() — we only need to suppress TS2307 here.

declare module "tree-sitter-c-sharp" {
  const language: unknown;
  export default language;
}
