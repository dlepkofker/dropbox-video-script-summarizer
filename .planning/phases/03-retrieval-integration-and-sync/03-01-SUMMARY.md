---
phase: 03-retrieval-integration-and-sync
plan: "01"
subsystem: rag
tags: [rag, retrieval, openai, supabase, embeddings, typescript]
dependency_graph:
  requires:
    - "02-02: embedder.ts, sync-blog.ts (caller-provided client pattern to replicate)"
    - "01-01: match_blog_chunks RPC (pgvector migration)"
  provides:
    - "ChunkRow interface"
    - "preprocessTranscript() — translate + summarize transcript to English"
    - "retrieveChunks() — embed summary, query top-5 blog chunks at 0.70 threshold"
    - "buildInstructions() — assemble [Blog Knowledge] + [Instructions] block"
  affects:
    - "03-02: index.ts integration — imports from rag.ts"
tech_stack:
  added: []
  patterns:
    - "Caller-provided client instances (openai + supabase passed as parameters, not created in module)"
    - "Responses API for transcript preprocessing (translate + summarize in one call)"
    - "Single-string embedding (not array) for per-request transcript embedding"
    - "Graceful null return from buildInstructions (never empty string)"
key_files:
  created:
    - server/rag.ts
  modified: []
decisions:
  - "model parameter accepted by preprocessTranscript so index.ts can pass its OPENAI_MODEL constant — no duplicate constant in rag.ts"
  - "buildInstructions returns null (not '') when both inputs absent — empty string would silently alter model behavior (Pitfall 3)"
  - "[Blog Knowledge] block uses double newlines between chunks to match D-01b format with visual separation"
metrics:
  duration: "~5 minutes"
  completed: "2026-04-11"
  tasks_completed: 1
  files_created: 1
  files_modified: 0
---

# Phase 03 Plan 01: RAG Retrieval Module Summary

**One-liner:** Domain-separated `server/rag.ts` module with `ChunkRow` interface, transcript preprocessing via OpenAI Responses API, pgvector retrieval at 0.70 threshold, and `[Blog Knowledge]` instruction block assembly.

## What Was Built

`server/rag.ts` — a focused retrieval module following the Phase 2 domain-separation pattern (mirroring `scraper.ts` / `embedder.ts`). Exports four symbols:

**`ChunkRow` interface** — mirrors the exact columns returned by the `match_blog_chunks` RPC function, verified from both the SQL migration file and the working `test-rag.ts`.

**`preprocessTranscript(openai, transcript, model): Promise<string>`** — calls `openai.responses.create` with the D-02c prompt as `instructions` and the raw transcript as `input`. This placement ensures the system prompt is developer-controlled (T-03-01 threat mitigation). Returns `response.output_text` (the semantic English summary).

**`retrieveChunks(supabase, openai, summary): Promise<ChunkRow[]>`** — embeds the summary as a single string via `text-embedding-3-small`, then calls `supabase.rpc('match_blog_chunks', { query_embedding, match_count: 5, match_threshold: 0.70 })`. Throws on RPC error (caller's try/catch handles RETR-05 fallback). Returns empty array when RPC returns no matches.

**`buildInstructions(chunks, instructionText): string | null`** — assembles the `[Blog Knowledge]` block per D-01b format: title + URL header per chunk, chunks separated by double newlines, wrapped in `---` delimiters. Appends `[Instructions]` section if `instructionText` is non-null. Returns `null` (not empty string) when both inputs are absent.

## Design Decisions

1. **`model` as parameter in `preprocessTranscript`** — the plan specified accepting model name as a parameter so `index.ts` can pass its existing `OPENAI_MODEL` constant. Avoids duplicate constant definition in `rag.ts`, consistent with "no module-level constants that differ from what index.ts already has" directive.

2. **`buildInstructions` returns `null`, never `''`** — guarding against Pitfall 3 (RESEARCH.md): passing an empty string to `openai.responses.create` `instructions` subtly changes model behavior. The caller uses `...(instructions ? { instructions } : {})` pattern (already established in `index.ts`).

3. **`[Blog Knowledge]` block uses `\n\n` between chunks** — the RESEARCH.md Pattern 4 example shows visual separation between chunks; using double newlines (via `.join('\n\n')`) provides that separation while keeping the format readable.

## Deviations from Plan

None — plan executed exactly as written. The `buildInstructions` join uses `'\n\n'` between chunks (matching the RESEARCH.md Pattern 4 visual format) rather than `'\n'`, which is a minor formatting refinement consistent with the D-01b intent.

## TypeScript Compile Result

`npx tsc --noEmit` exits with code 0. No TypeScript errors.

## Pitfalls Encountered

None. The research document (RESEARCH.md) provided exact parameter names, RPC signature, and pitfall guidance that prevented all common issues:
- Used `query_embedding`, `match_count`, `match_threshold` (not `embedding`, `k`, `threshold`)
- Passed `input` as string (not array) for single-string embedding
- Did not create `new OpenAI()` or `createClient()` inside the module
- Returned `null` not `''` from `buildInstructions`

## Threat Surface Scan

No new network endpoints, auth paths, or schema changes introduced. `rag.ts` is a pure function module with no I/O initialization. All trust boundary crossings (OpenAI API, Supabase RPC) use caller-provided clients initialized from server-side env vars in `index.ts` — consistent with T-03-04 acceptance.

## Self-Check: PASSED

- [x] `server/rag.ts` exists
- [x] Commit `4571c38` exists in git log
- [x] `npx tsc --noEmit` exits 0
- [x] All 5 verification grep checks pass
