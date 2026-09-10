# streetscape.gl, vendored

This directory is a copy of [aurora-opensource/streetscape.gl](https://github.com/aurora-opensource/streetscape.gl),
the deck.gl-based visualization toolkit for [XVIZ](https://github.com/aurora-opensource/xviz)
autonomy logs. It is the synthetic-world *viewer* in this repository, the way
[`carla/`](../carla) is the synthetic-world *engine*.

| | |
|---|---|
| Upstream | https://github.com/aurora-opensource/streetscape.gl |
| Commit | `befae1354ca8605c9f6cb1229b494858a8690e4f` |
| Tag | `v1.0.13` (3 June 2022) |
| Licence | MIT — see [`LICENSE`](LICENSE), retained unchanged |

Upstream is archived. Aurora stopped publishing after 1.0.13, so there is no
release to track and no fork to file pull requests against; the code is vendored
here so the parts we depend on are readable, patchable and reviewable in one
place, and so a change to them shows up as an ordinary diff in this repository.

## What is used

[`dashboard/viewer/`](../dashboard/viewer) builds the XVIZ viewer directly from
`modules/*/src` — the ES module sources, not the published `dist/` bundles.
`dashboard/viewer/vite.config.js` aliases the four package names at their source
entry points:

| Package | Source |
|---|---|
| `streetscape.gl` | `modules/main/src/index.js` |
| `@streetscape.gl/core` | `modules/core/src/index.js` |
| `@streetscape.gl/layers` | `modules/layers/src/index.js` |
| `@streetscape.gl/monochrome` | `modules/monochrome/src/index.js` |

Everything else in this tree — `examples/`, `docs/`, `test/`, `bindings/`, the
root build configuration — is upstream's, kept for reference. It is not built by
this repository's CI, and the upstream toolchain (ocular, lerna, webpack 4,
yarn workspaces) is not installed. Upstream's own `docs/` remain the API
reference for the components the viewer mounts.

The marketing website (`website/`, ~5 MB of images) was the one directory left
out; it documents a product page that no longer exists.

## Local patches

Kept to the minimum, each one a compatibility fix rather than a change of
behaviour, so a future diff against upstream stays small and legible.

### `modules/core/src/components/log-viewer/core-3d-viewer.js` — `_onViewStateChange`

streetscape.gl 1.0.13 was written against deck.gl 8.1, where `onViewStateChange`
fired only for user gestures. deck.gl 8.2 and later also fire it when the canvas
is resized, and when the first tracked pose arrives while `oldViewState` still
holds the untracked default at longitude 0, latitude 0. Upstream fed every such
event to `getViewStateOffset()`, which reads it as the user having dragged the
camera — off the coast of Africa, in the case of the initial event. The camera
ends up a kilometre from the vehicle and the 3D view renders empty.

The patch accumulates the view offset only from changes deck.gl flags as user
interaction, and never across a resize. Everything else passes the new view
state through and leaves the offset alone.

There is no upstream to send this to; if streetscape.gl is ever revived, this is
the diff to offer.

## Third-party dependencies

The vendored source imports its dependencies by name — `@deck.gl/*`, `react`,
`react-vis`, `@xviz/parser` and so on. Those are installed by
`dashboard/viewer/package.json` and resolved through a small Vite plugin
(`resolveVendorDeps` in `dashboard/viewer/vite.config.js`), because this
directory has no `node_modules` of its own. Two of them need pinning:

* **deck.gl 8.9.x**, not 8.1.5 as upstream's `package.json` asks for. The XVIZ
  parser pulls in loaders.gl 3.4, which requires luma.gl 8.5, and luma.gl
  refuses to load two major-minor versions in one page ("multiple VERSIONs
  detected"). 8.9 is the deck.gl line built on luma.gl 8.5, and the view-state
  patch above is what it costs.
* **React 16.14**, the last React 16, because the components use legacy
  lifecycles (`componentWillReceiveProps`) throughout. 16.14 is also the first
  React 16 with the automatic JSX runtime, which is what lets the source build
  without upstream's Babel configuration.

## Updating

Upstream is archived, so there is nothing to pull. If that changes:

```sh
git clone --depth 1 https://github.com/aurora-opensource/streetscape.gl /tmp/ssgl
# copy everything except .git and website/, then re-apply the patches above
cd dashboard/viewer && npm run build      # the build is the first check
cd .. && npm run check                    # then the Worker's own tests
```

Then drive the viewer for real — `npm run dev` in `dashboard/` and open
`/viewer/` — because the failures that matter here (an empty 3D view, a camera
pointing at nothing) are exactly the ones that leave the console silent.
