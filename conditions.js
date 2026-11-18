'use strict';
// Conditions panel for today's race: tidal current (NOAA CO-OPS predictions) and wind (NWS hourly
// grid forecast) at one place at a time. The places are the areas the selected course passes through,
// in the order the boat gets there; pick one to see what it'll be like there.
// Every response is cached on the device; offline, the last copy is shown with its age.
const conditions = (() => {
  const COOPS = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?application=BayRace&format=json&time_zone=lst_ldt&units=english';
  const KT_PER_KMH = 1 / 1.852, NEAR = 1.5;  // nm: a mark further than this from every area gets no chip
  const SERIES = '#2a78d6';  // categorical slot 1
  const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const panel = document.getElementById('cond'), body = document.getElementById('condbody');
  const when = document.getElementById('condwhen'), places = document.getElementById('condplaces');
  let cfg, picked = null, pickedFor, loading = 0, editing = false;

  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const hm = h => `${pad(Math.floor(h))}:${pad(Math.round((h % 1) * 60) % 60)}`;
  const hourOf = s => { const [, t] = s.split(' '); const [H, M] = t.split(':'); return +H + M / 60; };  // "2026-11-17 18:15"
  const compass = deg => COMPASS[Math.round(deg / 22.5) % 16];
  const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
  // Race window: the event's start time and length, unless changed on this device.
  const span = () => store.get('raceWindow') || {start: cfg.raceStart, end: hm(hourOf('x ' + cfg.raceStart) + cfg.raceHours)};
  const startH = () => hourOf('x ' + span().start), endH = () => { const e = hourOf('x ' + span().end); return e > startH() ? e : 24; };

  // fetch JSON; remember it on the device; fall back to the remembered copy when offline. A copy
  // younger than maxAge (ms) is used without asking again: tide and current predictions for a
  // date never change, so they're fetched once. pick trims a response to what's used before saving.
  async function cached(url, key, maxAge = 0, pick = d => d) {
    const c = store.get('cache:' + key);
    if (c && Date.now() - c.t < maxAge) return {data: c.data, t: c.t, stale: false};
    try {
      const r = await fetch(url, {signal: AbortSignal.timeout(12000)});
      if (!r.ok) throw new Error(r.status);
      const data = pick(await r.json());
      store.set('cache:' + key, {t: Date.now(), data});
      return {data, t: Date.now(), stale: false};
    } catch {
      return c ? {data: c.data, t: c.t, stale: true} : null;
    }
  }
  // Drop saved responses for past days (keys end in the date) and from older versions, so the
  // site's storage never fills up.
  function prune() {
    try {
      const today = ymd(new Date());
      Object.keys(localStorage).filter(k => k.startsWith('bayrace:cache:'))
        .filter(k => /^bayrace:cache:(cur30|nwszone):/.test(k) || (/:(\d{8})$/.test(k) && k.slice(-8) < today)).forEach(k => localStorage.removeItem(k));
    } catch {}
  }

  // Areas along the selected course (courses.js `current`), each with the marks that are in it.
  // No course: every area, so the panel is still useful before one is picked.
  function route() {
    if (!current) return cfg.areas.map(a => ({a, marks: []}));
    const stops = [{id: 'Start', pos: L.latLng(event.start.lat, event.start.lon)},
      ...current.marks.map(t => t.split('-')[0]).map(id => ({id, pos: markPos(id)})).filter(s => s.pos)];
    const out = new Map();
    for (const s of stops) {
      let best = null, bd = NEAR;
      for (const a of cfg.areas) { const d = nm(s.pos, L.latLng(a.at[0], a.at[1])); if (d < bd) { bd = d; best = a; } }
      if (!best) continue;
      if (!out.has(best)) out.set(best, []);
      if (!out.get(best).includes(s.id)) out.get(best).push(s.id);
    }
    return out.size ? [...out].map(([a, marks]) => ({a, marks})) : cfg.areas.map(a => ({a, marks: []}));
  }

  // NWS grid values are runs like {validTime: "2026-11-17T18:00:00+00:00/PT2H", value}; expand to hours.
  function hourly(values, date) {
    const out = {};
    for (const {validTime, value} of values || []) {
      const [start, dur] = validTime.split('/'), m = dur.match(/P(?:(\d+)D)?T?(?:(\d+)H)?/);
      const hours = (+(m[1] || 0)) * 24 + (+(m[2] || 0)), t0 = new Date(start);
      for (let i = 0; i < hours; i++) {
        const t = new Date(t0.getTime() + i * 3600e3);
        if (ymd(t) === ymd(date)) out[t.getHours()] = value;
      }
    }
    return out;
  }

  // Current at one station: 30-min series [{h, v}] (+ flood, - ebb) and slack/max events.
  // Subordinate stations (PCT…) only publish slack and max times; between those the speed follows
  // the usual cosine shape.
  async function currentAt(id, d) {
    const toH = p => hourOf(p.Time) + (p.Time.slice(0, 10).replace(/-/g, '') === d ? 0 : 24);  // early tomorrow → h > 24
    const series = await cached(`${COOPS}&product=currents_predictions&station=${id}&begin_date=${d}&range=30&interval=30`, `c30:${id}:${d}`, Infinity);
    const cp = series && series.data.current_predictions ? series.data.current_predictions.cp : [];
    const subordinate = cp.length && cp[0].Type;
    const evr = subordinate ? series : await cached(`${COOPS}&product=currents_predictions&station=${id}&begin_date=${d}&range=30&interval=MAX_SLACK`, `curev:${id}:${d}`, Infinity);
    const evs = (evr && evr.data.current_predictions ? evr.data.current_predictions.cp : []).map(p => ({h: toH(p), type: p.Type, v: p.Velocity_Major}));
    const pts = [];
    if (subordinate) {
      for (let i = 0; i + 1 < evs.length; i++)
        for (let h = evs[i].h; h < evs[i + 1].h; h += 0.25)
          pts.push({h, v: evs[i].v + (evs[i + 1].v - evs[i].v) * (1 - Math.cos(Math.PI * (h - evs[i].h) / (evs[i + 1].h - evs[i].h))) / 2});
    } else cp.forEach(p => pts.push({h: toH(p), v: p.Velocity_Major}));
    return {pts, evs, res: [series, evr]};
  }

  async function windAt(at) {
    const key = at.join(','), point = await cached(`https://api.weather.gov/points/${key}`, `nwspoint:${key}`, Infinity, d => ({properties: {forecastGridData: d.properties.forecastGridData}}));
    return point ? cached(point.data.properties.forecastGridData, `nwsgrid:${key}`, 30 * 60e3,
      ({properties: p}) => ({properties: {windSpeed: p.windSpeed, windGust: p.windGust, windDirection: p.windDirection}})) : null;
  }

  async function load() {
    const n = ++loading, date = new Date(), d = ymd(date), stops = route();
    if (pickedFor !== (current && current.no) || !stops.some(s => s.a === picked)) {  // new course: nearest place to me, else the start
      pickedFor = current && current.no;
      const here = typeof me !== 'undefined' && me && me.getLatLng();
      picked = here ? stops.map(s => s.a).sort((a, b) => nm(here, L.latLng(...a.at)) - nm(here, L.latLng(...b.at)))[0] : stops[0].a;
    }
    const stop = stops.find(s => s.a === picked);
    const {start, end} = span();
    when.innerHTML = `<div class="trow"><span>${date.toLocaleDateString(undefined, {weekday: 'long', month: 'short', day: 'numeric'})}</span>`
      + `<button type="button" class="trange" aria-expanded="${editing}">${start}–${end} <span aria-hidden="true">✎</span></button></div>`
      + `<div class="tedit"${editing ? '' : ' hidden'}><label>Start <input type="time" step="300" data-k="start" value="${start}"></label>`
      + `<label>End <input type="time" step="300" data-k="end" value="${end}"></label>${store.get('raceWindow') ? '<button type="button" class="treset">Reset</button>' : ''}</div>`;
    places.innerHTML = stops.map(s => `<button type="button" class="${s.a === picked ? 'on' : ''}">${s.a.name}</button>`).join('');
    places.querySelectorAll('button').forEach((b, i) => b.onclick = () => { picked = stops[i].a; load(); });
    body.innerHTML = '<p class="cmuted">Loading…</p>';
    const [cur, wind, tide] = await Promise.all([currentAt(picked.current, d), windAt(picked.at),
      cached(`${COOPS}&product=predictions&station=${cfg.tide.id}&begin_date=${d}&range=24&datum=MLLW&interval=hilo`, `tide:${cfg.tide.id}:${d}`, Infinity)]);
    if (n !== loading) return;  // another place was picked meanwhile
    render(date, stop, cur, wind, tide);
  }

  function render(date, stop, cur, grid, tide) {
    const start = startH(), end = endH(), x0 = Math.max(0, Math.floor(start - 1)), x1 = Math.min(24, Math.ceil(end + 1));
    const now = new Date(), nowH = ymd(date) === ymd(now) && now.getHours() + now.getMinutes() / 60;
    const stale = [...cur.res, grid, tide].filter(r => r && r.stale), missing = [...cur.res, grid, tide].some(r => !r);
    const at = h => { const p = cur.pts; for (let i = 0; i + 1 < p.length; i++) if (p[i].h <= h && h <= p[i + 1].h) return p[i].v + (p[i + 1].v - p[i].v) * (h - p[i].h) / (p[i + 1].h - p[i].h); return null; };
    const dir = v => Math.abs(v) < 0.05 ? 'Slack' : v > 0 ? 'Flood' : 'Ebb';
    const say = v => dir(v) === 'Slack' ? 'slack' : `${dir(v).toLowerCase()} ${Math.abs(v).toFixed(1)} kt`;

    // Current over the race: start → finish, plus any turn or peak in between
    const v0 = at(start), v1 = at(end);
    let curHead = '<span class="cmuted">No prediction</span>', curSub = '';
    if (v0 != null && v1 != null) {
      const d0 = dir(v0), d1 = dir(v1), kt = v => Math.abs(v).toFixed(1);
      curHead = `<b class="${d0.toLowerCase()}">${d0 === d1 && d0 !== 'Slack' ? `${d0} ${kt(v0)} → ${kt(v1)} kt` : `${d0 === 'Slack' ? d0 : `${d0} ${kt(v0)} kt`} → ${d1 === 'Slack' ? d1 : `${d1} ${kt(v1)} kt`}`}</b>`;
      const evs = cur.evs.filter(e => e.h > start && e.h < end).map(e => e.type === 'slack' ? `slack ${hm(e.h)}` : `max ${e.type} ${kt(e.v)} kt at ${hm(e.h)}`);
      const next = cur.evs.find(e => e.h >= end && e.type === 'slack');
      curSub = evs.length ? evs.join(' · ') : next ? `next slack ${hm(next.h % 24)}${next.h >= 24 ? ' (after midnight)' : ''}` : '';
    }

    // Wind, hourly in knots; headline is the range over the race hours
    const g = grid && grid.data.properties;
    const ws = g ? hourly(g.windSpeed.values, date) : {}, wg = g ? hourly(g.windGust.values, date) : {}, wd = g ? hourly(g.windDirection.values, date) : {};
    const wind = []; for (let h = x0; h < x1; h++) if (ws[h] != null) wind.push({h, s: ws[h] * KT_PER_KMH, g: (wg[h] ?? ws[h]) * KT_PER_KMH, d: wd[h]});
    const race = wind.filter(w => w.h >= Math.floor(start) && w.h < end);
    let windHead = '<span class="cmuted">No forecast for these hours</span>';
    if (race.length) {
      const lo = Math.round(Math.min(...race.map(w => w.s))), hi = Math.round(Math.max(...race.map(w => w.s))), gu = Math.round(Math.max(...race.map(w => w.g)));
      const c0 = compass(race[0].d), c1 = compass(race[race.length - 1].d);
      windHead = `<b>${c0}${c1 !== c0 ? ` → ${c1}` : ''} ${lo === hi ? lo : `${lo}–${hi}`} kt</b>, gusts ${gu} kt`;
    }

    // highs and lows from midday on: the ones that matter for an evening race
    const tides = tide && tide.data.predictions ? tide.data.predictions.filter(p => p.t.slice(0, 10).replace(/-/g, '') === ymd(date) && hourOf(p.t) >= start - 6)
      .map(p => `${p.type === 'H' ? 'High' : 'Low'} ${p.t.slice(11)} <span class="cmuted">${(+p.v).toFixed(1)} ft</span>`).join(' · ') : '';

    body.innerHTML = (stop.marks.length ? `<p class="cnear">Marks here: ${stop.marks.join(', ')}</p>` : '')
      + `<div class="chead"><div class="crow"><span class="clab">Current</span><span>${curHead}${curSub ? `<br><span class="cmuted">${curSub}</span>` : ''}</span></div>`
      + `<div class="crow"><span class="clab">Wind</span><span>${windHead}</span></div></div>`
      + (v0 != null ? currentChart(cur.pts, x0, x1, start, end, nowH) : '')
      + (wind.length ? windChart(wind, x0, x1, start, end, nowH) : '')
      + (tides ? `<p class="ctide"><b>Tide</b> ${tides}</p>` : '')
      + `<p class="cmuted csrc">${missing ? `<span class="warn">Couldn't download some of this — check your connection.</span> ` : ''}${stale.length ? `<span class="warn">Offline — showing data saved ${ago(Math.min(...stale.map(r => r.t)))}.</span> ` : ''}NOAA current station ${picked.current}; NWS forecast. Predictions, not observations. Not for navigation.</p>`;
    hover(body.querySelector('.cur svg'), x0, x1, h => { const v = at(h); return v == null ? '' : `<b>${hm(h)}</b> ${say(v)}`; });
    hover(body.querySelector('.wind svg'), x0, x1, h => { const w = wind.find(w => w.h === Math.floor(h)); return w ? `<b>${hm(w.h)}</b> from ${compass(w.d)}, ${Math.round(w.s)} kt, gusts ${Math.round(w.g)} kt` : ''; });
  }

  // ---- charts (inline SVG; viewBox scales to the panel width) ----
  const W = 340, PL = 30, PR = 8;
  const xs = (h, x0, x1) => PL + (h - x0) / (x1 - x0) * (W - PL - PR);
  function frame(x0, x1, H, PT, PB, start, end, nowH) {
    let s = `<rect x="${xs(start, x0, x1)}" y="${PT}" width="${xs(end, x0, x1) - xs(start, x0, x1)}" height="${H - PT - PB}" class="race"/>`
      + `<text x="${xs(start, x0, x1) + 3}" y="${H - PB - 3}" class="racel">race</text>`;
    for (let h = x0; h <= x1; h++) s += `<text x="${xs(h, x0, x1)}" y="${H - 4}" class="tick" text-anchor="middle">${h % 24}</text>`;
    if (nowH !== false && nowH >= x0 && nowH <= x1) s += `<line x1="${xs(nowH, x0, x1)}" x2="${xs(nowH, x0, x1)}" y1="${PT}" y2="${H - PB}" class="now"/><text x="${xs(nowH, x0, x1) + 3}" y="${PT + 9}" class="nowl">now</text>`;
    return s;
  }
  function currentChart(pts, x0, x1, start, end, nowH) {
    const H = 120, PT = 8, PB = 18, p = pts.filter(q => q.h >= x0 && q.h <= x1);
    const max = Math.max(1, Math.ceil(Math.max(0, ...p.map(q => Math.abs(q.v)))));
    const y = v => PT + (max - v) / (2 * max) * (H - PT - PB);
    let s = frame(x0, x1, H, PT, PB, start, end, nowH)
      + `<line x1="${PL}" x2="${W - PR}" y1="${y(0)}" y2="${y(0)}" class="zero"/>`
      + `<text x="${PL - 4}" y="${y(max) + 8}" class="tick" text-anchor="end">${max} kt</text><text x="${PL - 4}" y="${y(-max)}" class="tick" text-anchor="end">${max} kt</text>`
      + `<text x="${W - PR - 3}" y="${PT + 9}" class="dir" text-anchor="end">FLOOD ↑</text><text x="${W - PR - 3}" y="${H - PB - 3}" class="dir" text-anchor="end">EBB ↓</text>`;
    if (p.length) s += `<polyline points="${p.map(q => `${xs(q.h, x0, x1).toFixed(1)},${y(q.v).toFixed(1)}`).join(' ')}" fill="none" stroke="${SERIES}" stroke-width="2" stroke-linejoin="round"/>`;
    return `<div class="chart cur"><div class="ctitle">Current <span class="cmuted">(knots)</span></div><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Tidal current, knots; flood above the line, ebb below">${s}</svg><div class="tip" hidden></div></div>`;
  }
  function windChart(wind, x0, x1, start, end, nowH) {
    const H = 130, PT = 24, PB = 18, max = Math.max(10, Math.ceil(Math.max(...wind.map(w => w.g)) / 5) * 5);
    const y = v => PT + (max - v) / max * (H - PT - PB), bw = (W - PL - PR) / (x1 - x0) - 3;
    let s = frame(x0, x1, H, PT, PB, start, end, nowH);
    const step = max > 20 ? 10 : 5, top = Math.floor(max / step) * step;
    for (let v = 0; v <= max; v += step) s += `<line x1="${PL}" x2="${W - PR}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${PL - 4}" y="${y(v) + 3}" class="tick" text-anchor="end">${v}${v === top ? ' kt' : ''}</text>`;
    wind.forEach(w => {
      const x = xs(w.h, x0, x1) + 1.5, cx = x + bw / 2;
      s += `<rect x="${x}" y="${y(w.g)}" width="${bw}" height="${y(w.s) - y(w.g)}" rx="2" class="gust"/>`
        + `<rect x="${x}" y="${y(w.s)}" width="${bw}" height="${Math.max(0, y(0) - y(w.s))}" rx="2" fill="${SERIES}"/>`
        + `<text x="${cx}" y="${PT - 9}" class="wdir" text-anchor="middle">${compass(w.d)}</text>`;
    });
    return `<div class="chart wind"><div class="ctitle">Wind <span class="cmuted">(knots) · <span class="key" style="background:${SERIES}"></span>Speed <span class="key gustkey"></span>Gusts</span></div>`
      + `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Hourly wind speed and gusts, knots">${s}</svg><div class="tip" hidden></div></div>`;
  }
  // Crosshair + tooltip; works with touch (pointer events) as well as mouse.
  function hover(svg, x0, x1, html) {
    if (!svg) return;
    const box = svg.parentElement, tip = box.querySelector('.tip');
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('class', 'cross'); line.style.display = 'none'; svg.appendChild(line);
    const move = e => {
      const r = svg.getBoundingClientRect(), vx = (e.clientX - r.left) / r.width * W;
      if (vx < PL || vx > W - PR) return leave();
      const h = Math.round((x0 + (vx - PL) / (W - PL - PR) * (x1 - x0)) * 4) / 4, t = html(h);
      if (!t) return leave();
      const sx = xs(h, x0, x1);
      line.setAttribute('x1', sx); line.setAttribute('x2', sx); line.setAttribute('y1', 0); line.setAttribute('y2', svg.viewBox.baseVal.height); line.style.display = '';
      tip.innerHTML = t; tip.hidden = false;
      const px = sx / W * r.width;
      tip.style.left = Math.min(Math.max(0, px - tip.offsetWidth / 2), box.offsetWidth - tip.offsetWidth) + 'px';
    };
    const leave = () => { line.style.display = 'none'; tip.hidden = true; };
    svg.addEventListener('pointermove', move); svg.addEventListener('pointerdown', move); svg.addEventListener('pointerleave', leave);
  }

  function open() { panel.hidden = false; prune(); load(); }
  when.addEventListener('click', e => {
    if (e.target.closest('.trange')) { editing = !editing; load(); }
    if (e.target.closest('.treset')) { store.set('raceWindow', null); load(); }
  });
  when.addEventListener('change', e => {
    const k = e.target.dataset.k;
    if (!k || !/^\d\d:\d\d$/.test(e.target.value)) return;
    store.set('raceWindow', {...span(), [k]: e.target.value});
    load();
  });
  document.getElementById('condclose').onclick = () => panel.hidden = true;
  select.addEventListener('change', () => setTimeout(() => panel.hidden || load()));  // after courses.js has drawn the new course
  fetch(EVENT_URL).then(r => r.json()).then(ev => {
    cfg = ev.conditions;
    const btn = document.getElementById('condbtn');
    btn.hidden = false; btn.onclick = () => panel.hidden ? open() : (panel.hidden = true);
  });
  return {open};
})();
