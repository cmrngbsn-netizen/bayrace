'use strict';
// Courses: pick one from an event's SI, draw it, hide every mark not in it.
// Event files (data/events/*.json): marks table maps the SI's mark ids to a YRA/club mark ("ref")
// or to an approximate position (inflatables, wind marks); courses list marks as "ID-P"/"ID-S".
// Mark entries may override nick/colors/type/place/desc of the referenced mark.
const EVENT_URL = 'data/events/cyc-fnr-2026.json';
const SIDE = {P: 'port', S: 'stbd'}, SIDE_WORD = {P: 'PORT', S: 'STBD'};

const store = {  // per-device conveniences; the app must work when storage is unavailable
  get(k) { try { return JSON.parse(localStorage.getItem('bayrace:' + k)); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem('bayrace:' + k) : localStorage.setItem('bayrace:' + k, JSON.stringify(v)); } catch {} }
};

const nm = (a, b) => {  // flat-earth distance in nm; plenty accurate across the Bay
  const k = Math.cos((a.lat + b.lat) / 2 * Math.PI / 180);
  return Math.hypot((a.lat - b.lat) * 60, (a.lng - b.lng) * 60 * k);
};
const pathNm = p => p.slice(1).reduce((s, b, i) => s + nm(p[i], b), 0);

const courseLayer = L.layerGroup().addTo(map), leaderLayer = L.layerGroup().addTo(map);
const bar = document.getElementById('coursebar');
const select = document.getElementById('course');
const summary = document.getElementById('summary');
let event, marksById, current, hiddenGroups = null, drawn = null;

// Position of an event mark: user-placed > event table > referenced YRA/club mark.
function markPos(id) {
  const saved = store.get(`pos:${event.id}:${id}`);
  if (saved) return L.latLng(saved);
  const m = event.marks[id];
  if (!m) return null;
  if (m.ref) { const r = marksById[m.ref]; return r ? L.latLng(r.lat, r.lon) : null; }
  return L.latLng(m.lat, m.lon);
}
function info(id) {
  const em = event.marks[id] || {}, ref = em.ref && marksById[em.ref], p = markPos(id);
  const base = ref ? markInfo(ref) : {org: '', desc: ''};
  const out = {...base, id: ref && ref.id !== id ? `${id} (${ref.id})` : id, lat: p.lat, lng: p.lng};
  ['nick', 'colors', 'type', 'place', 'desc'].forEach(k => { if (em[k] !== undefined) out[k] = em[k]; });
  return out;
}
const placed = id => !!store.get(`pos:${event.id}:${id}`);

