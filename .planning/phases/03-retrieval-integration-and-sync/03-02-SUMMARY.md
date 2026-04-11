---
phase: 03-retrieval-integration-and-sync
plan: "02"
subsystem: server
tags: [rag, cron, admin-api, express, node-cron]
dependency_graph:
  requires:
    - 03-01  # rag.ts module (preprocessTranscript, retrieveChunks, buildInstructions)
    - 02-02  # sync-blog.ts runSync
  provides:
    - RAG-powered /generate endpoint with graceful fallback
    - POST /admin/sync-blog manual trigger endpoint
    - Daily 2 AM UTC cron job for blog corpus refresh
  affects:
    - server/index.ts
tech_stack:
  added:
    - node-cron@4.2.1 (daily cron scheduling; bundles own TS declarations)
  patterns:
    - Outer try/catch for RAG pipeline (fallback to instructions-only)
    - X-Admin-Secret header auth with empty-secret guard (Pitfall 6)
    - Async cron callback with try/catch (prevents unhandled rejection crash)
key_files:
  modified:
    - server/index.ts  # RAG integration, admin route, cron registration
    - server/.env.example  # ADMIN_SECRET placeholder added
decisions:
  - retrieveChunks takes 3 params in actual rag.ts (no model arg) — plan interface showed 4; used actual signature
  - ChunkRow imported directly (not via inline import()) — cleaner and fully equivalent
metrics:
  duration: ~8min
  completed: 2026-04-11
  tasks_completed: 2
  files_modified: 2
---

# Phase 03 Plan 02: RAG Integration and Cron Summary

One-liner: Node-cron daily sync + admin HTTP trigger wired into Express server, /generate augmented with RAG retrieval and RETR-05 graceful fallback.

## What Was Built

### Task 1 — Install node-cron, add ADMIN_SECRET to .env.example
- Installed `node-cron@4.2.1` via `npm install node-cron` in `server/`
- Did NOT install `@types/node-cron` — node-cron 4.x bundles its own TypeScript declarations
- Added to `server/.env.example` (lines 12-14):
  ```
  # Admin endpoint secret — required to call POST /admin/sync-blog
  # Generate with: openssl rand -hex 32
  ADMIN_SECRET=your_admin_secret_here
  ```

### Task 2 — Update server/index.ts
Three targeted sets of changes:

**Imports added (lines 13-15):**
```typescript
import cron from 'node-cron';
import {runSync} from './sync-blog.js';
import {preprocessTranscript, retrieveChunks, buildInstructions, type ChunkRow} from './rag.js';
```

**ADMIN_SECRET constant (lines 30-33):**
```typescript
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? '';
if (!ADMIN_SECRET) {
    console.warn('[startup] ADMIN_SECRET is not set — POST /admin/sync-blog will return 401 for all requests');
}
```

**Updated /generate route body (lines 556-580 approx):** The original `...(instruction?.text ? {instructions: instruction.text} : {})` pattern was replaced by a two-phase block:
1. Outer try/catch runs `preprocessTranscript` + `retrieveChunks`, sets `ragChunks` (null on any failure, logs warning)
2. `buildInstructions(ragChunks, instruction?.text ?? null)` assembles the instructions string combining blog knowledge blocks + instruction text
3. Inner try/catch calls `openai.responses.create` with the assembled instructions

**POST /admin/sync-blog route (lines 582-597 approx):**
- Auth check: `!provided || !ADMIN_SECRET || provided !== ADMIN_SECRET` — empty ADMIN_SECRET blocks all access
- On success: calls `runSync()`, returns `{ ok: true, processed, skipped, failed }`
- On error: returns 500 with error message

**Cron registration (lines 602-614 approx):**
```typescript
cron.schedule('0 2 * * *', async () => { ... });
```
- Async callback with try/catch to prevent unhandled rejection from crashing process
- Logs success/failure result

## TypeScript Compile Result

`npx tsc --noEmit` — exit code 0, zero errors.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] retrieveChunks actual signature is 3-param, not 4**

- **Found during:** Task 2 — read actual `server/rag.ts` before editing
- **Issue:** Plan's `<interfaces>` block showed `retrieveChunks(supabase, openai, summary, model)` with a 4th `model` parameter, but the actual exported function in `rag.ts` is `retrieveChunks(supabase, openai, summary)` (uses hardcoded `EMBED_MODEL` internally)
- **Fix:** Called with 3 arguments matching the actual signature
- **Files modified:** server/index.ts (call site only)

**2. [Rule 2 - Missing critical import type] ChunkRow imported directly**

- **Found during:** Task 2
- **Issue:** Plan template used inline `import('./rag.js').ChunkRow[]` in the variable declaration, which is valid but verbose and generates a TypeScript type query
- **Fix:** Imported `type ChunkRow` directly in the import statement at line 15, enabling clean `ChunkRow[] | null` annotation
- **Files modified:** server/index.ts

## Known Stubs

None — all wiring is complete. The RAG pipeline will return empty chunks if the blog_chunks table is unpopulated, but `buildInstructions` handles empty/null chunks correctly (returns instructions-only or null).

## Threat Surface Scan

No new threat surfaces beyond those already in the plan's threat model (T-03-05 through T-03-10). All mitigations implemented as specified.

## Self-Check: PASSED

- [x] `server/index.ts` exists and contains all required patterns
- [x] `server/.env.example` contains `ADMIN_SECRET=`
- [x] Commits d05e1af (Task 1) and 39e8fe0 (Task 2) exist in git log
- [x] `npx tsc --noEmit` exits 0
