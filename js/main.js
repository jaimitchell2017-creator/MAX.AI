function setModelStatus(kind, detail) {
  const labels = { 'not-loaded': 'Model not loaded', loading: 'Model loading…', ready: 'Model ready', error: 'Model error' };
  const pill = $('modelStatus');
  pill.dataset.state = kind;
  pill.textContent = labels[kind] || labels['not-loaded'];
  if (detail !== undefined) $('modelState').textContent = detail;
  if (kind !== 'loading') $('modelProgress').hidden = true;
}

function controls() {
  const busy = !!state.job || state.loading;
  const ready = astraIsReady();
  $('send').disabled = busy;
  $('load').disabled = busy || ready;
  $('unload').disabled = !(ready || busy);
  $('new').disabled = busy;
  $('stop').hidden = !busy;
  document.body.classList.toggle('working', busy);
}

function add(role, text) {
  $('welcome').hidden = true;
  const el = document.createElement('div');
  el.className = 'message ' + role;
  el.textContent = text;
  $('messages').append(el);
  $('chat').scrollTop = $('chat').scrollHeight;
  return el;
}

// ---------------------------------------------------------------- loading the model
function onEngineProgress(p) {
  state.loadActivity = Date.now();
  const text = p.text || 'Loading…';
  if (p.stage !== state.loadStage) {
    state.loadStage = p.stage;
    activity(text, true);
  } else {
    setPhase(text, true);
  }
  $('modelState').textContent = text;
  if (p.stage === 'download' && p.total) {
    $('modelProgress').hidden = false;
    $('modelProgress').value = Math.min(100, Math.round((p.loaded / p.total) * 100));
  }
}

async function loadModel() {
  if (state.loading || astraIsReady()) return astraIsReady();
  state.loading = true;
  state.loadStage = '';
  state.loadActivity = Date.now();
  setModelStatus('loading', 'Starting…');
  controls();
  activity('Loading model into browser…', true);
  try {
    await initAstraEngine(onEngineProgress);
    setModelStatus('ready', 'Loaded locally in this browser.');
    activity(CONFIG.title + ' loaded. Send a message.');
    toast('Ready for local chat.');
    return true;
  } catch (e) {
    if (e && e.code === 'CANCELLED') {
      setModelStatus('not-loaded', 'Loading was cancelled.');
      activity('Model loading cancelled.');
    } else {
      const msg = (e && e.message) || String(e);
      setModelStatus('error', msg);
      activity('Could not load the model.');
      log('Load error: ' + msg);
      toast(msg);
      menu(true);
    }
    return false;
  } finally {
    state.loading = false;
    controls();
  }
}

async function unloadModel() {
  await resetAstraEngine();
  setModelStatus('not-loaded', 'Model unloaded. The browser may keep a cached copy of the download.');
  controls();
  activity('Model unloaded.');
}

// ---------------------------------------------------------------- chat
function finishJob(job, note = '') {
  if (state.job !== job) return;
  state.job = null;
  if (job.text) {
    state.history.push({ role: 'user', content: job.prompt }, { role: 'assistant', content: job.text });
    state.history = state.history.slice(-20);
    job.el.textContent = job.text + (note ? '\n\n[' + note + ']' : '');
  } else {
    job.el.textContent = note || 'The model returned no text. Try a shorter message or reload the model.';
  }
  controls();
  activity(note || 'Reply complete · Model ready');
}

