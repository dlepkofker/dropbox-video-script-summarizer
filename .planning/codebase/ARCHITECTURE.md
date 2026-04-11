# Architecture

**Analysis Date:** 2026-04-11

## Pattern Overview

**Overall:** Two-tier web application — a vanilla TypeScript SPA (frontend) backed by a single-file Express REST server (backend). The two tiers are deployed as one process in production: the Express server serves the Vite-built static assets and handles all API routes.

**Key Characteristics:**
- No UI framework; DOM is managed imperatively via string template literals and `innerHTML`
- All secrets (API keys, OAuth credentials) are held exclusively on the server; the browser never sees them
- Module-level variables in `src/main.ts` act as the session store (equivalent to a Redux store in a framework app)
- Server is single-tenant by design; one Dropbox account, one token file

## Tiers

**Frontend SPA:**
- Purpose: Render views, handle user interaction, coordinate API calls
- Location: `src/`
- Entry: `index.html` → `src/main.ts`
- Depends on: `src/dropbox.ts`, `src/assemblyai.ts`, `src/supabase.ts` (all thin HTTP clients)
- Communicates with: Express server at `VITE_SERVER_URL`

**Express Backend:**
- Purpose: Proxy secrets-bearing requests, run ffmpeg audio extraction, store/retrieve data via Supabase
- Location: `server/index.ts`
- Entry: `server/index.ts` (single file, ~579 lines)
- Depends on: Supabase JS SDK, OpenAI SDK, ffmpeg-static, Dropbox OAuth endpoints via raw fetch
- Serves: Vite `dist/` as static files in production (catch-all `app.get('*')` → `index.html`)

## Module Boundaries (Frontend)

**`src/main.ts`:**
- UI orchestration: renders views (connect, loading, error, video list, video detail, prompts CRUD, instructions CRUD)
- Owns all event listeners and DOM mutations
- Maintains module-level state: `currentVideos`, `currentToken`, `activeView`, `currentPage`
- Calls into all three sibling modules

**`src/dropbox.ts`:**
- Dropbox SDK integration
- Exports: `listAllVideos()`, `getTemporaryLink()`, `formatBytes()`
- Uses the `dropbox` npm package directly; only module that imports it
- Type: `VideoFile` (re-exported subset of `files.FileMetadataReference`)

**`src/assemblyai.ts`:**
- Thin HTTP client for the server's `/assemblyai/*` proxy
- Exports: `requestTranscript(audioUrl)`
- Implements submit-then-poll loop (3-second fixed interval)
- No external SDK; uses `fetch` only

**`src/supabase.ts`:**
- Thin HTTP client for all server REST endpoints (transcripts, prompts, instructions, ai-responses)
- Exports typed CRUD functions and interfaces (`Prompt`, `Instruction`)
- No Supabase SDK in the browser; all calls go through the Express proxy

## Data Flow

**Video browsing:**
1. `src/main.ts` calls `fetchDropboxToken()` → `GET /auth/token` on server
2. Server checks `.tokens.json`; refreshes via Dropbox OAuth if expired
3. `main.ts` receives `access_token`, calls `listAllVideos(token)` in `src/dropbox.ts`
4. `dropbox.ts` uses Dropbox SDK directly (token scope only, no secrets) with cursor-based pagination
5. Result stored in module-level `currentVideos`; list view rendered

**Transcription (small files < 4.5 GB):**
1. User clicks "Get Transcript"; `main.ts` calls `getTemporaryLink()` → Dropbox SDK
2. `src/assemblyai.ts` POSTs the temporary link to `POST /assemblyai/transcript` (server proxy injects AAI key)
3. `assemblyai.ts` polls `GET /assemblyai/transcript/:id` at 3 s intervals until `completed`
4. Transcript text displayed; user can save via `POST /transcripts` → Supabase upsert

**Transcription (large files >= 4.5 GB):**
1. `main.ts` POSTs Dropbox URL to `POST /extract-audio`
2. Server spawns ffmpeg: Dropbox CDN URL → 64 kbps MP3 in a temp directory
3. MP3 uploaded to AssemblyAI via `POST /assemblyai/upload`; returns `upload_url`
4. Flow continues as small-file path from step 2 above

**AI generation:**
1. User selects prompt + optional instruction; clicks "Generate"
2. `main.ts` POSTs `{promptId, transcript, fields, instructionId}` to `POST /generate`
3. Server fetches prompt + instruction from Supabase in parallel (`Promise.all`)
4. Server interpolates `[[field]]` placeholders, calls OpenAI `responses.create`
5. Response returned to client; cached to Supabase `ai_response` on save

## Key Design Patterns

**Proxy pattern (secret isolation):** Every secrets-bearing API call (AssemblyAI, OpenAI, Dropbox OAuth) routes through the Express server. The browser modules (`assemblyai.ts`, `supabase.ts`) call only `/server-route/*`, never external APIs directly.

**Module-level state (ersatz store):** `src/main.ts` uses four module-level `let` variables as its state layer. Comments in the file explicitly acknowledge this is intentional — no framework, no store library.

**String template rendering:** All views are built as template literal strings returned from pure functions (`renderConnectView`, `renderVideoList`, `renderVideoDetail`, etc.) and assigned to `innerHTML`. XSS is prevented by manual `escapeHtml()` for user-supplied strings and `DOMPurify` for LLM markdown output.

**Two-stage Markdown sanitization:** LLM output goes through `marked` (Markdown → HTML) then `DOMPurify.sanitize` before reaching `innerHTML`. Both steps are required; neither is sufficient alone.

**Upsert idempotency:** Both `transcripts` and `ai_response` Supabase writes use `upsert` with `onConflict` keys so re-running a job overwrites rather than duplicates.

**Fail-fast startup:** `server/index.ts` checks all required environment variables at boot and calls `process.exit(1)` if any are missing, preventing cryptic runtime 401/500 errors.

## Entry Points

**Browser:**
- `index.html` — HTML shell with `<div id="app">` mount point and `<nav>` for view switching
- `src/main.ts` (loaded as `<script type="module">`) — initializes on `DOMContentLoaded`, probes `/auth/token`, branches into connect or video views

**Server:**
- `server/index.ts` — single `express()` instance, `app.listen(PORT)` at EOF

## State Management

State lives in four module-level variables in `src/main.ts`:

| Variable | Type | Purpose |
|---|---|---|
| `currentVideos` | `VideoFile[]` | Full video listing for current session |
| `currentToken` | `string` | Dropbox access token |
| `activeView` | `'videos' \| 'prompts' \| 'instructions'` | Which nav tab is active |
| `currentPage` | `number` | Pagination cursor for video list |

There is no persistent client-side state (no localStorage usage); all persistence is Supabase via the server.

## Error Handling

- API client functions (`src/supabase.ts`) extract `{error}` from JSON bodies, falling back to HTTP status text
- `main.ts` wraps async operations in try/catch and renders `renderError(message)` into `#app`
- Server handlers return `{error: string}` JSON with appropriate HTTP status codes; `process.exit(1)` on missing secrets at startup
- ffmpeg subprocess errors surface the last 800 bytes of stderr in the error response

---

*Architecture analysis: 2026-04-11*
