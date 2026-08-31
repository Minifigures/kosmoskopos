// KosmoSkopos — "Ask the planet" analyst widget.
//
// Lets the operator ask the free-AI Duty Officer about the live globe. Two modes:
//  - Default: POST /api/analyst (server-side Gemini -> Groq -> local -> rule-based
//    SITREP), so it works on any device and NEVER errors.
//  - Private (toggle): runs a small model 100% in the VISITOR's own browser via
//    WebLLM (WebGPU) — private, zero server/quota cost, works for any visitor
//    (not just the dev machine). First use downloads the model (cached after).
// It gathers lightweight live context (camera, HUD locality, enabled layers).

let _viewer = null;
let _dataManager = null;
let _busy = false;
let _private = false;

// --- WebLLM (in-browser) ---
let _engine = null;
let _engineModel = null;
const WEBLLM_PREFS = [
  'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
  'Llama-3.2-1B-Instruct-q4f16_1-MLC',
  'Llama-3.2-1B-Instruct-q4f32_1-MLC',
  'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
];

function pickModel(webllm) {
  const ids = (webllm.prebuiltAppConfig?.model_list || []).map((m) => m.model_id);
  for (const p of WEBLLM_PREFS) if (ids.includes(p)) return p;
  const small = ids.filter((id) => /instruct/i.test(id) && /(0\.5B|-1B-|1\.5B)/.test(id));
  return small[0] || ids[0] || WEBLLM_PREFS[0];
}

async function getEngine(onProgress) {
  if (_engine) return _engine;
  if (!('gpu' in navigator)) throw new Error('WebGPU not available — use Chrome or Edge for Private mode.');
  const webllm = await import('@mlc-ai/web-llm');
  _engineModel = pickModel(webllm);
  _engine = await webllm.CreateMLCEngine(_engineModel, {
    initProgressCallback: (r) => onProgress?.(r.text || '', r.progress ?? 0),
  });
  return _engine;
}

const DEG = 180 / Math.PI;

function gatherContext() {
  const ctx = {};
  try {
    const c = _viewer?.camera?.positionCartographic;
    if (c) ctx.camera = { lat: Number((c.latitude * DEG).toFixed(4)), lon: Number((c.longitude * DEG).toFixed(4)), altitudeKm: Number((c.height / 1000).toFixed(1)) };
  } catch { /* camera not ready */ }
  const txt = (id) => document.getElementById(id)?.textContent?.trim() || null;
  ctx.onScreenLocality = txt('hud-summary');
  ctx.latlon = txt('hud-latlon');
  ctx.mode = txt('hud-mode');
  ctx.visualStyle = txt('active-style-name');
  try {
    const layers = [];
    const highlights = {};
    const map = _dataManager?.layers;
    if (map && typeof map.forEach === 'function') {
      map.forEach((entry, id) => {
        if (!entry?.enabled) return;
        let count = null;
        let top = null;
        try {
          const s = entry.module?.getStats?.();
          count = s?.count ?? s?.total ?? s?.visible ?? s?.rendered ?? null;
          // The most notable records the layer exposes (Duty Officer context):
          // named storms with wind speed, largest quakes, severest alerts.
          if (Array.isArray(s?.top) && s.top.length) top = s.top;
        } catch { /* optional */ }
        layers.push(count != null ? `${id}:${count}` : id);
        if (top) highlights[id] = top;
      });
    }
    ctx.activeLayers = layers.length ? layers : 'none enabled';
    if (Object.keys(highlights).length) ctx.highlights = highlights;
  } catch { /* optional */ }
  return ctx;
}

const SYS = 'You are KosmoSkopos Duty Officer, a calm, precise spatial-intelligence analyst for a live humanitarian 3D globe of Earth built from public data (aircraft, vessels, satellites, earthquakes, active fires, weather, live disaster alerts). Answer using ONLY the live map context plus general knowledge. When the context includes a "highlights" object, cite the specific live events by name and value (storm names with wind speed in kt, the largest earthquake magnitude and place, the severest disaster alerts) rather than only counts. Be concise: 2-4 sentences, direct answer first. Do not invent specific live values not in the context. This is open-source situational awareness for disaster response, not surveillance of individuals.';

