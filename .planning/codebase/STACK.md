# Technology Stack

**Analysis Date:** 2026-04-11

## Languages

**Primary:**
- TypeScript ~5.9.3 — used across both frontend (`src/`) and backend (`server/`)

**Secondary:**
- CSS — `src/style.css` (vanilla, no preprocessor)

## Runtime

**Frontend Environment:**
- Browser (ES2023 target, DOM APIs)
- Module format: ESNext

**Backend Environment:**
- Node.js 20 (Alpine in Docker)
- Module format: ESM (`"type": "module"`)

**Package Manager:**
- npm (root) — lockfile: `package-lock.json`
- npm (server) — lockfile: `server/package-lock.json`
- Two separate package.json manifests — root for frontend, `server/` for backend

## Frameworks

**Frontend:**
- None — vanilla TypeScript SPA, no React/Vue/Svelte
- Build/dev: Vite ^8.0.0

**Backend:**
- Express ^4.18.2 — HTTP server and REST API
- cors ^2.8.5 — CORS middleware (currently wide-open; not origin-pinned)
- dotenv ^16.6.1 — environment variable loading at startup

## Build Tools

**Frontend Build:**
- Vite ^8.0.0 — dev server with HMR, production bundler
- TypeScript compiler (`tsc`) — type-check before Vite build
- Build command: `tsc && vite build` → outputs to `dist/`
- Config: `tsconfig.json` (bundler mode, `noEmit: true`, strict)

**Backend Build:**
- No compile step in production — tsx runs TypeScript directly at runtime
- tsx ^4.7.0 — TypeScript executor (dev: `tsx watch index.ts`, prod: `node --import tsx/esm index.ts`)
- Config: `server/tsconfig.json` (NodeNext module resolution, ES2022 target)

**Container:**
- Docker (multi-stage build: frontend build → server runtime)
- Base image: `node:20-alpine`
- ffmpeg installed via `apk` in the container image
- Exposes port 3001

**Deployment:**
- Fly.io — config at `fly.toml`
- Region: `iad` (US East)
- VM: 2 shared CPUs, 4 GB RAM (sized for ffmpeg audio extraction workloads)
- Auto-stop/start machines enabled; min 0 machines running

## Dev Tooling

**Formatter:**
- Prettier ^3.8.1
- Config: `.prettierrc` — single quotes, 4-space indent, 120 print width, trailing commas, no bracket spacing
- Format command: `npm run format` (covers `src/**/*.ts` and `server/**/*.ts`)

**Type Checker:**
- TypeScript strict mode enabled for both frontend and server
- Frontend: strict + `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noUncheckedSideEffectImports`, `erasableSyntaxOnly`
- Server: strict only (`skipLibCheck: true`)

**Linter:**
- None configured (no ESLint, Biome, or other linter present)

**Test Runner:**
- None configured

## Key Dependencies

**Frontend (root `package.json`):**
- `dropbox` ^10.34.0 — Dropbox SDK (file listing, temporary link generation)
- `@supabase/supabase-js` ^2.99.1 — present in root but not used directly from browser; all Supabase calls go through the server proxy
- `dompurify` ^3.3.3 — HTML sanitization for user-generated markdown output
- `marked` ^17.0.4 — Markdown-to-HTML rendering for AI-generated summaries

**Backend (`server/package.json`):**
- `openai` ^6.31.0 — OpenAI Responses API (uses `openai.responses.create`)
- `@supabase/supabase-js` ^2.99.1 — Postgres-backed storage via Supabase client
- `ffmpeg-static` ^5.2.0 — bundled ffmpeg binary (overridable via `FFMPEG_PATH` env var)
- `express` ^4.18.2 — REST API server
- `cors` ^2.8.5 — CORS middleware
- `dotenv` ^16.6.1 — `.env` loading

## TypeScript Configuration

**Frontend (`tsconfig.json`):**
- Target: ES2023
- Module: ESNext, moduleResolution: bundler
- `verbatimModuleSyntax: true`, `allowImportingTsExtensions: true`
- `noEmit: true` (Vite handles output)
- Includes: `src/` only

**Server (`server/tsconfig.json`):**
- Target: ES2022
- Module: NodeNext, moduleResolution: NodeNext
- `outDir: dist` (not used in practice — tsx runs source directly)
- Includes: `server/index.ts` only

---

*Stack analysis: 2026-04-11*
