# RAG System Feature Landscape

**Domain:** Retrieval-Augmented Generation for blog content augmentation
**Project:** Dropbox Video Script Summarizer with RAG
**Researched:** 2026-04-11
**Confidence:** HIGH (verified across multiple 2025 sources + official documentation)

---

## Chunking Strategy

### Recommended Approach: Semantic Chunking with Recursive Fallback

**Strategy:** For blog posts, use **recursive chunking** (paragraph → sentence boundaries) as the implementation baseline, with semantic grouping as a future optimization.

**Why:** Recursive chunking balances semantic grouping with simplicity and respects natural document structure (blog posts naturally break into paragraphs and sentences). Research shows semantic chunking achieves ~70% better accuracy in retrieval benchmarks, but recursive chunking provides 80% of that benefit with 20% of the implementation complexity.

### Specific Parameters for Text-Embedding-3-Small

| Parameter | Recommended | Rationale |
|-----------|-------------|-----------|
| **Chunk size** | 512 tokens | Sweet spot for blog content; stays well within embedding model's 8,191 token limit (1536-dim output); balances context preservation with granularity |
| **Chunk overlap** | 20% (102 tokens) | Ensures continuity at boundaries; captures context split across chunk edges; 10-20% is industry standard |
| **Max tokens per chunk** | 1024 (hard limit) | Never exceed this; text-embedding-3-small input max is 8,191 tokens; 1024 is practical ceiling for quality |
| **Min tokens per chunk** | 128 | Avoid tiny chunks; minimum viable context for semantic meaning |
| **Breaking rule** | Sentence boundaries first, then paragraphs | Preserve semantic units; never split mid-sentence unless absolutely necessary |

**Implementation detail:** Use token counting (e.g., `js-tiktoken` library for JavaScript) to accurately measure chunk size. Character-based chunking underestimates token count by ~30% and causes overages.

### When Chunking Strategy Matters

Chunking becomes critical for blog posts because:
- Blog articles are typically 2,000-5,000+ tokens (single piece → multiple chunks)
- Retrieval must target specific sections (e.g., feeding tips, grooming advice) not entire articles
- Small, focused chunks improve retrieval precision (fewer false positives in top-k results)
- Blog structure naturally aligns with sentence/paragraph boundaries

### Anti-Pattern: Fixed-Size Character Chunking

**Avoid:** Splitting by fixed character count (e.g., every 2,000 chars). Results in:
- Semantic breaks mid-sentence or mid-paragraph
- Token count variance (2,000 chars ≈ 400-600 tokens depending on word density)
- Reduced retrieval precision when chunks have no semantic coherence

---

## Retrieval Parameters

### Top-K Selection

| Scenario | Top-K | Rationale |
|----------|-------|-----------|
| **Initial implementation** | 3-5 chunks | Conservative budget; focus on highest-confidence results; ~1,500-2,500 tokens of context added to prompt |
| **Standard deployment** | 5-10 chunks | Balance between coverage and context window usage; ~2,500-5,000 tokens of retrieved content |
| **High-precision mode** | 3 chunks | When accuracy critical (e.g., health/safety info); eliminates borderline results |
| **Exploratory/synthesis** | 10-15 chunks | Multi-perspective summaries; requires reranking to avoid redundancy |

**Guidance:** Start with **top-5** for this RAG system (blog augmentation). Adjust down to top-3 if AI responses become verbose or unfocused; increase to top-10 only after measuring retrieval precision.

### Similarity Threshold (Cosine Similarity Cutoff)

| Use Case | Threshold | Confidence Level |
|----------|-----------|------------------|
| **Production default** | 0.70 | HIGH confidence match; reasonable false-negative rate; avoids noise |
| **Strict filtering** | 0.75+ | Only include very relevant chunks; reduces hallucination risk; may miss valid context |
| **Lenient retrieval** | 0.60-0.65 | Broader coverage; risk of irrelevant chunks; best for exploratory queries |
| **No threshold** | Retrieve all top-k | Use when you trust ranking; let LLM decide relevance |

**Recommendation for this project:** Start with **0.70 threshold** and no hard top-k limit (retrieve all chunks with similarity > 0.70, up to a maximum of 10). This avoids both false negatives (missing relevant posts) and false positives (noise). Adjust threshold up to 0.75 if you see irrelevant chunks being included; adjust down to 0.65 if relevant blog posts are being filtered out.