async function askServer(question, context, els, attempt = 0) {
  let response = null;
  let data = {};
  try {
    response = await fetch('/api/analyst', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, context }),
    });
    data = await response.json().catch(() => ({}));
  } catch {
    // Network error: the free-tier server is very likely still cold-starting.
    response = null;
  }
  if (response && response.ok && data.answer) {
    els.answer.textContent = data.answer;
    els.badge.textContent = `${data.provider || 'ai'}${data.model ? ' · ' + data.model : ''}${data.degraded ? ' · fallback' : ''}`;
    els.status.hidden = true;
    return;
  }
  // Free-tier cold start: the deployment spins down when idle and boots for
  // ~40-50s, returning 502/503/504 (or a dropped connection) during boot. Show
  // a friendly "booting up" status and auto-retry rather than a raw error, so
  // the answer appears on its own once the server is warm.
  const status = response ? response.status : 0;
  const bootLike = !response || status === 502 || status === 503 || status === 504;
  if (bootLike && attempt < 4) {
    els.status.hidden = false;
    els.status.textContent = `Duty Officer is booting up (free-tier cold start)… warming up${'.'.repeat(attempt % 3 + 1)}`;
    await new Promise((r) => setTimeout(r, 6000));
    return askServer(question, context, els, attempt + 1);
  }
  els.status.hidden = false;
  els.status.textContent = bootLike
    ? 'Still booting up — give it a few more seconds and ask again.'
    : (data.error || `analyst error (${status})`);
}

async function askPrivate(question, context, els) {
  els.status.hidden = false;
  els.status.textContent = 'Preparing private in-browser model…';
  const engine = await getEngine((text, progress) => {
    const pct = Math.round((progress || 0) * 100);
    els.status.textContent = `Loading local model in your browser… ${pct}%${pct < 100 ? ' (first time only)' : ''}`;
  });
  els.status.textContent = 'Thinking privately, on your device…';
  const user = context ? `LIVE MAP CONTEXT (JSON):\n${JSON.stringify(context)}\n\nOPERATOR QUESTION: ${question}` : question;
  const stream = await engine.chat.completions.create({
    messages: [{ role: 'system', content: SYS }, { role: 'user', content: user }],
    temperature: 0.3,
    max_tokens: 512,
    stream: true,
  });
  els.answer.textContent = '';
  els.status.hidden = true;
  for await (const chunk of stream) {
    els.answer.textContent += chunk.choices?.[0]?.delta?.content || '';
  }
  els.badge.textContent = `private · ${(_engineModel || 'local').replace(/-q4.*/, '')} · in-browser`;
}

async function ask(question, els) {
  const q = question.trim();
  if (_busy || !q) return;
  _busy = true;
  els.send.disabled = true;
  els.answer.textContent = '';
  els.badge.textContent = '';
  els.status.hidden = false;
  els.status.textContent = _private ? 'Starting private mode…' : 'Consulting the Duty Officer…';
  try {
    const context = gatherContext();
    if (_private) await askPrivate(q, context, els);
    else await askServer(q, context, els);
  } catch (e) {
    els.status.hidden = false;
    els.status.textContent = (_private ? 'Private AI: ' : 'network error: ') + (e?.message || e);
  } finally {
    _busy = false;
    els.send.disabled = false;
  }
}

