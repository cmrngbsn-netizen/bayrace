'use strict';
// Conditions panel: tidal current (NOAA CO-OPS predictions), tide highs/lows, and wind (NWS
// hourly grid forecast + SF Bay marine zone text) for a chosen day, centred on the race window.
// Every response is cached on the device; offline, the last copy is shown with its age.
const conditions = (() => {
  const COOPS = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?application=BayRace&format=json&time_zone=lst_ldt&units=english';
  const KT_PER_KMH = 1 / 1.852;
  const SERIES = ['#2a78d6', '#eb6834'];  // categorical slots 1-2 (validated pair)
  const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const panel = document.getElementById('cond'), body = document.getElementById('condbody'), days = document.getElementById('conddays');
  let cfg, day = 0, loading = 0;

  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const hm = h => `${pad(Math.floor(h))}:${pad(Math.round((h % 1) * 60) % 60)}`;
  const hourOf = s => { const [, t] = s.split(' '); const [H, M] = t.split(':'); return +H + M / 60; };  // "2026-11-17 18:15"
  const dateFor = n => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return d; };
  const compass = deg => COMPASS[Math.round(deg / 22.5) % 16];
  const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };

  // fetch JSON; remember it on the device; fall back to the remembered copy when offline
  async function cached(url, key) {
    try {
      const r = await fetch(url, {signal: AbortSignal.timeout(12000)});
      if (!r.ok) throw new Error(r.status);
      const data = await r.json();
      store.set('cache:' + key, {t: Date.now(), data});
      return {data, t: Date.now(), stale: false};
    } catch {
      const c = store.get('cache:' + key);
      return c ? {data: c.data, t: c.t, stale: true} : null;
    }
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

  async function load() {
    const n = ++loading, date = dateFor(day), d = ymd(date);
    body.innerHTML = '<p class="cmuted">Loading…</p>';
    const curs = cfg.currents.map(s => Promise.all([
      cached(`${COOPS}&product=currents_predictions&station=${s.id}&begin_date=${d}&range=24&interval=30`, `cur30:${s.id}:${d}`),
      cached(`${COOPS}&product=currents_predictions&station=${s.id}&begin_date=${d}&range=30&interval=MAX_SLACK`, `curev:${s.id}:${d}`)]));
    const tide = cached(`${COOPS}&product=predictions&station=${cfg.tide.id}&begin_date=${d}&range=24&datum=MLLW&interval=hilo`, `tide:${cfg.tide.id}:${d}`);
    const point = await cached(`https://api.weather.gov/points/${cfg.area[0]},${cfg.area[1]}`, `nwspoint:${cfg.area}`);
    const [grid, zone] = point ? await Promise.all([
      cached(point.data.properties.forecastGridData, `nwsgrid:${cfg.area}`),
      cached(point.data.properties.forecastZone + '/forecast', `nwszone:${cfg.area}`)]) : [null, null];
    const [cur, tid] = await Promise.all([Promise.all(curs), tide]);
    if (n !== loading) return;  // a newer day was picked meanwhile
    render(date, cur, tid, grid, zone);
  }

  function render(date, cur, tide, grid, zone) {
    const start = hourOf('x ' + cfg.raceStart), end = start + cfg.raceHours;
    const x0 = Math.max(0, Math.floor(start - 3)), x1 = Math.min(24, Math.ceil(end + 1));
    const isToday = ymd(date) === ymd(new Date()), now = new Date(), nowH = now.getHours() + now.getMinutes() / 60;
    const stale = [...cur.flat(), tide, grid, zone].filter(r => r && r.stale);

    // Current series per station: [{h, v}] (+ flood, - ebb) and slack/max events
    const stations = cfg.currents.map((s, i) => {
      const [c30, ev] = cur[i];
      const pts = (c30 && c30.data.current_predictions ? c30.data.current_predictions.cp : []).map(p => ({h: hourOf(p.Time), v: p.Velocity_Major}));
      // events run 30 h from midnight, so anything not on this date is early tomorrow (h > 24)
      const evs = (ev && ev.data.current_predictions ? ev.data.current_predictions.cp : [])
        .map(p => ({h: hourOf(p.Time) + (p.Time.slice(0, 10).replace(/-/g, '') === ymd(date) ? 0 : 24), type: p.Type, v: p.Velocity_Major}));
      return {...s, color: SERIES[i], pts, evs};
    });
    const at = (pts, h) => { for (let i = 0; i + 1 < pts.length; i++) if (pts[i].h <= h && h <= pts[i + 1].h) return pts[i].v + (pts[i + 1].v - pts[i].v) * (h - pts[i].h) / (pts[i + 1].h - pts[i].h); return null; };

    // Wind, hourly in knots
    const g = grid && grid.data.properties;
    const ws = g ? hourly(g.windSpeed.values, date) : {}, wg = g ? hourly(g.windGust.values, date) : {}, wd = g ? hourly(g.windDirection.values, date) : {};
    const wind = []; for (let h = x0; h < x1; h++) if (ws[h] != null) wind.push({h, s: ws[h] * KT_PER_KMH, g: (wg[h] ?? ws[h]) * KT_PER_KMH, d: wd[h]});

    // Headline: what the crew needs at the start
    const head = stations.map(s => {
      const v = at(s.pts, start);
      if (v == null) return `<div><b>${s.name}</b> <span class="cmuted">no prediction</span></div>`;
      const v2 = at(s.pts, start + 0.5), dir = Math.abs(v) < 0.15 ? 'Slack' : v > 0 ? 'Flood' : 'Ebb';
      const trend = Math.abs(v) < 0.15 ? '' : Math.abs(v2) > Math.abs(v) + 0.05 ? ', building' : Math.abs(v2) < Math.abs(v) - 0.05 ? ', easing' : ', steady';
      const next = s.evs.find(e => e.h > start && e.type === 'slack');
      return `<div><span class="key" style="background:${s.color}"></span><b>${s.name}</b> <span class="${dir.toLowerCase()}">${dir}${dir === 'Slack' ? '' : ' ' + Math.abs(v).toFixed(1) + ' kt'}</span>${trend}${next ? ` <span class="cmuted">· slack ${hm(next.h % 24)}${next.h >= 24 ? ' next day' : ''}</span>` : ''}</div>`;
    }).join('');
    const w0 = wind.find(w => w.h === Math.floor(start));
    const windHead = w0 ? `<div><b>Wind</b> ${compass(w0.d)} ${Math.round(w0.s)} kt, gusts ${Math.round(w0.g)}</div>` : '';

    const tideRows = tide && tide.data.predictions ? tide.data.predictions.filter(p => p.t.slice(0, 10).replace(/-/g, '') === ymd(date))
      .map(p => `<span><b>${p.type === 'H' ? 'High' : 'Low'}</b> ${p.t.slice(11)} · ${(+p.v).toFixed(1)} ft</span>`).join('') : '';
    const zoneText = zone && zone.data.properties ? zone.data.properties.periods.slice(0, 4).map(p => `<p><b>${p.name}:</b> ${p.detailedForecast}</p>`).join('') : '';
    const evList = stations.map(s => `<div class="evs"><span class="key" style="background:${s.color}"></span><b>${s.name}</b> `
      + s.evs.filter(e => e.h >= x0 && e.h <= x1).map(e => `<span>${hm(e.h % 24)} ${e.type === 'slack' ? 'slack' : `max ${e.type} ${Math.abs(e.v).toFixed(1)} kt`}</span>`).join(' · ') + '</div>').join('');

    body.innerHTML = `<div class="chead"><div class="cwhen">At the start · ${date.toLocaleDateString(undefined, {weekday: 'short', month: 'short', day: 'numeric'})} ${cfg.raceStart}</div>${head}${windHead}</div>`
      + `<h3>Current <span class="cmuted">knots · NOAA predictions</span></h3>${currentChart(stations, x0, x1, start, end, isToday && nowH)}${evList}`
      + `<h3>Wind <span class="cmuted">knots · NWS forecast</span></h3>${wind.length ? windChart(wind, x0, x1, start, end, isToday && nowH) : '<p class="cmuted">No wind forecast for this day.</p>'}`
      + (zoneText ? `<details${day === 0 ? ' open' : ''}><summary>SF Bay marine forecast (NWS)</summary>${zoneText}</details>` : '')
      + `<h3>Tide <span class="cmuted">${cfg.tide.name}</span></h3><div class="tides">${tideRows || '<span class="cmuted">No tide predictions.</span>'}</div>`
      + `<p class="cmuted csrc">${stale.length ? `<span class="warn">Offline — showing data saved ${ago(Math.min(...stale.map(r => r.t)))}.</span> ` : ''}Predictions, not observations. Not for navigation.</p>`;
    hover(body.querySelector('.cur svg'), x0, x1, h => `<b>${hm(h)}</b>` + stations.map(s => { const v = at(s.pts, h); return v == null ? '' : `<br><span class="key" style="background:${s.color}"></span>${s.name}: ${Math.abs(v) < 0.15 ? 'slack' : (v > 0 ? 'flood ' : 'ebb ') + Math.abs(v).toFixed(1) + ' kt'}`; }).join(''));
    hover(body.querySelector('.wind svg'), x0, x1, h => { const w = wind.find(w => w.h === Math.floor(h)); return w ? `<b>${hm(w.h)}</b><br>${compass(w.d)} (${Math.round(w.d)}°) ${Math.round(w.s)} kt<br>gusts ${Math.round(w.g)} kt` : ''; });
  }

  // ---- charts (inline SVG; viewBox scales to the panel width) ----
  const W = 340, PL = 30, PR = 8;
  const xs = (h, x0, x1) => PL + (h - x0) / (x1 - x0) * (W - PL - PR);
  function frame(x0, x1, H, PT, PB, start, end, nowH) {
    let s = `<rect x="${xs(start, x0, x1)}" y="${PT}" width="${xs(end, x0, x1) - xs(start, x0, x1)}" height="${H - PT - PB}" class="race"/>`
      + `<text x="${xs(start, x0, x1) + 3}" y="${PT + 9}" class="racel">race</text>`;
    for (let h = x0; h <= x1; h++) if ((h - x0) % (x1 - x0 > 8 ? 2 : 1) === 0) s += `<text x="${xs(h, x0, x1)}" y="${H - 4}" class="tick" text-anchor="middle">${h % 24}</text>`;
    if (nowH !== false && nowH >= x0 && nowH <= x1) s += `<line x1="${xs(nowH, x0, x1)}" x2="${xs(nowH, x0, x1)}" y1="${PT}" y2="${H - PB}" class="now"/><text x="${xs(nowH, x0, x1) + 3}" y="${H - PB - 3}" class="tick">now</text>`;
    return s;
  }
  function currentChart(stations, x0, x1, start, end, nowH) {
    const H = 150, PT = 10, PB = 18;
    const vals = stations.flatMap(s => s.pts.filter(p => p.h >= x0 && p.h <= x1).map(p => Math.abs(p.v)));
    const max = Math.max(1, Math.ceil(Math.max(0, ...vals)));
    const y = v => PT + (max - v) / (2 * max) * (H - PT - PB);
    let s = frame(x0, x1, H, PT, PB, start, end, nowH)
      + `<line x1="${PL}" x2="${W - PR}" y1="${y(0)}" y2="${y(0)}" class="zero"/>`
      + `<text x="${PL - 4}" y="${y(max) + 8}" class="tick" text-anchor="end">${max}</text><text x="${PL - 4}" y="${y(-max)}" class="tick" text-anchor="end">${max}</text>`
      + `<text x="${W - PR - 3}" y="${PT + 9}" class="dir" text-anchor="end">FLOOD ↑</text><text x="${W - PR - 3}" y="${H - PB - 3}" class="dir" text-anchor="end">EBB ↓</text>`;
    stations.forEach(st => {
      const p = st.pts.filter(q => q.h >= x0 && q.h <= x1);
      if (p.length) s += `<polyline points="${p.map(q => `${xs(q.h, x0, x1).toFixed(1)},${y(q.v).toFixed(1)}`).join(' ')}" fill="none" stroke="${st.color}" stroke-width="2" stroke-linejoin="round"/>`;
    });
    const legend = stations.map(st => `<span><span class="key" style="background:${st.color}"></span>${st.name}</span>`).join('');
    return `<div class="chart cur"><div class="legend">${legend}</div><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Tidal current, knots; flood above the line, ebb below">${s}</svg><div class="tip" hidden></div></div>`;
  }
  function windChart(wind, x0, x1, start, end, nowH) {
    const H = 150, PT = 26, PB = 18, max = Math.max(10, Math.ceil(Math.max(...wind.map(w => w.g)) / 5) * 5);
    const y = v => PT + (max - v) / max * (H - PT - PB), bw = (W - PL - PR) / (x1 - x0) - 3;
    let s = frame(x0, x1, H, PT, PB, start, end, nowH);
    for (let v = 0; v <= max; v += max > 20 ? 10 : 5) s += `<line x1="${PL}" x2="${W - PR}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${PL - 4}" y="${y(v) + 3}" class="tick" text-anchor="end">${v}</text>`;
    wind.forEach(w => {
      const x = xs(w.h, x0, x1) + 1.5, cx = x + bw / 2;
      s += `<rect x="${x}" y="${y(w.g)}" width="${bw}" height="${y(w.s) - y(w.g)}" rx="2" class="gust"/>`
        + `<rect x="${x}" y="${y(w.s)}" width="${bw}" height="${Math.max(0, y(0) - y(w.s))}" rx="2" fill="${SERIES[0]}"/>`
        + `<g transform="translate(${cx},${PT - 14}) rotate(${w.d + 180})"><path d="M0,-6 L4,4 L0,2 L-4,4 Z" class="arrow"/></g>`;
    });
    return `<div class="chart wind"><div class="legend"><span><span class="key" style="background:${SERIES[0]}"></span>Wind</span><span><span class="key gustkey"></span>Gusts</span><span class="cmuted">arrows: direction wind blows toward</span></div>`
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

  function open() {
    panel.hidden = false;
    days.innerHTML = [0, 1, 2, 3, 4, 5, 6].map(n => `<button type="button" data-d="${n}" class="${n === day ? 'on' : ''}">${n === 0 ? 'Today' : n === 1 ? 'Tmrw' : dateFor(n).toLocaleDateString(undefined, {weekday: 'short'})}</button>`).join('');
    load();
  }
  days.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; day = +b.dataset.d; days.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); load(); });
  document.getElementById('condclose').onclick = () => panel.hidden = true;
  fetch(EVENT_URL).then(r => r.json()).then(ev => {
    cfg = ev.conditions;
    const btn = document.getElementById('condbtn');
    btn.hidden = false; btn.onclick = () => panel.hidden ? open() : (panel.hidden = true);
  });
  return {open};
})();