function draw(no) {
  courseLayer.clearLayers();
  leaderLayer.clearLayers();
  drawn = null;
  current = event.courses.find(c => c.no === no);
  store.set('course', current ? current.no : null);
  // Hide the mark layers while a course is up; restore only the ones that were showing.
  if (current && !hiddenGroups) { hiddenGroups = [groups.yra, groups.other].filter(g => map.hasLayer(g)); hiddenGroups.forEach(g => map.removeLayer(g)); }
  if (!current && hiddenGroups) { hiddenGroups.forEach(g => map.addLayer(g)); hiddenGroups = null; }
  if (!current) { summary.textContent = ''; return; }

  const rounds = current.marks.map((t, i) => { const [id, side] = t.split('-'); return {id, side, n: i + 1, pos: markPos(id)}; });
  const missing = [...new Set(rounds.filter(r => !r.pos).map(r => r.id))];
  if (missing.length) showStatus(`No position for mark ${missing.join(', ')}`, 5000);
  const start = L.latLng(event.start.lat, event.start.lon), finish = L.latLng(event.finish.lat, event.finish.lon);
  const stops = [{id: 'SF', pos: start}, ...rounds.filter(r => r.pos), {id: 'SF', pos: finish}];

  // Legs, routed around land. A leg sailed more than once (either way) is drawn once.
  const legs = new Map();
  let total = 0, offLand = true;
  stops.slice(1).forEach((b, i) => {
    const a = stops[i];
    if (nm(a.pos, b.pos) < 0.01) return;
    const key = [a.id, b.id].sort().join('|');
    let leg = legs.get(key);
    if (!leg) {
      const r = land.route(a.pos, b.pos);
      offLand = offLand && r.ok;
      leg = {from: a.id, path: r.path, dist: pathNm(r.path), dirs: new Set()};
      legs.set(key, leg);
    }
    leg.dirs.add(a.id === leg.from ? 1 : -1);
    total += leg.dist;
  });
  legs.forEach(leg => {
    leg.line = L.polyline(leg.path, {color: '#0b2a3d', weight: 3, opacity: 0.85, interactive: false}).addTo(courseLayer);
    leg.tag = L.marker(leg.path[0], {interactive: false, keyboard: false, icon: L.divIcon({className: 'legtag', iconSize: [0, 0],
      html: `<div class="lt">${[...leg.dirs].map(d => `<span class="arr" data-d="${d}">➤</span>`).join('')}${leg.dist.toFixed(1)}</div>`})}).addTo(courseLayer);
  });

  // One dot + one label per mark, listing every rounding of it (e.g. "2·4").
  const byId = {};
  rounds.filter(r => r.pos).forEach(r => (byId[r.id] = byId[r.id] || {...r, order: []}).order.push(r.n));
  const marks = Object.values(byId).map(r => {
    const em = event.marks[r.id] || {}, inf = info(r.id), approx = !!em.approx, unplaced = approx && !placed(r.id);
    const sw = `<span class="sw${inf.colors && inf.colors.length ? '' : ' unk'}" style="background:${swatch(inf.colors)}"></span>`;
    const dot = L.marker(r.pos, {draggable: approx, keyboard: false, zIndexOffset: 1000, icon: L.divIcon({iconSize: [0, 0],
      className: `cdot${approx ? ' approx' : ''}`, html: `<span style="background:${swatch(inf.colors)}"></span>`})}).addTo(courseLayer);
    const tag = L.marker(r.pos, {keyboard: false, zIndexOffset: 900, icon: L.divIcon({className: 'mtag', iconSize: [0, 0],
      // Two lines normally; "compact" (one line, set by placeLabels when crowded) hides the type and
      // shows the swatch and side inline. Nickname and color stay visible either way.
      html: `<div class="tag${unplaced ? ' unplaced' : ''}"><div class="t1"><span class="ord">${r.order.join('·')}</span><b>${r.id}</b>`
        + `<span class="${inf.nick ? 'nick' : 'place'}">${inf.nick || inf.place || ''}</span>${sw}<span class="side ${SIDE[r.side]}">${SIDE_WORD[r.side]}</span></div>`
        + `<div class="t2">${sw}<span class="lk">${looksLike(inf.colors, inf.type, true)}</span>`
        + `<span class="side ${SIDE[r.side]}">${SIDE_WORD[r.side]}</span></div></div>`})}).addTo(courseLayer);
    [dot, tag].forEach(m => m.bindPopup(() => popup(r.id, r.side, r.order), {maxWidth: 280}));
    if (approx) dot.on('dragend', () => { store.set(`pos:${event.id}:${r.id}`, dot.getLatLng()); draw(current.no); });
    return {pos: r.pos, tag};
  });
  const sf = L.marker(start, {keyboard: false, zIndexOffset: 800, icon: L.divIcon({className: 'sf', iconSize: [0, 0], html: '<span>S/F</span>'})})
    .bindPopup(`<div class="card"><div class="ct">Start / Finish</div><div class="cd">${event.start.desc}</div><div class="cd">${event.finish.desc}</div></div>`).addTo(courseLayer);

  const unplaced = Object.keys(byId).filter(id => (event.marks[id] || {}).approx && !placed(id));
  summary.innerHTML = `<div class="seq">Start → ${rounds.map(r => `<span class="${SIDE[r.side]}">${r.id} ${r.side}</span>`).join(' → ')} → Finish</div>`
    + `<div class="dist">${total.toFixed(1)} nm <span>(SI ~${current.dist})</span>${unplaced.length ? ` · <span class="warn">approx: ${unplaced.join(', ')}</span>` : ''}`
    + `${offLand ? '' : ' · <span class="warn">a leg may cross land</span>'}</div>`;
  drawn = {legs: [...legs.values()], marks, sf: start};
  map.fitBounds(L.latLngBounds([...legs.values()].flatMap(l => l.path)), {paddingTopLeft: [30, 60], paddingBottomRight: [30, bar.offsetHeight + 30], maxZoom: 15});
  placeLabels();
}

