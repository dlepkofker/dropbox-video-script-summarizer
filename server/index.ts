import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import { Readable } from 'stream';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import ffmpegPath from 'ffmpeg-static';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

const APP_KEY       = process.env.DROPBOX_APP_KEY       ?? '';
const APP_SECRET    = process.env.DROPBOX_APP_SECRET    ?? '';
const AAI_KEY       = process.env.ASSEMBLYAI_API_KEY    ?? '';
const SUPABASE_URL  = process.env.SUPABASE_URL          ?? '';
const SUPABASE_KEY  = process.env.SUPABASE_ANON_KEY     ?? '';
const OPENAI_KEY    = process.env.OPENAI_API_KEY        ?? '';
const OPENAI_MODEL  = process.env.OPENAI_MODEL          ?? 'gpt-4o';
const PORT          = process.env.PORT                  ?? 3001;
const FRONTEND_URL  = process.env.FRONTEND_URL          ?? 'http://localhost:5173';
const REDIRECT_URI  = `http://localhost:${PORT}/auth/callback`;
const TOKENS_FILE   = join(dirname(fileURLToPath(import.meta.url)), '.tokens.json');

const missing = ['DROPBOX_APP_KEY', 'DROPBOX_APP_SECRET', 'ASSEMBLYAI_API_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'OPENAI_API_KEY']
  .filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai = new OpenAI({ apiKey: OPENAI_KEY });

// ── Dropbox token storage ──────────────────────────────────────────────────────

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

function loadTokens(): Tokens | null {
  if (!existsSync(TOKENS_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(TOKENS_FILE, 'utf8')) as Partial<Tokens>;
    if (data.access_token && data.refresh_token && data.expires_at) return data as Tokens;
    return null;
  } catch { return null; }
}

function saveTokens(tokens: Tokens) {
  writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

async function refreshAccessToken(refreshToken: string): Promise<Tokens> {
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${APP_KEY}:${APP_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
  const data = await res.json() as { access_token: string; expires_in: number };
  return { access_token: data.access_token, refresh_token: refreshToken, expires_at: Date.now() + data.expires_in * 1000 - 60_000 };
}

async function getValidToken(): Promise<string | null> {
  let tokens = loadTokens();
  if (!tokens) return null;
  if (Date.now() >= tokens.expires_at) { tokens = await refreshAccessToken(tokens.refresh_token); saveTokens(tokens); }
  return tokens.access_token;
}

// ── App ────────────────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

// ── Dropbox auth ───────────────────────────────────────────────────────────────

app.get('/auth/start', (_req, res) => {
  const params = new URLSearchParams({ client_id: APP_KEY, response_type: 'code', redirect_uri: REDIRECT_URI, token_access_type: 'offline' });
  res.redirect(`https://www.dropbox.com/oauth2/authorize?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code as string | undefined;
  if (!code) { res.status(400).send('Missing code'); return; }
  const tokenRes = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${APP_KEY}:${APP_SECRET}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
  });
  if (!tokenRes.ok) { res.status(500).send(`Token exchange failed: ${await tokenRes.text()}`); return; }
  const data = await tokenRes.json() as { access_token: string; refresh_token: string; expires_in: number };
  saveTokens({ access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + data.expires_in * 1000 - 60_000 });
  res.redirect(FRONTEND_URL);
});

app.get('/auth/token', async (_req, res) => {
  try {
    const token = await getValidToken();
    if (!token) { res.status(401).json({ error: 'Not authenticated' }); return; }
    res.json({ access_token: token });
  } catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
});

app.post('/auth/logout', (_req, res) => {
  if (existsSync(TOKENS_FILE)) writeFileSync(TOKENS_FILE, '{}');
  res.json({ ok: true });
});

// ── AssemblyAI proxy ───────────────────────────────────────────────────────────

const AAI_BASE = 'https://api.assemblyai.com/v2';

app.post('/assemblyai/transcript', async (req, res) => {
  const proxyRes = await fetch(`${AAI_BASE}/transcript`, {
    method: 'POST',
    headers: { authorization: AAI_KEY, 'content-type': 'application/json' },
    body: JSON.stringify(req.body),
  });
  res.status(proxyRes.status).json(await proxyRes.json());
});

app.get('/assemblyai/transcript/:id', async (req, res) => {
  const proxyRes = await fetch(`${AAI_BASE}/transcript/${req.params.id}`, {
    headers: { authorization: AAI_KEY },
  });
  res.status(proxyRes.status).json(await proxyRes.json());
});

// ── Audio extraction ───────────────────────────────────────────────────────────

app.post('/extract-audio', async (req, res) => {
  const { dropboxUrl } = req.body as { dropboxUrl?: string };
  if (!dropboxUrl) { res.status(400).json({ error: 'dropboxUrl is required' }); return; }
  if (!ffmpegPath) { res.status(500).json({ error: 'ffmpeg binary not found' }); return; }

  console.log('Extracting audio from:', dropboxUrl.slice(0, 80) + '…');

  const ffmpegProc = spawn(ffmpegPath as unknown as string, [
    '-i', dropboxUrl, '-vn', '-acodec', 'libmp3lame', '-ab', '64k', '-f', 'mp3', 'pipe:1',
  ]) as unknown as ChildProcessWithoutNullStreams;

  let stderrBuf = '';
  ffmpegProc.stderr.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString(); });
  ffmpegProc.on('close', (code: number | null) => {
    if (code !== 0) console.error(`FFmpeg exited ${code}\n${stderrBuf.slice(-1000)}`);
    else console.log('FFmpeg finished');
  });

  let uploadRes: Response;
  try {
    uploadRes = await (fetch as Function)(`${AAI_BASE}/upload`, {
      method: 'POST',
      headers: { Authorization: AAI_KEY, 'Content-Type': 'application/octet-stream' },
      duplex: 'half',
      body: Readable.toWeb(ffmpegProc.stdout),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err), ffmpeg_stderr: stderrBuf.slice(-500) });
    return;
  }

  if (!uploadRes.ok) { res.status(500).json({ error: `AssemblyAI upload failed (${uploadRes.status}): ${await uploadRes.text()}` }); return; }

  const { upload_url } = await uploadRes.json() as { upload_url: string };
  console.log('Uploaded to AssemblyAI:', upload_url);
  res.json({ upload_url });
});

// ── Transcripts (Supabase) ─────────────────────────────────────────────────────

app.get('/transcripts/:videoId', async (req, res) => {
  const { data } = await supabase.from('transcripts').select('transcript').eq('video_id', req.params.videoId).maybeSingle();
  res.json({ transcript: data?.transcript ?? null });
});

app.post('/transcripts', async (req, res) => {
  const { videoId, transcript } = req.body as { videoId?: string; transcript?: string };
  if (!videoId || transcript === undefined) { res.status(400).json({ error: 'videoId and transcript are required' }); return; }
  const { error } = await supabase.from('transcripts').upsert({ video_id: videoId, transcript }, { onConflict: 'video_id' });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ ok: true });
});

// ── Prompts (Supabase) ─────────────────────────────────────────────────────────

app.get('/prompts', async (_req, res) => {
  const { data, error } = await supabase.from('prompts').select('id, title, text');
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

app.post('/prompts', async (req, res) => {
  const { title, text } = req.body as { title?: string; text?: string };
  if (!title || !text) { res.status(400).json({ error: 'title and text are required' }); return; }
  const { error } = await supabase.from('prompts').insert({ title, text });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ ok: true });
});

app.put('/prompts/:id', async (req, res) => {
  const { title, text } = req.body as { title?: string; text?: string };
  if (!title || !text) { res.status(400).json({ error: 'title and text are required' }); return; }
  const { error } = await supabase.from('prompts').update({ title, text }).eq('id', Number(req.params.id));
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ ok: true });
});

app.delete('/prompts/:id', async (req, res) => {
  const { error } = await supabase.from('prompts').delete().eq('id', Number(req.params.id));
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ ok: true });
});

// ── Instructions (Supabase) ────────────────────────────────────────────────────

app.get('/instructions', async (_req, res) => {
  const { data, error } = await supabase.from('instructions').select('id, title, text');
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

app.post('/instructions', async (req, res) => {
  const { title, text } = req.body as { title?: string; text?: string };
  if (!title || !text) { res.status(400).json({ error: 'title and text are required' }); return; }
  const { error } = await supabase.from('instructions').insert({ title, text });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ ok: true });
});

app.put('/instructions/:id', async (req, res) => {
  const { title, text } = req.body as { title?: string; text?: string };
  if (!title || !text) { res.status(400).json({ error: 'title and text are required' }); return; }
  const { error } = await supabase.from('instructions').update({ title, text }).eq('id', Number(req.params.id));
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ ok: true });
});

app.delete('/instructions/:id', async (req, res) => {
  const { error } = await supabase.from('instructions').delete().eq('id', Number(req.params.id));
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ ok: true });
});

// ── AI Responses (Supabase) ────────────────────────────────────────────────────

app.get('/ai-responses/:videoId', async (req, res) => {
  const { data } = await supabase
    .from('ai_response')
    .select('prompt_id, response, prompt_fields, instruction_id')
    .eq('video_id', req.params.videoId)
    .limit(1)
    .maybeSingle();
  res.json(data ?? null);
});

app.get('/ai-responses/:videoId/:promptId', async (req, res) => {
  const { data } = await supabase
    .from('ai_response')
    .select('response, prompt_fields, instruction_id')
    .eq('video_id', req.params.videoId)
    .eq('prompt_id', Number(req.params.promptId))
    .maybeSingle();
  res.json({ response: data?.response ?? null, prompt_fields: data?.prompt_fields ?? null, instruction_id: data?.instruction_id ?? null });
});

app.post('/ai-responses', async (req, res) => {
  const { videoId, promptId, response, fields, instructionId } = req.body as { videoId?: string; promptId?: number; response?: string; fields?: Record<string, string>; instructionId?: number };
  if (!videoId || !promptId || response === undefined) { res.status(400).json({ error: 'videoId, promptId and response are required' }); return; }
  const { error } = await supabase
    .from('ai_response')
    .upsert({ video_id: videoId, prompt_id: promptId, response, prompt_fields: fields ?? null, instruction_id: instructionId ?? null }, { onConflict: 'video_id' });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ ok: true });
});

// ── Generate (OpenAI) ──────────────────────────────────────────────────────────

app.post('/generate', async (req, res) => {
  const { promptId, transcript, fields, instructionId } = req.body as { promptId?: number; transcript?: string; fields?: Record<string, string>; instructionId?: number };
  if (!promptId || !transcript) { res.status(400).json({ error: 'promptId and transcript are required' }); return; }

  const [{ data: prompt, error }, { data: instruction }] = await Promise.all([
    supabase.from('prompts').select('text').eq('id', promptId).maybeSingle(),
    instructionId ? supabase.from('instructions').select('text').eq('id', instructionId).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  if (error) { res.status(500).json({ error: error.message }); return; }
  if (!prompt) { res.status(404).json({ error: 'Prompt not found' }); return; }

  let promptContent = prompt.text;
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      promptContent = promptContent.split(`[[${key}]]`).join(value);
    }
  }

  try {
    const response = await openai.responses.create({
      model: OPENAI_MODEL,
      input: `${promptContent}\n\n${transcript}`,
      ...(instruction?.text ? { instructions: instruction.text } : {}),
    });
    res.json({ result: response.output_text });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
