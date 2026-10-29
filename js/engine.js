// js/engine.js
// A thin wrapper around wllama (WebAssembly build of llama.cpp).
// main.js only ever uses:
//   await initAstraEngine(onProgress);
//   const answer = await generateAstraReply(prompt, history, { onToken });
//
// Nothing here talks to the internet except to fetch files from THIS site
// (the wasm engine in /engine/ and the GGUF shards in /models/).

import { CONFIG } from './config.js';

// Turn a path that is relative to this file into an absolute URL.
const here = (relPath) => new URL(relPath, import.meta.url).href;

// ---- module-level state -----------------------------------------------------
let wllama = null;          // the engine instance
let astraReady = false;     // true once the model is loaded (init is only expensive once)
let initPromise = null;     // lets two callers share one load
let loadToken = 0;          // bumped by reset so an old load can notice it was cancelled
let generating = false;
let currentRun = null;

export class AstraError extends Error {
  constructor(message, { code = 'ERROR', cause } = {}) {
    super(message);
    this.name = 'AstraError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

export const astraIsReady = () => astraReady;
export const astraIsBusy = () => generating;

// ---- small helpers ----------------------------------------------------------
async function urlExists(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

function checkCancelled(token) {
  if (token !== loadToken) {
    throw new AstraError('Model loading was cancelled.', { code: 'CANCELLED' });
  }
}

async function loadEngineModule() {
  try {
    return await import(here(CONFIG.engineModule));
  } catch (cause) {
    throw new AstraError(
      'WebAssembly engine not found or failed to start (' + CONFIG.engineModule + '). ' +
      'Copy the wllama "esm" folder into /engine/wllama/ (README step 2).',
      { code: 'ENGINE_MISSING', cause }
    );
  }
}

// Finds "<base>.gguf" or the first shard "<base>-00001-of-0000N.gguf".
async function findModelUrl() {
  if (CONFIG.modelUrlOverride) return here(CONFIG.modelUrlOverride);
  const dir = CONFIG.modelDir.endsWith('/') ? CONFIG.modelDir : CONFIG.modelDir + '/';

  const single = here(dir + CONFIG.modelBaseName + '.gguf');
  if (await urlExists(single)) return single;

  for (let n = 2; n <= CONFIG.maxShards; n++) {
    const total = String(n).padStart(5, '0');
    const first = here(dir + CONFIG.modelBaseName + '-00001-of-' + total + '.gguf');
    if (await urlExists(first)) return first;
  }
  throw new AstraError(
    'Model file not found. Put "' + CONFIG.modelBaseName + '.gguf" or its shards ' +
    '("' + CONFIG.modelBaseName + '-00001-of-0000N.gguf", ...) in the /models/ folder. ' +
    'File names are case-sensitive.',
    { code: 'MODEL_NOT_FOUND' }
  );
}

function explainLoadError(e) {
  const msg = String((e && e.message) || e);
  if (/unknown model architecture/i.test(msg)) {
    return new AstraError(
      'This engine is too old for the model\'s architecture. Copy the newest @wllama/wllama (v3 or newer) into /engine/wllama/.',
      { code: 'ARCH_UNSUPPORTED', cause: e }
    );
  }
  if (/out of memory|memory|alloc|oom|RangeError/i.test(msg)) {
    return new AstraError(
      'Not enough memory to load the model. Close other tabs and try again, or lower nCtx in js/config.js.',
      { code: 'OUT_OF_MEMORY', cause: e }
    );
  }
  if (/fetch|network|404|not found|failed to download/i.test(msg)) {
    return new AstraError(
      'The model could not be downloaded from this site. Check that every shard is in /models/ and pushed to GitHub.',
      { code: 'DOWNLOAD_FAILED', cause: e }
    );
  }
  return new AstraError('Model failed to load: ' + msg, { code: 'LOAD_FAILED', cause: e });
}

// ---- 1) load wasm engine + GGUF ---------------------------------------------
// onProgress receives: { stage, text, loaded?, total? }
export function initAstraEngine(onProgress = () => {}) {
  if (astraReady) return Promise.resolve();
  if (initPromise) return initPromise;

  const token = ++loadToken;

  initPromise = (async () => {
    try {
      if (typeof WebAssembly !== 'object') {
        throw new AstraError('This browser does not support WebAssembly.', { code: 'NO_WASM' });
      }

      onProgress({ stage: 'engine', text: 'Starting the WebAssembly engine…' });
      const mod = await loadEngineModule();
      checkCancelled(token);

      const wasmUrl = here(CONFIG.engineWasm);
      if (!(await urlExists(wasmUrl))) {
        throw new AstraError(
          'WebAssembly file not found: ' + CONFIG.engineWasm + '. Copy the wllama "esm" folder into /engine/wllama/ (README step 2).',
          { code: 'WASM_MISSING' }
        );
      }
      checkCancelled(token);

      onProgress({ stage: 'find', text: 'Looking for the model file…' });
      const modelUrl = await findModelUrl();
      checkCancelled(token);

      let instance;
      try {
        // wllama v3 takes { default: <wasm url> }. (v2 used 'single-thread/wllama.wasm' keys.)
        instance = new mod.Wllama(
          { default: wasmUrl },
          Object.assign(
            { parallelDownloads: CONFIG.parallelDownloads },
            mod.LoggerWithoutDebug ? { logger: mod.LoggerWithoutDebug } : {}
          )
        );
      } catch (cause) {
        throw new AstraError('WebAssembly init failed: ' + ((cause && cause.message) || cause), { code: 'WASM_INIT_FAILED', cause });
      }
      wllama = instance;

      const loadOptions = {
        n_ctx: CONFIG.nCtx,
        progressCallback: ({ loaded, total }) => {
          const pct = total ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
          onProgress({
            stage: 'download',
            loaded,
            total,
            text: pct >= 100 ? 'Loading model into memory…' : 'Loading model into browser… ' + pct + '%'
          });
        }
      };
      if (!CONFIG.useWebGPU) loadOptions.n_gpu_layers = 0; // CPU only
      if (CONFIG.promptMode === 'template') {
        loadOptions.jinja = true;
        if (CONFIG.chatTemplate) loadOptions.chat_template = CONFIG.chatTemplate;
      }

      onProgress({ stage: 'download', text: 'Loading model into browser…' });
      try {
        await instance.loadModelFromUrl(modelUrl, loadOptions);
      } catch (cause) {
        checkCancelled(token);
        throw explainLoadError(cause);
      }

      if (token !== loadToken) {
        try { await instance.exit(); } catch { /* ignore */ }
        throw new AstraError('Model loading was cancelled.', { code: 'CANCELLED' });
      }
      astraReady = true;
    } catch (e) {
      if (wllama && !astraReady) {
        const w = wllama;
        wllama = null;
        try { await w.exit(); } catch { /* ignore */ }
      }
      throw e instanceof AstraError
        ? e
        : new AstraError('Engine error: ' + ((e && e.message) || e), { code: 'ENGINE_ERROR', cause: e });
    } finally {
      if (token === loadToken) initPromise = null;
    }
  })();

  return initPromise;
}

// ---- prompt building ---------------------------------------------------------
const clip = (s, n) => String(s ?? '').slice(0, n);
const validHistory = (m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim();

function recentHistory(history) {
  return (Array.isArray(history) ? history : []).filter(validHistory).slice(-CONFIG.historyMessages);
}

// Qwen/ChatML: <|im_start|>role\n...<|im_end|>\n
function buildChatML(userText, history) {
  const sys = '<|im_start|>system\n' + CONFIG.systemPrompt + '<|im_end|>\n';
  const tail =
    '<|im_start|>user\n' + userText + '<|im_end|>\n' +
    '<|im_start|>assistant\n' + (CONFIG.emptyThinkBlock ? '<think>\n\n</think>\n\n' : '');

  // Rough budget: ~3 characters per token, leave room for the reply.
  const budget = Math.max(400, Math.floor((CONFIG.nCtx - CONFIG.maxNewTokens) * 3) - sys.length - tail.length);

  const recent = recentHistory(history);
  const blocks = [];
  let used = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const block = '<|im_start|>' + recent[i].role + '\n' + clip(recent[i].content, 1200) + '<|im_end|>\n';
    if (used + block.length > budget) break; // drop the oldest messages first
    blocks.unshift(block);
    used += block.length;
  }
  return sys + blocks.join('') + tail;
}

function buildMessages(userText, history) {
  return [
    { role: 'system', content: CONFIG.systemPrompt },
    ...recentHistory(history).map((m) => ({ role: m.role, content: clip(m.content, 1200) })),
    { role: 'user', content: userText }
  ];
}

// Hide <think>…</think> and stray control tokens, also while text is streaming in.
function cleanReply(raw, streaming) {
  let t = String(raw).replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/think>/gi, '');
  const open = t.search(/<think>/i);
  if (open !== -1) t = t.slice(0, open); // unfinished thinking stays hidden
  t = t.replace(/<\|im_(?:end|start)\|>[\s\S]*$/i, '');
  if (streaming) t = t.replace(/<[^>]{0,12}$/, ''); // half-typed tag at the end
  return t.replace(/^\s+/, '');
}

function chunkText(c) {
  const ch = c && c.choices && c.choices[0];
  if (!ch) return '';
  return (ch.delta && ch.delta.content) || ch.text || (ch.message && ch.message.content) || '';
}

// ---- 2) generate -------------------------------------------------------------
// prompt:  the new user message (string)
// history: [{ role: 'user' | 'assistant', content }] of EARLIER messages
// opts:    { onToken(textSoFar), signal }
// returns: the full answer as a plain string
export async function generateAstraReply(prompt, history = [], opts = {}) {
  if (!astraReady || !wllama) {
    throw new AstraError('Model is not loaded yet. Call initAstraEngine() first.', { code: 'NOT_READY' });
  }
  if (generating) {
    throw new AstraError('A reply is already being generated.', { code: 'BUSY' });
  }
  const userText = clip(String(prompt ?? '').trim(), CONFIG.maxInputChars);
  if (!userText) throw new AstraError('Please type a message first.', { code: 'EMPTY' });

  const abort = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) abort.abort();
    else opts.signal.addEventListener('abort', () => abort.abort(), { once: true });
  }

