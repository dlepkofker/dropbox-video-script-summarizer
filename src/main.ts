import './style.css';
import {marked} from 'marked';
import DOMPurify from 'dompurify';
import {listAllVideos, getTemporaryLink, formatBytes} from './dropbox';
import {requestTranscript} from './assemblyai';
import {
    getCachedTranscript,
    cacheTranscript,
    getPrompts,
    createPrompt,
    updatePrompt,
    deletePrompt,
    getInstructions,
    createInstruction,
    updateInstruction,
    deleteInstruction,
} from './supabase';
import type {Prompt, Instruction} from './supabase';
import type {VideoFile} from './dropbox';

// Two-stage sanitization: marked converts Markdown to HTML, then DOMPurify
// strips any script tags, event handlers, or javascript: URIs that a malicious
// LLM response might embed. Neither library alone is sufficient — marked does
// not sanitize, and DOMPurify does not render Markdown.
function renderMarkdown(text: string): string {
    return DOMPurify.sanitize(marked.parse(text) as string);
}

// Extract deduplicated [[field]] placeholder names from a prompt template.
// The Set ensures each field name appears exactly once even if the template
// references the same placeholder multiple times.
function parseFields(text: string): string[] {
    const matches = text.match(/\[\[(\w+)\]\]/g) ?? [];
    return [...new Set(matches.map((m) => m.slice(2, -2)))];
}

// Resolve SERVER_URL from the Vite env at build time so the client always
// talks to the correct backend regardless of deployment environment.
const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? '';
// 4.5 GB threshold: above this size Dropbox temporary links are too large to
// pass directly to AssemblyAI, so we demux audio on the server first.
const LARGE_FILE_BYTES = 4.5 * 1024 * 1024 * 1024;
// Module-level state is intentional here: the app is a single-page vanilla TS
// SPA with no framework, so these variables serve as the single source of truth
// for the current session, equivalent to a Redux store in a React app.
let currentVideos: VideoFile[] = [];
let currentToken = '';
let activeView: 'videos' | 'prompts' | 'instructions' = 'videos';
let currentPage = 0;
const PAGE_SIZE = 10;

// Probe the server for a valid Dropbox token on startup. Returns null if the
// user hasn't authenticated yet, rather than throwing, so the caller can
// branch cleanly into the connect view.
async function fetchDropboxToken(): Promise<string | null> {
    try {
        const res = await fetch(`${SERVER_URL}/auth/token`);
        if (!res.ok) return null;
        const {access_token} = (await res.json()) as {access_token: string};
        return access_token;
    } catch {
        return null;
    }
}

// Manual HTML escaping rather than a library because the only attack surface
// here is string interpolation into template literals. The five characters
// covered (&, <, >, ") are sufficient to neutralise reflected XSS in attribute
// and text-content contexts. All user-supplied strings go through this before
// being written to innerHTML.
function escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderConnectView(): string {
    return `
    <div class="token-form">
      <h1>Dropbox Video Browser</h1>
      <p>Connect your Dropbox account to get started.</p>
      <a href="${SERVER_URL}/auth/start" class="connect-btn">Connect with Dropbox</a>
    </div>
  `;
}

function renderLoading(): string {
    return `<div class="loading"><div class="spinner"></div><p>Fetching videos…</p></div>`;
}

function renderError(message: string): string {
    return `<div class="error"><strong>Error:</strong> ${escapeHtml(message)}</div>`;
}

function renderVideoList(videos: VideoFile[]): string {
    if (videos.length === 0) {
        return `
      <div class="header">
        <h1>Dropbox Video Browser</h1>
        <button id="disconnect-btn">Disconnect</button>
      </div>
      <div class="empty">No video files found in your Dropbox.</div>
    `;
    }

    const totalPages = Math.ceil(videos.length / PAGE_SIZE);
    // Clamp page to valid range in case videos were deleted since the last render.
    const page = Math.min(currentPage, totalPages - 1);
    const start = page * PAGE_SIZE;
    const pageVideos = videos.slice(start, start + PAGE_SIZE);

    // Store the absolute index (not page-relative) in data-index so click
    // handlers can look up the correct video in currentVideos regardless of
    // which page the user is on.
    const rows = pageVideos
        .map(
            (v, i) => `
    <tr class="video-row" data-index="${start + i}">
      <td class="col-name">${escapeHtml(v.name)}</td>
      <td class="col-path">${escapeHtml(v.path_display)}</td>
      <td class="col-size">${formatBytes(v.size)}</td>
      <td class="col-date">${new Date(v.client_modified).toLocaleDateString()}</td>
    </tr>
  `,
        )
        .join('');

    const pagination =
        totalPages > 1
            ? `
    <div class="pagination">
      <button id="prev-page-btn" ${page === 0 ? 'disabled' : ''}>← Prev</button>
      <span class="page-info">Page ${page + 1} of ${totalPages}</span>
      <button id="next-page-btn" ${page >= totalPages - 1 ? 'disabled' : ''}>Next →</button>
    </div>
  `
            : '';

    return `
    <div class="header">
      <h1>Dropbox Video Browser</h1>
      <div class="header-right">
        <span class="count">${videos.length} video${videos.length !== 1 ? 's' : ''}</span>
        <button id="disconnect-btn">Disconnect</button>
      </div>
    </div>
    <div class="table-wrapper">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Path</th>
            <th>Size</th>
            <th>Modified</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${pagination}
  `;
}

