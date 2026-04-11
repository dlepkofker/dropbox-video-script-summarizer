-- Enable pgvector extension (idempotent, per D-03)
create extension if not exists vector with schema extensions;

-- Create blog_chunks table (per STOR-01)
create table if not exists blog_chunks (
  id           bigserial primary key,
  url          text not null,
  title        text not null,
  chunk_text   text not null,
  chunk_index  integer not null,
  url_hash     text not null,
  embedding    extensions.vector(1536),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- HNSW index on embedding column using cosine distance (per STOR-02)
-- m=16 and ef_construction=64 are Supabase-recommended defaults for cosine workloads
create index if not exists blog_chunks_embedding_idx
  on blog_chunks
  using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- Similarity search RPC function (per STOR-03)
-- Uses RETURNS TABLE (not returns setof) to avoid transmitting raw 1536-dim vectors
-- 1 - (embedding <=> query_embedding) converts cosine distance to similarity score
create or replace function match_blog_chunks (
  query_embedding  extensions.vector(1536),
  match_count      int,
  match_threshold  float
)
returns table (
  id          bigint,
  url         text,
  title       text,
  chunk_text  text,
  chunk_index integer,
  url_hash    text,
  similarity  float
)
language sql stable
as $$
  select
    id,
    url,
    title,
    chunk_text,
    chunk_index,
    url_hash,
    1 - (embedding <=> query_embedding) as similarity
  from blog_chunks
  where 1 - (embedding <=> query_embedding) > match_threshold
  order by embedding <=> query_embedding asc
  limit least(match_count, 200);
$$;
