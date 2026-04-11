# RAG System Architecture

**Project:** Dropbox Video Script Summarizer with RAG
**Domain:** Blog-enriched video transcription & summarization
**Researched:** 2026-04-11
**Overall Confidence:** MEDIUM

## Executive Summary

The RAG system extends the existing Express backend with three architectural layers: **(1) Ingestion Pipeline** (scrape → chunk → embed → store), **(2) Retrieval Service** (embed transcript → query vectors → inject into prompt), and **(3) Scheduled Sync** (periodic re-scrape + incremental update). This document recommends a modular, Express-integrated architecture that reuses existing infrastructure (Supabase pgvector, OpenAI SDK) while maintaining the current two-tier design and single-tenant deployment model.

## Recommended Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Express Backend (server/index.ts + new modules)             │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Routes:                                                     │
│  • POST /generate ← retrieval service injected              │
│  • POST /ingestion/trigger (manual backfill)                │
│  • GET /ingestion/status (job status)                       │
│                                                              │
│  Scheduled Tasks (node-cron):                               │
│  • Daily 2am UTC: sync task (scrape → embed → upsert)      │
│                                                              │
│  Service Modules:                                           │
│  ├─ services/blog-scraper.ts (Cheerio + fetch)            │
│  ├─ services/chunker.ts (recursive char split)             │
│  ├─ services/embedder.ts (OpenAI embedding wrapper)        │
│  ├─ services/blog-rag.ts (retrieval orchestrator)          │
│  └─ utils/dedup.ts (URL + content hash tracking)           │
│                                                              │
│  Persistent State:                                          │
│  └─ Supabase:                                               │
│     ├─ blog_chunks (id, url, title, body_chunk, embedding) │
│     ├─ blog_metadata (id, url, last_scraped, content_hash) │
│     └─ blog_ingestion_log (job_id, status, timestamp)      │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Component Boundaries

### 1. Blog Scraper (`services/blog-scraper.ts`)

**Responsibility:** Fetch blog posts from loyalpawrenting.pet/blogs/, parse HTML, extract article text.

**Input:** URL pattern, optional dedup filter (URLs already scraped)
**Output:** `BlogArticle[]` where `BlogArticle = { url, title, body, lastModified }`

**Design:**
- Uses Cheerio for DOM parsing (lightweight, no browser automation needed for static blog)
- Respects robots.txt; implements rate limiting (1-2 req/sec)
- Handles pagination (if blog uses it)
- Tracks `lastModified` from HTML meta tags or HTTP headers to skip unchanged posts
- Returns raw text; does NOT chunk or embed

**When Invoked:**
- Ingestion pipeline trigger (manual or scheduled)
- Called by sync job daily

**Error Handling:**
- Network errors → retry with exponential backoff
- Parse failures → log and skip single article, continue batch
- Invalid URLs → validate before fetch

**Scope:** Blog crawling only; no embedding, no storage.

### 2. Chunker (`services/chunker.ts`)

**Responsibility:** Break article text into semantic chunks; track source metadata.

**Input:** `BlogArticle` (url, title, body)
**Output:** `Chunk[]` where `Chunk = { url, title, chunk_text, chunk_index, total_chunks, content_hash }`

**Design:**
- Recursive character splitting (~2000 chars per chunk, ~200 char overlap per production RAG guidance)
- Preserves chunk ordering via `chunk_index` (useful for context preservation)
- Computes SHA256 hash of original `body` (not chunk) for deduplication (same article, multiple chunks share hash)
- Chunks are stateless; no API calls or DB access

**Chunk Size Rationale:**
- ~2000 chars ≈ 500 tokens (4 chars/token rule of thumb)
- Chunk overlaps enable semantic continuity in vector search
- No per-chunk embedding cost difference (OpenAI charges by token)

**When Invoked:**
- Between scraper and embedder in the pipeline
- Called per article after successful scrape

**Error Handling:**
- Empty body → return empty chunk array (article skipped)
- Oversized body (>10MB) → log warning, process anyway (will chunk into many pieces)

**Scope:** Chunking logic only; no embedding, no database.

### 3. Embedder (`services/embedder.ts`)

**Responsibility:** Convert chunk text to vectors via OpenAI API; handle batching for cost efficiency.

**Input:** `Chunk[]` (array of chunks, or single chunk)
**Output:** `ChunkWithEmbedding = { ...Chunk, embedding: number[], embedding_model: string, embedded_at: Date }`

