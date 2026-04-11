import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import {spawn} from 'child_process';
import {readFileSync, writeFileSync, existsSync} from 'fs';
import {readFile, mkdtemp, rm} from 'fs/promises';
import {tmpdir} from 'os';
import {fileURLToPath} from 'url';
import {join, dirname} from 'path';
import ffmpegPath from 'ffmpeg-static';
import {createClient} from '@supabase/supabase-js';
import OpenAI from 'openai';
import cron from 'node-cron';
import {runSync} from './sync-blog.js';
import {preprocessTranscript, retrieveChunks, buildInstructions, type ChunkRow} from './rag.js';

// Allow the ffmpeg binary path to be overridden at runtime (e.g. in Docker or
// serverless environments where the bundled static binary may not be executable).
const FFMPEG = process.env.FFMPEG_PATH ?? (ffmpegPath as unknown as string);
const APP_KEY = process.env.DROPBOX_APP_KEY ?? '';
const APP_SECRET = process.env.DROPBOX_APP_SECRET ?? '';
const AAI_KEY = process.env.ASSEMBLYAI_API_KEY ?? '';
const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY ?? '';
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? '';
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o';
const PORT = process.env.PORT ?? 3001;
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173';
const REDIRECT_URI = process.env.REDIRECT_URI ?? `http://localhost:${PORT}/auth/callback`;
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? '';
if (!ADMIN_SECRET) {
    console.warn('[startup] ADMIN_SECRET is not set — POST /admin/sync-blog will return 401 for all requests');
}
// Resolve the token file relative to this compiled module so it survives
// process.cwd() changes and works regardless of how the server is invoked.
const TOKENS_FILE = join(dirname(fileURLToPath(import.meta.url)), '.tokens.json');

// Fail fast at startup rather than surfacing cryptic 401/500s at runtime.
// Checking all required secrets in one pass makes misconfiguration obvious.
const missing = [
    'DROPBOX_APP_KEY',
    'DROPBOX_APP_SECRET',
    'ASSEMBLYAI_API_KEY',
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'OPENAI_API_KEY',
].filter((k) => !process.env[k]);
if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
}

// Single shared clients — constructing these is expensive (TLS handshakes,
// connection pool allocation) and they are safe to reuse across requests.
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai = new OpenAI({apiKey: OPENAI_KEY});

// ── Dropbox token storage ──────────────────────────────────────────────────────
// Tokens are persisted to a local JSON file rather than a database because this
// server is a single-tenant tool (one Dropbox account). A multi-tenant system
// would store tokens per-user in an encrypted column.

interface Tokens {
    access_token: string;
    refresh_token: string;
    // Stored as a Unix ms timestamp with a 60-second safety margin already
    // applied so callers can do a simple `Date.now() >= expires_at` check.
    expires_at: number;
}

function loadTokens(): Tokens | null {
    if (!existsSync(TOKENS_FILE)) return null;
    try {
        const data = JSON.parse(readFileSync(TOKENS_FILE, 'utf8')) as Partial<Tokens>;
        if (data.access_token && data.refresh_token && data.expires_at) return data as Tokens;
        return null;
    } catch {
        return null;
    }
}

function saveTokens(tokens: Tokens) {
    writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

/**
 * Exchanges a refresh token for a new access token using HTTP Basic auth,
 * which is the OAuth 2.0 client_credentials pattern Dropbox mandates for
 * confidential clients. The refresh token is long-lived and reused across calls.
 */
async function refreshAccessToken(refreshToken: string): Promise<Tokens> {
    const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
        method: 'POST',
        headers: {
            Authorization: `Basic ${Buffer.from(`${APP_KEY}:${APP_SECRET}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({grant_type: 'refresh_token', refresh_token: refreshToken}),
    });
    if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
    const data = (await res.json()) as {access_token: string; expires_in: number};
    return {
        access_token: data.access_token,
        refresh_token: refreshToken,
        // Subtract 60 s from the stated TTL so we never hand a token to a
        // caller that will expire mid-request (clock-skew + network latency guard).
        expires_at: Date.now() + data.expires_in * 1000 - 60_000,
    };
}

// Lazy token refresh: only hit the Dropbox token endpoint when the cached
// access token is actually expired, avoiding unnecessary network round-trips.
async function getValidToken(): Promise<string | null> {
    let tokens = loadTokens();
    if (!tokens) return null;
    if (Date.now() >= tokens.expires_at) {
        tokens = await refreshAccessToken(tokens.refresh_token);
        saveTokens(tokens);
    }
    return tokens.access_token;
}

