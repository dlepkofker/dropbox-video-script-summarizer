# Testing Patterns

**Analysis Date:** 2026-04-11

## Test Framework

**Runner:** None configured.

No test runner, assertion library, or coverage tool is installed or configured. The `package.json` at the project root and `server/package.json` contain no `test` script and no testing dependencies. Neither `jest.config.*`, `vitest.config.*`, nor any other test configuration file is present.

**Run Commands:**
```bash
# No test commands exist. The only quality-related scripts are:
npm run build    # tsc type-check + vite build (acts as a compile-time check)
npm run format   # prettier --write (style enforcement)
```

## Test File Organization

**No test files exist.** A search of the entire repository finds no files matching `*.test.ts`, `*.spec.ts`, `*.test.js`, or `*.spec.js`.

## Types of Tests Present

| Type | Present | Notes |
|------|---------|-------|
| Unit | No | No test files of any kind |
| Integration | No | No API endpoint tests |
| E2E | No | No browser automation |

## Coverage Level

**Estimated: 0%**

There is no test coverage whatsoever. TypeScript strict-mode compilation (`tsc`) acts as a static correctness check at build time but does not substitute for runtime test coverage.

## What TypeScript Strict Mode Catches (Partial Substitute)

The project uses `strict: true` plus additional lint-equivalent compiler flags in both `tsconfig.json` and `server/tsconfig.json`:
- `noUnusedLocals` and `noUnusedParameters` — catches dead code at compile time
- `noFallthroughCasesInSwitch` — catches switch statement bugs
- `verbatimModuleSyntax` — enforces correct import type usage
- `noUncheckedSideEffectImports` — guards against unintended side-effect imports

Running `npm run build` (which runs `tsc` before `vite build`) serves as the only automated quality gate.

## Test Coverage Gaps

**All application logic is untested.** Priority areas for test introduction:

**`src/dropbox.ts` — High Priority:**
- `isVideo()` type guard: extension matching logic, edge cases (no extension, uppercase, `.MP4`)
- `listAllVideos()`: cursor-based pagination, empty folder, recursive traversal
- `formatBytes()`: boundary values at 1024, 1024², 1024³, and exact GB formatting
- `getTemporaryLink()`: token propagation

**`src/assemblyai.ts` — High Priority:**
- `requestTranscript()`: polling loop termination on `completed`, error throw on `error` status, non-OK submission response
- Polling timeout behavior (the `while(true)` loop has no maximum iteration count)

**`src/supabase.ts` — High Priority:**
- `apiError()`: JSON parse success path, JSON parse failure fallback to status text
- All CRUD functions (`getPrompts`, `createPrompt`, `updatePrompt`, `deletePrompt`, and equivalents for instructions): non-OK response handling, correct URL construction

**`server/index.ts` — High Priority:**
- `/auth/token` route: valid token returned, null token → 401, token refresh on expiry
- `/generate` route: field interpolation (`[[key]]` replacement), missing prompt → 404, concurrent Supabase fetches
- `/extract-audio` route: temp directory cleanup in error and success paths, ffmpeg timeout
- `loadTokens()`: missing file, malformed JSON, partial token object
- `refreshAccessToken()`: non-OK response, expires_at calculation with 60s margin
- `/transcripts` upsert idempotency

**`src/main.ts` — Medium Priority:**
- `escapeHtml()`: all five escape sequences (`&`, `<`, `>`, `"`)
- `parseFields()`: deduplication, multiple occurrences, no matches
- `renderMarkdown()`: DOMPurify sanitization of script tags (security-critical)

## Recommended Testing Stack (Not Yet Installed)

For this project's tech stack (vanilla TypeScript, Node.js Express backend), the natural fit:

**Unit/Integration:**
- **Vitest** — native ESM support, matches Vite's build pipeline, fast
- Config: `vitest.config.ts` at project root, separate config for server

**API Integration:**
- **supertest** — for Express route testing without a live server

**E2E:**
- **Playwright** — browser automation for the SPA flows

**Test file naming convention (recommended to follow):**
- `src/dropbox.test.ts` co-located with source
- `server/index.test.ts` or `server/__tests__/routes.test.ts`

## Known Risks from Zero Coverage

- The `while(true)` polling loop in `src/assemblyai.ts` has no maximum retry count — a permanently-stuck `queued` job will hang the browser tab indefinitely.
- The `[[key]]` interpolation in `server/index.ts` uses `split/join` to avoid ReDoS but is untested against edge cases (empty value, key not in template, nested brackets).
- `loadTokens()` silently returns `null` on malformed JSON — token corruption is undetectable without tests.
- `escapeHtml()` in `src/main.ts` is security-critical (XSS prevention) but has no tests verifying all escape sequences fire correctly.

---

*Testing analysis: 2026-04-11*
