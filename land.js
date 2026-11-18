'use strict';
// Keeps course legs off land. A leg that would cross the coastline is routed around it through
// points just off each headland (shortest path over a visibility graph, A*).
// data/coast.json: OSM coastline simplified to ~10 m; "rings" are islands (closed), "lines" are
// mainland. OSM coastline keeps land on the left, so the right-hand side is always water.
const land = (() => {
  // CLEAR: headland waypoints sit this far out. BUF: legs keep at least this far off the coast
  // (except near their own ends, since a mark can be close to shore).
  const K = Math.cos(37.85 * Math.PI / 180), CELL = 0.25, CLEAR = 0.08, BUF = 0.05;  // nm
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

  const ptSeg = (p, a, b) => {
    const vx = b.x - a.x, vy = b.y - a.y, t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / (vx * vx + vy * vy || 1)));
    return Math.hypot(p.x - a.x - vx * t, p.y - a.y - vy * t);
  };
  const segSeg = (a, b, c, d) => Math.min(ptSeg(a, c, d), ptSeg(b, c, d), ptSeg(c, a, b), ptSeg(d, a, b));

  // Does segment a-b cross the coastline, or (buf > 0) pass within buf of it away from its ends?
  // Coast pieces in `ignore` (ring ids) don't count.
  function blocked(a, b, ignore, buf = 0) {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 3 * buf) buf = 0;  // a short hop between close points: crossing check only
    const ux = (b.x - a.x) / (len || 1), uy = (b.y - a.y) / (len || 1);
    const A = {x: a.x + ux * 1.5 * buf, y: a.y + uy * 1.5 * buf}, B = {x: b.x - ux * 1.5 * buf, y: b.y - uy * 1.5 * buf};
    let hit = false;
    const seen = new Set();
    cellsOf(Math.min(a.x, b.x) - buf, Math.min(a.y, b.y) - buf, Math.max(a.x, b.x) + buf, Math.max(a.y, b.y) + buf, k => {
      if (hit) return;
      for (const s of grid.get(k) || []) {
        if (seen.has(s)) continue; seen.add(s);
        const g = segs[s];
        if (ignore.has(g.ring)) continue;
        if (intersects(a, b, g.a, g.b) || (buf && segSeg(A, B, g.a, g.b) < buf)) { hit = true; return; }
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
    nodes = nodes.filter(p => !rings.some(r => r && inRing(p, r)) && !nearCoast(p));
  }
  function nearCoast(p) {  // a waypoint squeezed into a narrow gap is no use
    let near = false;
    cellsOf(p.x - BUF, p.y - BUF, p.x + BUF, p.y + BUF, k => { for (const s of grid.get(k) || []) if (!near && ptSeg(p, segs[s].a, segs[s].b) < BUF) near = true; });
    return near;
  }
  function norm(x, y) { const l = Math.hypot(x, y) || 1; return {x: x / l, y: y / l}; }

  // Shortest water route a -> b (LatLngs). Returns {path: [LatLng], ok}. ok=false means no route
  // was found and the straight line is returned.
  function route(aLL, bLL) {
    const a = toXY(aLL), b = toXY(bLL);
    const ignore = new Set([...ringsAt(a), ...ringsAt(b)]);  // a mark on an island (e.g. Alcatraz Light)
    if (!blocked(a, b, ignore, BUF)) return {path: [aLL, bLL], ok: true};
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
        if (!blocked(N[u], N[v], ignore, BUF)) { g[v] = g[u] + dist(u, v); from[v] = u; }
      }
    }
    const out = [];
    for (let i = 1; i >= 0; i = from[i]) out.unshift(N[i]);
    return out;
  }

  // Rounding a whole island (e.g. "Angel s"): the path that keeps it on the given side, going from
  // prev to next. Uses the island's convex hull pushed ROUND nm out: the boat comes in on the
  // tangent from prev, follows the hull, and leaves on the tangent to next. Returns
  // {entry, arc: [LatLng]} (arc starts at entry), or null if markLL isn't on an island.
  const ROUND = 0.1;
  function roundIsland(markLL, prevLL, nextLL, side) {
    const ri = [...ringsAt(toXY(markLL))][0];
    if (ri === undefined) return null;
    const pts = [...rings[ri]].sort((a, b) => a.x - b.x || a.y - b.y), lo = [], hi = [];  // monotone chain, CCW
    for (const p of pts) { while (lo.length > 1 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (const p of pts.reverse()) { while (hi.length > 1 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
    const h0 = [...lo.slice(0, -1), ...hi.slice(0, -1)], n = h0.length;
    const H = h0.map((v, i) => {
      const a = h0[(i - 1 + n) % n], b = h0[(i + 1) % n];
      const n1 = norm(v.y - a.y, a.x - v.x), n2 = norm(b.y - v.y, v.x - b.x), m = norm(n1.x + n2.x, n1.y + n2.y);  // outward for CCW
      return {x: v.x + m.x * ROUND, y: v.y + m.y * ROUND};
    });
    // Starboard: island on the right = clockwise = down the CCW hull. sgn flips the tests for port.
    const sgn = side === 'S' ? 1 : -1, P = toXY(prevLL), N = toXY(nextLL);
    const rightOf = (o, a) => H.every(p => sgn * cross(o, a, p) <= 1e-9);
    let e = H.findIndex(v => rightOf(P, v)), x = H.findIndex(v => rightOf(v, N));
    if (e < 0 || x < 0) return null;  // prev or next is inside the hull
    const arc = [H[e]];
    for (let i = e; i !== x;) { i = (i - sgn + n) % n; arc.push(H[i]); }
    return {entry: toLL(H[e]), arc: arc.map(toLL)};
  }

  ready = fetch('data/coast.json').then(r => r.json()).then(build).catch(() => showStatus('Coastline unavailable — legs drawn straight', 5000));
  const check = buf => (a, b) => blocked(toXY(a), toXY(b), new Set([...ringsAt(toXY(a)), ...ringsAt(toXY(b))]), buf);
  return {ready, route, roundIsland, crossesLand: check(0), hugsCoast: check(BUF)};
})();
