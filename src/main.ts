import './style.css';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { listAllVideos, getTemporaryLink, formatBytes } from './dropbox';
import { requestTranscript } from './assemblyai';
import { getCachedTranscript, cacheTranscript, getPrompts, createPrompt, updatePrompt, deletePrompt, getInstructions, createInstruction, updateInstruction, deleteInstruction } from './supabase';
import type { Prompt, Instruction } from './supabase';
import type { VideoFile } from './dropbox';

function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text) as string);
}

function parseFields(text: string): string[] {
  const matches = text.match(/\[\[(\w+)\]\]/g) ?? [];
  return [...new Set(matches.map((m) => m.slice(2, -2)))];
}

const SERVER_URL = import.meta.env.VITE_SERVER_URL as string | undefined ?? 'http://localhost:3001';
const LARGE_FILE_BYTES = 4.5 * 1024 * 1024 * 1024;
let currentVideos: VideoFile[] = [];
let currentToken = '';
let activeView: 'videos' | 'prompts' | 'instructions' = 'videos';
let currentPage = 0;
const PAGE_SIZE = 10;

async function fetchDropboxToken(): Promise<string | null> {
  try {
    const res = await fetch(`${SERVER_URL}/auth/token`);
    if (!res.ok) return null;
    const { access_token } = await res.json() as { access_token: string };
    return access_token;
  } catch {
    return null;
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
  const page = Math.min(currentPage, totalPages - 1);
  const start = page * PAGE_SIZE;
  const pageVideos = videos.slice(start, start + PAGE_SIZE);

  const rows = pageVideos.map((v, i) => `
    <tr class="video-row" data-index="${start + i}">
      <td class="col-name">${escapeHtml(v.name)}</td>
      <td class="col-path">${escapeHtml(v.path_display)}</td>
      <td class="col-size">${formatBytes(v.size)}</td>
      <td class="col-date">${new Date(v.client_modified).toLocaleDateString()}</td>
    </tr>
  `).join('');

  const pagination = totalPages > 1 ? `
    <div class="pagination">
      <button id="prev-page-btn" ${page === 0 ? 'disabled' : ''}>← Prev</button>
      <span class="page-info">Page ${page + 1} of ${totalPages}</span>
      <button id="next-page-btn" ${page >= totalPages - 1 ? 'disabled' : ''}>Next →</button>
    </div>
  ` : '';

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

async function showPromptBox(videoId: string) {
  const box = document.getElementById('prompt-box')!;
  box.innerHTML = '<p class="prompt-loading">Loading prompts…</p>';
  box.removeAttribute('hidden');

  let prompts: Prompt[];
  let instructions: Instruction[];
  try {
    [prompts, instructions] = await Promise.all([getPrompts(), getInstructions()]);
  } catch {
    box.innerHTML = '<p class="prompt-error">Failed to load prompts.</p>';
    return;
  }

  if (prompts.length === 0) {
    box.hidden = true;
    return;
  }

  const promptOptions = prompts
    .map((p) => `<option value="${p.id}">${escapeHtml(p.title)}</option>`)
    .join('');

  const instructionOptions = instructions.length > 0
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
  const responseExpandBtn = document.getElementById('response-expand-btn') as HTMLButtonElement;
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
  }

  rawToggleBtn.addEventListener('click', () => {
    showingRaw = !showingRaw;
    if (showingRaw) {
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
      promptFields.innerHTML = fields.map((f) => `
        <div class="field-row">
          <label class="field-label" for="field-${escapeHtml(f)}">${escapeHtml(f)}</label>
          <input class="field-input" id="field-${escapeHtml(f)}" type="text" placeholder="Enter ${escapeHtml(f)}…" data-field="${escapeHtml(f)}" />
        </div>
      `).join('');
      promptFields.removeAttribute('hidden');
      generateBtn.disabled = true;
      promptFields.querySelectorAll<HTMLInputElement>('.field-input').forEach((input) => {
        input.addEventListener('input', () => {
          const allFilled = Array.from(promptFields.querySelectorAll<HTMLInputElement>('.field-input'))
            .every((i) => i.value.trim() !== '');
          generateBtn.disabled = !allFilled;
        });
      });
    } else {
      promptFields.innerHTML = '';
      promptFields.hidden = true;
      generateBtn.disabled = false;
    }

    const cached = await fetch(`${SERVER_URL}/ai-responses/${encodeURIComponent(videoId)}/${promptId}`)
      .then((r) => r.json() as Promise<{ response: string | null; prompt_fields: Record<string, string> | null; instruction_id: number | null }>)
      .catch(() => ({ response: null, prompt_fields: null, instruction_id: null }));

    if (cached.response) {
      if (cached.instruction_id) instructionSelect.value = String(cached.instruction_id);
      if (cached.prompt_fields) {
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

  const existing = await fetch(`${SERVER_URL}/ai-responses/${encodeURIComponent(videoId)}`)
    .then((r) => r.json() as Promise<{ prompt_id: number; response: string } | null>)
    .catch(() => null);

  if (existing?.prompt_id && prompts.find((p) => p.id === existing.prompt_id)) {
    selectPrompt(existing.prompt_id);
  }

  generateBtn.addEventListener('click', async () => {
    const promptId = Number(select.value);
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
      fieldInputs.forEach((input) => { fields[input.dataset.field!] = input.value.trim(); });

      const res = await fetch(`${SERVER_URL}/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ promptId, transcript, instructionId, ...(Object.keys(fields).length > 0 ? { fields } : {}) }),
      });
      if (!res.ok) {
        const { error } = await res.json() as { error: string };
        throw new Error(error);
      }
      const { result } = await res.json() as { result: string };
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
    fieldInputs.forEach((input) => { fields[input.dataset.field!] = input.value.trim(); });

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';

    try {
      const res = await fetch(`${SERVER_URL}/ai-responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ videoId, promptId, response, instructionId, ...(Object.keys(fields).length > 0 ? { fields } : {}) }),
      });
      if (!res.ok) {
        const { error } = await res.json() as { error: string };
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
  await fetch(`${SERVER_URL}/auth/logout`, { method: 'POST' }).catch(() => {});
  currentToken = '';
  currentVideos = [];
  activeView = 'videos';
  setActiveNavItem('videos');
  const app = document.getElementById('app')!;
  app.innerHTML = renderConnectView();
}

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
    const url = await getTemporaryLink(currentToken, video.path_display);
    app.innerHTML = renderVideoDetail(video, url);

    document.getElementById('back-btn')?.addEventListener('click', () => {
      app.innerHTML = renderVideoList(currentVideos);
      bindVideoList();
    });
    document.getElementById('disconnect-btn')?.addEventListener('click', handleDisconnect);

    const transcriptBtn = document.getElementById('transcript-btn') as HTMLButtonElement;
    const saveBtn = document.getElementById('save-transcript-btn') as HTMLButtonElement;
    const transcriptContent = document.getElementById('transcript-content')!;
    const expandBtn = document.getElementById('transcript-expand-btn') as HTMLButtonElement;

    let transcriptExpanded = false;
    expandBtn.addEventListener('click', () => {
      transcriptExpanded = !transcriptExpanded;
      transcriptContent.classList.toggle('transcript-expanded', transcriptExpanded);
      expandBtn.querySelector('.expand-arrow')!.textContent = transcriptExpanded ? '▲' : '▼';
    });

    function showExpandBtn() {
      expandBtn.removeAttribute('hidden');
    }

    const cached = await getCachedTranscript(video.id);
    if (cached) {
      transcriptContent.className = 'transcript-content';
      transcriptContent.textContent = cached;
      transcriptBtn.textContent = 'Re-transcribe';
      showExpandBtn();
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

      const start = Date.now();
      timerEl.textContent = '0s';
      timerEl.removeAttribute('hidden');
      const tick = setInterval(() => {
        timerEl.textContent = `${Math.floor((Date.now() - start) / 1000)}s`;
      }, 1000);

      try {
        let audioUrl = url;
        if (video.size > LARGE_FILE_BYTES) {
          transcriptContent.textContent = 'Extracting audio… (large file, this may take a few minutes)';
          const extractRes = await fetch(`${SERVER_URL}/extract-audio`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dropboxUrl: url }),
          });
          if (!extractRes.ok) {
            const { error } = await extractRes.json() as { error: string };
            throw new Error(error ?? 'Audio extraction failed');
          }
          const { upload_url } = await extractRes.json() as { upload_url: string };
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
    currentVideos = videos.sort((a, b) =>
      new Date(b.client_modified).getTime() - new Date(a.client_modified).getTime()
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
      <label for="pe-text">Text</label>
      <textarea id="pe-text" rows="6" placeholder="Prompt text…">${editing ? escapeHtml(editing.text) : ''}</textarea>
      <div class="pe-form-actions">
        <button id="pe-submit">${submitLabel}</button>
        ${editing ? '<button id="pe-cancel" class="pe-cancel-btn">Cancel</button>' : ''}
      </div>
      <div id="pe-error" class="pe-error" hidden></div>
    </div>
  `;

  const list = prompts.length === 0
    ? '<p class="pe-empty">No prompts yet.</p>'
    : prompts.map((p) => `
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
    `).join('');

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
  const idInput = document.getElementById('pe-id') as HTMLInputElement | null;
  const errorDiv = document.getElementById('pe-error')!;

  function showError(msg: string) {
    errorDiv.textContent = msg;
    errorDiv.removeAttribute('hidden');
  }

  submitBtn.addEventListener('click', async () => {
    const title = titleInput.value.trim();
    const text = textArea.value.trim();
    if (!title || !text) { showError('Title and text are required.'); return; }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving…';
    errorDiv.hidden = true;

    try {
      if (idInput) {
        await updatePrompt(Number(idInput.value), title, text);
      } else {
        await createPrompt(title, text);
      }
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
      <label for="ie-text">Text</label>
      <textarea id="ie-text" rows="6" placeholder="Instruction text…">${editing ? escapeHtml(editing.text) : ''}</textarea>
      <div class="pe-form-actions">
        <button id="ie-submit">${submitLabel}</button>
        ${editing ? '<button id="ie-cancel" class="pe-cancel-btn">Cancel</button>' : ''}
      </div>
      <div id="ie-error" class="pe-error" hidden></div>
    </div>
  `;

  const list = instructions.length === 0
    ? '<p class="pe-empty">No instructions yet.</p>'
    : instructions.map((i) => `
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
    `).join('');

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
  const idInput = document.getElementById('ie-id') as HTMLInputElement | null;
  const errorDiv = document.getElementById('ie-error')!;

  function showError(msg: string) {
    errorDiv.textContent = msg;
    errorDiv.removeAttribute('hidden');
  }

  submitBtn.addEventListener('click', async () => {
    const title = titleInput.value.trim();
    const text = textArea.value.trim();
    if (!title || !text) { showError('Title and text are required.'); return; }

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

function setActiveNavItem(view: 'videos' | 'prompts' | 'instructions') {
  document.querySelectorAll<HTMLButtonElement>('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
}

function bindNav() {
  document.querySelectorAll<HTMLButtonElement>('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view as 'videos' | 'prompts' | 'instructions';
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

(async () => {
  const token = await fetchDropboxToken();
  if (token) {
    loadVideos(token);
  } else {
    app.innerHTML = renderConnectView();
  }
})();
