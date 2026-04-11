# Codebase Concerns

**Analysis Date:** 2026-04-11

---

## Security Concerns

**CORS Wildcard in Production — HIGH:**
- Issue: `app.use(cors())` in `server/index.ts` (line 122) allows all origins. The inline comment acknowledges this ("Production hardening would pin the origin to FRONTEND_URL") but it is not done.
- Files: `server/index.ts`
- Impact: Any website can make credentialed cross-origin requests to the API server, including the `/auth/token` endpoint which returns a live Dropbox access token.
- Fix approach: Replace `cors()` with `cors({ origin: FRONTEND_URL })` before any public deployment.

**Access Token Exposed to Frontend — HIGH:**
- Issue: `/auth/token` returns the raw Dropbox `access_token` in a JSON response, and `main.ts` stores it in the module-level variable `currentToken` (line 47). The token is then passed directly to `listAllVideos()` and `getTemporaryLink()` which call the Dropbox SDK client-side.
- Files: `src/main.ts`, `src/dropbox.ts`, `server/index.ts`
- Impact: The access token is visible in browser DevTools network tab, JavaScript heap, and any browser extension with page access. A leaked token grants full Dropbox API access for its TTL.
- Fix approach: Move all Dropbox SDK calls (file listing, temporary link generation) to the server. The frontend should only call server proxy endpoints, never hold the access token directly.

**No Authentication on Server API Endpoints — HIGH:**
- Issue: All server routes (`/transcripts`, `/prompts`, `/instructions`, `/ai-responses`, `/generate`, `/extract-audio`) are unauthenticated. Any client that can reach the server can read, create, update, and delete data, trigger OpenAI generation, and run ffmpeg jobs.
- Files: `server/index.ts`
- Impact: Data exfiltration, uncontrolled API spend (OpenAI, AssemblyAI), server resource abuse via repeated `/extract-audio` calls.
- Fix approach: Add a shared secret header (e.g., `X-Internal-Token`) verified by middleware on every route, or implement session cookies tied to the Dropbox OAuth flow.

**Tokens Persisted in Plaintext File — MEDIUM:**
- Issue: OAuth tokens (access + refresh) are stored as plaintext JSON in `server/.tokens.json`. This file is gitignored but sits on disk unencrypted.
- Files: `server/index.ts` (`TOKENS_FILE` constant), `server/.tokens.json`
- Impact: Anyone with filesystem access to the server host can steal long-lived refresh tokens and impersonate the authenticated Dropbox account indefinitely.
- Fix approach: Store tokens in an encrypted secret store (e.g., Fly.io secrets, Supabase encrypted column) or at minimum restrict file permissions to the server process user.

**No Rate Limiting on Expensive Endpoints — MEDIUM:**
- Issue: `/extract-audio`, `/generate`, and `/assemblyai/transcript` have no rate limiting. Each invocation can consume significant CPU (ffmpeg), money (OpenAI, AssemblyAI), and time.
- Files: `server/index.ts`
- Impact: A single client (or misconfigured script) could exhaust API quotas and rack up billing within minutes.
- Fix approach: Add `express-rate-limit` middleware scoped to the expensive routes, or gate them behind the authentication middleware described above.

**`dropboxUrl` in `/extract-audio` Not Validated — MEDIUM:**
- Issue: The `dropboxUrl` body parameter is passed directly to ffmpeg's `-i` flag without validating it is a legitimate Dropbox CDN URL (line 237, `server/index.ts`).
- Files: `server/index.ts`
- Impact: Server-side request forgery (SSRF) — an attacker could supply an internal network URL (e.g., `http://169.254.169.254/`) or a local file path to probe the server's network environment.
- Fix approach: Validate the URL against an allowlist of Dropbox CDN hostnames (`*.dropboxusercontent.com`, `*.dropbox.com`) before spawning ffmpeg.

---

## Performance Bottlenecks

