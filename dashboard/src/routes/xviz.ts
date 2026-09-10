/**
 * XVIZ endpoints: the demo scenes served in the protocol streetscape.gl speaks.
 *
 * Two transports, because streetscape.gl ships two loaders and both are worth
 * having on Workers:
 *
 *   * **Files** — `XVIZFileLoader` fetches a timings file, then one file per
 *     frame. Every response is pure, immutable and cacheable, so the whole log
 *     rides the Cloudflare edge cache and a replay costs the Worker nothing on
 *     the second view. This is the default the viewer uses.
 *   * **Socket** — `XVIZStreamLoader` opens a WebSocket and asks for time
 *     ranges with `transform_log`. Workers do this natively through
 *     `WebSocketPair`, with no Durable Object needed: the log is generated from
 *     a seed, so there is no shared state for one to hold. This is the path a
 *     live vehicle feed would take, and it is here so that shape is proven
 *     rather than assumed.
 *
 * Like `/api/scenes`, these are unauthenticated: the scenes are generated from
 * a fixed seed and carry no tenant data, so the viewer works on a fresh
 * deployment before a token exists or a single run has been ingested.
 */
/* eslint-disable camelcase */
import type { RouteContext } from "../router";
import { HttpError, json } from "../util";
import { SCENE_IDS, buildScene, listScenes, type Scene } from "../scenes";
import {
  buildFrame,
  buildMetadata,
  buildTimings,
  frameCount,
  frameTime,
  sceneContext,
  type FrameOptions,
  type SceneContext,
} from "../xviz/log";
import type { XVIZEnvelope, XVIZTransformLog } from "../xviz/types";

/** Frames are a pure function of (scene, index, density), so cache them hard. */
const IMMUTABLE = { "cache-control": "public, max-age=86400, immutable" };
const CATALOG = { "cache-control": "public, max-age=3600" };

/**
 * Default share of the scene's modelled return count that the XVIZ log ships.
 *
 * The deck.gl scene viewer simulates the full scan in the browser and pays
 * nothing to move it. Here every return is JSON on the wire, so the default is
 * turned down to something a phone on a Thimphu connection can stream — about
 * 25 kB of points per frame. `?lidar=` overrides it, `?lidar=0` drops the
 * stream, and `?lidar=1` sends the same density the deck.gl viewer draws.
 */
const DEFAULT_LIDAR_DENSITY = 0.35;

function checkDensity(raw: string | null): number {
  if (raw === null) return DEFAULT_LIDAR_DENSITY;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new HttpError(400, "lidar density must be between 0 and 1");
  return n;
}

/**
 * Density from the `lidar-<n>` path segment.
 *
 * It is a path segment rather than a query parameter because `XVIZFileLoader`
 * reads the file format off the end of the URL it is handed
 * (`filePath.match(/[^\.]*$/)`), so a `?lidar=` suffix makes every frame an
 * "Unknown file format". Putting it in the path also means each density is its
 * own cache key rather than a query-string variant.
 */
function pathDensity(profile: string | undefined): number {
  if (profile === undefined) return DEFAULT_LIDAR_DENSITY;
  const match = /^lidar-([0-9.]+)$/.exec(profile);
  if (!match) throw new HttpError(404, `not an XVIZ profile: ${profile}`);
  return checkDensity(match[1]);
}

interface Log {
  scene: Scene;
  index: number;
  context: SceneContext;
}

/**
 * Resolve a log id to its scene. The index fixes the log's place on the clock —
 * see `LOG_EPOCH_S` — so it has to come from the catalog, not from the request.
 */
function openLog(id: string): Log {
  const index = SCENE_IDS.indexOf(id);
  if (index < 0) throw new HttpError(404, `unknown XVIZ log: ${id}`);
  const scene = buildScene(id)!;
  return { scene, index, context: sceneContext(scene) };
}

// --------------------------------------------------------------- file loader

/** GET /api/xviz/logs — what the viewer's log picker lists. */
export function listLogs(c: RouteContext): Response {
  const origin = new URL(c.request.url).origin;
  const logs = listScenes().map((summary, index) => {
    const frames = Math.round(summary.duration_s * summary.hz) + 1;
    return {
      ...summary,
      log_id: summary.scene_id,
      frames,
      start_time: frameTime(summary.hz, index, 0),
      // Everything a streetscape.gl loader needs to open this log, so a client
      // never has to know how our URLs are shaped.
      timings_url: `${origin}/api/xviz/logs/${summary.scene_id}/0-frame.json`,
      // `{profile}` is `lidar-<density>`, or omit the segment for the default.
      frame_url_template: `${origin}/api/xviz/logs/${summary.scene_id}/{profile}/{index}-frame.json`,
      socket_url: `${origin.replace(/^http/, "ws")}/api/xviz/ws?log=${summary.scene_id}`,
    };
  });
  return json({ logs }, 200, CATALOG);
}