**Design:**
- Wraps OpenAI `text-embedding-3-small` (1536 dimensions, $0.02/1M tokens)
- Batches requests: embed up to 50 chunks per API call (OpenAI supports batches)
- Retries failed embeddings (3 attempts, exponential backoff)
- Reuses existing OpenAI SDK already in server

**API Call Optimization:**
- Single embedding: ~50ms, 0.0002 tokens
- Batch 50 chunks: ~200ms, ~400 tokens (much cheaper than serial)
- Cost: 100 blog articles × avg 5 chunks × 500 tokens/chunk = ~250K tokens = $5 per full index

**When Invoked:**
- Pipeline step: after chunking, before storage
- Rate limited by ingestion pipeline (not per-request)

**Error Handling:**
- API rate limit → exponential backoff + requeue
- Invalid text (too long) → truncate to 8191 tokens
- Network error → fail the batch, log, allow retry

**Scope:** Embedding generation only; does NOT store vectors.

### 4. Blog RAG Service (`services/blog-rag.ts`)

**Responsibility:** Orchestrate retrieval at request time; inject retrieved chunks into system prompt.

**Input:**
- Transcript text (from `/generate` route)
- Top-k parameter (default: 3)
- Optional: similarity threshold (min score)

**Output:** `RetrievalResult = { chunks: Chunk[], raw_text: string, metadata: { count, avg_similarity } }`

**Design:**
- Embed transcript via OpenAI embedding API (same model as blog chunks)
- Query Supabase pgvector: similarity search via RPC function (PostgREST limitation)
- Return top-k results sorted by cosine similarity
- Formatting: concatenate chunks into `raw_text` for injection into system prompt

**Query Pattern (Supabase RPC):**
```sql
CREATE FUNCTION search_blog_chunks(
  embedding extensions.vector(1536),
  k integer DEFAULT 3,
  threshold float DEFAULT 0.5
) RETURNS TABLE(
  id bigint, url text, title text, chunk_text text, similarity float
) AS $$
  SELECT id, url, title, chunk_text,
         1 - (embedding <=> $1)::float AS similarity
  FROM blog_chunks
  WHERE 1 - (embedding <=> $1)::float > $2
  ORDER BY similarity DESC
  LIMIT $3;
$$ LANGUAGE SQL;
```

**When Invoked:**
- Per-request at `/generate` time, before OpenAI call
- Lightweight: single embedding (~50ms) + single DB query (~10ms)

**Error Handling:**
- Embedding fails → log, retrieve without RAG (fallback to instruction-only prompt)
- DB query fails → same fallback
- No retrieved chunks → inject empty context (graceful degradation)

**Scope:** Retrieval orchestration only; does NOT modify chunks or embeddings.

### 5. Deduplication Tracker (`utils/dedup.ts`)

**Responsibility:** Track which blog posts have been scraped/embedded; skip re-processing unchanged content.

**Input:** Blog URL, content hash (SHA256 of article body)
**Output:** `DedupRecord = { url, content_hash, last_embedded_at }`

**Design:**
- Stores in Supabase `blog_metadata` table: `(id, url, content_hash, last_embedded_at, last_updated)`
- Before scraping: check if URL + hash already exist → skip
- After successful embedding: upsert record with new hash + timestamp
- Handles partial failures (e.g., scrape succeeded, embedding failed) → record not updated, retry on next sync

**Why Hash-Based:**
- URL alone is insufficient (blog posts are updated in-place)
- Hash detects content changes without re-parsing HTML
- Hash is computed by chunker (shared across blocks of same article)

**When Invoked:**
- Before scraper (to skip already-processed URLs)
- After each embedder batch (to mark articles as completed)

**Error Handling:**
- DB lookup fails → assume NOT deduplicated, proceed with full pipeline (retry)
- Hash mismatch (content changed) → re-embed (safe via upsert on `url` key)

**Scope:** Dedup bookkeeping only; no scraping, chunking, or embedding logic.

---

## Data Flow

### Ingestion Pipeline (Backfill or Scheduled Sync)

