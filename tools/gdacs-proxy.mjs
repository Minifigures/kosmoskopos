// GDACS live disaster-alerts proxy (keyless, free).
//
// GDACS (Global Disaster Alert and Coordination System — JRC / UN OCHA) serves
// a GeoJSON FeatureCollection of current Orange/Red disaster events, but sends
// no CORS header, so the browser fetches this same-origin proxy instead.
// Cached 5 min; serves last-good on upstream failure. GET /api/gdacs

const GDACS_URL = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?alertlevel=Orange;Red&eventlist=EQ;TC;FL;VO;DR;WF';
const TTL_MS = 5 * 60 * 1000;
let cache = null; // { at, body }

export function gdacsProxy() {
  function install(mw) {
    mw.use('/api/gdacs', async (req, res) => {
      const send = (status, body) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.end(body);
      };
      const now = Date.now();
      if (cache && now - cache.at < TTL_MS) return send(200, cache.body);
      try {
        const r = await fetch(GDACS_URL, { headers: { Accept: 'application/json', 'User-Agent': 'Kosmoskopos/1.0 (hackathon; humanitarian)' } });
        if (!r.ok) {
          if (cache) return send(200, cache.body);
          return send(502, JSON.stringify({ error: `GDACS HTTP ${r.status}`, type: 'FeatureCollection', features: [] }));
        }
        const body = await r.text();
        cache = { at: now, body };
        return send(200, body);
      } catch (e) {
        if (cache) return send(200, cache.body);
        return send(502, JSON.stringify({ error: e?.message || 'GDACS fetch failed', type: 'FeatureCollection', features: [] }));
      }
    });
  }
  return {
    name: 'kosmoskopos-gdacs-proxy',
    configureServer(s) { install(s.middlewares); },
    configurePreviewServer(s) { install(s.middlewares); },
  };
}
