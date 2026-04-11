import 'dotenv/config';
import {createClient} from '@supabase/supabase-js';
import OpenAI from 'openai';
import {crawlBlogUrls, scrapePost} from './scraper.js';
import {embedAndStore} from './embedder.js';

export interface SyncResult {
    processed: number;
    skipped: number;
    failed: number;
}

// Phase 3 imports runSync() directly — do not change this export signature
export async function runSync(): Promise<SyncResult> {
    const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_KEY ?? '';
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';

    if (!SUPABASE_URL || !SUPABASE_KEY || !OPENAI_API_KEY) {
        throw new Error(
            'Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY), OPENAI_API_KEY',
        );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const openai = new OpenAI({apiKey: OPENAI_API_KEY});

    let processed = 0;
    let skipped = 0;
    let failed = 0;

    const urls = await crawlBlogUrls();

    for (const url of urls) {
        try {
            const {title, body, urlHash} = await scrapePost(url);
            const result = await embedAndStore(supabase, openai, url, title, body, urlHash);

            if (result === 'skipped') {
                console.log(`[skip] ${url} (content unchanged)`);
                skipped++;
            } else {
                processed++;
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[error] ${url} — ${message}`);
            failed++;
        }
    }

    return {processed, skipped, failed};
}

// CLI entry point guard — prevents auto-execution when Phase 3 imports runSync()
// In ESM (NodeNext), there is no require.main === module; check argv instead
const isMain = process.argv[1]?.endsWith('sync-blog.ts') || process.argv[1]?.endsWith('sync-blog.js');

if (isMain) {
    const result = await runSync();
    console.log(
        `Sync complete: ${result.processed} posts processed, ${result.skipped} skipped (unchanged), ${result.failed} failed`,
    );
    process.exit(result.failed > 0 ? 1 : 0);
}