// ── App ────────────────────────────────────────────────────────────────────────

const app = express();
// CORS is intentionally wide here because this backend exclusively serves a
// single trusted frontend under our control. Production hardening would pin
// the origin to FRONTEND_URL.
app.use(cors());
app.use(express.json());

// ── Dropbox auth ───────────────────────────────────────────────────────────────
// Standard OAuth 2.0 Authorization Code flow. `token_access_type: 'offline'`
// instructs Dropbox to issue a refresh token alongside the short-lived access
// token, enabling silent re-authentication without user interaction.

app.get('/auth/start', (_req, res) => {
    const params = new URLSearchParams({
        client_id: APP_KEY,
        response_type: 'code',
        redirect_uri: REDIRECT_URI,
        token_access_type: 'offline',
    });
    res.redirect(`https://www.dropbox.com/oauth2/authorize?${params}`);
});

app.get('/auth/callback', async (req, res) => {
    const code = req.query.code as string | undefined;
    if (!code) {
        res.status(400).send('Missing code');
        return;
    }
    const tokenRes = await fetch('https://api.dropboxapi.com/oauth2/token', {
        method: 'POST',
        headers: {
            Authorization: `Basic ${Buffer.from(`${APP_KEY}:${APP_SECRET}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI}),
    });
    if (!tokenRes.ok) {
        res.status(500).send(`Token exchange failed: ${await tokenRes.text()}`);
        return;
    }
    const data = (await tokenRes.json()) as {access_token: string; refresh_token: string; expires_in: number};
    saveTokens({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + data.expires_in * 1000 - 60_000,
    });
    res.redirect(FRONTEND_URL);
});

// The frontend polls this endpoint to check auth state and retrieve a usable
// token without ever seeing the refresh token or the app secret.
app.get('/auth/token', async (_req, res) => {
    try {
        const token = await getValidToken();
        if (!token) {
            res.status(401).json({error: 'Not authenticated'});
            return;
        }
        res.json({access_token: token});
    } catch (err) {
        res.status(500).json({error: err instanceof Error ? err.message : String(err)});
    }
});

// Soft-delete: overwrite with an empty object rather than unlinking the file,
// so a partial-write failure never leaves a corrupt token store.
app.post('/auth/logout', (_req, res) => {
    if (existsSync(TOKENS_FILE)) writeFileSync(TOKENS_FILE, '{}');
    res.json({ok: true});
});

// ── AssemblyAI proxy ───────────────────────────────────────────────────────────
// The AAI API key must never be exposed to the browser, so all AssemblyAI
// requests are routed through this thin proxy that injects the Authorization
// header server-side. This also keeps the key out of Vite's bundle entirely.

const AAI_BASE = 'https://api.assemblyai.com/v2';

app.post('/assemblyai/transcript', async (req, res) => {
    const proxyRes = await fetch(`${AAI_BASE}/transcript`, {
        method: 'POST',
        headers: {authorization: AAI_KEY, 'content-type': 'application/json'},
        body: JSON.stringify(req.body),
    });
    res.status(proxyRes.status).json(await proxyRes.json());
});

app.get('/assemblyai/transcript/:id', async (req, res) => {
    const proxyRes = await fetch(`${AAI_BASE}/transcript/${req.params.id}`, {
        headers: {authorization: AAI_KEY},
    });
    res.status(proxyRes.status).json(await proxyRes.json());
});

// ── Audio extraction ───────────────────────────────────────────────────────────
// AssemblyAI accepts a public URL or a direct upload. Dropbox temporary links
// work for small files, but very large video files are first demuxed server-side
// with ffmpeg — stripping the video stream and downsampling audio to 64 kbps MP3
// — to reduce upload size and avoid AssemblyAI's file-size limits.
//
// The pipeline is: Dropbox CDN URL → ffmpeg (stdio stream) → tmp file → AAI upload.
// Using a temp directory (mkdtemp) instead of a fixed path avoids race conditions
// if multiple extract-audio requests run concurrently.

