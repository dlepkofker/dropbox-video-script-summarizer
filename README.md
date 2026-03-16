# Dropbox Video Script Summarizer

A full-stack web app for browsing Dropbox videos, generating transcriptions, and summarizing them with AI using custom prompts.

## Features

- **Dropbox browsing** — OAuth2 login, recursive video discovery across all folders (mp4, mov, avi, mkv, webm, m4v, wmv, flv), paginated and sorted by modification date
- **Transcription** — Speech-to-text via AssemblyAI with transcript caching; videos over 4.5 GB have audio extracted server-side via FFmpeg before upload
- **AI summarization** — Generate responses from transcripts using custom prompts via OpenAI; responses are cached per video + prompt
- **Prompt editor** — Create, edit, and delete reusable prompts stored in Supabase
- **Markdown rendering** — AI responses rendered as markdown with a raw toggle
- **Expandable text boxes** — Transcript and response boxes collapse to a scrollable preview with a ▼ expand button

## Architecture

```
┌─────────────────────┐        ┌──────────────────────────┐
│  Frontend (Vite SPA) │◄──────►│  Backend (Express)        │
│  Vanilla TypeScript  │        │  Node.js / TypeScript     │
└─────────────────────┘        └──────────┬───────────────┘
                                           │
                    ┌──────────────────────┼──────────────────────┐
                    ▼                      ▼                      ▼
             Dropbox API           AssemblyAI API          OpenAI API
                                          │
                                    Supabase (Postgres)
```

All API keys live on the backend. The frontend communicates exclusively through the Express server.

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla TypeScript, Vite |
| Backend | Node.js, Express, TypeScript, tsx |
| Database | Supabase (PostgreSQL) |
| Auth | Dropbox OAuth2 (backend-managed, token refresh) |
| Transcription | AssemblyAI |
| AI | OpenAI (gpt-4o by default) |
| Audio extraction | FFmpeg via ffmpeg-static |
| Markdown | marked + DOMPurify |

## Database Schema

Three tables are required in Supabase:

```sql
-- Cached transcripts
create table transcripts (
  video_id text primary key,
  transcript text
);

-- Reusable prompts
create table prompts (
  id bigint primary key generated always as identity,
  title varchar not null,
  text text not null
);

-- Cached AI responses
create table ai_response (
  video_id text not null,
  prompt_id bigint references prompts(id),
  response text,
  unique (video_id, prompt_id)
);
```

## Setup

### 1. Install dependencies

```bash
npm install
cd server && npm install
```

### 2. Configure the backend

```bash
cp server/.env.example server/.env
```

Fill in `server/.env`:

```env
DROPBOX_APP_KEY=your_app_key
DROPBOX_APP_SECRET=your_app_secret

ASSEMBLYAI_API_KEY=your_assemblyai_key

SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_supabase_anon_key

OPENAI_API_KEY=your_openai_key

# Optional
# PORT=3001
# FRONTEND_URL=http://localhost:5173
# OPENAI_MODEL=gpt-4o
```

### 3. Configure Dropbox OAuth

In the [Dropbox App Console](https://www.dropbox.com/developers/apps), add the following redirect URI:

```
http://localhost:3001/auth/callback
```

### 4. Run

```bash
# Terminal 1 — backend
cd server && npm run dev

# Terminal 2 — frontend
npm run dev
```

- Frontend: http://localhost:5173
- Backend: http://localhost:3001

Open the frontend and click **Connect with Dropbox** to authenticate.

## Frontend Environment

Optionally create a `.env` file in the project root:

```env
# Override backend URL (defaults to http://localhost:3001)
VITE_SERVER_URL=http://localhost:3001
```

## Build

```bash
npm run build     # type-check + bundle frontend
npm run preview   # preview production build
```

## Deployment (Fly.io)

A `Dockerfile` is included in `server/` for deploying the backend to Fly.io.

```bash
cd server
fly launch
fly secrets set DROPBOX_APP_KEY=... DROPBOX_APP_SECRET=... # etc.
```

Update `FRONTEND_URL` and `REDIRECT_URI` in your environment to match your production URLs, and add the production callback URL to your Dropbox app's redirect URIs.
