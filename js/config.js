// js/config.js
// Every setting you might want to change lives here.
// Paths are written relative to THIS file (js/config.js) and engine.js turns
// them into absolute URLs, so they also work inside the engine's web worker.

export const CONFIG = {
  // ---- Names shown in the UI --------------------------------------------
  title: 'Max AI – Astra 0.4',
  modelFileLabel: 'Max_AI_0.4_Astra-Q4_K_M.gguf',

  // ---- Engine: wllama (WebAssembly build of llama.cpp) -------------------
  // You copy the "esm" folder from the @wllama/wllama npm package into
  // /engine/wllama/ (README step 2). If your copy has a different layout,
  // change these two lines to match.
  engineModule: '../engine/wllama/index.js',
  engineWasm: '../engine/wllama/wasm/wllama.wasm',

  // ---- Model -------------------------------------------------------------
  // GitHub blocks files over 100 MB, so the model is split into shards:
  //   Max_AI_0.4_Astra-Q4_K_M-00001-of-00007.gguf, ...-00002-of-00007.gguf, ...
  // The engine looks for "<modelBaseName>.gguf" first, then for the first
  // shard, so you do not have to type the shard count anywhere.
  modelDir: '../models/',
  modelBaseName: 'Max_AI_0.4_Astra-Q4_K_M',
  maxShards: 40,
  // Optional: skip auto-detection and name the file (or first shard) yourself.
  // Example: '../models/Max_AI_0.4_Astra-Q4_K_M-00001-of-00007.gguf'
  modelUrlOverride: null,
  parallelDownloads: 4,

  // ---- Generation --------------------------------------------------------
  nCtx: 2048,          // context window. Bigger = more RAM. Keep 2048 on a Chromebook.
  maxNewTokens: 400,   // longest reply, in tokens
  temperature: 0.6,
  topK: 40,
  topP: 0.9,

  // CPU/WebAssembly only by default. WebGPU is faster on good hardware but
  // can crash low-memory laptops and Chromebooks, so it is opt-in.
  useWebGPU: false,

  // How the prompt is built:
  //   'chatml'   -> engine.js writes the Qwen/ChatML prompt itself (default;
  //                 works even if the GGUF has no chat template inside it).
  //   'template' -> let the engine use the chat template stored in the GGUF.
  promptMode: 'chatml',
  chatTemplate: null,       // only used with promptMode 'template'
  emptyThinkBlock: false,   // true = add "<think></think>" before the answer (Qwen3 "no thinking" style)

  historyMessages: 6,       // how many earlier messages Astra can see
  maxInputChars: 2000,      // longest message you can send

  // ---- System prompt -----------------------------------------------------
  // Your trained system prompt (sent before every chat).
  systemPrompt: [
    'You are Max v0.1 Astra, a school-safe AI study buddy for students in New South Wales, Australia.',
    'Explain topics clearly in simple language, keep most answers between 3–6 sentences, and focus on helping the student understand rather than doing their work for them.',
    'For quizzes, always include an answer key at the end.',
    'Never provide instructions for self-harm, suicide, weapons, bombs, hacking, illegal drugs, or other dangerous or illegal activities; if a user asks for these, refuse briefly and offer a safe alternative topic instead.',
    'Do not help users cheat on live tests or assignments; you may explain concepts, show worked examples with different numbers, or help them check their own reasoning.',
    'If you don’t know something or the question is unclear, say that you’re not sure and ask for more detail and you were made by Jai Mitchell.'
  ].join('\n'),

  // ---- Watchdog (in milliseconds) ---------------------------------------
  stall: {
    firstTokenMs: 180000, // give up if no text after 3 minutes
    idleMs: 60000,        // give up if text stops for 1 minute
    totalMs: 600000,      // hard limit per reply
    loadMs: 300000        // give up if loading shows no progress for 5 minutes
  }
};