function renderVideoDetail(video: VideoFile, url: string): string {
    return `
    <div class="header">
      <button id="back-btn" class="back-btn">← Back</button>
      <button id="disconnect-btn">Disconnect</button>
    </div>
    <div class="video-detail">
      <video src="${escapeHtml(url)}" controls></video>
      <div class="video-info">
        <h2>${escapeHtml(video.name)}</h2>
        <p class="video-path">${escapeHtml(video.path_display)}</p>
        <div class="video-meta">
          <span>${formatBytes(video.size)}</span>
          <span>${new Date(video.client_modified).toLocaleDateString()}</span>
        </div>
      </div>
      <div class="transcript-box">
        <div class="transcript-header">
          <span>Transcript</span>
          <div class="transcript-actions">
            <span id="transcript-timer" class="transcript-timer" hidden></span>
            <button id="save-transcript-btn" class="save-btn" hidden>Save</button>
            <button id="transcript-btn">Get Transcript</button>
            <button id="copy-transcript-btn" class="copy-btn" title="Copy transcript" disabled>
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            </button>
          </div>
        </div>
        <div class="transcript-body">
          <div id="transcript-content" class="transcript-content transcript-empty">
            Click "Get Transcript" to generate a transcript using AssemblyAI.
          </div>
          <button id="transcript-expand-btn" class="transcript-expand-btn" hidden>
            <span class="expand-arrow">▼</span>
          </button>
        </div>
      </div>
      <div id="prompt-box" hidden></div>
    </div>
  `;
}