app.post('/extract-audio', async (req, res) => {
    const {dropboxUrl} = req.body as {dropboxUrl?: string};
    if (!dropboxUrl) {
        res.status(400).json({error: 'dropboxUrl is required'});
        return;
    }

    console.log('Extracting audio from:', dropboxUrl.slice(0, 80) + '…');
    console.log('Using ffmpeg path:', FFMPEG);

    const tmpDir = await mkdtemp(join(tmpdir(), 'audio-'));
    const tmpFile = join(tmpDir, 'audio.mp3');

    try {
        await new Promise<void>((resolve, reject) => {
            const ffmpegProc = spawn(FFMPEG, [
                '-user_agent',
                'Mozilla/5.0', // some CDNs require a user-agent
                '-i',
                dropboxUrl,
                '-vn', // drop the video stream entirely — we only need audio
                '-acodec',
                'libmp3lame',
                '-ab',
                '64k', // 64 kbps is sufficient for speech; keeps upload small
                '-y', // overwrite output without prompting (safe; tmp path is unique)
                tmpFile,
            ]);

            // Hard kill after 20 minutes
            const killTimer = setTimeout(
                () => {
                    ffmpegProc.kill('SIGKILL');
                    reject(new Error('FFmpeg timed out after 5 minutes'));
                },
                5 * 60 * 1000,
            );

            // ffmpeg writes progress and diagnostics to stderr, not stdout.
            // Buffering the last 800 bytes lets us surface a useful error
            // message if the process exits non-zero.
            let stderrBuf = '';
            ffmpegProc.stderr.on('data', (chunk: Buffer) => {
                const text = chunk.toString();
                stderrBuf += text;
                console.log('[ffmpeg]', text.trimEnd());
            });
            ffmpegProc.on('error', (err) => {
                clearTimeout(killTimer);
                reject(err);
            });
            ffmpegProc.on('close', (code) => {
                clearTimeout(killTimer);
                if (code !== 0) reject(new Error(`FFmpeg exited ${code}: ${stderrBuf.slice(-800)}`));
                else resolve();
            });
        });

        console.log('FFmpeg finished, uploading to AssemblyAI…');

        // Read the entire MP3 into memory before uploading. For very large files
        // a streaming upload (piping ffmpeg stdout directly to the fetch body)
        // would be more memory-efficient, but adds complexity around error handling.
        const audioBuffer = await readFile(tmpFile);
        const uploadRes = await fetch(`${AAI_BASE}/upload`, {
            method: 'POST',
            headers: {Authorization: AAI_KEY, 'Content-Type': 'application/octet-stream'},
            body: audioBuffer,
        });

        if (!uploadRes.ok) {
            res.status(500).json({error: `AssemblyAI upload failed (${uploadRes.status}): ${await uploadRes.text()}`});
            return;
        }

        const {upload_url} = (await uploadRes.json()) as {upload_url: string};
        console.log('Uploaded to AssemblyAI:', upload_url);
        res.json({upload_url});
    } catch (err) {
        res.status(500).json({error: err instanceof Error ? err.message : String(err)});
    } finally {
        // Always clean up the temp directory — even on error — to prevent disk
        // accumulation in long-running server processes. `force: true` suppresses
        // errors if the directory was already removed.
        await rm(tmpDir, {recursive: true, force: true});
    }
});

// ── Transcripts (Supabase) ─────────────────────────────────────────────────────
// Transcript caching avoids re-running expensive speech-to-text jobs on every
// page load. The video_id (Dropbox file ID) is used as the natural key, which
// remains stable even if the file is renamed or moved within Dropbox.

app.get('/transcripts/:videoId', async (req, res) => {
    const {data} = await supabase
        .from('transcripts')
        .select('transcript')
        .eq('video_id', req.params.videoId)
        .maybeSingle();
    res.json({transcript: data?.transcript ?? null});
});

app.post('/transcripts', async (req, res) => {
    const {videoId, transcript} = req.body as {videoId?: string; transcript?: string};
    if (!videoId || transcript === undefined) {
        res.status(400).json({error: 'videoId and transcript are required'});
        return;
    }
    // upsert (INSERT … ON CONFLICT DO UPDATE) keeps the API idempotent:
    // re-transcribing the same video overwrites rather than duplicates the row.
    const {error} = await supabase
        .from('transcripts')
        .upsert({video_id: videoId, transcript}, {onConflict: 'video_id'});
    if (error) {
        res.status(500).json({error: error.message});
        return;
    }
    res.json({ok: true});
});

// ── Prompts (Supabase) ─────────────────────────────────────────────────────────
// Prompts are user-authored templates with optional [[field]] placeholders that
// get interpolated at generation time. Full CRUD is exposed so the UI can manage
// them without direct database access.

app.get('/prompts', async (_req, res) => {
    const {data, error} = await supabase.from('prompts').select('id, title, text');
    if (error) {
        res.status(500).json({error: error.message});
        return;
    }
    res.json(data);
});

