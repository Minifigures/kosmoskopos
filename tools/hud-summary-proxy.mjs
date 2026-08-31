// Free HUD intel-summary proxy — replaces the OpenAI /api/openai/hud-summary.
//
// hud.js POSTs the current scene context (basemap labels, enabled layers, etc.)
// and expects { summary: "<short line>" }. This produces a terse HUD status
// line using FREE models only: a local model (LOCAL_LLM_URL, unlimited/offline)
// first to spare cloud quota, then Gemini, then Groq. Keys stay server-side.

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GROQ_MODEL = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';
const LOCAL_LLM_URL = (process.env.LOCAL_LLM_URL || '').replace(/\/$/, '');
const LOCAL_LLM_MODEL = process.env.LOCAL_LLM_MODEL || 'local';

const SYS = 'You write ONE terse status line for a military-style heads-up display. Output ONLY 4 to 6 UPPERCASE words summarizing the scene from the context. No punctuation, no preamble, no quotes.';

function readBody(req, cap = 32768) {
  return new Promise((resolve) => {
    let d = '', n = 0;
    req.on('data', (c) => { n += c.length; if (n > cap) { req.destroy(); resolve(null); } else d += c; });
    req.on('end', () => resolve(d));
    req.on('error', () => resolve(null));
  });
}

async function chatOpenAI(base, model, headers, sys, user, signal) {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, signal,
    body: JSON.stringify({ model, temperature: 0.4, max_tokens: 24, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `HTTP ${r.status}`);
  const t = d?.choices?.[0]?.message?.content?.trim();
  if (!t) throw new Error('no text');
  return t;
}

async function callGemini(sys, user, key, signal) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { temperature: 0.4, maxOutputTokens: 40, thinkingConfig: { thinkingBudget: 0 } } }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `HTTP ${r.status}`);
  const t = (d?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!t) throw new Error('no text');
  return t;
}

function tidy(text) {
  // Strip any chain-of-thought a reasoning model might emit, then normalize.
  const clean = String(text).replace(/<think>[\s\S]*?<\/think>/gi, ' ').replace(/["'\n\r.]/g, ' ');
  return clean.trim().toUpperCase().split(/\s+/).filter(Boolean).slice(0, 6).join(' ');
}

// Never-fail fallback: build a terse HUD line straight from the scene context
// (no model needed) so the HUD always has something sensible even when every
// free AI provider is rate-limited or offline.
function ruleBasedHud(ctx) {
  try {
    const loc = String(ctx?.location || ctx?.place || ctx?.region || ctx?.basemap || '').trim();
    let layers = ctx?.layers || ctx?.enabledLayers || ctx?.activeLayers || [];
    if (!Array.isArray(layers)) layers = [];
    const names = layers.map((l) => (typeof l === 'string' ? l : (l?.name || l?.id || ''))).filter(Boolean);
    const parts = [];
    if (names.length) parts.push('MONITORING', String(names.length), names.length === 1 ? 'LIVE LAYER' : 'LIVE LAYERS');
    else parts.push('GLOBAL', 'WATCH', 'ACTIVE');
    if (loc) parts.push('OVER', loc);
    return tidy(parts.join(' ')) || 'GLOBAL WATCH ALL SYSTEMS NOMINAL';
  } catch { return 'GLOBAL WATCH ALL SYSTEMS NOMINAL'; }
}

export function hudSummaryProxy() {
  function install(mw) {
    mw.use('/api/hud-summary', async (req, res) => {
      const send = (s, p) => { res.statusCode = s; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(p)); };
      if (req.method !== 'POST') return send(405, { error: 'POST only' });
      const raw = await readBody(req);
      let ctx = {}; try { ctx = JSON.parse(raw || '{}'); } catch { return send(400, { error: 'invalid JSON' }); }
      const user = 'SCENE CONTEXT: ' + JSON.stringify(ctx).slice(0, 3500);
      const geminiKey = String(process.env.GEMINI_API_KEY || '').trim();
      const groqKey = String(process.env.GROQ_API_KEY || '').trim();
      // Per-attempt timeout budget so a slow provider can't starve the fallbacks.
      const attempt = async (fn) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try { return await fn(controller.signal); }
        finally { clearTimeout(timeout); }
      };
      try {
        // Cloud first (fast) for this frequent HUD blurb; the local CPU model is
        // a slower OFFLINE last-resort so it never stalls the 15s HUD refresh.
        let summary = null;
        if (geminiKey) { try { summary = await attempt((s) => callGemini(SYS, user, geminiKey, s)); } catch { /* fall through */ } }
        if (!summary && groqKey) { try { summary = await attempt((s) => chatOpenAI('https://api.groq.com/openai', GROQ_MODEL, { Authorization: `Bearer ${groqKey}` }, SYS, user, s)); } catch { /* fall through */ } }
        if (!summary && LOCAL_LLM_URL) { try { summary = await attempt((s) => chatOpenAI(LOCAL_LLM_URL, LOCAL_LLM_MODEL, {}, SYS, user, s)); } catch { /* fall through */ } }
        if (summary) return send(200, { summary: tidy(summary), degraded: false });
        // Every free provider missed (quota / offline): degrade gracefully, never error.
        return send(200, { summary: ruleBasedHud(ctx), degraded: true });
      } catch { return send(200, { summary: ruleBasedHud(ctx), degraded: true }); }
    });
  }
  return { name: 'kosmoskopos-hud-summary-proxy', configureServer(s) { install(s.middlewares); }, configurePreviewServer(s) { install(s.middlewares); } };
}