async function send() {
  const text = $('input').value.trim();
  if (!text || state.job || state.loading) return;
  if (text.length > CONFIG.maxInputChars) {
    toast('Please shorten your message to ' + CONFIG.maxInputChars.toLocaleString() + ' characters for this small local model.');
    return;
  }
  if (state.listening && state.rec) state.rec.stop();

  $('input').value = '';
  add('user', text);
  const el = add('assistant', astraIsReady() ? 'Preparing your message locally…' : 'Loading model into browser…');
  const now = Date.now();
  const job = { prompt: text, el, text: '', start: now, last: now, cancelled: false };
  state.job = job;
  controls();

  // Load the model first if needed.
  if (!astraIsReady()) {
    const ok = await loadModel();
    if (state.job !== job) return; // the user pressed Stop meanwhile
    if (!ok) {
      finishJob(job, job.cancelled ? 'Cancelled.' : 'The model could not be loaded. Open ☰ to see why.');
      return;
    }
  }

  el.textContent = 'Generating reply…';
  job.start = job.last = Date.now();
  activity('Generating reply…', true);

  try {
    const answer = await generateAstraReply(text, state.history, {
      onToken: (t) => {
        if (state.job !== job || !t) return;
        if (!job.text) log('First response text received.');
        job.text = t;
        job.last = Date.now();
        el.textContent = t;
        setPhase('Receiving reply text locally', true);
        $('chat').scrollTop = $('chat').scrollHeight;
      }
    });
    if (state.job !== job) return;
    job.text = answer || job.text;
    finishJob(job);
  } catch (e) {
    if (state.job !== job) return;
    const msg = (e && e.message) || String(e);
    log('Reply error: ' + msg);
    toast(msg);
    finishJob(job, msg);
  }
}

async function stop() {
  if (state.loading) {
    if (state.job) state.job.cancelled = true;
    await resetAstraEngine();
    return;
  }
  const job = state.job;
  if (!job) return;
  finishJob(job, 'Stopped. Model reset; press Send to load it again.');
  await stopAstraReply();
  setModelStatus('not-loaded', 'Model reset after Stop. Your next message will reload it.');
  controls();
}

// Watchdog: resets the model if a load or a reply gets stuck.
setInterval(() => {
  const now = Date.now();
  const s = CONFIG.stall;
  if (state.loading || state.job) {
    const seconds = Math.floor((now - state.phaseStart) / 1000);
    const job = state.job;
    const extra = job && job.text ? ' · ' + job.text.length + ' characters received' : '';
    $('activityText').textContent = state.phase + ' · ' + seconds + 's' + extra;
  }
  const job = state.job;
  if (job && !state.loading) {
    const total = now - job.start;
    const idle = now - job.last;
    if (total > s.totalMs || (!job.text && total > s.firstTokenMs) || (job.text && idle > s.idleMs)) {
      finishJob(job, 'Generation stalled or hit the time limit. The model was reset; try a shorter message.');
      stopAstraReply().then(() => { setModelStatus('not-loaded', 'Model reset after a stall.'); controls(); });
    }
  }
  if (state.loading && now - state.loadActivity > s.loadMs) {
    resetAstraEngine();
    toast('No loading progress for 5 minutes. Loading was stopped; check your connection and try again.');
  }
}, 1000);

// ---------------------------------------------------------------- files, mic, logo
function save(name, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function renderFiles() {
  $('files').replaceChildren();
  state.files.forEach((f, i) => {
    const card = document.createElement('div');
    card.className = 'card';
    const name = document.createElement('div');
    name.textContent = f.name;
    const edit = document.createElement('button');
    edit.textContent = 'Edit';
    edit.onclick = () => {
      state.editing = i;
      $('fileTitle').textContent = f.name;
      $('editor').value = f.text;
      $('fileDialog').showModal();
      log('Opened local workspace editor: ' + f.name);
    };
    const dl = document.createElement('button');
    dl.textContent = 'Download';
    dl.onclick = () => { save(f.name, f.text); log('Requested download: ' + f.name); };
    card.append(name, edit, dl);
    $('files').append(card);
  });
}

function setupMic() {
  $('mic').onclick = () => {
    if (state.listening && state.rec) { state.rec.stop(); return; }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR || !('processLocally' in SR.prototype)) {
      toast('Verified on-device speech recognition is unavailable here. No cloud speech fallback is used.');
      return;
    }
    try {
      const rec = new SR();
      state.rec = rec;
      rec.processLocally = true;
      rec.lang = navigator.language || 'en-AU';
      rec.interimResults = true;
      rec.onstart = () => {
        state.listening = true;
        $('mic').classList.add('active');
        if (!state.job && !state.loading) activity('Listening on-device · Tap mic to stop', true);
      };
      rec.onresult = (e) => {
        $('input').value = Array.from(e.results).map((r) => r[0].transcript).join(' ');
      };
      rec.onerror = (e) => toast('Local microphone: ' + e.error);
      rec.onend = () => {
        state.listening = false;
        $('mic').classList.remove('active');
        if (!state.job && !state.loading) activity('Microphone stopped. Review your text before sending.');
      };
      rec.start();
    } catch (e) {
      toast(e.message);
    }
  };
}