app.post('/prompts', async (req, res) => {
    const {title, text} = req.body as {title?: string; text?: string};
    if (!title || !text) {
        res.status(400).json({error: 'title and text are required'});
        return;
    }
    const {error} = await supabase.from('prompts').insert({title, text});
    if (error) {
        res.status(500).json({error: error.message});
        return;
    }
    res.json({ok: true});
});

app.put('/prompts/:id', async (req, res) => {
    const {title, text} = req.body as {title?: string; text?: string};
    if (!title || !text) {
        res.status(400).json({error: 'title and text are required'});
        return;
    }
    const {error} = await supabase.from('prompts').update({title, text}).eq('id', Number(req.params.id));
    if (error) {
        res.status(500).json({error: error.message});
        return;
    }
    res.json({ok: true});
});

app.delete('/prompts/:id', async (req, res) => {
    const {error} = await supabase.from('prompts').delete().eq('id', Number(req.params.id));
    if (error) {
        res.status(500).json({error: error.message});
        return;
    }
    res.json({ok: true});
});

// ── Instructions (Supabase) ────────────────────────────────────────────────────
// Instructions map to OpenAI's system-prompt role: they set the model's persona
// and output constraints independently of the user-facing prompt template.
// Separating them from prompts allows the same instruction (e.g. "reply in
// Spanish, be concise") to be mixed with multiple prompts without duplication.

app.get('/instructions', async (_req, res) => {
    const {data, error} = await supabase.from('instructions').select('id, title, text');
    if (error) {
        res.status(500).json({error: error.message});
        return;
    }
    res.json(data);
});

app.post('/instructions', async (req, res) => {
    const {title, text} = req.body as {title?: string; text?: string};
    if (!title || !text) {
        res.status(400).json({error: 'title and text are required'});
        return;
    }
    const {error} = await supabase.from('instructions').insert({title, text});
    if (error) {
        res.status(500).json({error: error.message});
        return;
    }
    res.json({ok: true});
});

app.put('/instructions/:id', async (req, res) => {
    const {title, text} = req.body as {title?: string; text?: string};
    if (!title || !text) {
        res.status(400).json({error: 'title and text are required'});
        return;
    }
    const {error} = await supabase.from('instructions').update({title, text}).eq('id', Number(req.params.id));
    if (error) {
        res.status(500).json({error: error.message});
        return;
    }
    res.json({ok: true});
});

app.delete('/instructions/:id', async (req, res) => {
    const {error} = await supabase.from('instructions').delete().eq('id', Number(req.params.id));
    if (error) {
        res.status(500).json({error: error.message});
        return;
    }
    res.json({ok: true});
});

// ── AI Responses (Supabase) ────────────────────────────────────────────────────
// Generated responses are cached by (video_id, prompt_id) so the user can
// switch between prompts without re-running generation, and reload the page
// without losing previous results.

app.get('/ai-responses/:videoId', async (req, res) => {
    const {data} = await supabase
        .from('ai_response')
        .select('prompt_id, response, prompt_fields, instruction_id')
        .eq('video_id', req.params.videoId)
        .limit(1)
        .maybeSingle();
    res.json(data ?? null);
});

app.get('/ai-responses/:videoId/:promptId', async (req, res) => {
    const {data} = await supabase
        .from('ai_response')
        .select('response, prompt_fields, instruction_id')
        .eq('video_id', req.params.videoId)
        .eq('prompt_id', Number(req.params.promptId))
        .maybeSingle();
    res.json({
        response: data?.response ?? null,
        prompt_fields: data?.prompt_fields ?? null,
        instruction_id: data?.instruction_id ?? null,
    });
});

app.post('/ai-responses', async (req, res) => {
    const {videoId, promptId, response, fields, instructionId} = req.body as {
        videoId?: string;
        promptId?: number;
        response?: string;
        fields?: Record<string, string>;
        instructionId?: number;
    };
    if (!videoId || !promptId || response === undefined) {
        res.status(400).json({error: 'videoId, promptId and response are required'});
        return;
    }
    const {error} = await supabase.from('ai_response').upsert(
        {
            video_id: videoId,
            prompt_id: promptId,
            response,
            prompt_fields: fields ?? null,
            instruction_id: instructionId ?? null,
        },
        {onConflict: 'video_id'},
    );
    if (error) {
        res.status(500).json({error: error.message});
        return;
    }
    res.json({ok: true});
});