  generating = true;
  currentRun = { abort };
  let raw = '';

  try {
    const params = {
      max_tokens: CONFIG.maxNewTokens,
      temperature: CONFIG.temperature,
      top_k: CONFIG.topK,
      top_p: CONFIG.topP,
      stream: true,
      abortSignal: abort.signal // ignored by versions that do not support it
    };

    let result;
    if (CONFIG.promptMode === 'template') {
      result = await wllama.createChatCompletion({ messages: buildMessages(userText, history), ...params });
    } else {
      result = await wllama.createCompletion({
        prompt: buildChatML(userText, history),
        stop: ['<|im_end|>', '<|im_start|>'],
        ...params
      });
    }

    if (result && typeof result[Symbol.asyncIterator] === 'function') {
      for await (const chunk of result) {
        if (abort.signal.aborted) break;
        raw += chunkText(chunk);
        if (opts.onToken) opts.onToken(cleanReply(raw, true));
      }
    } else {
      raw = chunkText(result);
      if (opts.onToken) opts.onToken(cleanReply(raw, false));
    }
  } catch (e) {
    if (abort.signal.aborted) return cleanReply(raw, false).trim(); // stopped on purpose: keep the partial text
    const msg = String((e && e.message) || e);
    if (e && (e.type === 'kv_cache_full' || /kv_cache_full|context (?:is )?full|exceeds.*context/i.test(msg))) {
      throw new AstraError('This chat got too long for the model\'s memory. Press ＋ to start a new chat.', { code: 'CONTEXT_FULL', cause: e });
    }
    throw new AstraError('Reply failed: ' + msg, { code: 'GENERATE_FAILED', cause: e });
  } finally {
    generating = false;
    currentRun = null;
  }

  return cleanReply(raw, false).trim();
}

// ---- stop / unload -----------------------------------------------------------
// Frees the worker and memory. Also cancels a model load that is still running.
export async function resetAstraEngine() {
  loadToken++;
  initPromise = null;
  if (currentRun) currentRun.abort.abort();
  const w = wllama;
  wllama = null;
  astraReady = false;
  if (w) {
    try { await w.exit(); } catch (e) { console.warn('wllama exit:', e); }
  }
}

// Stop = abort + reset, so no half-finished reply can linger in the worker.
// wllama normally keeps downloaded model files in the browser's cache, so loading again should be quicker.
export async function stopAstraReply() {
  await resetAstraEngine();
}
