import * as Cesium from 'cesium';

/**
 * NHC live tropical cyclones — every active hurricane / tropical storm now.
 *
 * NOAA National Hurricane Center CurrentStorms.json via the keyless /api/nhc
 * proxy. Each storm is a clamped marker + label colored by classification
 * (hurricane = red, tropical storm = orange), with the storm name and
 * intensity in knots. A high-salience "live weather threat" layer.
 */

const API_URL = '/api/nhc';

const CLASS_LABEL = {
  HU: 'Hurricane', MH: 'Major Hurricane', TS: 'Tropical Storm', TD: 'Tropical Depression',
  STS: 'Subtropical Storm', SD: 'Subtropical Depression', SS: 'Subtropical Storm',
  PTC: 'Potential Cyclone', TC: 'Cyclone',
};

function stormColor(cls, intensityKt) {
  const c = String(cls || '').toUpperCase();
  if (c === 'HU' || c === 'MH' || c === 'TC') return Number(intensityKt) >= 96 ? Cesium.Color.fromCssColorString('#ff1e3c') : Cesium.Color.fromCssColorString('#ff5a3c');
  if (c === 'TS' || c === 'STS' || c === 'SS') return Cesium.Color.fromCssColorString('#ff9500');
  return Cesium.Color.fromCssColorString('#ffd60a');
}

function createNhcLayer() {
  let _ds = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;

  const layer = {
    id: 'nhc',
    name: 'Hurricanes (live)',
    icon: '🌀',
    source: 'NOAA / NHC',
    updateInterval: 600000,

    init(viewer) {
      _ds = new Cesium.CustomDataSource('nhc');
      _ds.show = false;
      viewer.dataSources.add(_ds);
      _count = 0; _lastUpdate = null; _lastError = null;
      console.log('[Data:NHC] Initialized');
    },
    enable() { if (_ds) _ds.show = true; },
    disable() { if (_ds) _ds.show = false; },

    async update() {
      try {
        const response = await fetch(API_URL);
        if (!response.ok) { _lastError = `NHC HTTP ${response.status}`; return false; }
        const data = await response.json();
        const storms = Array.isArray(data?.activeStorms) ? data.activeStorms : (Array.isArray(data) ? data : []);
        _ds.entities.removeAll();
        let count = 0;
        for (const s of storms) {
          const lat = Number(s.latitudeNumeric ?? s.latitude);
          const lon = Number(s.longitudeNumeric ?? s.longitude);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
          const cls = s.classification || '';
          const kt = s.intensity;
          const name = s.name || 'Storm';
          const label = CLASS_LABEL[String(cls).toUpperCase()] || 'Cyclone';
          const color = stormColor(cls, kt);
          const major = String(cls).toUpperCase() === 'HU' && Number(kt) >= 96;
          count++;
          _ds.entities.add({
            id: `nhc:${s.id || s.binNumber || name}`,
            position: Cesium.Cartesian3.fromDegrees(lon, lat),
            point: {
              pixelSize: major ? 18 : 14,
              color: color.withAlpha(0.9),
              outlineColor: Cesium.Color.WHITE.withAlpha(0.9),
              outlineWidth: 2,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            label: {
              text: `🌀 ${name} · ${label}${Number.isFinite(Number(kt)) ? ` ${kt}kt` : ''}`,
              font: '600 12px "JetBrains Mono", monospace',
              fillColor: color,
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 3,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new Cesium.Cartesian2(0, -20),
              showBackground: true,
              backgroundColor: Cesium.Color.BLACK.withAlpha(0.55),
              scaleByDistance: new Cesium.NearFarScalar(1.0e6, 1.0, 2.0e7, 0.6),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            },
            properties: { classification: cls, intensityKt: kt, name, basin: s.basin || s.basinId || '' },
          });
        }
        _count = count; _lastUpdate = Date.now(); _lastError = null;
        console.log(`[Data:NHC] Updated: ${_count} active tropical cyclones`);
        return true;
      } catch (e) {
        console.warn('[Data:NHC] Fetch error:', e);
        _lastError = 'NHC network error';
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

const nhcLayer = createNhcLayer();
export default nhcLayer;