/**
 * GET /api/xviz/logs/:id[/lidar-<density>]/:file — the file-loader surface.
 *
 * `0-frame.json` is the timings index. `1-frame.json` is the metadata. From
 * `2-frame.json` on, file `n` is data frame `n - 2`. That numbering is
 * `XVIZFileLoader`'s, not ours: it loads `getFilePath(0)` as metadata and then
 * counts up through `timing.length` more files.
 */
export function getLogFile(c: RouteContext): Response {
  const match = /^(\d+)-frame\.json$/.exec(c.params.file);
  if (!match) throw new HttpError(404, `not an XVIZ frame file: ${c.params.file}`);
  const n = Number(match[1]);
  const { scene, index, context } = openLog(c.params.id);

  if (n === 0) return json(buildTimings(scene, index), 200, IMMUTABLE);
  if (n === 1) return json(envelope({ type: "xviz/metadata", data: buildMetadata(scene, index) }), 200, IMMUTABLE);

  const frame = n - 2;
  if (frame >= frameCount(scene)) throw new HttpError(404, `frame ${frame} is past the end of ${c.params.id}`);
  const options: FrameOptions = { lidarDensity: pathDensity(c.params.profile) };
  return json(envelope({ type: "xviz/state_update", data: buildFrame(scene, index, frame, context, options) }), 200, IMMUTABLE);
}

/** XVIZ messages travel in a typed envelope; this is just a readability alias. */
const envelope = (message: XVIZEnvelope): XVIZEnvelope => message;

// ------------------------------------------------------------------ websocket

/** How many frames to hand to the socket before yielding, so one log cannot monopolise the isolate. */
const SOCKET_BATCH = 25;

/**
 * GET /api/xviz/ws?log=<id> — the `XVIZStreamLoader` surface.
 *
 * The client's contract: we send metadata on connect, it replies with
 * `transform_log` naming a time range, and we stream that range as
 * `state_update` messages followed by `transform_log_done`. Seeking is another
 * `transform_log`; a new one supersedes whatever is still in flight.
 */
export function xvizSocket(c: RouteContext): Response {
  if (c.request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    throw new HttpError(426, "this endpoint requires a WebSocket upgrade");
  }
  const logId = c.url.searchParams.get("log") || SCENE_IDS[0];
  const log = openLog(logId);
  // The socket URL never reaches the file-format sniffing above, so the density
  // can stay an ordinary query parameter here.
  const options: FrameOptions = { lidarDensity: checkDensity(c.url.searchParams.get("lidar")) };

  const pair = new WebSocketPair();
  const server = pair[1];
  server.accept();

  // Bumped on every transform_log so an in-flight stream from a superseded
  // request stops sending instead of interleaving with the new one.
  let generation = 0;
  let closed = false;
  server.addEventListener("close", () => { closed = true; });
  server.addEventListener("error", () => { closed = true; });

  const send = (message: XVIZEnvelope): void => {
    if (closed) return;
    try {
      server.send(JSON.stringify(message));
    } catch {
      closed = true;
    }
  };

  server.addEventListener("message", (event: MessageEvent) => {
    let parsed: { type?: string; data?: XVIZTransformLog };
    try {
      parsed = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer));
    } catch {
      send({ type: "xviz/error", data: { message: "message is not valid JSON" } });
      return;
    }
    if (parsed.type !== "xviz/transform_log") return;
    generation += 1;
    void streamRange(parsed.data ?? {}, generation);
  });

  /** Stream every frame inside the requested window, newest request wins. */
  async function streamRange(request: XVIZTransformLog, mine: number): Promise<void> {
    const { scene, index, context } = log;
    const frames = frameCount(scene);
    const first = request.start_timestamp === undefined ? 0 : frameForTime(scene, index, request.start_timestamp);
    const last = request.end_timestamp === undefined ? frames - 1 : frameForTime(scene, index, request.end_timestamp);

    for (let frame = first; frame <= last; frame += 1) {
      if (closed || generation !== mine) return;
      send({ type: "xviz/state_update", data: buildFrame(scene, index, frame, context, options) });
      // Frames are generated, not read: without a yield the whole range would
      // be built in one synchronous run and the socket would buffer all of it.
      if ((frame - first + 1) % SOCKET_BATCH === 0) await new Promise((r) => setTimeout(r, 0));
    }
    if (!closed && generation === mine) {
      send({ type: "xviz/transform_log_done", data: { id: request.id ?? "0" } });
    }
  }

  send({ type: "xviz/metadata", data: buildMetadata(log.scene, log.index) });

  return new Response(null, { status: 101, webSocket: pair[0] });
}

/** Nearest frame to a wall-clock timestamp, clamped to the log. */
function frameForTime(scene: Scene, sceneIndex: number, timestamp: number): number {
  const frames = frameCount(scene);
  const offset = (timestamp - frameTime(scene.hz, sceneIndex, 0)) * scene.hz;
  return Math.min(Math.max(Math.round(offset), 0), frames - 1);
}
