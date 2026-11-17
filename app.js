'use strict';
// Basemap tile URLs. NOAA retired its raster charts in 2025 (the old NOAACharts tile URL 404s and
// its export returns blank images), so the chart comes from NOAA's ENC-based chart display WMS.
const BASEMAPS = {
  'Nautical chart (NOAA)': L.tileLayer.wms('https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/NOAAChartDisplay/MapServer/exts/MaritimeChartService/WMSServer',
    {layers: '0,1,2,3,4,5,6,7,8,9,10,11,12', format: 'image/png', maxZoom: 18, attribution: 'NOAA Office of Coast Survey — not for navigation'}),
  'Street': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    {maxZoom: 19, attribution: '© OpenStreetMap contributors'}),
  'Satellite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    {maxZoom: 19, attribution: 'Esri, Maxar, Earthstar Geographics'})
};

const map = L.map('map', {center: [37.83, -122.43], zoom: 12, zoomControl: false, layers: [BASEMAPS['Nautical chart (NOAA)']]});
L.control.zoom({position: 'topleft'}).addTo(map);

// Surface tile failures so a blank map isn't a mystery.
const status = document.getElementById('status');
let errTimer;
Object.entries(BASEMAPS).forEach(([name, layer]) => layer.on('tileerror', () => {
  status.textContent = navigator.onLine ? `${name}: some tiles failed to load` : 'Offline — showing cached tiles only';
  status.hidden = false; clearTimeout(errTimer); errTimer = setTimeout(() => status.hidden = true, 4000);
}));

const groups = {yra: L.layerGroup().addTo(map), other: L.layerGroup()};
const fmtDM = (v, pos, neg) => { const a = Math.abs(v), d = Math.floor(a), m = ((a - d) * 60).toFixed(3); return `${d}°${m}′ ${v >= 0 ? pos : neg}`; };

fetch('data/marks.json').then(r => r.json()).then(marks => {
  marks.forEach(m => {
    const label = m.group === 'yra' ? m.id : m.name;
    const icon = L.divIcon({className: `mk ${m.group}`, html: `<span class="dot"></span><span class="lbl">${label}</span>`, iconSize: [0, 0]});
    L.marker([m.lat, m.lon], {icon, keyboard: false}).addTo(groups[m.group])
      .bindPopup(`<div class="pop"><b>${m.group === 'yra' ? 'YRA ' + m.id : m.name}${m.nick ? ' — ' + m.nick : ''}</b><div>${m.desc}</div><div>${fmtDM(m.lat, 'N', 'S')}<br>${fmtDM(m.lon, 'E', 'W')}</div></div>`);
  });
}).catch(() => { status.textContent = 'Could not load marks'; status.hidden = false; });

L.control.layers(BASEMAPS, {'YRA marks': groups.yra, 'Other / club marks': groups.other}, {position: 'topright'}).addTo(map);

// Hide labels when zoomed far out so the Bay isn't a wall of text.
const setLabels = () => document.getElementById('map').classList.toggle('nolabels', map.getZoom() < 11);
map.on('zoomend', setLabels); setLabels();

let me;
document.getElementById('locate').onclick = () => map.locate({setView: true, maxZoom: 14, enableHighAccuracy: true});
map.on('locationfound', e => { me && me.remove(); me = L.circleMarker(e.latlng, {radius: 8, color: '#fff', weight: 3, fillColor: '#2a7fff', fillOpacity: 1}).addTo(map); });
map.on('locationerror', () => { status.textContent = 'Location unavailable'; status.hidden = false; setTimeout(() => status.hidden = true, 3000); });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
