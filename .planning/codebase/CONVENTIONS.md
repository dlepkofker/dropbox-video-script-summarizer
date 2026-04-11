# Coding Conventions

**Analysis Date:** 2026-04-11

## Naming Patterns

**Files:**
- `camelCase.ts` for all TypeScript source modules: `src/dropbox.ts`, `src/assemblyai.ts`, `src/supabase.ts`, `src/main.ts`
- `index.ts` for the single server entry point: `server/index.ts`
- `style.css` for the single stylesheet

**Functions:**
- `camelCase` for all exported and internal functions: `listAllVideos`, `getTemporaryLink`, `formatBytes`, `renderConnectView`, `escapeHtml`, `parseFields`
- Async functions are named with verb-noun patterns describing their action: `fetchDropboxToken`, `refreshAccessToken`, `getValidToken`, `requestTranscript`, `getCachedTranscript`, `cacheTranscript`
- Render functions prefixed with `render`: `renderConnectView`, `renderLoading`, `renderError`, `renderVideoList`, `renderVideoDetail`

**Variables:**
- `camelCase` for all local and module-level variables: `currentVideos`, `currentToken`, `activeView`, `currentPage`, `stderrBuf`
- `SCREAMING_SNAKE_CASE` for module-level constants: `VIDEO_EXTENSIONS`, `SERVER_URL`, `AAI_BASE`, `AAI_KEY`, `FFMPEG`, `PAGE_SIZE`, `LARGE_FILE_BYTES`
- Environment-derived constants use the same casing as their env var: `APP_KEY`, `APP_SECRET`, `OPENAI_MODEL`

**Types and Interfaces:**
- `PascalCase` for all interfaces and type aliases: `VideoFile`, `TranscriptResponse`, `Tokens`, `Prompt`, `Instruction`
- Types are co-located with the module that owns them, not in a separate `types/` directory

**DOM IDs (in template literals):**
- `kebab-case` with `-btn`, `-box`, `-content` suffixes: `transcript-btn`, `copy-transcript-btn`, `prompt-box`, `transcript-content`

## Code Style

**Formatter:** Prettier 3.x

**Prettier settings (`.prettierrc`):**
- `bracketSpacing: false` — object literals render without spaces: `{accessToken}` not `{ accessToken }`
- `singleQuote: true` — all string literals use single quotes
- `trailingComma: "all"` — trailing commas in all multi-line constructs
- `tabWidth: 4` — 4-space indentation
- `printWidth: 120` — lines wrap at 120 characters

**Format command:**
```bash
npm run format   # prettier --write "src/**/*.ts" "server/**/*.ts"
```

## TypeScript Usage

**Strict mode is fully enabled** in both `tsconfig.json` (frontend) and `server/tsconfig.json` (backend):
- `strict: true`
- `noUnusedLocals: true`
- `noUnusedParameters: true`
- `noFallthroughCasesInSwitch: true`

**Frontend-specific strictness (`tsconfig.json`):**
- `verbatimModuleSyntax: true` — enforces `import type` for type-only imports
- `noUncheckedSideEffectImports: true`
- `erasableSyntaxOnly: true`
- Target: `ES2023`

**Server-specific config (`server/tsconfig.json`):**
- `module: "NodeNext"` and `moduleResolution: "NodeNext"`
- Target: `ES2022`

**Type annotation patterns:**
- Explicit return types on all exported functions: `Promise<VideoFile[]>`, `Promise<string>`, `Promise<string | null>`
- Type assertions used where SDK types are imprecise: `entry as VideoFile`, `(await res.json()) as TranscriptResponse`
- `import type` syntax for type-only imports (enforced by `verbatimModuleSyntax`): `import type {files} from 'dropbox'`, `import type {Prompt, Instruction} from './supabase'`
- Inline type assertions on `fetch` response bodies: `(await res.json()) as {access_token: string}`

**Type guards:**
- Discriminated union checks used for Dropbox SDK types: `if (entry['.tag'] !== 'file') return false`
- `instanceof Error` pattern for catch-block type narrowing: `err instanceof Error ? err.message : String(err)`

## Import Organization

**Order observed in source files:**

1. Side-effect imports (CSS): `import './style.css'`
2. Third-party libraries: `import {marked} from 'marked'`, `import DOMPurify from 'dompurify'`
3. Local module imports (value): `import {listAllVideos, getTemporaryLink, formatBytes} from './dropbox'`
4. Local module imports (type-only): `import type {Prompt, Instruction} from './supabase'`

**No path aliases** — all local imports use relative `./` paths.

**Named exports preferred** — all functions exported individually, no default exports from application modules (only third-party defaults like `OpenAI` and `DOMPurify` are imported as defaults).

## Error Handling

**Client-side (`src/` modules):**
- Async functions throw `Error` on non-OK HTTP responses: `if (!submitRes.ok) throw new Error('Failed to submit transcription: ...')`
- Functions that represent "soft" failures return `null` instead of throwing: `fetchDropboxToken` returns `null` on failure, `getCachedTranscript` returns `null` on non-OK
- Catch blocks in UI code render error strings into the DOM rather than logging to console
- Error messages include HTTP status text for context

**Server-side (`server/index.ts`):**
- All route handlers respond with `{error: message}` JSON on failure — consistent error envelope
- Supabase errors use `error.message` directly: `res.status(500).json({error: error.message})`
- Unknown errors are safely stringified: `err instanceof Error ? err.message : String(err)`
- Startup validation uses early `process.exit(1)` for missing env vars with a clear message
- `try/finally` used for resource cleanup (temp directory removal in `/extract-audio`)
- Client-side `apiError` helper (`src/supabase.ts`) extracts structured error bodies with a fallback to HTTP status text

**No silent swallowing** — every `catch` block either rethrows, returns `null`, or produces a user-visible error.

## Comment and Documentation Style

**Inline comments explain "why", not "what":**
- Design decisions with non-obvious rationale get block comments above the relevant code
- Magic numbers and thresholds are always explained: `// 64 kbps is sufficient for speech; keeps upload small`
- Security decisions are called out explicitly: `// so the API key never appears in the browser bundle`

**JSDoc used selectively** — only on functions where the rationale for async behavior, polling strategy, or security boundary needs explanation. Not used on simple utility functions.

**Section dividers** in `server/index.ts` use `// ── Section Name ──────────────` style ASCII dividers to break the large file into logical sections.

**TODO/FIXME comments:** One known production shortcut acknowledged in a comment: `// A production system would use exponential back-off or AAI's webhook/streaming APIs instead` (in `src/assemblyai.ts`).

## Module Design

**High cohesion by domain:**
- `src/dropbox.ts` — Dropbox SDK wrapper and video type
- `src/assemblyai.ts` — AssemblyAI transcript polling client
- `src/supabase.ts` — All Supabase proxy calls (transcripts, prompts, instructions)
- `src/main.ts` — All UI rendering and event handling
- `server/index.ts` — Entire Express server (monolithic by design for a single-tenant tool)

**Constants extracted to module scope** rather than inlined: `VIDEO_EXTENSIONS` as a `Set`, `LARGE_FILE_BYTES`, `PAGE_SIZE`.

**No barrel files** — modules are imported directly by path.

---

*Convention analysis: 2026-04-11*
