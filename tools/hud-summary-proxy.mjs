// Free HUD intel-summary proxy — replaces the OpenAI /api/openai/hud-summary.
//
// hud.js POSTs the current scene context (basemap labels, enabled layers, etc.)
// and expects { summary: "<short line>" }. This produces a terse HUD status
// line using FREE models only: a local model (LOCAL_LLM_URL, unlimited/offline)
// first to spare cloud quota, then Gemini, then Groq. Keys stay server-side.

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
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
  return String(text).replace(/["'\n\r.]/g, ' ').trim().toUpperCase().split(/\s+/).filter(Boolean).slice(0, 6).join(' ');
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
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        // Cloud first (fast) for this frequent HUD blurb; the local CPU model is
        // a slower OFFLINE last-resort so it never stalls the 15s HUD refresh.
        let summary = null;
        if (geminiKey) { try { summary = await callGemini(SYS, user, geminiKey, controller.signal); } catch { /* fall through */ } }
        if (!summary && groqKey) { try { summary = await chatOpenAI('https://api.groq.com/openai', GROQ_MODEL, { Authorization: `Bearer ${groqKey}` }, SYS, user, controller.signal); } catch { /* fall through */ } }
        if (!summary && LOCAL_LLM_URL) { try { summary = await chatOpenAI(LOCAL_LLM_URL, LOCAL_LLM_MODEL, {}, SYS, user, controller.signal); } catch { /* fall through */ } }
        clearTimeout(timeout);
        if (summary) return send(200, { summary: tidy(summary) });
        return send(502, { error: 'no free summary provider available' });
      } catch (e) { clearTimeout(timeout); return send(502, { error: e?.message || 'summary failed' }); }
    });
  }
  return { name: 'kosmoskopos-hud-summary-proxy', configureServer(s) { install(s.middlewares); }, configurePreviewServer(s) { install(s.middlewares); } };
}