**Important distinction:** Cosine distance (used in some libraries) = 1 - cosine similarity. If using a distance-based library, threshold becomes **0.25-0.30** instead of 0.70-0.75.

### Context Window Budget

**Blog content injected into system prompt typical overhead:**

| Configuration | Tokens Added | Prompt Utilization* |
|---------------|--------------|-------------------|
| Top-3 chunks, 512 tokens each | ~1,800 tokens | ~11% of 16K context (GPT-3.5) |
| Top-5 chunks, 512 tokens each | ~3,000 tokens | ~19% of 16K context |
| Top-10 chunks, 512 tokens each | ~6,000 tokens | ~37% of 16K context |

*Assumes 128K or 200K context model for GPT-4; 16K for GPT-3.5. Budget includes metadata overhead.

**Safe budget:** Reserve 25-30% of context window for retrieved content + metadata + original prompt. Remaining 70-75% is available for response generation. This prevents "lost in the middle" syndrome where LLM ignores early context due to capacity constraints.

---

## Context Injection Format

### Recommended Format: Chunked with Clear Boundaries and Attribution

**Structure:**

```
System prompt:
You are an expert assistant for [domain]. When answering questions, prioritize information from the provided blog context below.

<blog_context>
## Relevant Blog Articles

[For each chunk retrieved:]

**Source:** {blog_title} | Published: {date} | URL: {url}
**Excerpt:**
{chunk_text}

---
</blog_context>

[Original standing instruction for the AI]
```

**Concrete example:**

```
System prompt:
You are an expert assistant helping dog owners with pet care advice. When answering questions about dog health, diet, and behavior, prioritize information from the Loyal Paw Renting blog excerpts provided below.

<blog_context>
## Relevant Blog Articles

**Source:** How to Choose the Right Dog Food | Published: 2025-08-14 | URL: https://loyalpawrenting.pet/blogs/dog-food-guide/
**Excerpt:**
When selecting dog food, consider your dog's age, size, and activity level. High-quality proteins (chicken, beef, fish) should be primary ingredients. Avoid foods with excessive fillers like corn meal or soy. Dogs typically need 18-25% protein and 5-15% fat depending on their age...

---

**Source:** Understanding Dog Behavior and Training | Published: 2025-09-22 | URL: https://loyalpawrenting.pet/blogs/dog-training/
**Excerpt:**
Positive reinforcement is the most effective training method. Reward desired behaviors immediately (within 2 seconds) with treats or praise. Avoid punishment-based methods, which create anxiety and unpredictable behavior...

---
</blog_context>

Now proceed with answering the user's question, grounding your response in the blog context above.
```

### Format Rationale

1. **Clear boundaries (`<blog_context>` tags):** Signals to the LLM that this is injected context, not part of the original query.

2. **Attribution metadata (Source, Published, URL):** Allows the LLM to cite sources accurately and tells it when information was published (recency awareness). URLs enable users to verify answers.

3. **Explicit instruction in system prompt:** "Prioritize information from the provided blog context" guides the LLM to weight retrieved content appropriately.

4. **Chunk separation (`---` between articles):** Prevents chunk bleeding; makes it clear where one article ends and another begins.

5. **Hierarchy:** Source header > excerpt text. LLMs parse hierarchical structure more reliably than flat text.

### Format Anti-Pattern: Unstructured Concatenation

**Avoid:**
```
system_prompt += "\n\nRelevant blog posts:\n"
for chunk in retrieved_chunks:
    system_prompt += chunk.text + "\n"
```

**Problem:** LLM cannot distinguish chunks from each other, loses source attribution, and treats injected content identically to original instruction. Results in hallucinated citations and lower relevance weighting.

### When to Include Metadata

| Metadata | Include? | Why |
|----------|----------|-----|
| Blog post title | YES | Essential for citation and context framing |
| Published date | YES | Allows LLM to assess recency/confidence |
| Full URL | YES | Enables user verification and backlinks |
| Author name | OPTIONAL | Helpful if blog authors are recognized experts; skip if not relevant |
| Category/tags | NO (initially) | Adds noise; can add in v2 if needed for filtering |
| Internal chunk ID | NO | Unnecessary; use source + excerpt for identification |

---

## Search Strategy: Hybrid vs Pure Vector

### Recommendation: Pure Vector Search (Initially), Upgrade to Hybrid Later