**Full Dropbox Recursive Listing on Every Page Load — HIGH:**
- Issue: `listAllVideos()` in `src/dropbox.ts` calls `filesListFolder` with `recursive: true` and pages through every entry in the Dropbox account on every app load. For accounts with thousands of files this produces many API round trips and all results are sorted client-side.
- Files: `src/dropbox.ts`, `src/main.ts` (line 702)
- Impact: Page load can take 10–60+ seconds for large Dropbox accounts. No caching between page loads.
- Fix approach: Cache the result server-side with a short TTL (e.g., 5 minutes), or use the Dropbox `longpoll_delta` API to invalidate only on actual changes.

**Entire MP3 Read into Memory Before Upload — MEDIUM:**
- Issue: After ffmpeg extraction, `readFile(tmpFile)` in `server/index.ts` (line 285) loads the complete audio file into a `Buffer` before uploading to AssemblyAI.
- Files: `server/index.ts`
- Impact: For a 4.5 GB video file downsampled to 64 kbps MP3, the MP3 can still be hundreds of MB. Combined with the 4 GB Fly VM memory, concurrent requests could cause OOM crashes.
- Fix approach: Stream the ffmpeg stdout directly to the AssemblyAI upload endpoint using a `ReadableStream` pipe, avoiding the intermediate file read.

**Polling Transcription at Fixed 3-Second Interval — LOW:**
- Issue: `requestTranscript()` in `src/assemblyai.ts` polls every 3 seconds without exponential backoff or a maximum retry count. The loop is unbounded (`while (true)`).
- Files: `src/assemblyai.ts`
- Impact: If AssemblyAI returns an unexpected status or the job hangs, the client polls indefinitely. Heavy polling also wastes proxy bandwidth through the server.
- Fix approach: Add exponential backoff (3s → 6s → 12s → max 30s) and a hard timeout (e.g., 30 minutes) after which the promise rejects with a user-friendly message.

---

## Technical Debt

**`src/main.ts` Monolithic File — HIGH:**
- Issue: `src/main.ts` is approximately 900 lines and handles rendering, event binding, transcript flow, prompt selection, instruction management, AI generation, pagination, and navigation — all in one file.
- Files: `src/main.ts`
- Impact: Difficult to test any single concern in isolation; changing one feature risks breaking unrelated UI flows.
- Fix approach: Split into domain modules: `src/views/videoList.ts`, `src/views/videoDetail.ts`, `src/views/promptEditor.ts`, `src/views/instructionEditor.ts`, with a thin `src/router.ts` coordinating between them.

**`server/index.ts` Monolithic File — MEDIUM:**
- Issue: All 579 lines of the server live in a single file: Express setup, OAuth flow, ffmpeg orchestration, AssemblyAI proxy, Supabase CRUD for four tables, and OpenAI generation.
- Files: `server/index.ts`
- Impact: Adding a new integration or modifying one resource type requires navigating the entire file. Hard to unit test individual handlers.
- Fix approach: Split into `server/routes/auth.ts`, `server/routes/transcripts.ts`, `server/routes/prompts.ts`, `server/routes/instructions.ts`, `server/routes/generate.ts`, `server/routes/extractAudio.ts`, mounted from a thin `server/index.ts`.

**`ai_response` Upsert Conflicts on `video_id` Only — MEDIUM:**
- Issue: The upsert in `/ai-responses` POST handler uses `onConflict: 'video_id'` (line 494, `server/index.ts`), but the table stores `(video_id, prompt_id)` pairs. Upserting on `video_id` alone overwrites any previous `(video_id, promptX)` row when a new `(video_id, promptY)` is saved.
- Files: `server/index.ts`
- Impact: Saving a response for a second prompt on the same video silently deletes the first prompt's cached response.
- Fix approach: Change the unique constraint and `onConflict` key to `video_id,prompt_id` so each `(video, prompt)` combination has its own independent row.

**No Server-Side TypeScript Compilation in Production — MEDIUM:**
- Issue: The Dockerfile runs `tsx index.ts` at runtime (line 29), which means TypeScript is compiled on every server startup via `tsx`. There is no compiled output checked in or produced during Docker build.
- Files: `Dockerfile`, `server/package.json`
- Impact: Slower cold start, tsx dependency required at runtime, TypeScript type errors not caught at build time.
- Fix approach: Add a `tsc` compile step in the Dockerfile (`RUN npx tsc`) and run the compiled JS with `node`.

