# Dropbox Video Script Summarizer — RAG System

## What This Is

A tool for generating AI-powered summaries of video scripts pulled from Dropbox, augmented by a RAG (Retrieval-Augmented Generation) system that enriches AI responses with relevant content from loyalpawrenting.pet blog posts. The app transcribes videos, retrieves semantically related blog knowledge, and injects it alongside system instructions before calling OpenAI — giving the AI domain-specific context drawn from the actual blog content rather than relying solely on training knowledge.

## Core Value

When a video transcript is processed, the AI response should be grounded in real blog content from loyalpawrenting.pet — not hallucinated generalities.

## Requirements

### Validated

<!-- Existing, working capabilities confirmed from codebase map. -->

- ✓ Dropbox OAuth token management with automatic refresh — existing
- ✓ Video file browsing with cursor-based pagination — existing
- ✓ Transcription via AssemblyAI for files < 4.5 GB — existing
- ✓ Transcription via ffmpeg + AssemblyAI upload for large files ≥ 4.5 GB — existing
- ✓ Prompt management (CRUD via Supabase) — existing
- ✓ Instructions management (CRUD via Supabase `instructions` table) — existing
- ✓ AI response generation (OpenAI) with prompt interpolation + optional instruction context — existing
- ✓ AI response caching to Supabase — existing

### Active

<!-- RAG system — the current milestone. -->

- [ ] Supabase pgvector extension enabled and `blog_chunks` table created with vector column
- [ ] Blog scraper: crawl loyalpawrenting.pet/blogs/, extract article text, chunk into segments
- [ ] Embedding pipeline: embed each chunk via OpenAI `text-embedding-3-small`, store in `blog_chunks`
- [ ] Deduplication: skip re-embedding chunks for blog posts already in the DB (by URL + hash)
- [ ] Scheduled sync: cron-triggered re-scrape + embed for new/updated posts
- [ ] Retrieval: given a transcript, generate embedding, query top-k similar chunks from Supabase
- [ ] Prompt augmentation: inject retrieved blog chunks into system context at `/generate` time, alongside existing instructions

### Out of Scope

- Multi-tenant support — single-user app by design; one Dropbox account, one token file
- Indexing websites other than loyalpawrenting.pet/blogs/ — RAG source is fixed for now
- Real-time streaming AI responses — not needed, existing response model is sufficient
- Browser-side embedding or retrieval — all vector operations stay on the server

## Context

**Existing system:** Two-tier app — vanilla TypeScript SPA (Vite, no framework) + Node.js 20 / Express backend deployed to Fly.io via Docker. Supabase is already the persistence layer; OpenAI SDK v6.31.0 is already integrated. The `instructions` table provides system-level context to the AI today; the RAG system extends this with retrieved blog content.

**AI generation flow (current):** `POST /generate` fetches prompt + instruction from Supabase, interpolates `[[field]]` placeholders, calls `openai.responses.create`. The instruction text is currently the only domain-specific context injected.

**AI generation flow (with RAG):** Same flow, but before calling OpenAI, embed the transcript → query `blog_chunks` for top-k similar chunks → prepend retrieved content to the system message alongside the instruction. The AI sees both the standing instruction and relevant blog knowledge.

**Embedding model decision:** `text-embedding-3-small` (1536 dims) — same OpenAI API already in use, cost-effective, and sufficient quality for semantic blog retrieval. No new API credential required.

**Blog source:** loyalpawrenting.pet/blogs/ — must respect robots.txt and rate-limit scraping. Blog structure needs to be surveyed before implementation.

## Constraints

- **Tech stack**: TypeScript / Node.js 20 / Express — RAG infrastructure must fit the existing server, not introduce a new runtime
- **Storage**: Supabase (existing project) — must extend with pgvector, not replace with a separate vector DB
- **Deployment**: Fly.io Docker container — scheduled sync must work within this environment (cron via node-cron or Fly.io scheduled machines)
- **Dependencies**: OpenAI SDK already present — use it for embeddings; avoid adding a separate embeddings client

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Supabase + pgvector for vector storage | Existing Supabase project; pgvector avoids a separate vector DB service | — Pending |
| `text-embedding-3-small` for embeddings | Already on OpenAI API, 1536 dims is sufficient, cost-effective | — Pending |
| RAG injection into system prompt | Blog content is background knowledge the AI should reason from, not a user query — system context is the right place | — Pending |
| Scheduled sync (not real-time) | Blog posts update infrequently; scheduled polling is simpler and cost-free vs webhook infrastructure | — Pending |
| Server-side only RAG | Keeps embeddings, API keys, and retrieval off the browser — consistent with existing proxy pattern | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-11 after initialization*
