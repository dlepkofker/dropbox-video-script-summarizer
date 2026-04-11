# RAG System Research Summary

**Project:** Dropbox Video Script Summarizer with Loyal Paw Renting Blog RAG
**Research Date:** 2026-04-11
**Overall Confidence:** HIGH

---

## Executive Summary

The RAG system extends your existing Express/TypeScript backend with retrieval-augmented generation by embedding blog posts and injecting relevant context into AI responses. The recommended stack reuses existing infrastructure (Supabase pgvector, OpenAI SDK) with lightweight additions (Cheerio for scraping, LangChain for chunking). The architecture is modular and low-risk: retrieval fails gracefully, and the system maintains its current two-tier design. Phase-based delivery starting with database setup ensures dependencies are satisfied progressively, with embedding cost of ~$5 for full blog corpus.

---

## Recommended Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| **Embedding Model** | OpenAI `text-embedding-3-small` (1536d) | Already licensed; cost-effective ($0.02/1M tokens); sufficient for blog semantic search |
| **Vector Storage** | Supabase pgvector with HNSW index | Extends existing DB; production-grade; ~10ms query latency at scale |
| **Web Scraper** | Cheerio ^1.2.0 + Axios | Static HTML parsing; 10x faster than browsers; no JS rendering needed for blog |
| **Text Chunking** | LangChain RecursiveCharacterTextSplitter | Production standard; handles edge cases; 500-char chunks (100-150 tokens) with 10% overlap |
| **Scheduled Sync** | node-cron in Express process | Blog updates are infrequent; Fly.io cron would add complexity; 5-10 min expected runtime |
| **Deduplication** | SHA256 hash tracking in `blog_metadata` table | Prevents re-embedding unchanged content; tracks by URL + content hash |
| **HTTP Client** | Axios ^1.6.2 (add) | Standard; retry/timeout support; integrates cleanly with Cheerio |

**New Dependencies:** `@langchain/textsplitters`, `@langchain/core`, `cheerio`, `axios`
**Estimated Embedding Cost:** ~$5 full index, $0.25 per incremental sync

---

## Table Stakes Features (MVP Must-Have)

These are non-negotiable for functional RAG:

- **Vector Embedding Pipeline** — Scrape blog → chunk content → embed via OpenAI → store in pgvector
- **Chunk Storage with Metadata** — Supabase table with `url`, `title`, `chunk_text`, `embedding`, `published_date`
- **Similarity Search** — Postgres cosine distance operator with top-k filtering and 0.70 similarity threshold
- **Context Injection** — Format retrieved chunks with source attribution (title, date, URL) and inject into system prompt before `/generate` call
- **Deduplication Logic** — Skip re-embedding unchanged blog posts (URL + content hash key)
- **Graceful Degradation** — If retrieval fails, continue `/generate` without RAG context (no user error)

**Effort Estimate:** 40-60 hours (researcher + backend engineer)

---

## Key Architecture Decisions

1. **Service-Based Modular Design** — Separate concerns: scraper, chunker, embedder, RAG service, dedup tracker. Each testable independently; easier to fix when web scraping breaks.

2. **Single Ingestion Pipeline, Two Invocation Paths** — Manual trigger (`POST /ingestion/trigger`) and scheduled sync (`node-cron` daily 2 AM UTC) call the same code. Idempotent upserts prevent duplicates on partial failures.

3. **RPC Function for Vector Search** — Use Supabase `match_blog_chunks()` function rather than PostgREST raw SQL. Cleaner, reusable, keeps complex logic at DB layer.

4. **No RLS on `blog_chunks`** — Single-user app; blog content is public. RLS overhead not justified and increases failure modes.

5. **Retrieval as Service, Not Middleware** — Call `retrieveContext()` directly in `/generate` route. Domain-specific, not cross-cutting; allows graceful error handling if RAG fails.

---

## Top Risks to Watch

| Risk | Impact | Mitigation |
|------|--------|-----------|
| **robots.txt/rate limit violations** | IP ban from loyalpawrenting.pet; sync pipeline fails for days | Parse robots.txt; exponential backoff on 429; randomized 100-500ms delays between requests; alert on 403 patterns |
| **Anti-bot detection (Cloudflare/CAPTCHA)** | Scraper blocked; corpus never populates | Pre-test static vs JS-rendered content; implement circuit breaker (>50% failures → pause); consider Firecrawl if heavy protection detected |
| **HTML structure fragility** | Silently extracts garbage; RAG quality degrades over weeks | Log all scraped content to staging table; validate text length (50-50K chars); monitor chunk quality; expect quarterly parser rewrites |
| **pgvector index selection** | HNSW vs IVFFlat; slow queries at 100K+ chunks | Use HNSW from start (`CREATE INDEX USING hnsw`); self-maintaining; monitor query latency (alert >10ms) |
| **Partial sync failures & duplicates** | Chunks accumulate over time; retrieval redundancy | Wrap pipeline in transaction (or use idempotent upserts with `ON CONFLICT`); mark progress in staging table; monitor for `count(distinct url) << count(*)` |