// Renders the prompt selection and AI generation UI into #prompt-box.
// This function is intentionally heavy — it owns the complete lifecycle of
// prompt selection, cached-response restoration, field interpolation, generation,
// and save — keeping all that stateful logic co-located rather than scattered
// across the module.
async function showPromptBox(videoId: string) {
    const box = document.getElementById('prompt-box')!;
    box.innerHTML = '<p class="prompt-loading">Loading prompts…</p>';
    box.removeAttribute('hidden');

    let prompts: Prompt[];
    let instructions: Instruction[];
    try {
        // Fetch prompts and instructions in parallel — they are independent
        // resources and parallelising halves the latency of this initial render.
        [prompts, instructions] = await Promise.all([getPrompts(), getInstructions()]);
    } catch {
        box.innerHTML = '<p class="prompt-error">Failed to load prompts.</p>';
        return;
    }

    if (prompts.length === 0) {
        box.hidden = true;
        return;
    }

    const promptOptions = prompts.map((p) => `<option value="${p.id}">${escapeHtml(p.title)}</option>`).join('');

    const instructionOptions =
        instructions.length > 0
            ? instructions.map((i) => `<option value="${i.id}">${escapeHtml(i.title)}</option>`).join('')
            : '<option value="">— No instructions available —</option>';

    box.innerHTML = `
    <div class="prompt-selector">
      <div class="prompt-header">
        <span>Prompt</span>
        <div class="prompt-actions">
          <button id="save-response-btn" class="save-btn" hidden>Save</button>
          <button id="generate-btn" hidden>Generate</button>
        </div>
      </div>
      <div class="prompt-body">
        <div class="instruction-row">
          <label class="instruction-label" for="instruction-select">Instruction</label>
          <select id="instruction-select">${instructionOptions}</select>
        </div>
        <select id="prompt-select">
          <option value="">— Select a prompt —</option>
          ${promptOptions}
        </select>
        <div id="prompt-text" class="prompt-text" hidden></div>
        <div id="prompt-fields" class="prompt-fields" hidden></div>
        <div id="result-wrapper" hidden>
          <div class="result-toolbar">
            <button id="raw-toggle-btn" class="raw-toggle-btn">Raw</button>
            <button id="copy-response-btn" class="copy-btn" title="Copy response" disabled>
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            </button>
          </div>
          <div class="transcript-body">
            <div id="generate-result" class="generate-result"></div>
            <button id="response-expand-btn" class="transcript-expand-btn">
              <span class="expand-arrow">▼</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  `;

    const instructionSelect = document.getElementById('instruction-select') as HTMLSelectElement;
    const select = document.getElementById('prompt-select') as HTMLSelectElement;
    const promptText = document.getElementById('prompt-text')!;
    const promptFields = document.getElementById('prompt-fields')!;
    const generateBtn = document.getElementById('generate-btn') as HTMLButtonElement;
    const saveBtn = document.getElementById('save-response-btn') as HTMLButtonElement;
    const resultWrapper = document.getElementById('result-wrapper')!;
    const generateResult = document.getElementById('generate-result')!;
    const rawToggleBtn = document.getElementById('raw-toggle-btn') as HTMLButtonElement;
    const copyResponseBtn = document.getElementById('copy-response-btn') as HTMLButtonElement;
    const responseExpandBtn = document.getElementById('response-expand-btn') as HTMLButtonElement;
    // rawResponse holds the unmodified LLM output so the raw/rendered toggle
    // can switch back and forth without re-fetching.
    let rawResponse = '';
    let showingRaw = false;
    let responseExpanded = false;

    function displayResponse(text: string) {
        rawResponse = text;
        showingRaw = false;
        responseExpanded = false;
        rawToggleBtn.textContent = 'Raw';
        generateResult.innerHTML = renderMarkdown(text);
        generateResult.classList.remove('transcript-expanded');
        responseExpandBtn.querySelector('.expand-arrow')!.textContent = '▼';
        resultWrapper.removeAttribute('hidden');
        copyResponseBtn.disabled = false;
    }

    copyResponseBtn.addEventListener('click', async () => {
        await navigator.clipboard.writeText(generateResult.textContent ?? '');
        const svg = copyResponseBtn.innerHTML;
        copyResponseBtn.textContent = '✓';
        setTimeout(() => {
            copyResponseBtn.innerHTML = svg;
        }, 1500);
    });

    rawToggleBtn.addEventListener('click', () => {
        showingRaw = !showingRaw;
        if (showingRaw) {
            // textContent assignment is XSS-safe; the raw markdown is rendered
            // as plain text so no HTML can execute.
            generateResult.textContent = rawResponse;
            rawToggleBtn.textContent = 'Rendered';
        } else {
            generateResult.innerHTML = renderMarkdown(rawResponse);
            rawToggleBtn.textContent = 'Raw';
        }
    });

    responseExpandBtn.addEventListener('click', () => {
        responseExpanded = !responseExpanded;
        generateResult.classList.toggle('transcript-expanded', responseExpanded);
        responseExpandBtn.querySelector('.expand-arrow')!.textContent = responseExpanded ? '▲' : '▼';
    });

    async function selectPrompt(promptId: number) {
        const prompt = prompts.find((p) => p.id === promptId);
        if (!prompt) return;

        select.value = String(promptId);
        promptText.textContent = prompt.text;
        promptText.removeAttribute('hidden');
        generateBtn.removeAttribute('hidden');
        saveBtn.hidden = true;
        resultWrapper.hidden = true;
        generateResult.textContent = '';
        generateResult.classList.remove('generate-error');

        const fields = parseFields(prompt.text);
        if (fields.length > 0) {
            promptFields.innerHTML = fields
                .map(
                    (f) => `
        <div class="field-row">
          <label class="field-label" for="field-${escapeHtml(f)}">${escapeHtml(f)}</label>
          <input class="field-input" id="field-${escapeHtml(f)}" type="text" placeholder="Enter ${escapeHtml(f)}…" data-field="${escapeHtml(f)}" />
        </div>
      `,
                )
                .join('');
            promptFields.removeAttribute('hidden');
            // Disable Generate until all required fields are filled; the input
            // listener below re-evaluates the gate on every keystroke.
            generateBtn.disabled = true;
            promptFields.querySelectorAll<HTMLInputElement>('.field-input').forEach((input) => {
                input.addEventListener('input', () => {
                    const allFilled = Array.from(promptFields.querySelectorAll<HTMLInputElement>('.field-input')).every(
                        (i) => i.value.trim() !== '',
                    );
                    generateBtn.disabled = !allFilled;
                });
            });
        } else {
            promptFields.innerHTML = '';
            promptFields.hidden = true;
            generateBtn.disabled = false;
        }

        // Optimistically load any previously saved response for this
        // (video, prompt) pair so the UI feels instant on revisit.
        const cached = await fetch(`${SERVER_URL}/ai-responses/${encodeURIComponent(videoId)}/${promptId}`)
            .then(
                (r) =>
                    r.json() as Promise<{
                        response: string | null;
                        prompt_fields: Record<string, string> | null;
                        instruction_id: number | null;
                    }>,
            )
            .catch(() => ({response: null, prompt_fields: null, instruction_id: null}));

        if (cached.response) {
            if (cached.instruction_id) instructionSelect.value = String(cached.instruction_id);
            if (cached.prompt_fields) {
                // Restore field values from the saved response so the user can
                // see what inputs produced the cached output.
                promptFields.querySelectorAll<HTMLInputElement>('.field-input').forEach((input) => {
                    const val = cached.prompt_fields![input.dataset.field!];
                    if (val !== undefined) input.value = val;
                });
                generateBtn.disabled = false;
            }
            displayResponse(cached.response);
        }
    }

    select.addEventListener('change', () => {
        const promptId = Number(select.value);
        if (!promptId) {
            promptText.hidden = true;
            generateBtn.hidden = true;
            saveBtn.hidden = true;
            resultWrapper.hidden = true;
            return;
        }
        selectPrompt(promptId);
    });

    // Auto-select the most recently saved prompt for this video so returning
    // users land in a meaningful state rather than an empty selector.
    const existing = await fetch(`${SERVER_URL}/ai-responses/${encodeURIComponent(videoId)}`)
        .then((r) => r.json() as Promise<{prompt_id: number; response: string} | null>)
        .catch(() => null);

    if (existing?.prompt_id && prompts.find((p) => p.id === existing.prompt_id)) {
        selectPrompt(existing.prompt_id);
    }

    generateBtn.addEventListener('click', async () => {
        const promptId = Number(select.value);
        // Read transcript text directly from the DOM element — it's the live
        // text node that may have been edited by the user since page load.
        const transcript = document.getElementById('transcript-content')?.textContent ?? '';

        generateBtn.disabled = true;
        generateBtn.textContent = 'Generating…';
        saveBtn.hidden = true;
        resultWrapper.hidden = true;
        generateResult.classList.remove('generate-error');

        try {
            const instructionId = Number(instructionSelect.value) || undefined;
            const fieldInputs = promptFields.querySelectorAll<HTMLInputElement>('.field-input');
            const fields: Record<string, string> = {};
            fieldInputs.forEach((input) => {
                fields[input.dataset.field!] = input.value.trim();
            });

            const res = await fetch(`${SERVER_URL}/generate`, {
                method: 'POST',
                headers: {'content-type': 'application/json'},
                body: JSON.stringify({
                    promptId,
                    transcript,
                    instructionId,
                    // Omit fields key entirely when there are no placeholders
                    // to avoid sending an empty object the server must handle.
                    ...(Object.keys(fields).length > 0 ? {fields} : {}),
                }),
            });
            if (!res.ok) {
                const {error} = (await res.json()) as {error: string};
                throw new Error(error);
            }
            const {result} = (await res.json()) as {result: string};
            displayResponse(result);
            saveBtn.textContent = 'Save';
            saveBtn.disabled = false;
            saveBtn.hidden = false;
        } catch (err) {
            generateResult.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
            generateResult.classList.add('generate-error');
            resultWrapper.removeAttribute('hidden');
        } finally {
            generateBtn.disabled = false;
            generateBtn.textContent = 'Generate';
        }
    });

    saveBtn.addEventListener('click', async () => {
        const promptId = Number(select.value);
        const response = rawResponse;
        const instructionId = Number(instructionSelect.value) || undefined;
        const fieldInputs = promptFields.querySelectorAll<HTMLInputElement>('.field-input');
        const fields: Record<string, string> = {};
        fieldInputs.forEach((input) => {
            fields[input.dataset.field!] = input.value.trim();
        });

        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';

        try {
            const res = await fetch(`${SERVER_URL}/ai-responses`, {
                method: 'POST',
                headers: {'content-type': 'application/json'},
                body: JSON.stringify({
                    videoId,
                    promptId,
                    response,
                    instructionId,
                    ...(Object.keys(fields).length > 0 ? {fields} : {}),
                }),
            });
            if (!res.ok) {
                const {error} = (await res.json()) as {error: string};
                throw new Error(error);
            }
            saveBtn.textContent = 'Saved';
        } catch {
            saveBtn.textContent = 'Save';
            saveBtn.disabled = false;
            saveBtn.classList.add('save-error');
        }
    });
}