// ---- Label placement (screen space; redone after every zoom or pan) ----
// Mark labels go on whichever side of the dot crosses the fewest course lines and other labels.
// Leg labels slide along their leg to a clear spot, and are hidden only if none is found.
const segHitsBox = (p, q, b) => {  // Liang-Barsky clip of segment p-q against box b
  let t0 = 0, t1 = 1;
  const dx = q.x - p.x, dy = q.y - p.y;
  for (const [pp, qq] of [[-dx, p.x - b.x0], [dx, b.x1 - p.x], [-dy, p.y - b.y0], [dy, b.y1 - p.y]]) {
    if (pp === 0) { if (qq < 0) return false; continue; }
    const t = qq / pp;
    if (pp < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return true;
};
const boxesHit = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const grow = (b, m) => ({x0: b.x0 - m, y0: b.y0 - m, x1: b.x1 + m, y1: b.y1 + m});

function placeLabels() {
  if (!drawn) return;
  const pt = ll => map.latLngToContainerPoint(ll), size = map.getSize();
  const view = {x0: 4, y0: 50, x1: size.x - 4, y1: size.y - bar.offsetHeight - 30};  // clear of controls and course bar
  const segs = drawn.legs.flatMap(l => l.path.slice(1).map((b, i) => [pt(l.path[i]), pt(b)]));
  const taken = [...drawn.marks.map(m => pt(m.pos)), pt(drawn.sf)].map(p => ({x0: p.x - 16, y0: p.y - 13, x1: p.x + 16, y1: p.y + 13}));
  const score = (b, lineCost) => {
    let s = 0;
    for (const t of taken) if (boxesHit(b, t)) s += 100;
    for (const [p, q] of segs) if (segHitsBox(p, q, b)) s += lineCost;
    if (b.x0 < 4 || b.y0 < 50 || b.x1 > size.x - 4 || b.y1 > size.y - bar.offsetHeight - 30) s += 300;  // off screen or under the controls
    return s;
  };

  // 8 positions around the dot, then further out (joined to the dot by a leader line). Every
  // candidate is pulled back inside the visible map area, so a label is never cut off.
  const bestSpot = ({w, h, c}) => {
    let best;
    [15, 50, 90].forEach((g, ri) => [[g, -h / 2], [-g - w, -h / 2], [-w / 2, -g - h], [-w / 2, g], [g - 4, -g - h + 4], [-g - w + 4, -g - h + 4], [g - 4, g - 4], [-g - w + 4, g - 4]]
      .forEach(([dx, dy], i) => {
        const x = Math.max(view.x0, Math.min(c.x + dx, view.x1 - w)), y = Math.max(view.y0, Math.min(c.y + dy, view.y1 - h));
        const shift = Math.hypot(x - c.x - dx, y - c.y - dy), b = {x0: x, y0: y, x1: x + w, y1: y + h};
        const s = score(grow(b, 3), 10) + i * 0.1 + ri * 6 + shift * 0.1 + (boxesHit(b, {x0: c.x - 12, y0: c.y - 12, x1: c.x + 12, y1: c.y + 12}) ? 100 : 0);
        if (!best || s < best.s) best = {s, b, far: ri > 0 || shift > 8};
      }));
    return best;
  };
  const fixed = taken.slice();
  const placeMarks = compact => {
    const items = drawn.marks.map(m => {
      const el = m.tag.getElement().firstChild;
      el.classList.toggle('compact', compact);
      return {m, el, w: el.offsetWidth, h: el.offsetHeight, c: pt(m.pos), best: null};
    });
    // Greedy in course order, then two passes re-placing each label with every other label's
    // current spot known (so an early label can move out of the way of a later one).
    for (let pass = 0; pass < 3; pass++) items.forEach((it, k) => {
      taken.length = 0;
      taken.push(...fixed, ...items.filter((o, j) => j !== k && o.best).map(o => grow(o.best.b, 2)));
      it.best = bestSpot(it);
    });
    taken.length = 0;
    taken.push(...fixed, ...items.map(o => grow(o.best.b, 2)));
    items.forEach(({el, c, best}) => el.style.transform = `translate(${best.b.x0 - c.x}px,${best.b.y0 - c.y}px)`);
    return {items, worst: Math.max(...items.map(o => o.best.s)),
      leaders: items.filter(o => o.best.far).map(({m, c, best: {b}}) => [m.pos, {x: Math.max(b.x0, Math.min(c.x, b.x1)), y: Math.max(b.y0, Math.min(c.y, b.y1))}])};
  };
  drawn.marks.forEach(m => m.tag.getElement().firstChild.classList.remove('mini'));
  let res = placeMarks(false);
  if (res.worst >= 20) res = placeMarks(true);  // a full label covers 2+ lines or another label
  if (res.worst >= 100) {  // still colliding (tight cluster): shrink just those labels to ID, color and side
    res.items.filter(o => o.best.s >= 100).forEach(o => o.el.classList.add('mini'));
    res = placeMarks(true);
  }
  leaderLayer.clearLayers();
  res.leaders.forEach(([ll, p]) => L.polyline([ll, map.containerPointToLatLng(L.point(p.x, p.y))], {color: '#0b2a3d', weight: 1.5, opacity: 0.7, dashArray: '2 3', interactive: false}).addTo(leaderLayer));

  drawn.legs.forEach(leg => {
    const el = leg.tag.getElement(), lt = el.firstChild, P = leg.path.map(pt);
    const lens = P.slice(1).map((b, i) => Math.hypot(b.x - P[i].x, b.y - P[i].y)), L = lens.reduce((s, x) => s + x, 0);
    el.style.display = L < 70 ? 'none' : '';
    if (L < 70) return;
    const w = lt.offsetWidth, h = lt.offsetHeight;
    let best;
    [0.5, 0.38, 0.62, 0.28, 0.72].forEach(t => {
      let d = t * L, i = 0;
      while (i < lens.length - 1 && d > lens[i]) d -= lens[i++];
      const a = P[i], b = P[i + 1], f = d / (lens[i] || 1), x = a.x + (b.x - a.x) * f, y = a.y + (b.y - a.y) * f;
      const ux = (b.x - a.x) / (lens[i] || 1), uy = (b.y - a.y) / (lens[i] || 1), ang = Math.atan2(uy, ux) * 180 / Math.PI;
      [1, -1].forEach(side => {
        const off = (Math.abs(ux) * h + Math.abs(uy) * w) / 2 + 5;  // clear the line whatever its angle
        const cx = x - uy * off * side, cy = y + ux * off * side;
        const bx = {x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2}, s = score(grow(bx, 2), 4) + Math.abs(t - 0.5) * 4;
        if (!best || s < best.s) best = {s, bx, ang};
      });
    });
    if (best.s >= 100) { el.style.display = 'none'; return; }
    const anchor = pt(leg.path[0]);
    lt.style.transform = `translate(${best.bx.x0 - anchor.x}px,${best.bx.y0 - anchor.y}px)`;
    lt.querySelectorAll('.arr').forEach(a => a.style.transform = `rotate(${best.ang + (a.dataset.d === '-1' ? 180 : 0)}deg)`);
    taken.push(best.bx);
  });
}
map.on('moveend', placeLabels);  // after zooms and pans (including fitBounds' own animation)
window.addEventListener('resize', () => setTimeout(placeLabels, 100));

function popup(id, side, order) {
  const em = event.marks[id] || {}, isPlaced = placed(id);
  const el = document.createElement('div');
  const nth = n => n + ({1: 'st', 2: 'nd', 3: 'rd'}[n] || 'th');
  el.innerHTML = markCard(info(id),
    `<div class="cr"><span>Rounding</span><b class="${SIDE[side]}">Leave to ${side === 'P' ? 'port' : 'starboard'}</b> · ${order.map(nth).join(' & ')} mark</div>`
    + (em.approx ? `<div class="cr warn"><span>Position</span>${isPlaced ? 'Placed by you on this device' : 'Approximate'} — drag the dot to move it</div>` : ''))
    + (isPlaced ? '<button type="button">Reset position</button>' : '');
  const btn = el.querySelector('button');
  if (btn) btn.onclick = () => { store.set(`pos:${event.id}:${id}`, null); map.closePopup(); draw(current.no); };
  return el;
}

Promise.all([marksReady, fetch(EVENT_URL).then(r => r.json()), land.ready]).then(([byId, ev]) => {
  marksById = byId; event = ev;
  const sections = [...new Set(ev.courses.map(c => c.section))];
  select.innerHTML = `<option value="">${ev.name} — choose course</option>` + sections.map(s =>
    `<optgroup label="${s}">${ev.courses.filter(c => c.section === s).map(c => `<option value="${c.no}">Course ${c.no} — ${c.dist} nm</option>`).join('')}</optgroup>`).join('');
  select.onchange = () => draw(select.value);
  const last = store.get('course');
  if (last && ev.courses.some(c => c.no === last)) { select.value = last; draw(last); }
  bar.hidden = false;
}).catch(() => showStatus('Could not load courses', 5000));
