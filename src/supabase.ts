// All Supabase reads/writes go through the Express server rather than
// hitting Supabase directly from the browser. This keeps the anon key
// out of the client bundle and centralises authorization logic in one place.
const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? '';

// Centralised error extraction: tries to parse a structured `{error}` body
// first (our server always returns this shape), then falls back to the HTTP
// status text if the response isn't JSON (e.g. a 502 from a reverse proxy).
async function apiError(res: Response): Promise<Error> {
    try {
        const {error} = (await res.json()) as {error: string};
        return new Error(error);
    } catch {
        return new Error(`Request failed: ${res.statusText}`);
    }
}

// Transcript cache — avoids re-running expensive ASR jobs on repeated views.
// The server uses the Dropbox file ID as the stable natural key, so lookups
// remain correct even after a file is renamed or moved within Dropbox.

export async function getCachedTranscript(videoId: string): Promise<string | null> {
    const res = await fetch(`${SERVER_URL}/transcripts/${encodeURIComponent(videoId)}`);
    if (!res.ok) return null;
    const {transcript} = (await res.json()) as {transcript: string | null};
    return transcript;
}

export async function cacheTranscript(videoId: string, transcript: string): Promise<void> {
    const res = await fetch(`${SERVER_URL}/transcripts`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({videoId, transcript}),
    });
    if (!res.ok) throw await apiError(res);
}

// Prompts are user-authored templates stored in Supabase. The [[field]]
// placeholder syntax is resolved at generation time on the server, so the
// substitution logic lives in one authoritative place rather than being
// duplicated across client and server.

export interface Prompt {
    id: number;
    title: string;
    text: string;
}

export async function getPrompts(): Promise<Prompt[]> {
    const res = await fetch(`${SERVER_URL}/prompts`);
    if (!res.ok) throw await apiError(res);
    return res.json() as Promise<Prompt[]>;
}

export async function createPrompt(title: string, text: string): Promise<void> {
    const res = await fetch(`${SERVER_URL}/prompts`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({title, text}),
    });
    if (!res.ok) throw await apiError(res);
}

export async function updatePrompt(id: number, title: string, text: string): Promise<void> {
    const res = await fetch(`${SERVER_URL}/prompts/${id}`, {
        method: 'PUT',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({title, text}),
    });
    if (!res.ok) throw await apiError(res);
}

export async function deletePrompt(id: number): Promise<void> {
    const res = await fetch(`${SERVER_URL}/prompts/${id}`, {method: 'DELETE'});
    if (!res.ok) throw await apiError(res);
}

// Instructions map to the OpenAI system-prompt role. Decoupling them from
// prompt templates lets a single instruction (e.g. tone, language, output
// format) be composed with any prompt without duplication.

export interface Instruction {
    id: number;
    title: string;
    text: string;
}

export async function getInstructions(): Promise<Instruction[]> {
    const res = await fetch(`${SERVER_URL}/instructions`);
    if (!res.ok) throw await apiError(res);
    return res.json() as Promise<Instruction[]>;
}

export async function createInstruction(title: string, text: string): Promise<void> {
    const res = await fetch(`${SERVER_URL}/instructions`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({title, text}),
    });
    if (!res.ok) throw await apiError(res);
}

export async function updateInstruction(id: number, title: string, text: string): Promise<void> {
    const res = await fetch(`${SERVER_URL}/instructions/${id}`, {
        method: 'PUT',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({title, text}),
    });
    if (!res.ok) throw await apiError(res);
}

export async function deleteInstruction(id: number): Promise<void> {
    const res = await fetch(`${SERVER_URL}/instructions/${id}`, {method: 'DELETE'});
    if (!res.ok) throw await apiError(res);
}
