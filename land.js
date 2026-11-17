'use strict';
// Keeps course legs off land. A leg that would cross the coastline is routed around it through
// points just off each headland (shortest path over a visibility graph, A*).
// data/coast.json: OSM coastline simplified to ~10 m; "rings" are islands (closed), "lines" are
// mainland. OSM coastline keeps land on the left, so the right-hand side is always water.
const land = (() => {
  const K = Math.cos(37.85 * Math.PI / 180), CELL = 0.25, CLEAR = 0.05;  // nm
  const toXY = ll => ({x: ll.lng * 60 * K, y: ll.lat * 60});
  const toLL = p => L.latLng(p.y / 60, p.x / 60 / K);
  let segs = [], rings = [], nodes = [], grid = new Map(), ready;

  const cellKey = (i, j) => i + ',' + j;
  function cellsOf(ax, ay, bx, by, fn) {
    for (let i = Math.floor(Math.min(ax, bx) / CELL); i <= Math.floor(Math.max(ax, bx) / CELL); i++)
      for (let j = Math.floor(Math.min(ay, by) / CELL); j <= Math.floor(Math.max(ay, by) / CELL); j++) fn(cellKey(i, j));
  }
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const intersects = (a, b, c, d) => {
    const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
  };

  // Does segment a-b cross the coastline? Coast pieces in `ignore` (ring ids) don't count.
  function blocked(a, b, ignore) {
    let hit = false;
    const seen = new Set();
    cellsOf(a.x, a.y, b.x, b.y, k => {
      if (hit) return;
      for (const s of grid.get(k) || []) {
        if (seen.has(s)) continue; seen.add(s);
        const g = segs[s];
        if (!ignore.has(g.ring) && intersects(a, b, g.a, g.b)) { hit = true; return; }
      }
    });
    return hit;
  }
  const inRing = (p, r) => {  // even-odd ray cast
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++)
      if ((r[i].y > p.y) !== (r[j].y > p.y) && p.x < (r[j].x - r[i].x) * (p.y - r[i].y) / (r[j].y - r[i].y) + r[i].x) inside = !inside;
    return inside;
  };
  const ringsAt = p => new Set(rings.map((r, i) => inRing(p, r) ? i : -1).filter(i => i >= 0));

  function build(data) {
    const chains = [...data.rings.map(r => ({pts: r, ring: true})), ...data.lines.map(l => ({pts: l, ring: false}))];
    chains.forEach((c, ci) => {
      const P = c.pts.map(([lat, lon]) => toXY({lat, lng: lon}));
      if (c.ring) rings[ci] = P;
      for (let i = 0; i + 1 < P.length; i++) {
        const s = segs.push({a: P[i], b: P[i + 1], ring: ci}) - 1;
        cellsOf(P[i].x, P[i].y, P[i + 1].x, P[i + 1].y, k => (grid.get(k) || grid.set(k, []).get(k)).push(s));
      }
      // Headlands: vertices where the coast turns left (land bulges into the water). Each gets a
      // routing node CLEAR nm out on the water side (right-hand normal).
      const n = c.ring ? P.length - 1 : P.length;
      for (let i = 0; i < n; i++) {
        const prev = c.ring ? P[(i - 1 + n) % n] : P[i - 1], next = P[i + 1];
        if (!prev || !next) continue;
        const v = P[i];
        if (cross(prev, v, next) <= 0) continue;
        const n1 = norm(v.y - prev.y, prev.x - v.x), n2 = norm(next.y - v.y, v.x - next.x), m = norm(n1.x + n2.x, n1.y + n2.y);
        nodes.push({x: v.x + m.x * CLEAR, y: v.y + m.y * CLEAR});
      }
    });
    rings.length = chains.length;
    nodes = nodes.filter(p => !rings.some(r => r && inRing(p, r)));
  }
  function norm(x, y) { const l = Math.hypot(x, y) || 1; return {x: x / l, y: y / l}; }

  // Shortest water route a -> b (LatLngs). Returns {path: [LatLng], ok}. ok=false means no route
  // was found and the straight line is returned.
  function route(aLL, bLL) {
    const a = toXY(aLL), b = toXY(bLL);
    const ignore = new Set([...ringsAt(a), ...ringsAt(b)]);  // a mark on an island (e.g. Alcatraz Light)
    if (!blocked(a, b, ignore)) return {path: [aLL, bLL], ok: true};
    for (const pad of [0.75, 2.5]) {  // search near the leg first; a mark on the mainland fails fast
      const box = {x0: Math.min(a.x, b.x) - pad, x1: Math.max(a.x, b.x) + pad, y0: Math.min(a.y, b.y) - pad, y1: Math.max(a.y, b.y) + pad};
      const N = [a, b, ...nodes.filter(p => p.x > box.x0 && p.x < box.x1 && p.y > box.y0 && p.y < box.y1)];
      const path = astar(N, ignore);
      if (path) return {path: path.map(toLL), ok: true};
    }
    return {path: [aLL, bLL], ok: false};
  }
  function astar(N, ignore) {
    const dist = (i, j) => Math.hypot(N[i].x - N[j].x, N[i].y - N[j].y);
    const g = new Float64Array(N.length).fill(Infinity), from = new Int32Array(N.length).fill(-1), done = new Uint8Array(N.length);
    g[0] = 0;
    for (;;) {
      let u = -1, best = Infinity;
      for (let i = 0; i < N.length; i++) if (!done[i] && g[i] + dist(i, 1) < best) { best = g[i] + dist(i, 1); u = i; }
      if (u < 0) return null;
      if (u === 1) break;
      done[u] = 1;
      for (let v = 1; v < N.length; v++) {
        if (done[v] || g[u] + dist(u, v) >= g[v]) continue;
        if (!blocked(N[u], N[v], ignore)) { g[v] = g[u] + dist(u, v); from[v] = u; }
      }
    }
    const out = [];
    for (let i = 1; i >= 0; i = from[i]) out.unshift(N[i]);
    return out;
  }

  ready = fetch('data/coast.json').then(r => r.json()).then(build).catch(() => showStatus('Coastline unavailable — legs drawn straight', 5000));
  return {ready, route, crossesLand: (a, b) => blocked(toXY(a), toXY(b), new Set([...ringsAt(toXY(a)), ...ringsAt(toXY(b))]))};
})();