async function handleDisconnect() {
    await fetch(`${SERVER_URL}/auth/logout`, {method: 'POST'}).catch(() => {});
    // Clear in-memory state so a subsequent login starts with a clean slate,
    // avoiding stale video lists or tokens leaking between sessions.
    currentToken = '';
    currentVideos = [];
    activeView = 'videos';
    setActiveNavItem('videos');
    const app = document.getElementById('app')!;
    app.innerHTML = renderConnectView();
}

// Event binding is separated from HTML generation because innerHTML assignment
// destroys and recreates DOM nodes, detaching any previously registered listeners.
// Re-binding after every render is the simplest correct approach for a no-framework SPA.
function bindVideoList() {
    document.getElementById('disconnect-btn')?.addEventListener('click', handleDisconnect);
    document.querySelectorAll<HTMLTableRowElement>('.video-row').forEach((row) => {
        row.addEventListener('click', () => {
            const idx = Number(row.dataset.index);
            showVideoDetail(currentVideos[idx]);
        });
    });
    document.getElementById('prev-page-btn')?.addEventListener('click', () => {
        currentPage--;
        const app = document.getElementById('app')!;
        app.innerHTML = renderVideoList(currentVideos);
        bindVideoList();
    });
    document.getElementById('next-page-btn')?.addEventListener('click', () => {
        currentPage++;
        const app = document.getElementById('app')!;
        app.innerHTML = renderVideoList(currentVideos);
        bindVideoList();
    });
}

