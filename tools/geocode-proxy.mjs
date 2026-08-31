// Free, keyless geocoding proxy (OpenStreetMap Nominatim).
//
// Replaces the fork's Google Geocoding dependency (which needs a billed Google
// key) with a same-origin GET /api/geocode?q=<place>&bounds=<south,west,north,east>.
// Server-side so a proper User-Agent is sent (Nominatim usage policy) and results
// are cached. Returns a Google-ish shape the client already understands.
//
// Reply (JSON): { lat, lng, label, types, viewport:{southwest,northeast} } | null

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'KosmoSkopos-globe/1.0 (hackathon; contact minifiguresgt@gmail.com)';
const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map(); // key -> { at, payload }

// Map Nominatim class/type to the Google-style `types` the client's
// geocodeNavigationMode() keys off, so camera framing stays sensible.
function mapTypes(type, klass, addresstype) {
  const t = String(addresstype || type || '').toLowerCase();
  const c = String(klass || '').toLowerCase();
  if (t === 'country') return ['country'];
  if (['state', 'province', 'region'].includes(t)) return ['administrative_area_level_1'];
  if (['county', 'state_district'].includes(t)) return ['administrative_area_level_2'];
  if (['city', 'town', 'municipality'].includes(t)) return ['locality'];
  if (['village', 'hamlet', 'suburb', 'neighbourhood', 'quarter'].includes(t)) return ['sublocality', 'locality'];
  if (c === 'natural' || ['peak', 'volcano', 'mountain_range', 'water', 'bay', 'sea', 'desert', 'island'].includes(t)) return ['natural_feature'];
  if (['building', 'house', 'residential'].includes(t)) return ['premise'];
  if (c === 'highway' || t === 'road') return ['route'];
  return ['establishment'];
}

export function geocodeProxy() {
  function install(middlewares) {
    middlewares.use('/api/geocode', async (req, res) => {
      const send = (status, payload) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'private, max-age=3600');
        res.end(JSON.stringify(payload));
      };
      const reqUrl = new URL(req.url || '', 'http://localhost');
      const query = String(reqUrl.searchParams.get('q') || '').trim();
      if (!query) {
        send(400, { error: 'q is required' });
        return;
      }
      const key = query.toLowerCase();
      const now = Date.now();
      const hit = cache.get(key);
      if (hit && now - hit.at < CACHE_TTL_MS) {
        send(200, hit.payload);
        return;
      }
      try {
        const url = new URL(NOMINATIM_URL);
        url.searchParams.set('q', query);
        url.searchParams.set('format', 'jsonv2');
        url.searchParams.set('limit', '1');
        url.searchParams.set('addressdetails', '0');
        // Soft viewport bias (bounds arrive as "south,west,north,east" from the client).
        const bounds = reqUrl.searchParams.get('bounds');
        if (bounds) {
          const p = bounds.split(',').map(Number);
          if (p.length === 4 && p.every(Number.isFinite)) {
            // Nominatim viewbox order is west,north,east,south; bounded=0 = soft bias.
            url.searchParams.set('viewbox', `${p[1]},${p[2]},${p[3]},${p[0]}`);
            url.searchParams.set('bounded', '0');
          }
        }
        const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
        const arr = await response.json().catch(() => []);
        const g = Array.isArray(arr) ? arr[0] : null;
        if (!g || !Number.isFinite(Number(g.lat)) || !Number.isFinite(Number(g.lon))) {
          cache.set(key, { at: now, payload: null });
          send(200, null);
          return;
        }
        const bb = Array.isArray(g.boundingbox) ? g.boundingbox.map(Number) : null; // [south, north, west, east]
        const viewport = (bb && bb.length === 4 && bb.every(Number.isFinite))
          ? { southwest: { lat: bb[0], lng: bb[2] }, northeast: { lat: bb[1], lng: bb[3] } }
          : null;
        const payload = {
          lat: Number(g.lat),
          lng: Number(g.lon),
          label: g.display_name || query,
          types: mapTypes(g.type, g.class, g.addresstype),
          viewport,
        };
        cache.set(key, { at: now, payload });
        send(200, payload);
      } catch (error) {
        send(502, { error: error?.message || 'geocode failed' });
      }
    });
  }
  return {
    name: 'argus-geocode-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
