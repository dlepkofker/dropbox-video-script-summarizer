const SERVER_URL = import.meta.env.VITE_SERVER_URL as string | undefined ?? '';

async function apiError(res: Response): Promise<Error> {
  try {
    const { error } = await res.json() as { error: string };
    return new Error(error);
  } catch {
    return new Error(`Request failed: ${res.statusText}`);
  }
}

export async function getCachedTranscript(videoId: string): Promise<string | null> {
  const res = await fetch(`${SERVER_URL}/transcripts/${encodeURIComponent(videoId)}`);
  if (!res.ok) return null;
  const { transcript } = await res.json() as { transcript: string | null };
  return transcript;
}

export async function cacheTranscript(videoId: string, transcript: string): Promise<void> {
  const res = await fetch(`${SERVER_URL}/transcripts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ videoId, transcript }),
  });
  if (!res.ok) throw await apiError(res);
}

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
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, text }),
  });
  if (!res.ok) throw await apiError(res);
}

export async function updatePrompt(id: number, title: string, text: string): Promise<void> {
  const res = await fetch(`${SERVER_URL}/prompts/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, text }),
  });
  if (!res.ok) throw await apiError(res);
}

export async function deletePrompt(id: number): Promise<void> {
  const res = await fetch(`${SERVER_URL}/prompts/${id}`, { method: 'DELETE' });
  if (!res.ok) throw await apiError(res);
}

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
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, text }),
  });
  if (!res.ok) throw await apiError(res);
}

export async function updateInstruction(id: number, title: string, text: string): Promise<void> {
  const res = await fetch(`${SERVER_URL}/instructions/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, text }),
  });
  if (!res.ok) throw await apiError(res);
}

export async function deleteInstruction(id: number): Promise<void> {
  const res = await fetch(`${SERVER_URL}/instructions/${id}`, { method: 'DELETE' });
  if (!res.ok) throw await apiError(res);
}
