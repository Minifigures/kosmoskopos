import * as Cesium from 'cesium';

/**
 * Toronto Heat Relief Network — 500+ air-conditioned public cool spaces.
 *
 * City of Toronto Open Data via the keyless /api/toronto-cool proxy. During a
 * heat event these libraries, community centres, pools and malls are where
 * vulnerable residents can cool off. Each is a clamped marker + label; labels
 * only surface when zoomed into the city so the global view stays clean. This
 * is KosmoSkopos's hyperlocal social-good layer.
 */

const API_URL = '/api/toronto-cool';
const COOL = Cesium.Color.fromCssColorString('#ffb638');

function createTorontoCoolLayer() {
  let _ds = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;

  const layer = {
    id: 'toronto-cool',
    name: 'Toronto Cool Spaces',
    icon: '❄️',
    source: 'City of Toronto',
    updateInterval: 3600000,

    init(viewer) {
      _ds = new Cesium.CustomDataSource('toronto-cool');
      _ds.show = false;
      viewer.dataSources.add(_ds);
      _count = 0; _lastUpdate = null; _lastError = null;
      console.log('[Data:TorontoCool] Initialized');
    },
    enable() { if (_ds) _ds.show = true; },
    disable() { if (_ds) _ds.show = false; },

    async update() {
      try {
        const response = await fetch(API_URL);
        if (!response.ok) { _lastError = `Toronto HTTP ${response.status}`; return false; }
        const data = await response.json();
        const spaces = Array.isArray(data?.spaces) ? data.spaces : [];
        _ds.entities.removeAll();
        let count = 0;
        for (const s of spaces) {
          if (!Number.isFinite(s.lon) || !Number.isFinite(s.lat)) continue;
          count++;
          _ds.entities.add({
            id: `toronto-cool:${count}`,
            position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat),
            point: {
              pixelSize: 8,
              color: COOL.withAlpha(0.9),
              outlineColor: Cesium.Color.WHITE.withAlpha(0.8),
              outlineWidth: 1,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            label: {
              text: `❄️ ${s.name}`,
              font: '500 11px "JetBrains Mono", monospace',
              fillColor: COOL,
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 3,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new Cesium.Cartesian2(0, -14),
              showBackground: true,
              backgroundColor: Cesium.Color.BLACK.withAlpha(0.5),
              // Labels only when zoomed into the city (< ~12 km); hidden far out.
              scaleByDistance: new Cesium.NearFarScalar(3.0e3, 1.0, 1.2e4, 0.6),
              translucencyByDistance: new Cesium.NearFarScalar(1.2e4, 1.0, 3.0e4, 0.0),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            },
            properties: { name: s.name, type: s.type, address: s.address },
          });
        }
        _count = count; _lastUpdate = Date.now(); _lastError = null;
        console.log(`[Data:TorontoCool] Updated: ${_count} cool spaces`);
        return true;
      } catch (e) {
        console.warn('[Data:TorontoCool] Fetch error:', e);
        _lastError = 'Toronto network error';
        return false;
      }
    },

    destroy(viewer) {
      if (_ds) { viewer.dataSources.remove(_ds, true); _ds = null; }
      _count = 0; _lastUpdate = null; _lastError = null;
    },
    getStats() { return { count: _count, lastUpdate: _lastUpdate, error: _lastError }; },
  };
  return layer;
}

const torontoCoolLayer = createTorontoCoolLayer();
export default torontoCoolLayer;
