import * as Cesium from 'cesium';

/**
 * GDACS live disaster alerts — current Orange/Red events worldwide.
 *
 * Global Disaster Alert and Coordination System (JRC / UN OCHA): earthquakes,
 * tropical cyclones, floods, volcanoes, droughts and wildfires that are active
 * RIGHT NOW, fetched keyless through the same-origin /api/gdacs proxy. Each
 * event is a clamped point + label, colored by alert level (Red = severe).
 * This is the headline "live crises" layer for KosmoSkopos.
 */

const API_URL = '/api/gdacs';

const TYPE_EMOJI = { EQ: '🌍', TC: '🌀', FL: '🌊', VO: '🌋', DR: '🏜️', WF: '🔥' };
const TYPE_LABEL = { EQ: 'Earthquake', TC: 'Cyclone', FL: 'Flood', VO: 'Volcano', DR: 'Drought', WF: 'Wildfire' };

function alertColor(level) {
  const l = String(level || '').toLowerCase();
  if (l === 'red') return Cesium.Color.fromCssColorString('#ff3b30');
  if (l === 'orange') return Cesium.Color.fromCssColorString('#ff9500');
  return Cesium.Color.fromCssColorString('#ffd60a');
}

function createGdacsLayer() {
  let _ds = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  // Analyst seam: the most severe active alerts (Red first), so the Duty
  // Officer can name real events instead of only counting them.
  let _top = [];

  const LEVEL_RANK = { red: 0, orange: 1, green: 2 };

  const layer = {
    id: 'gdacs',
    name: 'Disaster Alerts',
    icon: '🚨',
    source: 'GDACS',
    updateInterval: 300000,

    init(viewer) {
      _ds = new Cesium.CustomDataSource('gdacs');
      _ds.show = false;
      viewer.dataSources.add(_ds);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      _top = [];
      console.log('[Data:GDACS] Initialized');
    },

    enable() {
      _enabled = true;
      if (_ds) _ds.show = true;
    },

    disable() {
      _enabled = false;
      if (_ds) _ds.show = false;
    },

    async update() {
      try {
        const response = await fetch(API_URL);
        if (!response.ok) {
          _lastError = `GDACS HTTP ${response.status}`;
          return false;
        }
        const geojson = await response.json();
        if (!geojson || !Array.isArray(geojson.features)) {
          _lastError = 'Malformed GDACS response';
          return false;
        }

        _ds.entities.removeAll();
        let count = 0;
        const events = [];
        for (const feature of geojson.features) {
          const coords = feature?.geometry?.coordinates;
          if (!Array.isArray(coords) || coords.length < 2) continue;
          const [lon, lat] = coords;
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

          const p = feature.properties || {};
          const type = p.eventtype || '';
          const level = p.alertlevel || '';
          const name = p.name || p.eventname || TYPE_LABEL[type] || 'Event';
          const emoji = TYPE_EMOJI[type] || '⚠️';
          const color = alertColor(level);
          const severe = String(level).toLowerCase() === 'red';
          count++;
          events.push({ name, type: TYPE_LABEL[type] || type || 'Event', level: String(level || 'orange').toLowerCase(), lon, lat });

          _ds.entities.add({
            id: `gdacs:${type}:${p.eventid || count}`,
            position: Cesium.Cartesian3.fromDegrees(lon, lat),
            point: {
              pixelSize: severe ? 16 : 12,
              color: color.withAlpha(0.9),
              outlineColor: Cesium.Color.WHITE.withAlpha(0.85),
              outlineWidth: 2,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            label: {
              text: `${emoji} ${name}`,
              font: '600 12px "JetBrains Mono", monospace',
              fillColor: color,
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 3,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new Cesium.Cartesian2(0, -18),
              showBackground: true,
              backgroundColor: Cesium.Color.BLACK.withAlpha(0.55),
              scaleByDistance: new Cesium.NearFarScalar(1.0e6, 1.0, 1.5e7, 0.5),
              translucencyByDistance: new Cesium.NearFarScalar(1.0e7, 1.0, 3.0e7, 0.0),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            },
            properties: {
              gdacsType: type,
              alertlevel: level,
              name,
              description: p.htmldescription || p.description || '',
            },
          });
        }

        events.sort((a, b) => (LEVEL_RANK[a.level] ?? 3) - (LEVEL_RANK[b.level] ?? 3));
        _top = events.slice(0, 6);
        _count = count;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(`[Data:GDACS] Updated: ${_count} Orange/Red disaster alerts`);
        return true;
      } catch (e) {
        console.warn('[Data:GDACS] Fetch error:', e);
        _lastError = 'GDACS network error';
        return false;
      }
    },

    destroy(viewer) {
      _enabled = false;
      if (_ds) {
        viewer.dataSources.remove(_ds, true);
        _ds = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _top = [];
    },

    getStats() {
      return { count: _count, lastUpdate: _lastUpdate, error: _lastError, top: _top };
    },
  };
  return layer;
}

const gdacsLayer = createGdacsLayer();

export default gdacsLayer;
