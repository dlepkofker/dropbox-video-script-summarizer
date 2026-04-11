# External Integrations

**Analysis Date:** 2026-04-11

## APIs & External Services

**Dropbox:**
- Purpose: Browse and list all video files in the connected account; generate short-lived temporary download links for audio extraction
- SDK: `dropbox` ^10.34.0 (frontend, `src/dropbox.ts`)
- Auth flow: OAuth 2.0 Authorization Code with offline access (refresh token)
- Auth server-side: `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET` env vars
- Auth frontend: short-lived access token fetched from `/auth/token` — browser never sees the refresh token or app secret
- Token persistence: server writes tokens to `server/.tokens.json` (local JSON file, single-tenant design)
- Token refresh: lazy — server checks expiry before each use and calls `https://api.dropboxapi.com/oauth2/token` with the refresh token

**AssemblyAI:**
- Purpose: Asynchronous speech-to-text transcription of video audio
- Integration: HTTP REST (`https://api.assemblyai.com/v2`)
- Auth: `ASSEMBLYAI_API_KEY` env var, injected server-side only
- Client exposure: zero — all AAI requests are proxied through `server/index.ts` (`/assemblyai/transcript`, `/assemblyai/transcript/:id`) so the key never appears in the browser bundle
- Models requested: `['universal-3-pro', 'universal-2']` with language auto-detection
- Polling: client polls every 3 seconds until status reaches `completed` or `error`
- Frontend module: `src/assemblyai.ts`
- Large file path: audio is first extracted by ffmpeg on the server (`/extract-audio`), uploaded to AssemblyAI (`https://api.assemblyai.com/v2/upload`), and the returned `upload_url` is used as `audio_url` for transcription

**OpenAI:**
- Purpose: Generate AI summaries/scripts from transcripts using user-authored prompt templates
- SDK: `openai` ^6.31.0 — uses `openai.responses.create` (Responses API, not Chat Completions)
- Auth: `OPENAI_API_KEY` env var, server-side only
- Model: configurable via `OPENAI_MODEL` env var, defaults to `gpt-4o`
- Prompt interpolation: `[[field]]` placeholders replaced server-side before sending to OpenAI
- System prompt: optional `instructions` row fetched from Supabase and passed as `instructions` field
- Endpoint: `POST /generate` (server-side, `server/index.ts`)

**Supabase:**
- Purpose: Persistent storage for transcripts, prompts, instructions, and AI responses
- SDK: `@supabase/supabase-js` ^2.99.1 — used server-side only
- Auth: `SUPABASE_URL`, `SUPABASE_ANON_KEY` env vars
- Client exposure: zero — browser communicates with Supabase exclusively through the Express server REST API
- Tables used:
  - `transcripts` — keyed by `video_id` (Dropbox file ID), stores raw transcript text; upsert on conflict
  - `prompts` — user-authored templates with `[[field]]` placeholder syntax; full CRUD
  - `instructions` — system-prompt role text; full CRUD
  - `ai_response` — cached AI output keyed by `(video_id, prompt_id)`; upsert on conflict

## Audio Processing

**ffmpeg:**
- Purpose: Extract and transcode audio from Dropbox video URLs before uploading to AssemblyAI
- Binary: `ffmpeg-static` ^5.2.0 (bundled), overridable via `FFMPEG_PATH` env var
- In Docker: system ffmpeg installed via `apk add ffmpeg`, `FFMPEG_PATH=ffmpeg` set at image build time
- Pipeline: Dropbox CDN URL → ffmpeg (strips video stream, resamples to 64 kbps MP3) → temp file → AssemblyAI upload
- Temp files: created in OS temp dir via `mkdtemp`, always cleaned up in `finally` block
- Timeout: 5 minutes hard kill via `SIGKILL`

## Authentication & Identity

**Auth Provider:**
- Dropbox OAuth 2.0 (single-tenant — one Dropbox account per deployment)
- Authorization Code flow with `token_access_type=offline`
- Endpoints:
  - `GET /auth/start` — redirects browser to Dropbox authorization page
  - `GET /auth/callback` — exchanges authorization code for tokens, saves to `.tokens.json`
  - `GET /auth/token` — returns current valid access token (refreshes if expired)
  - `POST /auth/logout` — overwrites `.tokens.json` with `{}`