async function showVideoDetail(video: VideoFile) {
    const app = document.getElementById('app')!;
    app.innerHTML = renderLoading();

    try {
        // Dropbox temporary links expire after ~4 hours — fetching fresh on
        // every detail view avoids serving an expired URL to the <video> element.
        const url = await getTemporaryLink(currentToken, video.path_display);
        app.innerHTML = renderVideoDetail(video, url);

        document.getElementById('back-btn')?.addEventListener('click', () => {
            app.innerHTML = renderVideoList(currentVideos);
            bindVideoList();
        });
        document.getElementById('disconnect-btn')?.addEventListener('click', handleDisconnect);

        const transcriptBtn = document.getElementById('transcript-btn') as HTMLButtonElement;
        const saveBtn = document.getElementById('save-transcript-btn') as HTMLButtonElement;
        const copyTranscriptBtn = document.getElementById('copy-transcript-btn') as HTMLButtonElement;
        const transcriptContent = document.getElementById('transcript-content')!;
        const expandBtn = document.getElementById('transcript-expand-btn') as HTMLButtonElement;

        let transcriptExpanded = false;
        expandBtn.addEventListener('click', () => {
            transcriptExpanded = !transcriptExpanded;
            transcriptContent.classList.toggle('transcript-expanded', transcriptExpanded);
            expandBtn.querySelector('.expand-arrow')!.textContent = transcriptExpanded ? '▲' : '▼';
        });

        copyTranscriptBtn.addEventListener('click', async () => {
            const text = transcriptContent.textContent ?? '';
            await navigator.clipboard.writeText(text);
            const svg = copyTranscriptBtn.innerHTML;
            copyTranscriptBtn.textContent = '✓';
            setTimeout(() => {
                copyTranscriptBtn.innerHTML = svg;
            }, 1500);
        });

        function showExpandBtn() {
            expandBtn.removeAttribute('hidden');
        }

        function enableCopyBtn() {
            copyTranscriptBtn.disabled = false;
        }

        // Show cached transcript immediately if one exists, then reveal the
        // prompt box so the user can start generating without waiting for a new run.
        const cached = await getCachedTranscript(video.id);
        if (cached) {
            transcriptContent.className = 'transcript-content';
            transcriptContent.textContent = cached;
            transcriptBtn.textContent = 'Re-transcribe';
            showExpandBtn();
            enableCopyBtn();
            showPromptBox(video.id);
        }

        saveBtn.addEventListener('click', async () => {
            saveBtn.disabled = true;
            saveBtn.classList.remove('save-error');
            saveBtn.textContent = 'Saving…';
            try {
                await cacheTranscript(video.id, transcriptContent.textContent ?? '');
                saveBtn.textContent = 'Saved';
            } catch {
                saveBtn.textContent = 'Save';
                saveBtn.disabled = false;
                saveBtn.classList.add('save-error');
            }
        });

        const timerEl = document.getElementById('transcript-timer') as HTMLSpanElement;

        transcriptBtn.addEventListener('click', async () => {
            transcriptBtn.disabled = true;
            transcriptBtn.textContent = 'Transcribing…';
            saveBtn.hidden = true;
            transcriptContent.className = 'transcript-content transcript-loading';
            transcriptContent.textContent = 'Transcribing… this may take a few minutes.';

            // Wall-clock timer gives the user feedback on a process that can
            // take several minutes for long videos, reducing perceived abandonment.
            const start = Date.now();
            timerEl.textContent = '0s';
            timerEl.removeAttribute('hidden');
            const tick = setInterval(() => {
                timerEl.textContent = `${Math.floor((Date.now() - start) / 1000)}s`;
            }, 1000);

            try {
                let audioUrl = url;
                if (video.size > LARGE_FILE_BYTES) {
                    // For large files, offload audio extraction to the server
                    // (ffmpeg) before passing the URL to AssemblyAI. This avoids
                    // AssemblyAI's file-size limit and reduces transcription cost
                    // by stripping the video stream before upload.
                    transcriptContent.textContent = 'Extracting audio… (large file, this may take a few minutes)';
                    const extractRes = await fetch(`${SERVER_URL}/extract-audio`, {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({dropboxUrl: url}),
                    });
                    if (!extractRes.ok) {
                        const {error} = (await extractRes.json()) as {error: string};
                        throw new Error(error ?? 'Audio extraction failed');
                    }
                    const {upload_url} = (await extractRes.json()) as {upload_url: string};
                    audioUrl = upload_url;
                    transcriptContent.textContent = 'Transcribing… this may take a few minutes.';
                }
                const text = await requestTranscript(audioUrl);
                clearInterval(tick);
                const elapsed = ((Date.now() - start) / 1000).toFixed(1);
                timerEl.textContent = `${elapsed}s`;
                transcriptContent.className = 'transcript-content';
                transcriptContent.textContent = text;
                transcriptBtn.textContent = 'Re-transcribe';
                transcriptBtn.disabled = false;
                saveBtn.textContent = 'Save';
                saveBtn.disabled = false;
                saveBtn.hidden = false;
                showExpandBtn();
                enableCopyBtn();
                showPromptBox(video.id);
            } catch (err: unknown) {
                clearInterval(tick);
                timerEl.hidden = true;
                const message = err instanceof Error ? err.message : String(err);
                transcriptContent.className = 'transcript-content transcript-error';
                transcriptContent.textContent = `Error: ${message}`;
                transcriptBtn.textContent = 'Retry';
                transcriptBtn.disabled = false;
            }
        });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        // Render the error inline above the video list so the user doesn't lose
        // their place in the pagination and can try a different video.
        app.innerHTML = renderError(message) + renderVideoList(currentVideos);
        bindVideoList();
    }
}