```
1. TRIGGER (manual route or cron)
   ↓
2. SCRAPER
   Input:  loyalpawrenting.pet/blogs/ URL
   Output: BlogArticle[] = [
     { url: "...", title: "...", body: "..." },
     { url: "...", title: "...", body: "..." },
     ...
   ]
   ↓
3. DEDUP FILTER (optional for incremental sync)
   Input:  BlogArticle[] + previous blog_metadata table
   Output: BlogArticle[] (filtered to new/updated only)
   ↓
4. CHUNKER
   Input:  BlogArticle[]
   Output: Chunk[] = [
     { url, title, chunk_text, chunk_index, content_hash },
     { url, title, chunk_text, chunk_index, content_hash },
     ...
   ]
   ↓
5. EMBEDDER (batched)
   Input:  Chunk[]
   Output: ChunkWithEmbedding[] (same + embedding vectors)
   ↓
6. STORAGE (upsert to Supabase)
   Input:  ChunkWithEmbedding[]
   Action:
     • blog_chunks: INSERT ... ON CONFLICT (url, chunk_index) DO UPDATE
     • blog_metadata: INSERT ... ON CONFLICT (url) DO UPDATE (hash, timestamp)
   Output: Confirmation + count of stored chunks
   ↓
7. LOGGING
   Input:  Job result (success/failure, chunk count, duration)
   Action: INSERT blog_ingestion_log
   Output: Historical audit trail
```

### Retrieval at /generate Time

```
1. POST /generate { promptId, transcript, ... }
   ↓
2. RAG SERVICE (blog-rag.ts)
   a. Embed transcript: embed(transcript) → vector[1536]
   b. Query: search_blog_chunks(vector, k=3)
   c. Format: retrieved_text = chunks.map(c => `${c.title}\n${c.chunk_text}`).join('\n---\n')
   ↓
3. PROMPT AUGMENTATION
   Input:  system_prompt = instruction + retrieved_text + original_system
   Output: Enhanced system prompt
   ↓
4. OPENAI CALL
   Input:  { system: enhanced_system, user: transcript }
   Output: AI response
   ↓
5. RESPONSE
   Output: { response, source_chunks: [...] } (optional: surface which blog posts were used)
```

### Data Relationships

```
blog_metadata (URL, hash, last_embedded_at)
    ↓ (url FK)
blog_chunks (url, chunk_index, chunk_text, embedding[])
    ↓ (referenced in prompt injection)
POST /generate response
```

---

## Build Order & Dependencies

### Phase 1: Foundational Setup (Week 1)

**Why first:** Enables all downstream components; no external dependencies blocked.

1. **Database Schema**
   - Enable pgvector extension (Supabase UI or SQL)
   - Create `blog_chunks` table with embedding column (vector 1536)
   - Create `blog_metadata` table for dedup tracking
   - Create `blog_ingestion_log` table for audit
   - Deploy search_blog_chunks RPC function

2. **Service: Dedup Tracker** (`utils/dedup.ts`)
   - Read/write to `blog_metadata`
   - Tests: upsert idempotency, hash matching

**Outcome:** Database ready, dedup system testable.

### Phase 2: Scraping & Chunking (Week 2)

**Why second:** Independent of embedding API cost; can validate blog structure offline.

3. **Service: Blog Scraper** (`services/blog-scraper.ts`)
   - Crawl loyalpawrenting.pet/blogs/
   - Extract title, body, metadata
   - Test on live site (respecting robots.txt)
   - Dedup integration: check `blog_metadata` before scraping (optional optimization)

4. **Service: Chunker** (`services/chunker.ts`)
   - Split articles into ~2000 char chunks
   - Preserve URL + title + index
   - Hash original body for dedup
   - Unit tests: various text lengths, overlap correctness

**Outcome:** Can scrape and chunk a full blog locally; validate chunk quality before embedding.

### Phase 3: Embedding & Ingestion (Week 3)

**Why third:** Depends on Phase 1 (schema) + Phase 2 (chunks). Incurs OpenAI cost; prioritize after testing.

5. **Service: Embedder** (`services/embedder.ts`)
   - Batch embed chunks via OpenAI
   - Handle retries, rate limiting
   - Tests: API error simulation, batch correctness

6. **Route: POST /ingestion/trigger** (in `server/index.ts`)
   - Orchestrates: scraper → chunker → embedder → storage
   - Input: `{ full_reindex?: boolean }` (backfill vs. incremental)
   - Output: `{ status, chunk_count, duration_ms }`
   - Logs result to `blog_ingestion_log`

7. **Route: GET /ingestion/status** (in `server/index.ts`)
   - Polls `blog_ingestion_log` for recent jobs
   - Input: optional `?limit=10`
   - Output: `{ jobs: [ { id, status, chunk_count, created_at } ] }`