// ── Generate (OpenAI) ──────────────────────────────────────────────────────────
// Field interpolation and instruction lookup are done server-side so that:
//   1. The raw prompt template (which may contain sensitive framing) is never
//      sent to the browser.
//   2. The OpenAI API key is never exposed to the client.
//
// The prompt and instruction are fetched in parallel with Promise.all to avoid
// two sequential round-trips to Supabase.

app.post('/generate', async (req, res) => {
    const {promptId, transcript, fields, instructionId} = req.body as {
        promptId?: number;
        transcript?: string;
        fields?: Record<string, string>;
        instructionId?: number;
    };
    if (!promptId || !transcript) {
        res.status(400).json({error: 'promptId and transcript are required'});
        return;
    }

    // Fetch prompt and (optional) instruction concurrently.
    const [{data: prompt, error}, {data: instruction}] = await Promise.all([
        supabase.from('prompts').select('text').eq('id', promptId).maybeSingle(),
        instructionId
            ? supabase.from('instructions').select('text').eq('id', instructionId).maybeSingle()
            : Promise.resolve({data: null}),
    ]);
    if (error) {
        res.status(500).json({error: error.message});
        return;
    }
    if (!prompt) {
        res.status(404).json({error: 'Prompt not found'});
        return;
    }

    // Replace every [[key]] placeholder with the corresponding field value.
    // Using split/join instead of a regex replace avoids ReDoS risk on
    // adversarial field names that contain regex metacharacters.
    let promptContent = prompt.text;
    if (fields) {
        for (const [key, value] of Object.entries(fields)) {
            promptContent = promptContent.split(`[[${key}]]`).join(value);
        }
    }

    // RAG: preprocess transcript → embed summary → retrieve blog chunks
    // Wrapped in try/catch — any failure falls back to instructions-only (RETR-05)
    let ragChunks: ChunkRow[] | null = null;
    try {
        const summary = await preprocessTranscript(openai, transcript, OPENAI_MODEL);
        ragChunks = await retrieveChunks(supabase, openai, summary);
    } catch (err) {
        console.warn('[rag] Retrieval failed, falling back to instructions-only:', err instanceof Error ? err.message : String(err));
    }

    const builtInstructions = buildInstructions(ragChunks, instruction?.text ?? null);

    try {
        const response = await openai.responses.create({
            model: OPENAI_MODEL,
            input: `${promptContent}\n\n${transcript}`,
            ...(builtInstructions ? {instructions: builtInstructions} : {}),
        });
        res.json({result: response.output_text});
    } catch (err) {
        res.status(500).json({error: err instanceof Error ? err.message : String(err)});
    }
});

// ── Admin: manual sync trigger ─────────────────────────────────────────────────
// Requires X-Admin-Secret header matching ADMIN_SECRET env var.
// Returns 401 for missing/wrong secret. Returns sync result on success.
// Note: ADMIN_SECRET being empty causes 401 for ALL requests (Pitfall 6 guard).
app.post('/admin/sync-blog', async (req, res) => {
    const provided = req.headers['x-admin-secret'];
    if (!provided || !ADMIN_SECRET || provided !== ADMIN_SECRET) {
        res.status(401).json({error: 'Unauthorized'});
        return;
    }
    try {
        const result = await runSync();
        res.json({ok: true, ...result});
    } catch (err) {
        res.status(500).json({error: err instanceof Error ? err.message : String(err)});
    }
});

// ── Scheduled sync (node-cron) ─────────────────────────────────────────────────
// Runs daily at 2 AM UTC. Async wrapper with try/catch prevents unhandled
// rejection from crashing the process on sync failure (Pitfall 1).
cron.schedule('0 2 * * *', async () => {
    console.log('[cron] Starting daily blog sync…');
    try {
        const result = await runSync();
        console.log(`[cron] Done: ${result.processed} processed, ${result.skipped} skipped, ${result.failed} failed`);
    } catch (err) {
        console.error('[cron] Sync failed:', err instanceof Error ? err.message : String(err));
    }
});
console.log('[cron] Daily blog sync scheduled at 0 2 * * * (2 AM UTC)');

// ── Frontend static files ──────────────────────────────────────────────────────
// Serve the Vite-built SPA from the same process so a single `node server/index.js`
// command handles both API and UI in production, eliminating the need for a
// separate reverse-proxy entry point.

const distPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
app.use(express.static(distPath));
// Catch-all sends index.html for any unmatched path, enabling client-side
// routing to work correctly on hard refreshes and direct URL navigation.
app.get('*', (_req, res) => res.sendFile(join(distPath, 'index.html')));

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
