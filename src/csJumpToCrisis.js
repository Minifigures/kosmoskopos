import * as Cesium from 'cesium';

/**
 * "Jump to crisis" control — one click flies the camera to the single most
 * severe active event on the map, reusing the highlight (_top) data the layers
 * already compute for the AI Duty Officer. Priority: a GDACS Red/Orange alert
 * (already sorted severest-first), else the strongest active hurricane, else the
 * largest recent earthquake. Self-contained (mirrors csAsk): injects its own
 * pill + styles and reads the live viewer/dataManager. Auto-hides when there is
 * nothing to jump to (e.g. a clean globe with no disaster layer enabled).
 */

let _viewer = null;
let _dataManager = null;
let _root = null;
let _labelEl = null;
let _labelTimer = null;

const STYLE = `
#cs-jump{position:fixed;left:50%;top:96px;transform:translateX(-50%);z-index:8000;font-family:'JetBrains Mono',ui-monospace,monospace;}
#cs-jump.cs-hidden{display:none;}
#cs-jump .cs-jump-btn{display:inline-flex;align-items:center;gap:9px;padding:8px 15px;border:1px solid rgba(244,183,64,.5);border-radius:16px;
  background:rgba(20,15,4,.82);backdrop-filter:blur(10px);color:#f4b740;font-size:11px;letter-spacing:.12em;text-transform:uppercase;
  cursor:pointer;box-shadow:0 4px 18px rgba(0,0,0,.4),0 0 16px rgba(244,183,64,.12);transition:transform .15s,box-shadow .15s,background .15s;}
#cs-jump .cs-jump-btn:hover{background:rgba(244,183,64,.16);box-shadow:0 4px 22px rgba(0,0,0,.5),0 0 26px rgba(244,183,64,.28);transform:translateY(-1px);}
#cs-jump .cs-jump-btn:focus-visible{outline:1px solid color-mix(in srgb,#f4b740 80%,transparent);outline-offset:2px;}
#cs-jump .cs-jump-btn:active{transform:translateY(0);}
#cs-jump .cs-jump-dot{width:8px;height:8px;border-radius:50%;background:#ff3b30;box-shadow:0 0 10px #ff3b30;flex:0 0 auto;
  animation:cs-jump-pulse 2s ease-in-out infinite;}
@keyframes cs-jump-pulse{0%,100%{opacity:1;}50%{opacity:.35;}}
@media (prefers-reduced-motion:reduce){#cs-jump .cs-jump-dot{animation:none;}}
#cs-jump .cs-jump-label{max-width:0;overflow:hidden;white-space:nowrap;opacity:0;color:#f7e4b5;text-transform:none;letter-spacing:.02em;
  transition:max-width .35s ease,opacity .35s ease;}
#cs-jump.cs-named .cs-jump-label{max-width:min(46vw,420px);opacity:1;}
#cs-jump .cs-jump-sep{width:1px;height:14px;background:rgba(244,183,64,.3);}
`;

function statsFor(id) {
  const layers = _dataManager?.layers;
  if (!layers) return null;
  let entry = null;
  try {
    if (typeof layers.get === 'function') entry = layers.get(id);
    else if (typeof layers.forEach === 'function') layers.forEach((e, k) => { if (k === id) entry = e; });
    return entry?.module?.getStats?.() || null;
  } catch { return null; }
}

const hasCoords = (x) => x && Number.isFinite(x.lon) && Number.isFinite(x.lat);

/** The single most severe active event, or null. */
function topCrisis() {
  const gd = statsFor('gdacs');
  if (gd && !gd.error && Array.isArray(gd.top)) {
    const e = gd.top.find(hasCoords);
    if (e) return { lon: e.lon, lat: e.lat, title: e.name, tag: `${e.level === 'red' ? 'RED ALERT' : 'ALERT'} · ${e.type}`, alt: 900000 };
  }
  const nh = statsFor('nhc');
  if (nh && !nh.error && Array.isArray(nh.top)) {
    const e = nh.top.find(hasCoords);
    if (e) return { lon: e.lon, lat: e.lat, title: e.name, tag: `${e.class}${e.kt != null ? ` · ${e.kt} kt` : ''}`, alt: 700000 };
  }
  const eq = statsFor('earthquakes');
  if (eq && !eq.error && Array.isArray(eq.top)) {
    const e = eq.top.find(hasCoords);
    if (e) return { lon: e.lon, lat: e.lat, title: e.place, tag: `M${e.mag} earthquake`, alt: 550000 };
  }
  return null;
}

function showLabel(text, holdMs = 6000) {
  if (!_labelEl || !_root) return;
  _labelEl.textContent = text;
  _root.classList.add('cs-named');
  clearTimeout(_labelTimer);
  _labelTimer = setTimeout(() => { _root?.classList.remove('cs-named'); }, holdMs);
}

function jump() {
  const c = topCrisis();
  if (!c || !_viewer) { showLabel('No active crisis — turn on a disaster layer', 4000); return; }
  try {
    _viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(c.lon, c.lat, c.alt),
      orientation: { heading: Cesium.Math.toRadians(12), pitch: Cesium.Math.toRadians(-55), roll: 0 },
      duration: 3.2,
    });
    showLabel(`${c.tag} · ${c.title}`);
  } catch {
    showLabel('Could not fly to the event', 3000);
  }
}

function refreshVisibility() {
  if (!_root) return;
  _root.classList.toggle('cs-hidden', !topCrisis());
}

export function initJumpToCrisis(viewer, dataManager) {
  _viewer = viewer;
  _dataManager = dataManager;

  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  _root = document.createElement('div');
  _root.id = 'cs-jump';
  _root.className = 'cs-hidden';
  _root.innerHTML = `
    <button class="cs-jump-btn" type="button" aria-label="Jump to the most severe active crisis" title="Fly to the most severe active crisis">
      <span class="cs-jump-dot" aria-hidden="true"></span>
      <span>Jump to crisis</span>
      <span class="cs-jump-sep" aria-hidden="true"></span>
      <span class="cs-jump-label"></span>
    </button>`;
  document.body.appendChild(_root);
  _labelEl = _root.querySelector('.cs-jump-label');
  _root.querySelector('.cs-jump-btn').addEventListener('click', jump);

  // Show/hide as disaster layers turn on and their feeds land. Cheap poll; the
  // getStats() calls are O(1) reads of already-computed highlight arrays.
  refreshVisibility();
  setInterval(refreshVisibility, 5000);
}