async function loadVideos(token: string) {
    const app = document.getElementById('app')!;
    currentToken = token;
    app.innerHTML = renderLoading();

    try {
        const videos = await listAllVideos(token);
        // Sort descending by modification date so the most recently edited
        // videos appear at the top — the most common access pattern.
        currentVideos = videos.sort(
            (a, b) => new Date(b.client_modified).getTime() - new Date(a.client_modified).getTime(),
        );
        currentPage = 0;
        app.innerHTML = renderVideoList(currentVideos);
        bindVideoList();
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        app.innerHTML = renderError(message) + renderConnectView();
    }
}

// ── Prompt Editor ─────────────────────────────────────────────────────────────
// Pure render function: takes the full prompts array plus an optional editing ID
// and returns HTML. Keeping rendering stateless makes it trivial to refresh the
// list after any mutation by simply calling showPromptEditor() again.

function renderPromptEditor(prompts: Prompt[], editingId: number | null = null): string {
    const editing = editingId !== null ? prompts.find((p) => p.id === editingId) : null;

    const formTitle = editing ? 'Edit Prompt' : 'New Prompt';
    const submitLabel = editing ? 'Update' : 'Add Prompt';

    const form = `
    <div class="prompt-editor-form">
      <h2>${formTitle}</h2>
      ${editing ? `<input type="hidden" id="pe-id" value="${editing.id}" />` : ''}
      <label for="pe-title">Title</label>
      <input id="pe-title" type="text" placeholder="Prompt title" value="${editing ? escapeHtml(editing.title) : ''}" />
      <div class="pe-label-row">
        <label for="pe-text">Text</label>
        <button id="pe-copy-btn" class="copy-btn" title="Copy text" ${editing && editing.text ? '' : 'disabled'}>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
        </button>
      </div>
      <textarea id="pe-text" rows="6" placeholder="Prompt text…">${editing ? escapeHtml(editing.text) : ''}</textarea>
      <div class="pe-form-actions">
        <button id="pe-submit">${submitLabel}</button>
        ${editing ? '<button id="pe-cancel" class="pe-cancel-btn">Cancel</button>' : ''}
      </div>
      <div id="pe-error" class="pe-error" hidden></div>
    </div>
  `;

    const list =
        prompts.length === 0
            ? '<p class="pe-empty">No prompts yet.</p>'
            : prompts
                  .map(
                      (p) => `
      <div class="pe-prompt-row" data-id="${p.id}">
        <div class="pe-prompt-info">
          <span class="pe-prompt-title">${escapeHtml(p.title)}</span>
          <span class="pe-prompt-text-preview">${escapeHtml(p.text.slice(0, 80))}${p.text.length > 80 ? '…' : ''}</span>
        </div>
        <div class="pe-prompt-actions">
          <button class="pe-edit-btn save-btn" data-id="${p.id}">Edit</button>
          <button class="pe-delete-btn" data-id="${p.id}">Delete</button>
        </div>
      </div>
    `,
                  )
                  .join('');

    return `
    <div class="prompt-editor">
      <div class="header"><h1>Prompt Editor</h1></div>
      ${form}
      <div class="pe-list">${list}</div>
    </div>
  `;
}