---

## Build Order (5-Phase Delivery)

### Phase 1: Database Foundation (Week 1)
- Enable pgvector in Supabase
- Create `blog_chunks`, `blog_metadata`, `blog_ingestion_log` tables
- Deploy `search_blog_chunks()` RPC function
- Create HNSW index on embedding column

**Why First:** All downstream components depend on schema
**Deliverable:** DB schema ready; no data yet

---

### Phase 2: Scraping & Chunking (Week 2)
- Implement `blog-scraper.ts` (Cheerio + Axios, rate limiting, robots.txt)
- Implement `chunker.ts` (recursive split, 500-char chunks, SHA256 hash)
- Unit tests for both; validate on live blog subset

**Why Second:** Test blog structure without embedding costs
**Deliverable:** Can scrape and chunk full blog locally; understand content quality

---

### Phase 3: Embedding & Ingestion (Week 3)
- Implement `embedder.ts` (batch OpenAI API, retries, rate limiting)
- Implement `dedup.ts` (track processed URLs in `blog_metadata`)
- Create `POST /ingestion/trigger` route (manual backfill)
- Create `GET /ingestion/status` route (job history)

**Why Third:** Depends on Phase 1 & 2; incurs OpenAI cost
**Deliverable:** Can manually index full blog; monitor sync jobs

---

### Phase 4: Retrieval Integration (Week 4)
- Implement `blog-rag.ts` (embed transcript, query pgvector, format context)
- Modify `POST /generate` to call `retrieveContext()` before OpenAI call
- Add graceful error handling (retrieval fails → generate without RAG)
- Unit + integration tests

**Why Fourth:** Depends on Phase 1-3; production RAG behavior
**Deliverable:** `/generate` now returns RAG-augmented responses

---

### Phase 5: Scheduled Sync & Operations (Week 5)
- Add node-cron job (daily 2 AM UTC, incremental sync)
- Add logging and optional alerting (Slack webhook on failures)
- Monitoring: sync duration, chunk count, embedding cost tracking

**Why Fifth:** Last to add operational burden; Phases 1-4 can run in production without it
**Deliverable:** Blog stays fresh automatically; manual trigger available as backup

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|-----------|-------|
| **Stack** | HIGH | Official docs verified; production patterns documented |
| **Features** | HIGH | RAG fundamentals well-researched; no novel requirements |
| **Architecture** | MEDIUM | Modular design sound, but web scraping success depends on site structure (pre-test required) |
| **Pitfalls** | HIGH | Anti-bot, rate limiting, and pgvector risks well-documented with mitigation |

**Key Unknowns:**
- Exact HTML structure of loyalpawrenting.pet blog (need manual inspection before Phase 2)
- Whether site uses JS rendering or Cloudflare protection (impacts scraper choice)
- Actual blog size and update frequency (affects sync schedule)

**Gaps to Address During Planning:**
1. Audit loyalpawrenting.pet's robots.txt and inspect 2-3 blog post pages
2. Determine if static HTML or JS rendering required (test Cheerio vs Puppeteer)
3. Measure scrape time for full blog corpus (estimate #articles, chars/article)
4. Confirm OpenAI embedding cost budget and token limits

---

## Sources

**Stack Research:**
- OpenAI Embeddings API docs (text-embedding-3-small pricing & specs)
- Supabase pgvector guide (schema, RPC, performance)
- Cheerio npm package & examples (web scraping)
- LangChain Text Splitters documentation (chunking strategies)
- Fly.io Task Scheduling guide (cron vs scheduled machines)

**Features Research:**
- RAG chunking strategies (Weaviate, NVIDIA, LangChain)
- Retrieval parameter tuning (top-k, similarity threshold, context windows)
- Hybrid search patterns (BM25 + vector, RRF)
- Metadata in RAG (attribution, recency, filtering)

**Architecture Research:**
- Production RAG patterns (Apify, web scraping architecture)
- PostgreSQL vector indexing (HNSW vs IVFFlat)
- Node.js scheduling patterns (node-cron vs workers vs Fly cron)
- Error handling in multi-stage pipelines (idempotency, partial failures)

**Pitfalls Research:**
- Web scraping risks (rate limiting, anti-bot, HTML fragility)
- pgvector gotchas (index types, dimension mismatches, RLS)
- Deduplication edge cases (hash collisions, partial sync failures)
- Production RAG operational patterns (monitoring, alerting)

---

## Ready for Roadmap Planning

Research is complete. No blocking unknowns; pre-implementation tasks (site audit, scraper proof-of-concept) should happen during Phase 1-2 planning.

Next steps: Convert this summary into detailed requirements and task breakdowns per phase.
