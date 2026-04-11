import type {SupabaseClient} from '@supabase/supabase-js';
import type OpenAI from 'openai';

// ChunkRow mirrors the columns returned by the match_blog_chunks RPC function
// (verified from supabase/migrations/20260411073813_create_blog_chunks.sql and test-rag.ts).
export interface ChunkRow {
    id: number;
    url: string;
    title: string;
    chunk_text: string;
    chunk_index: number;
    url_hash: string;
    similarity: number;
}

const EMBED_MODEL = 'text-embedding-3-small';

/**
 * Translate (if not English) and summarize the raw transcript into a concise,
 * information-dense English paragraph. The semantic summary — not the raw transcript —
 * is what gets embedded, improving retrieval quality.
 *
 * Uses openai.responses.create (Responses API), consistent with the existing /generate
 * route pattern in index.ts. The transcript occupies the `input` (user) slot so the
 * preprocessing prompt in `instructions` is never user-controlled (T-03-01 mitigation).
 *
 * @param openai  Caller-provided OpenAI client (initialized in index.ts)
 * @param transcript  Raw transcript text from the video
 * @param model  OpenAI model to use (caller passes OPENAI_MODEL constant)
 * @returns Concise English semantic summary of the transcript
 */
export async function preprocessTranscript(
    openai: OpenAI,
    transcript: string,
    model: string,
): Promise<string> {
    const response = await openai.responses.create({
        model,
        input: transcript,
        instructions:
            'If this transcript is not in English, translate it to English first. ' +
            'Then summarize it into a concise, information-dense paragraph. ' +
            'Remove filler words and repetition. Preserve all meaningful content.',
    });
    return response.output_text;
}

/**
 * Embed the semantic summary string and query Supabase for the top 5 most similar
 * blog chunks with a similarity threshold of 0.70.
 *
 * Returns an empty array (never throws) when the RPC returns zero matches above threshold.
 * Throws on RPC errors so the caller's try/catch can trigger the RETR-05 fallback.
 *
 * @param supabase  Caller-provided Supabase client (initialized in index.ts)
 * @param openai  Caller-provided OpenAI client (initialized in index.ts)
 * @param summary  Preprocessed English semantic summary to embed and query with
 * @returns Array of matching ChunkRow objects (empty array when no matches)
 */
export async function retrieveChunks(
    supabase: SupabaseClient,
    openai: OpenAI,
    summary: string,
): Promise<ChunkRow[]> {
    // Embed the summary as a single string (not array) — one embedding per request
    const embeddingRes = await openai.embeddings.create({
        model: EMBED_MODEL,
        input: summary,
    });
    const embedding: number[] = embeddingRes.data[0].embedding;

    // Query the match_blog_chunks RPC with exact parameter names from the SQL migration
    const {data, error} = await supabase.rpc('match_blog_chunks', {
        query_embedding: embedding,
        match_count: 5,
        match_threshold: 0.70,
    });

    if (error) {
        throw new Error(`match_blog_chunks RPC failed: ${error.message}`);
    }

    // data is null or empty array when no matches above threshold — return [] in both cases
    if (!data || (data as ChunkRow[]).length === 0) {
        return [];
    }

    return data as ChunkRow[];
}

/**
 * Assemble the `instructions` string for openai.responses.create.
 *
 * Format (D-01b):
 *   [Blog Knowledge]
 *   ---
 *   **{title}** ({url})
 *   {chunk_text}
 *
 *   **{title}** ({url})
 *   {chunk_text}
 *   ---
 *
 *   [Instructions]
 *   {instructionText}
 *
 * Returns null (not empty string) when both inputs are absent — passing an empty string
 * to the instructions field changes model behavior (Pitfall 3 in RESEARCH.md).
 *
 * @param chunks  Retrieved blog chunks, or null/empty when retrieval failed or returned nothing
 * @param instructionText  User-selected instruction text from Supabase, or null if none selected
 * @returns Assembled instructions string, or null if both chunks and instructionText are absent
 */
export function buildInstructions(
    chunks: ChunkRow[] | null,
    instructionText: string | null,
): string | null {
    const parts: string[] = [];

    if (chunks && chunks.length > 0) {
        const chunkBlock = [
            '[Blog Knowledge]',
            '---',
            ...chunks.map((c) => `**${c.title}** (${c.url})\n${c.chunk_text}`),
            '---',
        ].join('\n\n');
        parts.push(chunkBlock);
    }

    if (instructionText) {
        if (parts.length > 0) {
            parts.push('[Instructions]');
        }
        parts.push(instructionText);
    }

    return parts.length > 0 ? parts.join('\n\n') : null;
}
