/**
 * Build an XVIZ loader for one log on one transport.
 *
 * Both transports are served by the same Worker (`dashboard/src/routes/xviz.ts`)
 * and carry byte-identical frames; they differ only in how the frames arrive:
 *
 *   * `file` — `XVIZFileLoader` fetches the timings index and then one JSON file
 *     per frame. Each response is immutable, so a replay is served by the
 *     Cloudflare edge cache rather than re-generated.
 *   * `socket` — `XVIZStreamLoader` opens a WebSocket and asks for time ranges.
 *     This is the shape a live vehicle feed takes; the Worker answers it out of
 *     a `WebSocketPair`.
 */
import {XVIZFileLoader, XVIZStreamLoader} from 'streetscape.gl';

import {API_BASE} from './constants';

export const TRANSPORTS = {
  file: 'Files · cached at the edge',
  socket: 'WebSocket · live stream'
};

/**
 * @param log     one entry from GET /api/xviz/logs
 * @param transport  'file' | 'socket'
 * @param lidar   density passed through to the API as `?lidar=`
 */
export function createLoader(log, transport, lidar) {

  if (transport === 'socket') {
    const base = API_BASE || window.location.origin;
    const serverUrl = `${base.replace(/^http/, 'ws')}/api/xviz/ws`;
    return new XVIZStreamLoader({
      logGuid: log.log_id,
      serverConfig: {serverUrl, queryParams: {lidar}},
      // The whole log is a few seconds of frames, so buffer all of it and let
      // the first transform_log cover the log end to end.
      duration: log.duration_s,
      bufferLength: log.duration_s,
      // Parsing on the main thread: the worker build of @xviz/parser wants to
      // be served as a separate bundle, and these frames are small enough that
      // it buys nothing here.
      worker: false
    });
  }

  // The density is a path segment, not a query parameter: XVIZFileLoader picks
  // the parser from the end of the URL string, so anything after `.json` makes
  // the frame an "Unknown file format".
  const base = `${API_BASE}/api/xviz/logs/${log.log_id}`;
  return new XVIZFileLoader({
    timingsFilePath: `${base}/0-frame.json`,
    // Index 0 is the metadata file; index n > 0 is data frame n - 1.
    getFilePath: index => `${base}/lidar-${encodeURIComponent(lidar)}/${index + 1}-frame.json`,
    worker: false,
    maxConcurrency: 4
  });
}

/** GET /api/xviz/logs — the catalog the picker lists. */
export async function fetchLogs() {
  const response = await fetch(`${API_BASE}/api/xviz/logs`);
  if (!response.ok) {
    throw new Error(`the XVIZ API answered ${response.status} ${response.statusText}`);
  }
  const body = await response.json();
  if (!body.logs || body.logs.length === 0) {
    throw new Error('the XVIZ API returned no logs');
  }
  return body.logs;
}