const STYLE = `
#cs-ask{position:fixed;left:20px;bottom:190px;z-index:9000;font-family:'JetBrains Mono',ui-monospace,monospace;}
#cs-ask .cs-pill{display:flex;align-items:center;gap:8px;cursor:pointer;padding:9px 14px;border:1px solid rgba(244, 183, 64,.5);border-radius:20px;background:rgba(20, 15, 4, .86);color:#f4b740;font-size:12px;letter-spacing:.14em;text-transform:uppercase;backdrop-filter:blur(6px);box-shadow:0 0 18px rgba(244, 183, 64,.16);transition:border-color .2s,box-shadow .2s;}
#cs-ask .cs-pill:hover{border-color:#f4b740;box-shadow:0 0 26px rgba(244, 183, 64,.34);}
#cs-ask .cs-pill .cs-eye{font-size:14px;}
#cs-ask .cs-panel{display:none;flex-direction:column;width:340px;max-width:78vw;border:1px solid rgba(244, 183, 64,.42);border-radius:12px;background:rgba(20, 15, 4, .94);backdrop-filter:blur(8px);box-shadow:0 10px 40px rgba(0,0,0,.55),0 0 30px rgba(244, 183, 64,.1);overflow:hidden;}
#cs-ask.cs-open .cs-panel{display:flex;}
#cs-ask.cs-open .cs-pill{display:none;}
#cs-ask .cs-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(244, 183, 64,.2);color:#f4b740;font-size:11px;letter-spacing:.14em;text-transform:uppercase;}
#cs-ask .cs-head-actions{display:flex;align-items:center;gap:6px;}
#cs-ask .cs-toggle{cursor:pointer;border:1px solid rgba(244, 183, 64,.35);background:rgba(0,0,0,.25);color:#e6c78a;border-radius:12px;font-size:9.5px;letter-spacing:.08em;padding:3px 8px;text-transform:uppercase;}
#cs-ask .cs-toggle.on{border-color:#3ad07a;color:#3ad07a;background:rgba(58,208,122,.14);}
#cs-ask .cs-close{cursor:pointer;color:#e6c78a;background:none;border:none;font-size:15px;line-height:1;padding:2px 4px;}
#cs-ask .cs-close:hover{color:#fff;}
#cs-ask .cs-body{padding:12px;display:flex;flex-direction:column;gap:10px;}
#cs-ask .cs-answer{min-height:20px;max-height:30vh;overflow-y:auto;color:#fbf5e7;font-family:'Inter',system-ui,sans-serif;font-size:13.5px;line-height:1.5;white-space:pre-wrap;}
#cs-ask .cs-status{color:#e6c78a;font-size:11.5px;font-style:italic;}
#cs-ask .cs-badge{color:#ad8b3a;font-size:10px;letter-spacing:.1em;text-transform:uppercase;}
#cs-ask .cs-inrow{display:flex;gap:8px;align-items:flex-end;}
#cs-ask textarea{flex:1;resize:none;background:rgba(0,0,0,.35);border:1px solid rgba(244, 183, 64,.3);border-radius:8px;color:#fbf5e7;font-family:'Inter',system-ui,sans-serif;font-size:13px;padding:8px 10px;line-height:1.4;min-height:38px;max-height:110px;outline:none;}
#cs-ask textarea:focus{border-color:#f4b740;}
#cs-ask .cs-send{cursor:pointer;border:1px solid #f4b740;background:rgba(244, 183, 64,.14);color:#f4b740;border-radius:8px;padding:9px 12px;font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:.1em;}
#cs-ask .cs-send:hover:not(:disabled){background:rgba(244, 183, 64,.26);}
#cs-ask .cs-send:disabled{opacity:.5;cursor:default;}
#cs-ask .cs-hint{color:#ad8b3a;font-size:10.5px;}
#cs-ask .cs-chips{display:flex;flex-wrap:wrap;gap:6px;}
#cs-ask .cs-chip{cursor:pointer;border:1px solid rgba(244, 183, 64,.28);border-radius:12px;background:rgba(0,0,0,.25);color:#ead39f;font-size:10.5px;padding:4px 8px;}
#cs-ask .cs-chip:hover{border-color:#f4b740;color:#fbf5e7;}
@media (max-width:640px){#cs-ask{left:10px;bottom:150px;}}
/* --- polish pass: entrance, accent line, tactile controls --- */
#cs-ask .cs-pill{transition:border-color .2s,box-shadow .2s,transform .2s;}
#cs-ask .cs-pill:hover{transform:translateY(-1px);}
#cs-ask .cs-panel{position:relative;transform-origin:bottom left;max-height:min(52vh,380px);}
#cs-ask .cs-panel::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,rgba(244,183,64,.75),transparent);pointer-events:none;z-index:1;}
#cs-ask.cs-open .cs-panel{animation:csIn .24s cubic-bezier(.2,.8,.2,1);}
@keyframes csIn{from{opacity:0;transform:translateY(8px) scale(.985);}to{opacity:1;transform:translateY(0) scale(1);}}
#cs-ask .cs-send{transition:background .2s,box-shadow .2s;box-shadow:0 0 14px rgba(244,183,64,.1);}
#cs-ask .cs-send:hover:not(:disabled){box-shadow:0 0 20px rgba(244,183,64,.3);}
#cs-ask .cs-chip{transition:border-color .15s,color .15s,transform .15s,background .15s;}
#cs-ask .cs-chip:hover{background:rgba(244,183,64,.1);transform:translateY(-1px);}
#cs-ask .cs-answer{scrollbar-width:thin;scrollbar-color:rgba(244,183,64,.4) transparent;}
`;

