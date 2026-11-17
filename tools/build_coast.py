"""Build data/coast.json from OpenStreetMap coastline.

Download (Overpass API):
  curl -s --data-urlencode 'data=[out:json][timeout:90];way["natural"="coastline"](37.74,-122.56,37.96,-122.27);out geom;' \
    https://overpass-api.de/api/interpreter -o coast-osm.json
Then: python3 tools/build_coast.py coast-osm.json data/coast.json 10   (last arg = simplify tolerance in metres)

Coastline data (c) OpenStreetMap contributors, ODbL.
"""
import json, math, sys
d = json.load(open(sys.argv[1]))
ways = [(w['nodes'], [(g['lat'], g['lon']) for g in w['geometry']]) for w in d['elements']]
# Join ways end-to-start by shared node ids. OSM coastline direction: land on the left, water on the right.
by_start = {n[0]: i for i, (n, _) in enumerate(ways)}
used, chains = set(), []
for i in range(len(ways)):
    if i in used: continue
    # walk back to the chain head
    head = i; seen = {i}
    while True:
        prev = next((j for j, (n, _) in enumerate(ways) if j not in seen and j not in used and n[-1] == ways[head][0][0]), None)
        if prev is None: break
        head = prev; seen.add(prev)
    nodes, pts = list(ways[head][0]), list(ways[head][1]); used.add(head)
    while nodes[-1] in by_start and by_start[nodes[-1]] not in used:
        j = by_start[nodes[-1]]; used.add(j)
        nodes += ways[j][0][1:]; pts += ways[j][1][1:]
    chains.append((nodes[0] == nodes[-1], pts))
K = math.cos(math.radians(37.85))
def xy(p): return (p[1] * 60 * K, p[0] * 60)  # nm
def dp(pts, tol):
    if len(pts) < 3: return pts
    a, b = xy(pts[0]), xy(pts[-1]); dx, dy = b[0] - a[0], b[1] - a[1]; L = math.hypot(dx, dy)
    best, bi = 0, 0
    for i in range(1, len(pts) - 1):
        p = xy(pts[i])
        dist = abs(dy * (p[0] - a[0]) - dx * (p[1] - a[1])) / L if L else math.hypot(p[0] - a[0], p[1] - a[1])
        if dist > best: best, bi = dist, i
    if best <= tol: return [pts[0], pts[-1]]
    return dp(pts[:bi + 1], tol)[:-1] + dp(pts[bi:], tol)
tol = float(sys.argv[3]) / 1852
out = {'rings': [], 'lines': []}
for closed, pts in chains:
    s = dp(pts, tol)
    if closed and len(s) < 4: continue          # rocks smaller than the tolerance
    (out['rings'] if closed else out['lines']).append([[round(a, 5), round(b, 5)] for a, b in s])
json.dump(out, open(sys.argv[2], 'w'), separators=(',', ':'))
print(f"tol {sys.argv[3]}m: rings {len(out['rings'])} lines {len(out['lines'])} points {sum(map(len, out['rings'] + out['lines']))}")
