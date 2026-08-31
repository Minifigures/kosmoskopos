// Toronto Heat Relief cool-spaces proxy (keyless, free, City of Toronto Open Data).
//
// The 500+ air-conditioned public "cool spaces" (Heat Relief Network) via the
// CKAN datastore_search API, normalized to a compact GeoJSON-ish list the layer
// draws directly. Same-origin (avoids CORS uncertainty). Cached 6 h (updates rarely).
// GET /api/toronto-cool

const RESOURCE_ID = '34b1fd5f-18c1-4449-b36e-7759228510ef';
const CKAN_URL = `https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/datastore_search?resource_id=${RESOURCE_ID}&limit=1000`;
const TTL_MS = 6 * 60 * 60 * 1000;
let cache = null;

export function torontoCoolProxy() {
  function install(mw) {
    mw.use('/api/toronto-cool', async (req, res) => {
      const send = (s, b) => { res.statusCode = s; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'private, max-age=3600'); res.end(b); };
      const now = Date.now();
      if (cache && now - cache.at < TTL_MS) return send(200, cache.body);
      try {
        const r = await fetch(CKAN_URL, { headers: { Accept: 'application/json', 'User-Agent': 'KosmoSkopos/1.0 (hackathon)' } });
        if (!r.ok) { if (cache) return send(200, cache.body); return send(502, JSON.stringify({ spaces: [], error: `CKAN HTTP ${r.status}` })); }
        const data = await r.json().catch(() => ({}));
        const records = data?.result?.records || [];
        const spaces = [];
        for (const rec of records) {
          let g = rec.geometry;
          if (typeof g === 'string') { try { g = JSON.parse(g); } catch { g = null; } }
          const coords = g?.coordinates;
          if (!Array.isArray(coords) || coords.length < 2) continue;
          const [lon, lat] = coords;
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
          spaces.push({
            lon, lat,
            name: rec.locationName || 'Cool Space',
            type: rec.locationTypeDesc || '',
            address: (rec.address || '').trim(),
          });
        }
        const body = JSON.stringify({ spaces });
        cache = { at: now, body };
        return send(200, body);
      } catch (e) {
        if (cache) return send(200, cache.body);
        return send(502, JSON.stringify({ spaces: [], error: e?.message || 'CKAN fetch failed' }));
      }
    });
  }
  return { name: 'kosmoskopos-toronto-cool-proxy', configureServer(s) { install(s.middlewares); }, configurePreviewServer(s) { install(s.middlewares); } };
}
