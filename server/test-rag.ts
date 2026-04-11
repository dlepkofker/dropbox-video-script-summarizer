import 'dotenv/config';
import {createClient} from '@supabase/supabase-js';
import OpenAI from 'openai';

const supabase = createClient(
    process.env.SUPABASE_URL!,
    (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_KEY)!,
);
const openai = new OpenAI({apiKey: process.env.OPENAI_API_KEY});

const {data: embed} = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: ['snuffle mat'],
});

const {data, error} = await supabase.rpc('match_blog_chunks', {
    query_embedding: embed[0].embedding,
    match_count: 5,
    match_threshold: 0.5,
});

if (error) {
    console.error(error);
    process.exit(1);
}

console.log('Top matches:');
(data as any[]).forEach((r, i) =>
    console.log(`${i + 1}. [${r.similarity.toFixed(3)}] ${r.title}\n   ${r.chunk_text.slice(0, 1500)}...\n`),
);