async function showPromptEditor(editingId: number | null = null) {
    const app = document.getElementById('app')!;
    app.innerHTML = '<div class="loading"><div class="spinner"></div><p>Loading…</p></div>';

    let prompts: Prompt[];
    try {
        prompts = await getPrompts();
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        app.innerHTML = renderError(message);
        return;
    }

    app.innerHTML = renderPromptEditor(prompts, editingId);

    const submitBtn = document.getElementById('pe-submit') as HTMLButtonElement;
    const cancelBtn = document.getElementById('pe-cancel') as HTMLButtonElement | null;
    const titleInput = document.getElementById('pe-title') as HTMLInputElement;
    const textArea = document.getElementById('pe-text') as HTMLTextAreaElement;
    const copyBtn = document.getElementById('pe-copy-btn') as HTMLButtonElement;
    // pe-id is only present when editing an existing prompt; its absence
    // signals that the submit handler should INSERT rather than UPDATE.
    const idInput = document.getElementById('pe-id') as HTMLInputElement | null;
    const errorDiv = document.getElementById('pe-error')!;

    textArea.addEventListener('input', () => {
        copyBtn.disabled = textArea.value.trim() === '';
    });

    copyBtn.addEventListener('click', async () => {
        await navigator.clipboard.writeText(textArea.value);
        const svg = copyBtn.innerHTML;
        copyBtn.textContent = '✓';
        setTimeout(() => {
            copyBtn.innerHTML = svg;
        }, 1500);
    });

    function showError(msg: string) {
        errorDiv.textContent = msg;
        errorDiv.removeAttribute('hidden');
    }

    submitBtn.addEventListener('click', async () => {
        const title = titleInput.value.trim();
        const text = textArea.value.trim();
        if (!title || !text) {
            showError('Title and text are required.');
            return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Saving…';
        errorDiv.hidden = true;

        try {
            if (idInput) {
                await updatePrompt(Number(idInput.value), title, text);
            } else {
                await createPrompt(title, text);
            }
            // Re-render the full editor after mutation to reflect the latest
            // state from the server, rather than optimistically patching the DOM.
            showPromptEditor();
        } catch (err: unknown) {
            submitBtn.disabled = false;
            submitBtn.textContent = idInput ? 'Update' : 'Add Prompt';
            showError(err instanceof Error ? err.message : String(err));
        }
    });

    cancelBtn?.addEventListener('click', () => showPromptEditor());

    document.querySelectorAll<HTMLButtonElement>('.pe-edit-btn').forEach((btn) => {
        btn.addEventListener('click', () => showPromptEditor(Number(btn.dataset.id)));
    });

    document.querySelectorAll<HTMLButtonElement>('.pe-delete-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                await deletePrompt(Number(btn.dataset.id));
                showPromptEditor();
            } catch (err: unknown) {
                btn.disabled = false;
                alert(err instanceof Error ? err.message : String(err));
            }
        });
    });
}

// ── Instructions Editor ───────────────────────────────────────────────────────
// Structurally identical to the prompt editor. The duplication is intentional:
// prompts and instructions have different semantic roles (user content vs. system
// persona) and may diverge in future — shared abstractions would couple them
// prematurely.

function renderInstructionsEditor(instructions: Instruction[], editingId: number | null = null): string {
    const editing = editingId !== null ? instructions.find((i) => i.id === editingId) : null;

    const formTitle = editing ? 'Edit Instruction' : 'New Instruction';
    const submitLabel = editing ? 'Update' : 'Add Instruction';

    const form = `
    <div class="prompt-editor-form">
      <h2>${formTitle}</h2>
      ${editing ? `<input type="hidden" id="ie-id" value="${editing.id}" />` : ''}
      <label for="ie-title">Title</label>
      <input id="ie-title" type="text" placeholder="Instruction title" value="${editing ? escapeHtml(editing.title) : ''}" />
      <div class="pe-label-row">
        <label for="ie-text">Text</label>
        <button id="ie-copy-btn" class="copy-btn" title="Copy text" ${editing && editing.text ? '' : 'disabled'}>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
        </button>
      </div>
      <textarea id="ie-text" rows="6" placeholder="Instruction text…">${editing ? escapeHtml(editing.text) : ''}</textarea>
      <div class="pe-form-actions">
        <button id="ie-submit">${submitLabel}</button>
        ${editing ? '<button id="ie-cancel" class="pe-cancel-btn">Cancel</button>' : ''}
      </div>
      <div id="ie-error" class="pe-error" hidden></div>
    </div>
  `;

    const list =
        instructions.length === 0
            ? '<p class="pe-empty">No instructions yet.</p>'
            : instructions
                  .map(
                      (i) => `
      <div class="pe-prompt-row" data-id="${i.id}">
        <div class="pe-prompt-info">
          <span class="pe-prompt-title">${escapeHtml(i.title)}</span>
          <span class="pe-prompt-text-preview">${escapeHtml(i.text.slice(0, 80))}${i.text.length > 80 ? '…' : ''}</span>
        </div>
        <div class="pe-prompt-actions">
          <button class="ie-edit-btn save-btn" data-id="${i.id}">Edit</button>
          <button class="ie-delete-btn pe-delete-btn" data-id="${i.id}">Delete</button>
        </div>
      </div>
    `,
                  )
                  .join('');

    return `
    <div class="prompt-editor">
      <div class="header"><h1>Instructions</h1></div>
      ${form}
      <div class="pe-list">${list}</div>
    </div>
  `;
}

