'use strict';
// Courses: pick one from an event's SI, draw it, hide every mark not in it.
// Event files (data/events/*.json): marks table maps the SI's mark ids to a YRA/club mark ("ref")
// or to an approximate position (inflatables, wind marks); courses list marks as "ID-P"/"ID-S".
const EVENT_URL = 'data/events/cyc-fnr-2026.json';
const SIDE = {P: 'port', S: 'stbd'};
const NM_PER_DEG = 60;

const store = {  // per-device conveniences; the app must work when storage is unavailable
  get(k) { try { return JSON.parse(localStorage.getItem('bayrace:' + k)); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem('bayrace:' + k) : localStorage.setItem('bayrace:' + k, JSON.stringify(v)); } catch {} }
};

const nm = (a, b) => {  // flat-earth distance in nm; plenty accurate across the Bay
  const k = Math.cos((a.lat + b.lat) / 2 * Math.PI / 180);
  return Math.hypot((a.lat - b.lat) * NM_PER_DEG, (a.lng - b.lng) * NM_PER_DEG * k);
};

const courseLayer = L.layerGroup().addTo(map);
const bar = document.getElementById('coursebar');
const select = document.getElementById('course');
const summary = document.getElementById('summary');
let event, marksById, current, hiddenGroups = null;

// Position of an event mark: user-placed > event table > referenced YRA/club mark.
function markPos(id) {
  const saved = store.get(`pos:${event.id}:${id}`);
  if (saved) return L.latLng(saved);
  const m = event.marks[id];
  if (!m) return null;
  if (m.ref) { const r = marksById[m.ref]; return r ? L.latLng(r.lat, r.lon) : null; }
  return L.latLng(m.lat, m.lon);
}
const markDesc = id => { const m = event.marks[id] || {}; return m.desc || (marksById[m.ref] || {}).desc || ''; };