**For Phase 1 (MVP):** Pure vector search with `text-embedding-3-small`.
- Simpler to implement: one embedding model, one similarity metric
- Sufficient for blog content: well-written blog posts have semantically rich language (less reliance on exact keyword matching)
- Cost-effective: avoids maintaining separate full-text index

**For Phase 2+ (Production hardening):** Hybrid search (vector + BM25 keyword search).

### When Hybrid Search Becomes Critical

Hybrid search (20-30% retrieval accuracy improvement) is essential when:

| Trigger | Example | Vector Risk |
|---------|---------|------------|
| Exact terminology matters | Blog post titles, product names, specific tips | Embedding loses exact match; wrong semantic area |
| Query contains abbreviations | "FAQ", "DIY", "GPT" | Abbreviations don't embed well |
| User searches with typos | "puppie training" vs "puppy training" | Vector search handles this, but keyword won't |
| Numerical precision required | "70% protein", "12 weeks old" | Numbers embed poorly; keyword catches them |
| Technical references | Command names, code samples | Keywords anchor citations; vectors can drift |

**For blog content specifically:** Hybrid search becomes valuable if:
- Blog titles are searched directly (e.g., "Article on dog grooming")
- Users query with breed names, product names, or health conditions
- Exact numerical recommendations matter (e.g., "How much should my dog eat?")

### Hybrid Implementation Pattern (When Ready)

```
1. Vector search → retrieve top-20 candidates by semantic similarity
2. BM25 keyword search → retrieve top-10 by keyword relevance
3. Merge results using Reciprocal Rank Fusion (RRF)
4. Rerank merged results by vector similarity
5. Return top-5 to system prompt
```

**RRF formula:** `score = 1/(60 + rank_in_vector) + 1/(60 + rank_in_keyword)` ensures both ranking systems contribute fairly.

---

## Table Stakes vs Nice-to-Haves

### Table Stakes (MVP Must-Have)

These features must exist for a functional RAG system:

| Feature | Implementation Effort | Why Essential |
|---------|----------------------|----------------|
| **Vector embedding pipeline** | Medium | Cannot do retrieval without embeddings; text-embedding-3-small via OpenAI API |
| **Chunk storage with vectors** | Low | Supabase pgvector table (`blog_chunks`); standard schema |
| **Similarity search** | Low | Supabase `<->` operator for vector distance; 5-10 lines of SQL |
| **Top-k filtering** | Low | `LIMIT 5` in SQL query; combine with similarity threshold in application code |
| **Metadata storage** | Low | Add columns: `blog_title`, `published_date`, `source_url`, `chunk_text` |
| **Context injection into system prompt** | Low | Concatenate chunks into prompt before `/generate` API call |
| **Deduplication (by URL hash)** | Low | Skip re-embedding if URL already exists in `blog_chunks` |

**Effort estimate for table stakes:** 40-60 hours (researcher + backend engineer).

### Nice-to-Haves (Phase 2+)

| Feature | Priority | Rationale |
|---------|----------|-----------|
| **Hybrid search (BM25 + vector)** | Medium | 20-30% retrieval accuracy boost; requires PostgreSQL full-text index |
| **Chunk reranking** | Medium | Reorder retrieved chunks by relevance; improves context quality when top-5 are mixed-quality |
| **Chunk deduplication** | Low | If same blog post exists in DB, detect and skip; prevents duplicate content in context |
| **Metadata filtering** | Low | Filter by publish date (e.g., "only posts from last 12 months") |
| **Query expansion** | Low | Expand user query with synonyms before embedding; improves recall for paraphrases |
| **Chunk summarization** | Low | Summarize large chunks before injection to fit more content in context window |
| **User feedback loop** | Low | Log which chunks were used for responses; measure which snippets lead to good outputs |
| **Admin dashboard** | Low | View indexed blog posts, trigger manual rescrape, check embedding status |
| **Scheduled sync metrics** | Low | Dashboard showing last scrape time, chunks indexed, errors during sync |

### What to Skip (Out of Scope)

| Feature | Why Skip |
|---------|----------|
| **Multi-language support** | Loyal Paw Renting blog is English-only; embedding model assumes English |
| **Real-time indexing** | Blog posts don't update constantly; scheduled sync (daily/weekly) is sufficient |
| **Graph RAG** | No structured relationships between blog posts to model; semantic chunking + vector search sufficient |
| **Query routing/branching** | Single fixed blog source; no need to choose between multiple document bases |
| **Streaming response generation** | Not in project scope; existing `/generate` endpoint is sufficient |