async function showInstructionsEditor(editingId: number | null = null) {
    const app = document.getElementById('app')!;
    app.innerHTML = '<div class="loading"><div class="spinner"></div><p>Loading…</p></div>';

    let instructions: Instruction[];
    try {
        instructions = await getInstructions();
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        app.innerHTML = renderError(message);
        return;
    }

    app.innerHTML = renderInstructionsEditor(instructions, editingId);

    const submitBtn = document.getElementById('ie-submit') as HTMLButtonElement;
    const cancelBtn = document.getElementById('ie-cancel') as HTMLButtonElement | null;
    const titleInput = document.getElementById('ie-title') as HTMLInputElement;
    const textArea = document.getElementById('ie-text') as HTMLTextAreaElement;
    const copyBtn = document.getElementById('ie-copy-btn') as HTMLButtonElement;
    const idInput = document.getElementById('ie-id') as HTMLInputElement | null;
    const errorDiv = document.getElementById('ie-error')!;

    textArea.addEventListener('input', () => {
        copyBtn.disabled = textArea.value.trim() === '';
    });

    copyBtn.addEventListener('click', async () => {
        await navigator.clipboard.writeText(textArea.value);
        const svg = copyBtn.innerHTML;
        copyBtn.textContent = '✓';
        setTimeout(() => {
            copyBtn.innerHTML = svg;
        }, 1500);
    });

    function showError(msg: string) {
        errorDiv.textContent = msg;
        errorDiv.removeAttribute('hidden');
    }

    submitBtn.addEventListener('click', async () => {
        const title = titleInput.value.trim();
        const text = textArea.value.trim();
        if (!title || !text) {
            showError('Title and text are required.');
            return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Saving…';
        errorDiv.hidden = true;

        try {
            if (idInput) {
                await updateInstruction(Number(idInput.value), title, text);
            } else {
                await createInstruction(title, text);
            }
            showInstructionsEditor();
        } catch (err: unknown) {
            submitBtn.disabled = false;
            submitBtn.textContent = idInput ? 'Update' : 'Add Instruction';
            showError(err instanceof Error ? err.message : String(err));
        }
    });

    cancelBtn?.addEventListener('click', () => showInstructionsEditor());

    document.querySelectorAll<HTMLButtonElement>('.ie-edit-btn').forEach((btn) => {
        btn.addEventListener('click', () => showInstructionsEditor(Number(btn.dataset.id)));
    });

    document.querySelectorAll<HTMLButtonElement>('.ie-delete-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                await deleteInstruction(Number(btn.dataset.id));
                showInstructionsEditor();
            } catch (err: unknown) {
                btn.disabled = false;
                alert(err instanceof Error ? err.message : String(err));
            }
        });
    });
}

// ── Nav ───────────────────────────────────────────────────────────────────────
// Navigation is driven by data-view attributes on buttons rather than URLs,
// which avoids adding a client-side router dependency for a three-view app.
// The tradeoff is that views aren't bookmarkable or back-button navigable.

function setActiveNavItem(view: 'videos' | 'prompts' | 'instructions') {
    document.querySelectorAll<HTMLButtonElement>('.nav-item').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.view === view);
    });
}

function bindNav() {
    document.querySelectorAll<HTMLButtonElement>('.nav-item').forEach((btn) => {
        btn.addEventListener('click', () => {
            const view = btn.dataset.view as 'videos' | 'prompts' | 'instructions';
            // Guard against re-rendering the current view, which would
            // discard any unsaved state (e.g. a half-written prompt).
            if (view === activeView) return;
            activeView = view;
            setActiveNavItem(view);
            if (view === 'prompts') {
                showPromptEditor();
            } else if (view === 'instructions') {
                showInstructionsEditor();
            } else {
                if (currentToken) {
                    const app = document.getElementById('app')!;
                    app.innerHTML = renderVideoList(currentVideos);
                    bindVideoList();
                } else {
                    const app = document.getElementById('app')!;
                    app.innerHTML = renderConnectView();
                }
            }
        });
    });
}

// Boot
const app = document.getElementById('app')!;

bindNav();

// IIFE lets us use top-level await without converting the entire module to async,
// which would change module evaluation semantics and defer bindNav() unnecessarily.
(async () => {
    const token = await fetchDropboxToken();
    if (token) {
        loadVideos(token);
    } else {
        app.innerHTML = renderConnectView();
    }
})();
