// GDACS live disaster-alerts proxy (keyless, free).
//
// GDACS (Global Disaster Alert and Coordination System — JRC / UN OCHA) serves
// a GeoJSON FeatureCollection of current Orange/Red disaster events, but sends
// no CORS header, so the browser fetches this same-origin proxy instead.
//
// GDACS can be slow to answer cold (observed 60s+ on a cache miss), so this
// proxy PRE-WARMS the cache on server startup and refreshes it in the
// background: clients are always served the last-good body instantly
// (stale-while-revalidate) and never block on the upstream. GET /api/gdacs

const GDACS_URL = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?alertlevel=Orange;Red&eventlist=EQ;TC;FL;VO;DR;WF';
const TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 90 * 1000; // GDACS cold fetches can take 60s+
let cache = null;      // { at, body }
let inflight = null;   // de-dupe concurrent refreshes
let warming = false;   // one background timer per process

async function refresh() {
  if (inflight) return inflight;
  inflight = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const r = await fetch(GDACS_URL, {
        headers: { Accept: 'application/json', 'User-Agent': 'Kosmoskopos/1.0 (hackathon; humanitarian)' },
        signal: controller.signal,
      });
      if (!r.ok) throw new Error(`GDACS HTTP ${r.status}`);
      const body = await r.text();
      cache = { at: Date.now(), body };
      return cache;
    } finally {
      clearTimeout(timer);
    }
  })().catch((e) => { /* keep last-good cache; surface nothing to clients */ return null; })
    .finally(() => { inflight = null; });
  return inflight;
}

export function gdacsProxy() {
  function install(mw) {
    // Pre-warm on startup and keep the cache fresh in the background so no
    // client request ever pays the cold-fetch latency.
    if (!warming) {
      warming = true;
      refresh();
      const id = setInterval(() => { refresh(); }, TTL_MS);
      if (typeof id.unref === 'function') id.unref();
    }
    mw.use('/api/gdacs', async (req, res) => {
      const send = (status, body) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.end(body);
      };
      // Serve any cached body immediately; revalidate in the background if stale.
      if (cache) {
        if (Date.now() - cache.at >= TTL_MS) refresh();
        return send(200, cache.body);
      }
      // No cache yet (very first request before warm completed): await one fetch.
      try {
        await refresh();
        if (cache) return send(200, cache.body);
        return send(502, JSON.stringify({ error: 'GDACS unavailable', type: 'FeatureCollection', features: [] }));
      } catch (e) {
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