**Outcome:** Manual backfill possible; can index full blog via HTTP trigger.

### Phase 4: Retrieval Integration (Week 4)

**Why fourth:** Depends on Phase 1 (schema + RPC) + Phase 3 (populated vectors).

8. **Service: Blog RAG** (`services/blog-rag.ts`)
   - Query pgvector for top-k chunks
   - Format results for prompt injection
   - Tests: similarity scoring, top-k ordering

9. **Modify: POST /generate** (in `server/index.ts`)
   - Before OpenAI call: call blog-rag.retrieveContext(transcript)
   - Inject retrieved text into system prompt
   - Preserve fallback (if retrieval fails, still generate with instruction only)
   - Optional: surface source chunks in response

**Outcome:** `/generate` now returns RAG-augmented responses.

### Phase 5: Scheduled Sync (Week 5)

**Why fifth:** Depends on Phase 2-4 fully working; last to add operational burden.

10. **Scheduled Task: Daily Sync** (in `server/index.ts`)
    - Use `node-cron`: `0 2 * * *` (2 AM UTC daily)
    - Call ingestion pipeline with `full_reindex: false` (incremental)
    - Log results; alert on failure (optional: Slack webhook)
    - Respects robots.txt; 1-2 req/sec rate limit

**Outcome:** Blog stays fresh automatically; manual trigger still available.

### Phase 6: Monitoring & Refinement (Week 6)

11. **Instrumentation**
    - Chunk count and embedding cost tracking
    - Retrieval hit rate (% of /generate calls that find relevant chunks)
    - Sync job latency, success rate

12. **Tuning**
    - Adjust chunk size based on relevance feedback
    - Adjust top-k (currently 3) based on prompt quality
    - Adjust sync schedule if blog updates are infrequent

---

## Integration with Existing `/generate` Route

### Current Flow (No RAG)

```typescript
POST /generate { promptId, transcript, instructionId? }
  ↓
1. Fetch prompt + instruction from Supabase (parallel)
2. Interpolate [[field]] in prompt
3. Build system = instruction || "You are a helpful assistant"
4. Call OpenAI { system, user: transcript }
5. Return response
```

### New Flow (With RAG)

```typescript
POST /generate { promptId, transcript, instructionId? }
  ↓
1. Fetch prompt + instruction from Supabase (parallel)
2. Interpolate [[field]] in prompt
3. Call blog-rag.retrieveContext(transcript)  ← NEW: retrieve chunks
4. Build system = instruction + retrieved_context + original_system
5. Call OpenAI { system, user: transcript }
6. Return response
   ↓ Optional:
7. Attach { source_chunks: [...] } to response (indicate which blog posts were used)
```

### Code Structure

**Minimal change to existing /generate:**

```typescript
// server/index.ts
import { retrieveContext } from './services/blog-rag';

app.post('/generate', async (req, res) => {
  const { promptId, transcript, instructionId } = req.body;

  try {
    // Existing logic
    const [prompt, instruction] = await Promise.all([...]);
    const interpolated = interpolate(prompt.text, req.body.fields);

    // NEW: RAG enrichment
    let systemPrompt = instruction?.text || DEFAULT_SYSTEM;
    try {
      const context = await retrieveContext(transcript);
      if (context.chunks.length > 0) {
        systemPrompt = `${systemPrompt}\n\nRelevant Context from Blog:\n${context.raw_text}`;
      }
    } catch (err) {
      // Retrieval failed: log and continue without RAG
      console.error('RAG retrieval failed:', err);
      // systemPrompt unchanged
    }

    // Existing OpenAI call
    const response = await openai.responses.create({
      system: systemPrompt,
      user: transcript,
    });

    res.json({ response });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

### Why Service Function (Not Middleware)

- **Middleware** is for cross-cutting concerns (auth, logging, parsing)
- **RAG retrieval** is domain-specific to `/generate`, not needed on other routes
- **Service function** (`blog-rag.retrieveContext()`) is cleaner, testable, and composable
- **Error handling:** If RAG fails, continue without it (graceful degradation easier in service than middleware)

---

## Scheduled Sync: node-cron vs. Separate Worker

### Recommendation: **node-cron inside the Express process**

**Why:**
- Blog updates are infrequent (weekly/monthly); no high frequency needed
- Single process deployment (Fly.io Docker) makes external queues unnecessary
- node-cron adds ~10KB to bundle; negligible
- Fly.io scheduled machines add operational complexity (extra service, auth, monitoring)

**Tradeoff:**
- If task takes >30 minutes or crashes process: migrate to Fly.io scheduled machine
- Blog scraping is expected to be ~5-10 minutes (100 articles × 2 req/sec = ~50 sec scrape, 5-10 min embedding)
- **Acceptable risk:** If sync fails, retry on next scheduled run (usually same day)

**Implementation:**

```typescript
import cron from 'node-cron';