function showDiagnostics() {
  const parts = [
    'WebAssembly: ' + (typeof WebAssembly === 'object' ? 'yes' : 'NO'),
    'Secure context: ' + (window.isSecureContext ? 'yes' : 'no (use https or localhost)'),
    'Threads: ' + (self.crossOriginIsolated ? 'multi-thread available' : 'single-thread (normal on GitHub Pages)'),
    'Engine mode: ' + (CONFIG.useWebGPU ? (navigator.gpu ? 'WebGPU' : 'WebGPU requested but unavailable') : 'CPU / WebAssembly')
  ];
  if (navigator.hardwareConcurrency) parts.push('CPU cores: ' + navigator.hardwareConcurrency);
  if (navigator.deviceMemory) parts.push('Memory hint: ' + navigator.deviceMemory + ' GB or more');
  $('diagnostics').textContent = parts.join(' · ');
}

// ---------------------------------------------------------------- start-up (after the DOM exists)
function start() {
  $('menu').onclick = () => menu(true);
  $('close').onclick = () => menu(false);
  $('shade').onclick = () => menu(false);
  $('stop').onclick = stop;
  $('load').onclick = loadModel;
  $('unload').onclick = async () => { if (state.job || state.loading) await stop(); await unloadModel(); };

  $('send').onclick = send;
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  document.querySelectorAll('[data-text]').forEach((b) => {
    b.addEventListener('click', () => { $('input').value = b.dataset.text; send(); });
  });

  $('new').onclick = () => {
    if (state.job || state.loading) return;
    state.history = [];
    $('messages').replaceChildren();
    $('welcome').hidden = false;
    activity(astraIsReady() ? 'New chat · Model ready' : 'New chat · Model not loaded');
  };

  $('voice').onclick = () => toast('Fully local voice conversation is not implemented yet. Chat and text-file tools are available.');
  setupMic();

  $('create').onclick = () => {
    const name = prompt('File name', 'notes.txt');
    if (name) {
      state.files.push({ name: name.replace(/[\\/]/g, '_'), text: '' });
      renderFiles();
      log('Created local workspace file: ' + name);
    }
  };
  $('upload').onclick = $('upload2').onclick = () => $('fileInput').click();
  $('fileInput').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      if (f.size > 2000000) throw new Error('Choose a text file under 2 MB.');
      log('Reading local file: ' + f.name);
      state.files.push({ name: f.name, text: await f.text() });
      renderFiles();
      menu(true);
      log('File added locally; not sent to the model.');
    } catch (err) {
      toast(err.message);
    }
    e.target.value = '';
  };
  $('saveFile').onclick = () => {
    if (state.editing >= 0) {
      state.files[state.editing].text = $('editor').value;
      renderFiles();
      log('Saved workspace copy: ' + state.files[state.editing].name);
    }
    $('fileDialog').close();
    toast('Download the file to keep your changes.');
  };
  $('cancelFile').onclick = () => $('fileDialog').close();
  $('logoDownload').onclick = () => save('max-ai-logo.svg', LOGO_SVG, 'image/svg+xml');

  window.addEventListener('error', (e) => { toast('Page error: ' + e.message); log('Page error: ' + e.message); });
  window.addEventListener('unhandledrejection', (e) => {
    const msg = String((e.reason && e.reason.message) || e.reason);
    toast(msg);
    log('Unhandled error: ' + msg);
  });

  showDiagnostics();
  setModelStatus('not-loaded');
  controls();
  activity('Interface ready · Press Load model in ☰, or just send a message');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
