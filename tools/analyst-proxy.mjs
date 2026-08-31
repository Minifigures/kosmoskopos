// CrisisScape "Duty Officer" analyst — free-AI proxy.
//
// A same-origin POST /api/analyst endpoint that answers an operator's question
// about the live globe using free LLMs: Google Gemini (free tier) first, then
// Groq (free tier) as fallback. API keys are read server-side from process.env
// (populated from the gitignored .env by vite.config) and NEVER reach the
// browser. No paid providers, no billing.
//
// Body (JSON): { question: string, context?: object|string }
// Reply (JSON): { answer, provider, model, degraded } or { error, details }

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const REQUEST_TIMEOUT_MS = 25_000;
const MAX_BODY_BYTES = 64 * 1024;
// Optional local free model (llama-cpp-python / Ollama, OpenAI-compatible server).
// When LOCAL_LLM_URL is set it is used as an offline/quota fallback after cloud.
const LOCAL_LLM_URL = (process.env.LOCAL_LLM_URL || '').replace(/\/$/, '');
const LOCAL_LLM_MODEL = process.env.LOCAL_LLM_MODEL || 'local';

// Cost/abuse guardrail: cap analyst calls per IP per minute so a public deploy
// cannot burn the free Gemini/Groq daily quota (or hammer the providers). The
// free tiers have no billing linked, so this protects QUOTA, not a bill.
// Tune with ANALYST_RATELIMIT_PER_MIN (default 15; 0 disables).
const RATE_WINDOW_MS = 60_000;
const _ipHits = new Map(); // ip -> number[] (recent request timestamps)
function overRateLimit(ip) {
  const max = Number(process.env.ANALYST_RATELIMIT_PER_MIN ?? 15);
  if (!Number.isFinite(max) || max <= 0) return false; // disabled
  const now = Date.now();
  const hits = (_ipHits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= max) {
    _ipHits.set(ip, hits);
    return true;
  }
  hits.push(now);
  _ipHits.set(ip, hits);
  if (_ipHits.size > 5000) _ipHits.clear(); // crude memory cap
  return false;
}

const SYSTEM_PROMPT = [
  'You are CrisisScape Duty Officer, a calm, precise spatial-intelligence analyst monitoring a',
  'live photorealistic 3D globe of Earth built entirely from PUBLIC data feeds (aircraft,',
  'vessels, satellites, earthquakes, active fires, weather, traffic, public cameras, and',
  'humanitarian disaster alerts). Answer the operator using ONLY the live map context',
  'provided plus well-established general knowledge. Be concise and factual: 2-5 sentences',
  'or short bullets, leading with the direct answer. If the context lacks the data to',
  'answer, say so plainly and name which layer to enable. NEVER invent specific live values',
  '(counts, coordinates, callsigns, magnitudes) that are not present in the context. This is',
  'open-source situational awareness for humanitarian response and public understanding —',
  'not targeting or surveillance of individuals.',
].join(' ');

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        resolve(null);
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(null));
  });
}

async function callGemini(system, user, apiKey, signal) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 800 },
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data?.error?.message || `Gemini HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || '')
    .join('')
    .trim();
  if (!text) throw new Error('Gemini returned no text');
  return text;
}

async function callGroq(system, user, apiKey, signal) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    signal,
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.3,
      max_tokens: 800,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data?.error?.message || `Groq HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('Groq returned no text');
  return text;
}