// Run daily at 2 AM UTC
cron.schedule('0 2 * * *', async () => {
  try {
    const result = await ingestBlogPipeline({ full_reindex: false });
    console.log(`✓ Blog sync: ${result.chunk_count} chunks in ${result.duration_ms}ms`);
  } catch (err) {
    console.error('✗ Blog sync failed:', err);
    // Optional: send alert (Slack, email)
  }
});
```

---

## Backfill vs. Scheduled Sync

### Design Decision: **Single Pipeline, Two Invocation Paths**

Both use the same `ingestBlogPipeline()` function:

| Path | Trigger | Mode | Dedup | Log |
|------|---------|------|-------|-----|
| **Backfill** | Manual `POST /ingestion/trigger { full_reindex: true }` | Full crawl, embed all | Ignored | `blog_ingestion_log` |
| **Scheduled Sync** | node-cron daily 2 AM UTC | Incremental, only new/changed | Enabled (dedup filter) | `blog_ingestion_log` |

**Why not separate scripts?**
- Shared code avoids bugs from duplication
- Single point of logging, monitoring
- Idempotent upserts (ON CONFLICT DO UPDATE) allow both paths to write safely

**Idempotency Pattern:**
```sql
-- blog_chunks table
INSERT INTO blog_chunks (url, chunk_index, chunk_text, embedding, ...)
VALUES (...)
ON CONFLICT (url, chunk_index) DO UPDATE SET
  chunk_text = EXCLUDED.chunk_text,
  embedding = EXCLUDED.embedding,
  updated_at = now();
```

This allows backfill and sync to coexist:
- Backfill processes all articles, upserts every chunk
- Sync processes only new/changed, upserts those chunks
- No duplication, no data loss

---

## Supabase pgvector Setup

### Required SQL

```sql
-- Enable pgvector (run in Supabase SQL Editor or via `supabase db push`)
CREATE EXTENSION IF NOT EXISTS vector;

-- Create blog_chunks table
CREATE TABLE blog_chunks (
  id BIGSERIAL PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  chunk_index INT NOT NULL,
  total_chunks INT NOT NULL,
  chunk_text TEXT NOT NULL,
  embedding VECTOR(1536),
  embedded_at TIMESTAMP DEFAULT now(),
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  UNIQUE(url, chunk_index)
);

