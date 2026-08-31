// NHC active tropical cyclones proxy (keyless, free).
//
// NOAA / National Hurricane Center CurrentStorms.json — every active tropical
// cyclone worldwide (Atlantic + E/C Pacific), no CORS header so the browser
// fetches this same-origin proxy. Cached 10 min. GET /api/nhc

const NHC_URL = 'https://www.nhc.noaa.gov/CurrentStorms.json';
const TTL_MS = 10 * 60 * 1000;
let cache = null;

export function nhcProxy() {
  function install(mw) {
    mw.use('/api/nhc', async (req, res) => {
      const send = (s, b) => { res.statusCode = s; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'private, max-age=600'); res.end(b); };
      const now = Date.now();
      if (cache && now - cache.at < TTL_MS) return send(200, cache.body);
      try {
        const r = await fetch(NHC_URL, { headers: { Accept: 'application/json', 'User-Agent': 'Kosmoskopos/1.0 (hackathon)' } });
        if (!r.ok) { if (cache) return send(200, cache.body); return send(502, JSON.stringify({ activeStorms: [], error: `NHC HTTP ${r.status}` })); }
        const body = await r.text();
        cache = { at: now, body };
        return send(200, body);
      } catch (e) {
        if (cache) return send(200, cache.body);
        return send(502, JSON.stringify({ activeStorms: [], error: e?.message || 'NHC fetch failed' }));
      }
    });
  }
  return { name: 'kosmoskopos-nhc-proxy', configureServer(s) { install(s.middlewares); }, configurePreviewServer(s) { install(s.middlewares); } };
}
