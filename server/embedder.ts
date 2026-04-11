import type {SupabaseClient} from '@supabase/supabase-js';
import type OpenAI from 'openai';
import {RecursiveCharacterTextSplitter} from '@langchain/textsplitters';

const EMBED_MODEL = 'text-embedding-3-small';
const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 50;

const SPLITTER = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
});

export type EmbedResult = 'skipped' | 'embedded' | 'failed';

export async function embedAndStore(
    supabase: SupabaseClient,
    openai: OpenAI,
    url: string,
    title: string,
    body: string,
    urlHash: string,
): Promise<EmbedResult> {
    // Deduplication check — fetch stored hash for this URL
    const {data: existing, error: selectError} = await supabase
        .from('blog_chunks')
        .select('url_hash')
        .eq('url', url)
        .limit(1)
        .maybeSingle();

    if (selectError) throw new Error(`Dedup check failed for ${url}: ${selectError.message}`);

    const storedHash: string | null = existing?.url_hash ?? null;
    if (storedHash === urlHash) {
        return 'skipped';
    }

    // Content changed (or new) — chunk the body text
    const chunks: string[] = await SPLITTER.splitText(body);

    if (chunks.length === 0) {
        throw new Error(`No chunks produced for ${url} — body may be too short`);
    }

    // Embed all chunks in a single batched API call
    const embeddingResponse = await openai.embeddings.create({
        model: EMBED_MODEL,
        input: chunks,
    });
    const embeddings: number[][] = embeddingResponse.data.map((item) => item.embedding);

    // Delete existing chunks for this URL before inserting new ones
    // (chunk count may change if content grows/shrinks — upsert by index is unsafe)
    const {error: deleteError} = await supabase
        .from('blog_chunks')
        .delete()
        .eq('url', url);
    if (deleteError) throw new Error(`Delete failed for ${url}: ${deleteError.message}`);

    // Insert new chunks with embeddings
    // Note: pgvector column is typed as string in Supabase codegen — cast via unknown
    const rows = chunks.map((chunk_text, chunk_index) => ({
        url,
        title,
        chunk_text,
        chunk_index,
        url_hash: urlHash,
        embedding: embeddings[chunk_index] as unknown as string,
    }));

    const {error: insertError} = await supabase.from('blog_chunks').insert(rows);
    if (insertError) throw new Error(`Insert failed for ${url}: ${insertError.message}`);

    console.log(`[embed] ${url} → ${chunks.length} chunks`);
    return 'embedded';
}