-- Create blog_metadata for dedup tracking
CREATE TABLE blog_metadata (
  id BIGSERIAL PRIMARY KEY,
  url TEXT UNIQUE NOT NULL,
  content_hash TEXT NOT NULL,
  last_embedded_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- Create blog_ingestion_log for audit trail
CREATE TABLE blog_ingestion_log (
  id BIGSERIAL PRIMARY KEY,
  job_id TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL, -- 'pending', 'running', 'completed', 'failed'
  chunk_count INT,
  error_message TEXT,
  duration_ms INT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- Create search RPC function (PostgREST limitation workaround)
CREATE FUNCTION search_blog_chunks(
  embedding VECTOR(1536),
  k INT DEFAULT 3,
  threshold FLOAT DEFAULT 0.5
) RETURNS TABLE(
  id BIGINT,
  url TEXT,
  title TEXT,
  chunk_index INT,
  chunk_text TEXT,
  similarity FLOAT
) AS $$
  SELECT id, url, title, chunk_index, chunk_text,
         1 - (embedding <=> $1)::float AS similarity
  FROM blog_chunks
  WHERE 1 - (embedding <=> $1)::float > $2
  ORDER BY similarity DESC
  LIMIT $3;
$$ LANGUAGE SQL;

-- Create index for faster similarity search
CREATE INDEX idx_blog_chunks_embedding ON blog_chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Grant permissions to your app's database user
GRANT EXECUTE ON FUNCTION search_blog_chunks TO authenticated;
GRANT SELECT ON blog_chunks TO authenticated;
GRANT SELECT ON blog_metadata TO authenticated;
GRANT INSERT, UPDATE ON blog_ingestion_log TO authenticated;
```

---

## Error Handling & Resilience

### Scenario: Partial Failure in Pipeline

**Scraper succeeds, chunker fails:**
- Scraper writes logs, returns articles
- Chunker exception caught, logged
- **Action:** Fail job, don't update `blog_metadata`
- **Retry:** Next sync will re-scrape same URL (dedup has no record)

**Chunker succeeds, embedder fails (mid-batch):**
- 45/50 chunks embedded successfully
- Embedder API times out on chunk #46
- **Action:** Log failure, don't update `blog_metadata` for that article
- **Retry:** Next sync will re-embed from URL, safe via upsert

**Embedder succeeds, storage fails:**
- Vectors in memory, DB insert fails (connection lost)
- **Action:** Log failure, don't update `blog_metadata`
- **Retry:** Next sync will attempt same chunks, upsert deduplicates

### Graceful Degradation: RAG Retrieval Fails

**At /generate time:**
```typescript
let context = { chunks: [], raw_text: '' };
try {
  context = await blog-rag.retrieveContext(transcript);
} catch (err) {
  console.warn('RAG retrieval failed; generating without context:', err);
  // context remains empty
}

const systemPrompt = instruction + context.raw_text; // if empty, just instruction
```

Result: User gets response without blog context, not an error.

---

## Performance Considerations

### Embedding Cost

- Blog articles: ~100
- Chunks per article: ~5 (average)
- Tokens per chunk: ~500 (2000 chars)
- **Full index:** 100 × 5 × 500 = 250,000 tokens = **$5 USD** (text-embedding-3-small at $0.02/1M)
- **Incremental sync:** 5 new articles × 5 chunks × 500 tokens = 12,500 tokens = **$0.25**

### Retrieval Latency

- Embed transcript: ~50ms (OpenAI API)
- Query pgvector: ~10ms (Supabase)
- Format results: ~2ms
- **Total RAG overhead:** ~60ms per `/generate` request

### Storage

- 500 chunks × 1536 dims × 4 bytes/float = ~3 MB vectors
- Text storage (chunks + metadata): ~5 MB
- **Total:** ~8 MB, negligible for Supabase

---

## Testing Strategy

### Unit Tests (Per Service)

- **Scraper:** Mock HTTP responses, validate parsing
- **Chunker:** Various text lengths, verify overlap and indexing
- **Embedder:** Mock OpenAI API, test batching and retries
- **Dedup:** Hash matching, upsert idempotency
- **RAG Service:** Mock pgvector query, verify formatting

### Integration Tests

- Full pipeline (scrape → chunk → embed → store) against test blog subset
- Retrieval flow (embed → query → format) against populated test DB

### E2E Tests

- Manual trigger `POST /ingestion/trigger` on staging, verify chunks in DB
- Check `/generate` returns augmented response with blog context

---

## Sources

- [RAG in Production: From Website Crawl to Vector Search That Actually Works (2026)](https://use-apify.com/blog/rag-production-architecture-2026)
- [Web Scraping Architecture Patterns: From Prototype to Production (2026)](https://use-apify.com/blog/web-scraping-architecture-patterns)
- [pgvector: Embeddings and vector similarity | Supabase Docs](https://supabase.com/docs/guides/database/extensions/pgvector)
- [Vector columns | Supabase Docs](https://supabase.com/docs/guides/ai/vector-columns)
- [GitHub - Priom7/RAG-System-Architecture-With-NodeJS](https://github.com/Priom7/RAG-System-Architecture-With-NodeJS)
- [When to Use Single Functions, Jobs, and Cron Jobs in Node.js](https://medium.com/@barreira/when-to-use-single-functions-jobs-and-cron-jobs-in-node-js-a-practical-guide-ef83bd1826e5)
- [Schedulers in Node: A Comparison of the Top 10 Libraries](https://betterstack.com/community/guides/scaling-nodejs/best-nodejs-schedulers/)
- [RAG API Integration Patterns: Best Practices For Developer Teams](https://customgpt.ai/rag-api-integration-patterns/)
- [Understanding the Middleware Pattern in Express.js](https://dzone.com/articles/understanding-middleware-pattern-in-expressjs)
- [JavaScript Web Scraping with Node.js: The Complete Guide (2026)](https://www.scrapingdog.com/blog/javascript-web-scraping/)
- [Storing OpenAI embeddings in Postgres with pgvector](https://supabase.com/blog/openai-embeddings-postgres-vector)

---

*Architecture analysis: 2026-04-11*
