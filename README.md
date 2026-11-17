# BayRace

Installable web app (PWA) for SF Bay sailboat racing: YRA racing marks on a NOAA chart, street or satellite map, with courses, tides and wind to come. Works offline once loaded.

**Not for navigation.** Mark positions are approximate (source: [nkiesel/YRA-Marks](https://github.com/nkiesel/YRA-Marks)); sanity-check them on the water.

Run locally: `python3 -m http.server 8000`, then open http://localhost:8000.

Coastline used to keep course legs off land: © OpenStreetMap contributors (ODbL), simplified to ~10 m by `tools/build_coast.py`.