function draw(no) {
  courseLayer.clearLayers();
  current = event.courses.find(c => c.no === no);
  store.set('course', current ? current.no : null);
  // Hide the mark layers while a course is up; restore only the ones that were showing.
  if (current && !hiddenGroups) { hiddenGroups = [groups.yra, groups.other].filter(g => map.hasLayer(g)); hiddenGroups.forEach(g => map.removeLayer(g)); }
  if (!current && hiddenGroups) { hiddenGroups.forEach(g => map.addLayer(g)); hiddenGroups = null; }
  if (!current) { summary.textContent = ''; return; }

  const rounds = current.marks.map(t => { const [id, side] = t.split('-'); return {id, side, pos: markPos(id)}; });
  const missing = rounds.filter(r => !r.pos).map(r => r.id);
  if (missing.length) showStatus(`No position for mark ${[...new Set(missing)].join(', ')}`, 5000);
  const start = L.latLng(event.start.lat, event.start.lon), finish = L.latLng(event.finish.lat, event.finish.lon);
  const pts = [start, ...rounds.filter(r => r.pos).map(r => r.pos), finish];

  // Legs with a direction arrow and length at each midpoint. Mercator keeps angles, so the
  // projected bearing is right at every zoom.
  let total = 0;
  pts.slice(1).forEach((b, i) => {
    const a = pts[i], d = nm(a, b);
    if (d < 0.01) return;
    total += d;
    L.polyline([a, b], {color: '#0b2a3d', weight: 3, opacity: 0.85, interactive: false}).addTo(courseLayer);
    const pa = map.project(a, 0), pb = map.project(b, 0), deg = Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180 / Math.PI;
    L.marker([(a.lat + b.lat) / 2, (a.lng + b.lng) / 2], {interactive: false, keyboard: false, icon: L.divIcon({className: 'leg', iconSize: [0, 0],
      html: `<span class="arr" style="transform:rotate(${deg}deg)">➤</span><span class="legd">${d.toFixed(1)}</span>`})}).addTo(courseLayer);
  });

  // One marker per mark, listing every rounding of it (e.g. "2·4" when rounded twice).
  const byId = {};
  rounds.forEach((r, i) => r.pos && (byId[r.id] = byId[r.id] || {...r, order: []}).order.push(i + 1));
  Object.values(byId).forEach(r => {
    const em = event.marks[r.id] || {}, approx = !!em.approx && !store.get(`pos:${event.id}:${r.id}`);
    const icon = L.divIcon({className: `cm ${SIDE[r.side]}${em.approx ? ' approx' : ''}${approx ? ' unplaced' : ''}`, iconSize: [0, 0],
      html: `<span class="dot"></span><span class="clbl"><b>${r.id}</b> <i>${r.order.join('·')}</i> <em>${r.side}</em></span>`});
    const mk = L.marker(r.pos, {icon, draggable: !!em.approx, keyboard: false, zIndexOffset: 1000}).addTo(courseLayer);
    mk.bindPopup(() => popup(r.id, r.side));
    if (em.approx) mk.on('dragend', () => { store.set(`pos:${event.id}:${r.id}`, mk.getLatLng()); draw(current.no); });
  });
  L.marker(start, {keyboard: false, icon: L.divIcon({className: 'sf', iconSize: [0, 0], html: '<span>S/F</span>'})})
    .bindPopup(`<div class="pop"><b>Start / Finish</b><div>${event.start.desc}</div><div>${event.finish.desc}</div></div>`).addTo(courseLayer);

  const unplaced = Object.keys(byId).filter(id => (event.marks[id] || {}).approx && !store.get(`pos:${event.id}:${id}`));
  summary.innerHTML = `<div class="seq">Start → ${rounds.map(r => `<span class="${SIDE[r.side]}">${r.id} ${r.side}</span>`).join(' → ')} → Finish</div>`
    + `<div class="dist">${total.toFixed(1)} nm <span>(SI ~${current.dist})</span>${unplaced.length ? ` · <span class="warn">approx: ${unplaced.join(', ')}</span>` : ''}</div>`;
  map.fitBounds(L.latLngBounds(pts), {paddingTopLeft: [40, 60], paddingBottomRight: [40, bar.offsetHeight + 30], maxZoom: 15});
}

function popup(id, side) {
  const em = event.marks[id] || {}, p = markPos(id), placed = !!store.get(`pos:${event.id}:${id}`);
  const el = document.createElement('div');
  el.className = 'pop';
  el.innerHTML = `<b>${id} — leave to ${side === 'P' ? 'port' : 'starboard'}</b><div>${markDesc(id)}</div>`
    + `<div>${fmtDM(p.lat, 'N', 'S')}<br>${fmtDM(p.lng, 'E', 'W')}</div>`
    + (em.approx ? `<div class="warn">${placed ? 'Placed by you on this device.' : 'Approximate position.'} Drag the mark to move it.</div>` : '')
    + (placed ? '<button type="button">Reset position</button>' : '');
  const btn = el.querySelector('button');
  if (btn) btn.onclick = () => { store.set(`pos:${event.id}:${id}`, null); map.closePopup(); draw(current.no); };
  return el;
}

Promise.all([marksReady, fetch(EVENT_URL).then(r => r.json())]).then(([byId, ev]) => {
  marksById = byId; event = ev;
  const sections = [...new Set(ev.courses.map(c => c.section))];
  select.innerHTML = `<option value="">${ev.name} — choose course</option>` + sections.map(s =>
    `<optgroup label="${s}">${ev.courses.filter(c => c.section === s).map(c => `<option value="${c.no}">Course ${c.no} — ${c.dist} nm</option>`).join('')}</optgroup>`).join('');
  select.onchange = () => draw(select.value);
  const last = store.get('course');
  if (last && ev.courses.some(c => c.no === last)) { select.value = last; draw(last); }
  bar.hidden = false;
}).catch(() => showStatus('Could not load courses', 5000));