async function callLocal(system, user, signal) {
  const response = await fetch(`${LOCAL_LLM_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model: LOCAL_LLM_MODEL,
      temperature: 0.3,
      max_tokens: 800,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data?.error?.message || `Local HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('Local model returned no text');
  return text;
}

// Deterministic, never-fail fallback: turn the live context into a useful SITREP
// so a visitor never sees an error when every free provider is momentarily busy.
function ruleBasedSitrep(question, context) {
  const c = context && typeof context === 'object' ? context : {};
  const parts = [];
  const loc = c.onScreenLocality || c.locality || c.latlon
    || (c.camera ? `${c.camera.lat}, ${c.camera.lon}` : null);
  if (loc) parts.push(`View centered on ${loc}`);
  if (c.camera && c.camera.altitudeKm != null) parts.push(`altitude ${c.camera.altitudeKm} km`);
  const layers = Array.isArray(c.activeLayers)
    ? c.activeLayers
    : (typeof c.activeLayers === 'string' && c.activeLayers !== 'none enabled' ? [c.activeLayers] : []);
  if (layers.length) parts.push(`active layers: ${layers.join(', ')}`);
  else parts.push('no data layers enabled');
  const head = parts.length ? parts.join('; ') + '.' : 'Live view active.';
  const q = String(question || '').slice(0, 160);
  return `SITREP (offline mode): ${head} Free cloud AI is momentarily at capacity — ask again shortly, or switch on Private in-browser AI for a local answer.${q ? ` Logged: "${q}"` : ''}`;
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

/**
 * Vite plugin: registers POST /api/analyst on the dev + preview servers.
 * @returns {import('vite').Plugin}
 */
export function analystProxy() {
  function install(middlewares) {
    middlewares.use('/api/analyst', async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'POST only' });
        return;
      }
      const ip = (req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || 'unknown').trim();
      if (overRateLimit(ip)) {
        sendJson(res, 429, { error: 'rate limit: too many analyst requests, slow down' });
        return;
      }
      const raw = await readBody(req);
      if (raw === null) {
        sendJson(res, 413, { error: 'request body too large or unreadable' });
        return;
      }
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
        return;
      }
      const question = String(body.question || '').trim();
      if (!question) {
        sendJson(res, 400, { error: 'question is required' });
        return;
      }
      const context = body.context
        ? (typeof body.context === 'string' ? body.context : JSON.stringify(body.context))
        : '';
      const user = context
        ? `LIVE MAP CONTEXT (JSON):\n${context}\n\nOPERATOR QUESTION: ${question}`
        : question;

      const geminiKey = String(process.env.GEMINI_API_KEY || '').trim();
      const groqKey = String(process.env.GROQ_API_KEY || '').trim();
      if (!geminiKey && !groqKey && !LOCAL_LLM_URL) {
        sendJson(res, 503, { error: 'no analyst provider set (GEMINI_API_KEY, GROQ_API_KEY, or LOCAL_LLM_URL)' });
        return;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const errors = [];
      try {
        if (geminiKey) {
          try {
            const answer = await callGemini(SYSTEM_PROMPT, user, geminiKey, controller.signal);
            clearTimeout(timeout);
            sendJson(res, 200, { answer, provider: 'gemini', model: GEMINI_MODEL, degraded: false });
            return;
          } catch (e) {
            errors.push(`gemini: ${e.message}`);
          }
        }
        if (groqKey) {
          try {
            const answer = await callGroq(SYSTEM_PROMPT, user, groqKey, controller.signal);
            clearTimeout(timeout);
            sendJson(res, 200, { answer, provider: 'groq', model: GROQ_MODEL, degraded: Boolean(geminiKey) });
            return;
          } catch (e) {
            errors.push(`groq: ${e.message}`);
          }
        }
        if (LOCAL_LLM_URL) {
          try {
            const answer = await callLocal(SYSTEM_PROMPT, user, controller.signal);
            clearTimeout(timeout);
            sendJson(res, 200, { answer, provider: 'local', model: LOCAL_LLM_MODEL, degraded: Boolean(geminiKey || groqKey) });
            return;
          } catch (e) {
            errors.push(`local: ${e.message}`);
          }
        }
        clearTimeout(timeout);
        // Never-fail rule-based SITREP: when every free provider is busy/quota'd,
        // still return a useful deterministic answer from the live context so the
        // Duty Officer never shows an error to a visitor.
        sendJson(res, 200, { answer: ruleBasedSitrep(question, body.context), provider: 'sitrep', model: 'rule-based', degraded: true });
      } catch (e) {
        clearTimeout(timeout);
        sendJson(res, 502, { error: e?.message || 'analyst error', details: errors });
      }
    });
  }

  return {
    name: 'argus-analyst-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
