# Repository Guidelines

## Project Structure & Module Organization
- Sources: `src/`
  - Core (AST extractors): `src/core/{definitions.ts,calls.ts}`
  - Analyzer (editor-agnostic orchestration): `src/analyzer/compute.ts` (+ `src/analyzer/types.ts`)
  - Extension (VS Code adapter): `src/extension/{controller.ts,decorator.ts,updater.ts,resolver.ts,extension.ts}`
- Tests: Vitest, colocated as `src/**/__tests__/*.test.ts` (top-most layer tests at `src/analyzer/__tests__/compute.test.ts`)
- Build output: `dist/` by `tsc` (do not edit generated artifacts)
- Entry point: `package.json` → `main: ./dist/extension.js`; commands are defined in `contributes.commands`

## Build, Test, and Development Commands
- `npm run compile` — Type-checks and compiles TS to `dist/`
- `npm run lint` — ESLint on `src/**/*.ts`
- `npm test` — Vitest (unit/integration)
- `npm run test:unit:watch` — Vitest watch
- `npm run vscode:prepublish` — Production compile (for packaging)
- Tip: Run in VS Code with `F5` (Extension Development Host)

## Coding Style & Naming Conventions
- Language: TypeScript (strict). Module: NodeNext, Target: ESNext (per tsconfig)
- Indentation: 2 spaces; prefer early returns and braces (`curly` rule enabled).
- Imports: follow ESLint `@typescript-eslint/naming-convention` for import aliases (camelCase or PascalCase).
- Semicolons: required (enforced by `@typescript-eslint/semi`).
- Namespacing: prefix command IDs with `nextjs-server-functions-visualizer.*`.
- Do not commit generated files (`dist/`) or `.vscode-test/` artifacts.

## Testing Guidelines
- Framework: Vitest (globals enabled)
- Location: `src/**/__tests__/*.test.ts`
- Focus: Ensure visualization behavior via parameterized tests at the upper layer (analyzer/compute)
- Run: `npm test` / `npm run test:unit:watch`

## Commit & Pull Request Guidelines
- Commits: Prefer Conventional Commits (e.g., `feat:`, `fix:`, `chore:`) and scope when helpful (e.g., `feat(commands): add action scan`).
- PRs: Include a clear description, linked issue(s), reproduction or screenshots (when UI-visible), and test coverage for new behavior.
- Quality gate: CI checklist — run `npm run lint` and `npm test` locally; update `README.md` and `CHANGELOG.md` when user-facing changes occur.

## Security & Configuration Tips
- Minimum VS Code engine: see `package.json` (currently `^1.100.0`)
- Prefer static analysis; avoid executing workspace code
- Limit code to `src/**`. Add new commands in `package.json` and initialize them from `src/extension.ts`

## Architecture for Agents
- Layer boundaries
  - Core (syntax extraction): editor/LSP-independent AST extractors. No side effects.
  - Analyzer (composition/decision): applies policy and resolution to Core results and outputs offset ranges (pure function). Depends only on `ResolveFn` (DI).
  - Extension (application/wiring): converts to VS Code Ranges, applies decorations, wires events. Uses `makeVsCodeResolveFn()` as the resolver.
- Dependency direction: Core ← Analyzer ← Extension (no backflow)
- Documentation: see `docs/ARCHITECTURE.md` (includes a Mermaid diagram)
