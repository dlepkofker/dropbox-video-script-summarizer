const SERVER_URL = import.meta.env.VITE_SERVER_URL as string | undefined ?? '';
const BASE = `${SERVER_URL}/assemblyai`;

interface TranscriptResponse {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'error';
  text?: string;
  error?: string;
}

export async function requestTranscript(audioUrl: string): Promise<string> {
  const submitRes = await fetch(`${BASE}/transcript`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audio_url: audioUrl, speech_models: ['universal-3-pro', 'universal-2'], language_detection: true }),
  });

  if (!submitRes.ok) throw new Error(`Failed to submit transcription: ${submitRes.statusText}`);

  const { id } = await submitRes.json() as TranscriptResponse;

  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const pollRes = await fetch(`${BASE}/transcript/${id}`);
    if (!pollRes.ok) throw new Error(`Failed to poll transcription: ${pollRes.statusText}`);

    const data = await pollRes.json() as TranscriptResponse;
    if (data.status === 'completed') return data.text ?? '';
    if (data.status === 'error') throw new Error(data.error ?? 'Transcription failed');
  }
}
