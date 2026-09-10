import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
// The upstream streetscape.gl checkout, vendored at the root of this monorepo.
const vendor = resolve(here, '../../streetscape/modules');

/**
 * The viewer is built straight from the vendored streetscape.gl *source* under
 * `streetscape/modules/`, not from the published `dist/` bundles. Two reasons:
 *
 *   1. Upstream is archived. Building from source is what lets us patch it —
 *      the deck.gl compatibility fix recorded in `streetscape/VENDORED.md` is a
 *      diff reviewable in this repo, not a fork published to a registry.
 *   2. The published bundles are ES5 behind `dist/es5` main fields; feeding
 *      Rollup the ES modules under `src/` lets it tree-shake the parts of
 *      monochrome (drag-drop lists, float panels) the viewer never mounts.
 *
 * That source is React 16-era — JSX inside `.js` files, class properties, and
 * one Flow-annotated file — so the Babel configuration below is what makes the
 * tree parse. Nothing there had to be edited to build it.
 */

/**
 * The vendored source lives outside this package, so Node's resolution walks up
 * from `streetscape/modules/...` and never reaches `dashboard/viewer/node_modules`
 * — every bare import (`@deck.gl/core`, `react`, `react-vis/dist/...`) fails.
 *
 * Rather than restructure the repo into an npm workspace (which would break the
 * `npm ci` in `dashboard/` that CI relies on), re-ask Vite's own resolver for
 * those specifiers as if they had been imported by a file in this package. That
 * keeps the real resolver — export maps, `module`/`browser` fields, dedupe —
 * instead of hard-coding a path per dependency.
 */
function resolveVendorDeps() {
  const asViewerImport = resolve(here, 'vite.config.js');
  return {
    name: 'streetscape-vendor-deps',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (!importer || !importer.startsWith(vendor)) return null;
      if (source[0] === '.' || source[0] === '/' || source[0] === '\0') return null;
      const resolved = await this.resolve(source, asViewerImport, {skipSelf: true});
      return resolved ? resolved.id : null;
    }
  };
}

export default defineConfig({
  base: '/viewer/',
  plugins: [
    resolveVendorDeps(),
    react({
      include: /\.[jt]sx?$/,
      babel: {
        babelrc: false,
        configFile: false,
        // plugin-react only hands `.jsx`/`.tsx` to its own JSX transform
        // (`filepath.endsWith('x')`), and every upstream component is a `.js`
        // file full of JSX — so the React preset has to be requested here.
        presets: [['@babel/preset-react', {runtime: 'automatic'}]],
        plugins: ['@babel/plugin-transform-flow-strip-types']
      }
    })
  ],
  resolve: {
    alias: [
      {find: /^streetscape\.gl$/, replacement: resolve(vendor, 'main/src/index.js')},
      {find: /^@streetscape\.gl\/core$/, replacement: resolve(vendor, 'core/src/index.js')},
      {find: /^@streetscape\.gl\/layers$/, replacement: resolve(vendor, 'layers/src/index.js')},
      {find: /^@streetscape\.gl\/monochrome$/, replacement: resolve(vendor, 'monochrome/src/index.js')}
    ]
  },
  // deck.gl reads `process.env.NODE_ENV` at module scope; math.gl and probe.gl
  // check `global`. Neither exists in a browser without these two shims.
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
    global: 'globalThis'
  },
  optimizeDeps: {
    // The vendored source is outside the Vite root, so pre-bundling has to be
    // told about the transitive deps it pulls in.
    include: ['react', 'react-dom', 'prop-types', 'popper.js', 'debounce', 'lodash.merge', 'reselect']
  },
  server: {
    fs: {allow: [resolve(here, '../..')]},
    // `npm run dev` in this folder proxies the XVIZ API to `wrangler dev`, so
    // the viewer can be developed with HMR against the real Worker.
    proxy: {
      '/api': {target: 'http://127.0.0.1:8787', changeOrigin: true, ws: true}
    }
  },
  build: {
    // Straight into the Worker's static asset directory: `wrangler deploy`
    // uploads whatever is in dashboard/public, so a built viewer ships with the
    // Worker and needs no second origin or CDN.
    outDir: resolve(here, '../public/viewer'),
    emptyOutDir: true,
    // Kept on, at ~9 MB of extra static asset per deploy. The failure this
    // viewer actually produces is a silent one — an empty 3D view with a clean
    // console — and diagnosing that in a 3 MB minified bundle without a map is
    // not worth the bytes saved. All of the source is in this repo anyway.
    sourcemap: true,
    // streetscape.gl pulls in deck.gl, luma.gl, React 16, react-vis and the
    // XVIZ parser, and they all run on first paint — a manual chunk split only
    // moved bytes between files and introduced circular chunks. One bundle it is.
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      onwarn(warning, warn) {
        // @xviz/io bundles the Node file-system paths of @loaders.gl. Vite
        // stubs Node builtins for the browser, so those imports resolve to a
        // stub that throws if ever called — and they are not, because the
        // viewer only ever loads XVIZ over fetch and WebSocket. Everything else
        // still warns.
        if (warning.code === 'MISSING_EXPORT' && warning.exporter === '__vite-browser-external') return;
        warn(warning);
      }
    }
  }
});
