# XVIZ viewer

The [streetscape.gl](https://github.com/aurora-opensource/streetscape.gl)
log viewer for OA Driverless Vision, served by the Atlas Worker at `/viewer/`.

It plays the demo scenes as [XVIZ](https://github.com/aurora-opensource/xviz)
logs: ego pose and mesh, simulated lidar returns, actor boxes with per-object
labels and ranges, road geometry, the planned trajectory and driven trail,
time-series metrics, and a scene-event table that fills as playback reaches each
event. Nothing here needs a database, a token or a GPU workstation — the scenes
are generated from a fixed seed, so a fresh deployment plays a log immediately.

```
dashboard/src/scenes.ts    ego and actor tracks on a local metre grid
        ↓                  dashboard/src/lidar.ts casts the rays
dashboard/src/xviz/log.ts  XVIZ v2 metadata and one state_update per frame
        ↓                  dashboard/src/routes/xviz.ts serves it
   this app                streetscape.gl renders it with deck.gl
```

## Running it

The viewer needs the Worker's `/api/xviz` endpoints, so start that first:

```sh
cd dashboard
npm run dev            # wrangler dev on http://127.0.0.1:8787
```

Then either:

* **Built** — `npm run build:viewer`, then open <http://127.0.0.1:8787/viewer/>.
  This is what ships: the build writes into `dashboard/public/viewer/`, which
  `wrangler deploy` uploads as a static asset of the same Worker.
* **With HMR** — `npm run dev:viewer` in `dashboard/` (or `npm run dev` here),
  then open the Vite URL. Vite proxies `/api` to `wrangler dev` on port 8787,
  including the WebSocket, so the viewer runs against the real Worker.

## Transports

The header switches between the two loaders streetscape.gl ships, both served by
the same Worker and carrying byte-identical frames:

* **Files** (default) — one immutable JSON file per frame. Cacheable end to end,
  so a replay is served from the Cloudflare edge rather than re-generated.
* **WebSocket** — `XVIZStreamLoader` asks for time ranges over a socket the
  Worker answers from a `WebSocketPair`. This is the shape a live vehicle feed
  would take.

The **Lidar** control trades fidelity for bandwidth. Every return is JSON on the
wire, so the default ships about a third of the scan the scene models — roughly
10 kB gzipped per frame. "Full scan" sends what the deck.gl scene viewer draws
in the Atlas dashboard; "Off" drops the point cloud entirely.

## Configuration

All optional, read at build time:

| Variable | Effect |
|---|---|
| `VITE_MAPBOX_TOKEN` | Draws a Mapbox basemap under the log. Without it the basemap is switched off — the honest default for synthetic scenes on a local metre grid, which would otherwise imply survey accuracy the scene does not have. |
| `VITE_MAP_STYLE` | Mapbox style URL, when a token is set. |
| `VITE_API_BASE` | Point the viewer at a different Atlas origin. Defaults to same-origin. |

## Where the code is

* `src/app.jsx` — the shell: log picker, transport and lidar controls, panels, HUD.
* `src/constants.js` — XVIZ parser config, stream styling, the ego mesh, theme.
* `src/log-source.js` — builds the right loader for a log and transport.
* `vite.config.js` — aliases `streetscape.gl` at [`../../streetscape`](../../streetscape),
  the vendored upstream source. See [`streetscape/VENDORED.md`](../../streetscape/VENDORED.md)
  for what is patched there and why.