---

## Feature Dependencies & Sequencing

```
Chunking Strategy → Chunk Storage (pgvector)
                 ↓
Embedding Pipeline (text-embedding-3-small) → Deduplication
                                            ↓
Similarity Threshold → Retrieval (top-k + cosine similarity) → Context Injection Format
                                                            ↓
                                                      System Prompt Augmentation
                                                            ↓
                                                      AI Response Generation
```

**Critical path:**
1. Define chunking strategy (decide on 512-token, 20% overlap)
2. Set up pgvector storage (`blog_chunks` table)
3. Implement embedding pipeline (scrape blog, chunk, embed via OpenAI)
4. Build retrieval query (top-5, threshold 0.70)
5. Inject into system prompt (use format from "Context Injection Format" section)

**No blockers:** Each step depends on the previous, but each is implementable independently.

---

## Sources

- [Chunking Strategies to Improve LLM RAG Pipeline Performance | Weaviate](https://weaviate.io/blog/chunking-strategies-for-rag)
- [Document Chunking for RAG: 9 Strategies Tested (70% Accuracy Boost 2025)](https://langcopilot.com/posts/2025-10-11-document-chunking-for-rag-practical-guide)
- [Finding the Best Chunking Strategy for Accurate AI Responses | NVIDIA](https://developer.nvidia.com/blog/finding-the-best-chunking-strategy-for-accurate-ai-responses/)
- [Breaking up is hard to do: Chunking in RAG applications | Stack Overflow Blog](https://stackoverflow.blog/2024/12/27/breaking-up-is-hard-to-do-chunking-in-rag-applications/)
- [Optimizing Chunking, Embedding, and Vectorization for RAG | Medium](https://medium.com/@adnanmasood/optimizing-chunking-embedding-and-vectorization-for-retrieval-augmented-generation-ea3b083b68f7)
- [Chunk Documents | Microsoft Learn](https://learn.microsoft.com/en-us/azure/search/vector-search-how-to-chunk-documents)
- [A Guide to Setting Embedding Chunk Length | Medium](https://medium.com/@averyaveavi/a-guide-to-setting-embedding-chunk-length-finding-the-sweet-spot-between-small-and-large-chunks-03093464ee8a)
- [From RAG to Context - A 2025 year-end review of RAG | RAGFlow](https://ragflow.io/blog/rag-review-2025-from-rag-to-context)
- [How to Optimize RAG Context Windows for Smarter Retrieval | Medium](https://medium.com/@ai.nishikant/how-to-optimize-rag-context-windows-for-smarter-retrieval-b26859f03b2d)
- [Better RAG Retrieval — Similarity with Threshold | Medium](https://meisinlee.medium.com/better-rag-retrieval-similarity-with-threshold-a6dbb535ef9e)
- [Cosine Similarity vs Dot Product vs Euclidean Distance in RAG | QualityPoint](https://www.blog.qualitypointtech.com/2025/12/cosine-similarity-vs-dot-product-vs.html)
- [Mastering the Art of Prompting LLMs for RAG | Progress](https://www.progress.com/blogs/mastering-the-art-of-prompting-llms-for-rag/)
- [RAG prompt engineering makes LLMs super smart | K2View](https://www.k2view.com/blog/rag-prompt-engineering/)
- [Optimizing RAG with Hybrid Search & Reranking | Superlinked](https://superlinked.com/vectorhub/articles/optimizing-rag-with-hybrid-search-reranking)
- [Full-text search for RAG apps: BM25 & hybrid search | Redis](https://redis.io/blog/full-text-search-for-rag-the-precision-layer/)
- [Hybrid Search for RAG: BM25 + Vector Search Tutorial (2025) | Ailog RAG](https://app.ailog.fr/en/blog/guides/hybrid-search-rag)
- [Understanding hybrid search RAG for better AI answers | Meilisearch](https://www.meilisearch.com/blog/hybrid-search-rag)
- [Leveraging Metadata in RAG Customization | deepset Blog](https://www.deepset.ai/blog/leveraging-metadata-in-rag-customization)
- [Metadata for RAG: Improve Contextual Retrieval | Unstructured](https://unstructured.io/insights/how-to-use-metadata-in-rag-for-better-contextual-results)
- [Advanced RAG techniques with LangChain — Part 7 | Medium](https://medium.com/@roberto.g.infante/advanced-rag-techniques-with-langchain-part-7-843ecd3199f0)