- No user identity system — the tool is single-user by design

## Data Storage

**Databases:**
- Supabase (PostgreSQL)
  - URL: `SUPABASE_URL` env var
  - Key: `SUPABASE_ANON_KEY` env var
  - Client: `@supabase/supabase-js` (server only)

**File Storage:**
- Local filesystem — `server/.tokens.json` stores Dropbox OAuth tokens
- OS temp directory — used transiently during audio extraction, always cleaned up

**Caching:**
- Application-level only: transcripts and AI responses cached in Supabase `transcripts` and `ai_response` tables to avoid re-running expensive jobs

## Monitoring & Observability

**Error Tracking:**
- None — no Sentry, Datadog, or equivalent

**Logs:**
- `console.log` / `console.error` only
- ffmpeg stderr is captured and logged with `[ffmpeg]` prefix
- Missing env vars cause `process.exit(1)` at startup with a clear error message

## CI/CD & Deployment

**Hosting:**
- Fly.io — config: `fly.toml`
- Single machine serving both Express API and Vite-built SPA static files
- The Express server serves `dist/` (Vite output) with a catch-all for client-side routing

**Container:**
- Dockerfile at project root
- Multi-stage: build frontend with Vite, then install server deps and run with tsx

**CI Pipeline:**
- None configured

## Environment Configuration

**Frontend env vars (Vite prefix `VITE_`):**

| Variable | Purpose |
|----------|---------|
| `VITE_SERVER_URL` | Base URL of the Express backend (empty string = same origin) |
| `VITE_ASSEMBLYAI_API_KEY` | Present in `.env.example` but NOT used in current source — all AAI calls are proxied |
| `VITE_SUPABASE_URL` | Present in `.env.example` but NOT used in current source — Supabase is server-side only |
| `VITE_SUPABASE_ANON_KEY` | Present in `.env.example` but NOT used in current source |

**Server env vars (loaded via dotenv):**

| Variable | Purpose | Required |
|----------|---------|----------|
| `DROPBOX_APP_KEY` | Dropbox OAuth app key | Yes |
| `DROPBOX_APP_SECRET` | Dropbox OAuth app secret | Yes |
| `ASSEMBLYAI_API_KEY` | AssemblyAI auth key | Yes |
| `SUPABASE_URL` | Supabase project URL | Yes |
| `SUPABASE_ANON_KEY` | Supabase anon/public key | Yes |
| `OPENAI_API_KEY` | OpenAI API key | Yes |
| `OPENAI_MODEL` | OpenAI model name | No (defaults to `gpt-4o`) |
| `PORT` | HTTP listen port | No (defaults to `3001`) |
| `FRONTEND_URL` | URL to redirect to after OAuth | No (defaults to `http://localhost:5173`) |
| `REDIRECT_URI` | Dropbox OAuth callback URL | No (defaults to `http://localhost:3001/auth/callback`) |
| `FFMPEG_PATH` | Override ffmpeg binary path | No (defaults to ffmpeg-static bundled path) |

Server fails fast at startup if any of the six required env vars are missing.

## Data Flow Between External Systems

```
Browser
  │
  ├── GET /auth/token → Express → .tokens.json (refresh via Dropbox API if expired)
  │
  ├── Dropbox SDK (src/dropbox.ts) → Dropbox API (file listing, temp links)
  │       uses access token from /auth/token
  │
  ├── POST /extract-audio → Express
  │       → ffmpeg (Dropbox CDN URL → MP3 temp file)
  │       → AssemblyAI /v2/upload
  │       ← upload_url returned to browser
  │
  ├── POST /assemblyai/transcript → Express → AssemblyAI /v2/transcript
  ├── GET  /assemblyai/transcript/:id → Express → AssemblyAI /v2/transcript/:id
  │       (browser polls until completed)
  │
  ├── POST /transcripts → Express → Supabase (cache transcript)
  ├── GET  /transcripts/:videoId → Express → Supabase (retrieve cached transcript)
  │
  ├── POST /generate → Express
  │       → Supabase (fetch prompt + instruction)
  │       → OpenAI Responses API
  │       ← AI-generated text
  │
  └── POST /ai-responses → Express → Supabase (cache AI response)
```

---

*Integration audit: 2026-04-11*