**Duplicate `SERVER_URL` Resolution Across Client Files — LOW:**
- Issue: The line `const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? ''` appears in three separate files: `src/main.ts`, `src/supabase.ts`, and `src/assemblyai.ts`.
- Files: `src/main.ts`, `src/supabase.ts`, `src/assemblyai.ts`
- Impact: If the env var name or fallback logic ever changes, it must be updated in three places.
- Fix approach: Extract to `src/config.ts` and import from there.

---

## Missing Error Handling

**Supabase Errors Swallowed in GET Handlers — MEDIUM:**
- Issue: `GET /transcripts/:videoId` and `GET /ai-responses/:videoId` do not check the Supabase `error` field on the response — they return `null` silently on database errors.
- Files: `server/index.ts` (lines 315–322, 450–458)
- Impact: Database misconfiguration or RLS policy changes fail silently; the UI shows "no transcript" instead of surfacing the actual error.
- Fix approach: Add `if (error) { res.status(500).json({ error: error.message }); return; }` after all Supabase selects.

**ffmpeg Comment/Code Mismatch on Timeout — LOW:**
- Issue: The kill timer comment says "Hard kill after 20 minutes" but the actual timeout is `5 * 60 * 1000` (5 minutes), and the rejection message says "5 minutes". The comment is wrong.
- Files: `server/index.ts` (lines 252–257)
- Impact: Minor documentation confusion; no functional bug.
- Fix approach: Update the comment to say "5 minutes" to match the code.

---

## Scalability Limitations

**Single-Tenant Token File Storage — MEDIUM:**
- Issue: The OAuth token store is a single file (`server/.tokens.json`) supporting exactly one Dropbox account. The code itself acknowledges this ("this server is a single-tenant tool").
- Files: `server/index.ts`
- Impact: The architecture cannot be extended to serve multiple users without a database-backed token store.
- Fix approach: Move tokens to Supabase (already a dependency) keyed by a user identifier if multi-tenant support becomes a requirement.

**Fly.io `auto_stop_machines = 'stop'` with Token File State — LOW:**
- Issue: `fly.toml` is configured to stop machines when idle (`auto_stop_machines = 'stop'`, `min_machines_running = 0`). The token file is written to the container filesystem, which is ephemeral on Fly.
- Files: `fly.toml`, `server/index.ts`
- Impact: When the machine stops and restarts, `.tokens.json` is lost, requiring the user to re-authenticate through the Dropbox OAuth flow on every cold start.
- Fix approach: Persist tokens to a Fly volume or to Supabase so they survive machine restarts.

---

## Missing Features / Incomplete Areas

**No Test Suite — HIGH:**
- Issue: There is no test runner, no test configuration file, and no test files anywhere in the repository. The `package.json` scripts section has no `test` command.
- Files: `package.json`, `server/package.json`
- Impact: All business logic (field interpolation, video filtering, pagination, token refresh, ffmpeg orchestration) is untested. Regressions cannot be caught automatically.
- Fix approach: Add Vitest for the frontend (`src/`) and the server (`server/`), targeting the pure utility functions first: `isVideo`, `formatBytes`, `parseFields`, `refreshAccessToken`.

**No Linting — MEDIUM:**
- Issue: No ESLint or Biome configuration is present. Only Prettier (formatting) is configured.
- Files: `package.json`
- Impact: Code style bugs, misused APIs, and unused variables are not caught automatically in CI or locally.
- Fix approach: Add `eslint` with `typescript-eslint` and run it in the GitHub Actions deploy workflow before the deploy step.

**No Confirmation on Destructive Actions — LOW:**
- Issue: The "Delete" button on prompts and instructions in the editor views triggers deletion immediately without any confirmation dialog.
- Files: `src/main.ts`
- Impact: Accidental deletions cannot be recovered without direct database access.
- Fix approach: Add an inline confirmation step (`data-confirm-pending` attribute pattern) before executing the delete request.

---

*Concerns audit: 2026-04-11*
