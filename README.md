# Max AI – Astra 0.4 (runs in your browser)

Max AI – Astra 0.4 is a school-safe study buddy that runs **entirely inside the web browser**. It is powered by your own model file, `Max_AI_0.4_Astra-Q4_K_M.gguf`, and a WebAssembly engine.

> **This site does not call Hugging Face or external AI APIs. All inference happens in the browser using the wasm engine and your GGUF file.**

There is no backend server. The whole project is static files, so it works on GitHub Pages.

---

## How it works

1. The page (`index.html`) loads `js/main.js`, which draws the chat UI.
2. When you press **Load model** (or send your first message), `js/engine.js` loads the WebAssembly engine from `/engine/wllama/` and then your GGUF from `/models/`. Both come from **this same website**.
3. When you send a message, `generateAstraReply(prompt, history)` builds a ChatML prompt (system prompt + earlier messages + your new message), runs the model in a web worker and streams the answer back into the chat bubble.

### Which engine, and why not tangledgroup/llama-cpp-wasm?

The code is written so that only `js/engine.js` knows about the engine. I picked **[wllama](https://github.com/ngxson/wllama)** (`@wllama/wllama` on npm, version 3 or newer) because:

- It ships a **prebuilt `.wasm` file** in its npm package. You don't have to compile anything.
- It tracks recent llama.cpp, so it can load a Qwen3-based model like Astra.
- It can load a GGUF that is **split into several files**, which you need because GitHub refuses single files over 100 MB.

`tangledgroup/llama-cpp-wasm` is a good idea but a poor fit here: the repository was archived in September 2025, it has no downloadable releases (you must compile it with Emscripten), and its build script pins an old llama.cpp snapshot that, as far as I can tell, predates Qwen3 support.

Exact names used by `js/engine.js`:

| Thing | Name |
| --- | --- |
| Engine class | `Wllama` (from `engine/wllama/index.js`) |
| WebAssembly file | `engine/wllama/wasm/wllama.wasm` |
| Load model | `wllama.loadModelFromUrl(firstShardUrl, { n_ctx, n_gpu_layers: 0, progressCallback })` |
| Generate | `wllama.createCompletion({ prompt, stream: true, ... })` |
| Your wrappers | `initAstraEngine()` and `generateAstraReply(prompt, history)` |

> I checked these against wllama's current README and V3 guide. I could not run the real engine or your real model where I wrote this, so the first real load on your machine is the real test. The Troubleshooting section lists what to try if something is off.

---

## Folder layout

```
max-ai-astra-web/
  index.html
  style.css
  README.md
  .nojekyll
  js/
    config.js            <- all settings (file names, context size, system prompt)
    engine.js            <- wraps the wasm engine
    main.js              <- chat UI
  engine/
    wllama/              <- YOU copy the engine files here (step 2)
      index.js
      wasm/wllama.wasm
      ...
  models/                <- YOU copy the model shards here (step 3)
    Max_AI_0.4_Astra-Q4_K_M-00001-of-0000N.gguf
    ...
```

---

## What you need

- Your file `Max_AI_0.4_Astra-Q4_K_M.gguf`.
- A free GitHub account.
- A way to run `git` (your own computer, a Chromebook's Linux mode, or **GitHub Codespaces**, which runs in the browser and has git, Node and npm already installed).
- Internet at home once, to download the engine files and push the site.

> GitHub's website only accepts uploads up to 25 MB per file. The model must go up with `git push` (or Codespaces), not by dragging files into the GitHub web page.

---

## Step 1 – Create the repository

1. On GitHub press **New repository**. Name it, for example, `max-ai-astra-web`. Choose **Public** (free GitHub Pages needs a public repository).
2. Clone it:

   ```bash
   git clone https://github.com/YOUR-NAME/max-ai-astra-web.git
   cd max-ai-astra-web
   ```
3. Copy every file from this project into that folder, keeping the layout shown above.

## Step 2 – Get the engine files (wllama)

In a terminal inside your repo folder:

```bash
mkdir -p /tmp/engine-download && cd /tmp/engine-download
npm init -y
npm install @wllama/wllama
cd -                                   # back to your repo
mkdir -p engine/wllama
cp -r /tmp/engine-download/node_modules/@wllama/wllama/esm/. engine/wllama/
```

Check that these two exist:

```bash
ls engine/wllama/index.js engine/wllama/wasm/wllama.wasm
```

- Copy the **whole** `esm` folder. Don't pick single files.
- If your copy has a different layout, change `engineModule` and `engineWasm` in `js/config.js` to match.
- Links: [wllama on GitHub](https://github.com/ngxson/wllama) · [@wllama/wllama on npm](https://www.npmjs.com/package/@wllama/wllama)

## Step 3 – Split your GGUF and put it in `/models/`

GitHub blocks files over 100 MB, so split the model into pieces of about 90 MB with llama.cpp's `llama-gguf-split` tool. The easiest way is a Google Colab notebook:

```python
from google.colab import drive
drive.mount('/content/drive')

!git clone --depth 1 https://github.com/ggml-org/llama.cpp
!cmake -S llama.cpp -B llama.cpp/build -DLLAMA_CURL=OFF
!cmake --build llama.cpp/build --target llama-gguf-split -j 4

!mkdir -p /content/shards
!llama.cpp/build/bin/llama-gguf-split --split-max-size 90M \
   "/content/drive/MyDrive/PATH/TO/Max_AI_0.4_Astra-Q4_K_M.gguf" \
   /content/shards/Max_AI_0.4_Astra-Q4_K_M
!ls -lh /content/shards
```

(You can also download a llama.cpp release for your computer and run `llama-gguf-split --split-max-size 90M your.gguf Max_AI_0.4_Astra-Q4_K_M`.)

You will get files such as:

```
Max_AI_0.4_Astra-Q4_K_M-00001-of-00007.gguf
Max_AI_0.4_Astra-Q4_K_M-00002-of-00007.gguf
...
```

Copy **all** of them into `models/`. You don't need to tell the site how many there are. It looks for the first piece by itself, and wllama loads the rest.

- If your model is under about 95 MB, skip the split and just copy `Max_AI_0.4_Astra-Q4_K_M.gguf` into `models/`.
- **Do not use Git LFS.** GitHub Pages cannot serve LFS files.
- Keep the whole repo under about 1 GB. A Q4_K_M model of roughly 1 billion parameters is around 0.6 to 0.7 GB, which fits.

## Step 4 – Commit and push

```bash
git add .
git commit -m "Max AI Astra 0.4"
git push
```

The push uploads the whole model, so it may take a while. If it is rejected for file size, one of your pieces is over 100 MB. Re-split with a smaller `--split-max-size`.

## Step 5 – Turn on GitHub Pages

1. In your repository open **Settings → Pages**.
2. Under **Build and deployment** choose **Deploy from a branch**.
3. Pick branch **main** and folder **/(root)**, then **Save**.
4. After a minute or two your site is at `https://YOUR-NAME.github.io/max-ai-astra-web/`.

## Step 6 – Test it on your own computer first

Opening `index.html` by double-clicking will **not** work, because browsers block JavaScript modules on `file://`. Start a tiny server instead:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`. Open ☰ and press **Load model**. The status should go from *Model not loaded* to *Model loading…* to *Model ready*.

## Step 7 – Use it on a school computer

Just open your GitHub Pages address. Nothing needs installing.

- The first load downloads the whole model, so use a good connection. Later loads should be faster because the browser keeps a copy.
- It needs a lot of free memory. Close other tabs first.
- It runs on the CPU by default (slower, but stable). Expect replies to take a while on a Chromebook.
- If your school blocks `github.io`, ask your teacher or IT department.

---

## Settings (`js/config.js`)

| Setting | What it does |
| --- | --- |
| `modelBaseName` | File name without `.gguf` or shard numbers. |
| `modelUrlOverride` | Name the model file yourself instead of auto-detecting it. |
| `nCtx` | Context window in tokens. Larger needs more memory. Default 2048. |
| `maxNewTokens` | Longest reply. Default 400. |
| `useWebGPU` | `false` = CPU only (default, safest). `true` tries the GPU. |
| `promptMode` | `'chatml'` (default) or `'template'` (use the template inside the GGUF). |
| `emptyThinkBlock` | Set `true` if Astra starts writing `<think>` text and you want it skipped. |
| `systemPrompt` | The instructions sent before every chat. Paste the one you trained Astra with. |

---

## Troubleshooting

| Message or problem | Fix |
| --- | --- |
| *WebAssembly engine not found or failed to start* | `engine/wllama/index.js` is missing or in the wrong folder. Redo step 2. |
| *WebAssembly file not found* | `engine/wllama/wasm/wllama.wasm` is missing. Copy the whole `esm` folder. |
| *Model file not found* | Files must be in `models/` with exactly the names above. Names are case-sensitive on GitHub Pages. |
| *Engine too old for the model's architecture* | You have an old wllama. Install the newest `@wllama/wllama` and redo step 2. |
| *Not enough memory* | Close other tabs. Lower `nCtx` to 1024 in `js/config.js`. |
| Page is blank or buttons do nothing | You opened the file with `file://`. Use the Pages address or `python3 -m http.server`. |
| Replies are very slow | Normal for CPU mode. Shorten `maxNewTokens`. |
| Astra shows `<think>` or odd tags | Set `emptyThinkBlock: true`, or `promptMode: 'template'`. |
| Model downloads a tiny text file instead of the model | The file was pushed with Git LFS. Remove LFS and push the plain shards. |
| Stop button | Stop resets the model so no half-finished reply is left over. The next message reloads it. |

Optional speed-up: GitHub Pages cannot send the headers browsers need for multi-threaded WebAssembly, so wllama runs single-threaded. A small service-worker add-on such as [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) can enable threads, but it is optional and not included here.

---

## Please read: this is a public download

A free GitHub Pages site needs a **public** repository, so anyone who finds the address can download your `.gguf`. If you want the model only for yourself and friends, don't publish it this way. Also keep the licence notice of the base model your Astra was built from (Qwen3 is Apache 2.0) if you share the file.

## Credits

- [wllama](https://github.com/ngxson/wllama) by Xuan-Son Nguyen (MIT)
- [llama.cpp](https://github.com/ggml-org/llama.cpp) (MIT)
