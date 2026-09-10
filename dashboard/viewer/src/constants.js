// Viewer configuration: XVIZ parser settings, stream styling, the ego mesh and
// the theme the monochrome components render with. Kept apart from app.jsx so
// the "how it looks" decisions sit in one file.
import {CarMesh} from 'streetscape.gl';

/**
 * Where the XVIZ API lives. Same origin in production — the Worker serves both
 * this app and /api — and proxied to `wrangler dev` by vite.config.js in
 * development, so the default of "" is right in both cases.
 */
export const API_BASE = import.meta.env.VITE_API_BASE || '';

/**
 * A Mapbox token is optional and there is no default. Without one the viewer
 * runs with the basemap switched off, which is the honest thing for these logs:
 * they are synthetic scenes on a local metre grid, and a satellite tile under
 * them would imply survey accuracy the scene does not have. Set
 * VITE_MAPBOX_TOKEN at build time to put a real map underneath.
 */
export const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || '';
export const MAP_STYLE = import.meta.env.VITE_MAP_STYLE || 'mapbox://styles/mapbox/dark-v10';

export const XVIZ_CONFIG = {
  PLAYBACK_FRAME_RATE: 10,
  // The demo logs have no video and no /vehicle_pose gaps, but a range request
  // that lands mid-buffer can still deliver a frame before its pose; letting
  // the loader through avoids a stall on seek.
  ALLOW_MISSING_PRIMARY_POSE: true
};

/** The ego mesh. Dimensions match `EGO_DIMENSIONS` in dashboard/src/scenes.ts. */
export const CAR = CarMesh.sedan({
  origin: [1.08, -0.32, 0],
  length: 4.7,
  width: 1.9,
  height: 1.6,
  color: [58, 135, 229]
});

/**
 * Client-side style overrides on top of the stylesheet the Worker ships in the
 * XVIZ metadata. Only the interaction states live here — hover and selection
 * are viewer concerns, not log content, so the server has no business
 * describing them.
 */
export const XVIZ_STYLE = {
  '/object/shape': [
    {name: 'selected', style: {fill_color: '#ffa53dcc'}},
    {name: 'hovered', style: {fill_color: '#ffd08acc'}}
  ]
};

export const APP_SETTINGS = {
  viewMode: {
    type: 'select',
    title: 'View mode',
    data: {PERSPECTIVE: 'Perspective', TOP_DOWN: 'Top down', DRIVER: 'Driver'}
  },
  showTooltip: {
    type: 'toggle',
    title: 'Hover tooltip'
  }
};

/** Lidar densities offered in the header, as the `?lidar=` value the API takes. */
export const LIDAR_DENSITIES = [
  {value: '0', label: 'Off'},
  {value: '0.15', label: 'Sparse'},
  {value: '0.35', label: 'Default'},
  {value: '0.6', label: 'Dense'},
  {value: '1', label: 'Full scan'}
];

/** Keeps the monochrome controls on the same palette as public/app.css. */
export const THEME = {
  extends: 'dark',
  background: '#1a1a19',
  backgroundAlt: '#242423',
  controlColorPrimary: '#c3c2b7',
  controlColorSecondary: '#8f8e86',
  controlColorHovered: '#ffffff',
  controlColorActive: '#3987e5',
  controlColorDisabled: '#4a4a46',
  textColorPrimary: '#ffffff',
  textColorSecondary: '#c3c2b7',
  textColorDisabled: '#8f8e86',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  fontSize: 13
};

/** What the point colours and box classes in the 3D view mean. */
export const LEGEND = [
  {color: 'rgb(96,110,126)', label: 'Lidar return · carriageway'},
  {color: 'rgb(122,104,74)', label: 'Lidar return · verge'},
  {color: 'rgb(235,176,60)', label: 'Lidar return · object or post'},
  {color: 'rgb(27,176,122)', label: 'Tracked vehicle'},
  {color: 'rgb(214,58,58)', label: 'Vulnerable road user'},
  {color: 'rgb(138,138,132)', label: 'Outside sensor range · not detected'}
];