const SUGGESTIONS = [
  'What am I looking at right now?',
  'Any active disasters near this view?',
  'Summarize what these layers show.',
];

/**
 * Mount the Ask KosmoSkopos widget.
 * @param {Cesium.Viewer} viewer
 * @param {object} dataManager DataLayerManager (for active-layer context)
 */
export function initKosmoSkoposAsk(viewer, dataManager) {
  _viewer = viewer;
  _dataManager = dataManager;
  if (document.getElementById('cs-ask')) return;

  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'cs-ask';
  root.innerHTML = `
    <div class="cs-pill" role="button" tabindex="0" aria-label="Ask KosmoSkopos">
      <span class="cs-eye">◈</span><span>Ask KosmoSkopos</span>
    </div>
    <div class="cs-panel" role="dialog" aria-label="Ask KosmoSkopos">
      <div class="cs-head">
        <span>◈ Duty Officer</span>
        <span class="cs-head-actions">
          <button class="cs-toggle" id="cs-private" title="Run a model 100% in your own browser (WebGPU) — private, no server">🔒 Private</button>
          <button class="cs-close" aria-label="Close">✕</button>
        </span>
      </div>
      <div class="cs-body">
        <div class="cs-answer" id="cs-answer"></div>
        <div class="cs-status" id="cs-status" hidden></div>
        <div class="cs-badge" id="cs-badge"></div>
        <div class="cs-chips" id="cs-chips"></div>
        <div class="cs-inrow">
          <textarea id="cs-input" rows="1" placeholder="Ask the planet…"></textarea>
          <button class="cs-send" id="cs-send">ASK</button>
        </div>
        <div class="cs-hint" id="cs-hint">Free AI · answers from live map context</div>
      </div>
    </div>`;
  document.body.appendChild(root);

  const pill = root.querySelector('.cs-pill');
  const input = root.querySelector('#cs-input');
  const privateBtn = root.querySelector('#cs-private');
  const hint = root.querySelector('#cs-hint');
  const els = {
    answer: root.querySelector('#cs-answer'),
    status: root.querySelector('#cs-status'),
    badge: root.querySelector('#cs-badge'),
    send: root.querySelector('#cs-send'),
  };

  const open = () => { root.classList.add('cs-open'); setTimeout(() => input.focus(), 30); };
  const close = () => root.classList.remove('cs-open');
  pill.addEventListener('click', open);
  pill.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  root.querySelector('.cs-close').addEventListener('click', close);

  privateBtn.addEventListener('click', () => {
    _private = !_private;
    privateBtn.classList.toggle('on', _private);
    hint.textContent = _private
      ? 'Private · runs in YOUR browser (WebGPU), no server, no keys'
      : 'Free AI · answers from live map context';
  });

  const chips = root.querySelector('#cs-chips');
  SUGGESTIONS.forEach((s) => {
    const chip = document.createElement('button');
    chip.className = 'cs-chip';
    chip.type = 'button';
    chip.textContent = s;
    chip.addEventListener('click', () => { input.value = s; ask(s, els); });
    chips.appendChild(chip);
  });

  const submit = () => ask(input.value, els);
  els.send.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    if (e.key === 'Escape') close();
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(110, input.scrollHeight) + 'px';
  });
}
