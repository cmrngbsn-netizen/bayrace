'use strict';
// Start countdown: time left until your start today. The start is the race window's start
// (the same one Tides & Wind uses), so changing it in either place changes both.
(() => {
  const btn = document.getElementById('timerbtn'), el = document.getElementById('timer');
  const pad = n => String(n).padStart(2, '0');
  const fmt = s => { const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`; };
  // The button has little room: "11h", "1h 23m", then minutes and seconds in the last hour.
  const short = s => s >= 36000 ? `${Math.floor(s / 3600)}h` : s >= 3600 ? `${Math.floor(s / 3600)}h ${pad(Math.floor(s / 60) % 60)}m` : fmt(s);
  const startAt = t => { const [H, M] = t.split(':'), d = new Date(); d.setHours(+H, +M, 0, 0); return d; };
  const nice = t => startAt(t).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});

  // Seconds to go (negative once started), or null before the event has loaded.
  const left = () => { const w = conditions.span(); return w && Math.ceil((startAt(w.start) - Date.now()) / 1000); };

  function draw() {
    const w = conditions.span();
    if (!w) return;
    el.innerHTML = `<div class="lrow"><span>Start</span><input type="time" step="60" value="${w.start}" aria-label="Your start time">`
      + `${conditions.custom() ? '<button type="button" class="btn alt">Reset</button>' : ''}</div><div class="tbig"></div>`;
    tick();
  }
  function tick() {
    const s = left(), w = conditions.span(), counting = s > 0;
    btn.textContent = counting ? short(s) : '⏱';
    btn.classList.toggle('icon', !counting);
    btn.classList.toggle('soon', counting && s <= 300);
    const big = el.querySelector('.tbig');
    if (el.hidden || !big) return;
    big.innerHTML = s == null ? '' : counting ? `${fmt(s)}<small>to your start at ${nice(w.start)} today</small>`
      : `<small>Started at ${nice(w.start)} today · ${fmt(-s)} ago</small>`;
  }
  const show = on => {
    if (el.hidden === !on) return;
    el.hidden = !on; btn.setAttribute('aria-expanded', on);
    if (on) { showLayers(false); draw(); }
    placeLabels();  // the card changed height
  };

  btn.onclick = () => show(el.hidden);
  document.getElementById('layerbtn').addEventListener('click', () => show(false));
  map.on('click', () => show(false));
  el.addEventListener('change', e => { if (/^\d\d:\d\d$/.test(e.target.value)) { conditions.setStart(e.target.value); draw(); } });
  el.addEventListener('click', e => { if (e.target.closest('button')) { conditions.setStart(null); draw(); } });
  select.addEventListener('change', () => setTimeout(() => { el.hidden || draw(); tick(); }));  // new event: its own start
  setInterval(tick, 1000);
})();
