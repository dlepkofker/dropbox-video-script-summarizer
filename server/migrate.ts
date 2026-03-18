import 'dotenv/config';
import {readdir, readFile} from 'fs/promises';
import {join, dirname} from 'path';
import {fileURLToPath} from 'url';

const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;

if (!ACCESS_TOKEN || !SUPABASE_URL) {
    console.error('SUPABASE_ACCESS_TOKEN and SUPABASE_URL are required');
    process.exit(1);
}

// Derive the project ref from the Supabase URL (https://<ref>.supabase.co)
// so we don't need a separate SUPABASE_PROJECT_REF secret.
const PROJECT_REF = new URL(SUPABASE_URL).hostname.split('.')[0];

// Supabase Management API — supports arbitrary SQL including DDL, unlike the
// data API (PostgREST) which only handles CRUD on known tables.
const QUERY_URL = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');

async function query(sql: string): Promise<void> {
    const res = await fetch(QUERY_URL, {
        method: 'POST',
        headers: {Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({query: sql}),
    });
    if (!res.ok) throw new Error(`(${res.status}) ${await res.text()}`);
}

async function migrate() {
    // Tracking table is idempotent — safe to run on every deploy.
    await query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            filename text PRIMARY KEY,
            applied_at timestamp with time zone NOT NULL DEFAULT now()
        )
    `);

    // Fetch applied migrations via the same API so we don't need a second
    // connection type just for reads.
    const res = await fetch(QUERY_URL, {
        method: 'POST',
        headers: {Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({query: 'SELECT filename FROM schema_migrations'}),
    });
    if (!res.ok) throw new Error(`Failed to read schema_migrations: ${await res.text()}`);
    const rows = (await res.json()) as {filename: string}[];
    const applied = new Set(rows.map((r) => r.filename));

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    let count = 0;
    for (const file of files) {
        if (applied.has(file)) {
            console.log(`skip  ${file}`);
            continue;
        }

        const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf-8');

        // Wrap each migration in a transaction — if it fails, the database
        // stays clean and Fly aborts the deploy before traffic switches over.
        try {
            await query(`BEGIN; ${sql}; INSERT INTO schema_migrations (filename) VALUES ('${file}'); COMMIT;`);
            console.log(`apply ${file}`);
            count++;
        } catch (err) {
            await query('ROLLBACK').catch(() => {});
            throw new Error(`Failed on ${file}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    console.log(`Done: ${count} applied, ${applied.size} already up to date.`);
}

migrate().catch((err) => {
    console.error('Migration failed:', err.message);
    process.exit(1);
});
