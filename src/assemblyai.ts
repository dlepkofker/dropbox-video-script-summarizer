// All AssemblyAI requests are routed through the server proxy (/assemblyai/*)
// so the API key never appears in the browser bundle. BASE points at the proxy
// rather than the AAI origin directly.
const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? '';
const BASE = `${SERVER_URL}/assemblyai`;

interface TranscriptResponse {
    id: string;
    // AAI's job lifecycle: queued → processing → completed | error.
    // There is no partial-result streaming on this REST API; the full
    // transcript is only available once status reaches 'completed'.
    status: 'queued' | 'processing' | 'completed' | 'error';
    text?: string;
    error?: string;
}

/**
 * Submits an audio URL to AssemblyAI and polls until the transcript is ready.
 *
 * AAI's transcription is asynchronous — submission returns a job ID immediately
 * and the caller must poll for completion. A fixed 3-second interval is a
 * pragmatic balance: short enough to feel responsive for 1-2 minute clips,
 * not so aggressive that it wastes quota on long videos. A production system
 * would use exponential back-off or AAI's webhook/streaming APIs instead.
 */
export async function requestTranscript(audioUrl: string): Promise<string> {
    const submitRes = await fetch(`${BASE}/transcript`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
            audio_url: audioUrl,
            // Providing a priority-ordered list of models lets AAI fall back
            // gracefully if the preferred model is unavailable.
            speech_models: ['universal-3-pro', 'universal-2'],
            language_detection: true,
        }),
    });

    if (!submitRes.ok) throw new Error(`Failed to submit transcription: ${submitRes.statusText}`);

    const {id} = (await submitRes.json()) as TranscriptResponse;

    // Busy-wait loop: AAI offers no push notification on the REST tier, so
    // polling is the only option. The loop runs on the main thread but is
    // non-blocking because each iteration awaits a Promise (setTimeout + fetch),
    // yielding control back to the event loop between ticks.
    while (true) {
        await new Promise((resolve) => setTimeout(resolve, 3000));

        const pollRes = await fetch(`${BASE}/transcript/${id}`);
        if (!pollRes.ok) throw new Error(`Failed to poll transcription: ${pollRes.statusText}`);

        const data = (await pollRes.json()) as TranscriptResponse;
        if (data.status === 'completed') return data.text ?? '';
        if (data.status === 'error') throw new Error(data.error ?? 'Transcription failed');
        // status === 'queued' | 'processing' — keep polling
    }
}
