/**
 * Encode a demo scene as an XVIZ v2 log.
 *
 * This is the bridge between the two halves of the dashboard: `src/scenes.ts`
 * describes a scene as ego and actor tracks on a local metre grid, and
 * streetscape.gl wants XVIZ — a pose stream plus primitive, time-series and
 * declarative-UI streams, one message per frame.
 *
 * Everything here is pure: same scene in, same bytes out. That is what lets the
 * routes cache frames hard, lets the unit tests assert on exact output, and
 * means a partner report screenshot is reproducible months later.
 *
 * All primitive streams are left in the default IDENTITY coordinate system,
 * which streetscape.gl reads as metre offsets from the pose's `map_origin` —
 * exactly the frame the scenes are already authored in, so no stream needs a
 * per-frame transform.
 */
/* eslint-disable camelcase */
import type { Scene, SceneActor, SceneEvent } from "../scenes";
import { rangeAt } from "../scenes";
import { scan, scanContext, type ScanContext } from "../lidar";
import type {
  XVIZMetadata,
  XVIZPolygon,
  XVIZPolyline,
  XVIZStateUpdate,
  XVIZStreamMetadata,
  XVIZStreamSet,
  XVIZText,
  XVIZTimeSeriesEntry,
  XVIZTreeTableNode,
  XVIZUIComponent,
} from "./types";

/**
 * Logs are timestamped from a fixed epoch rather than from zero. XVIZ
 * timestamps are wall-clock seconds and the viewer renders them as dates, so a
 * zero-based log reads as 1 January 1970 on the playback control. Each scene is
 * offset by an hour from the last so two logs are never confused for each other.
 */
export const LOG_EPOCH_S = Date.UTC(2025, 2, 4, 3, 30, 0) / 1000;
const SCENE_EPOCH_STRIDE_S = 3600;

/** Vertical placement of the label above an actor's roof, metres. */
const LABEL_CLEARANCE_M = 0.8;
/** How far ahead of the ego the planned-trajectory ribbon is drawn, seconds. */
const TRAJECTORY_HORIZON_S = 6;
/** How much of the driven path stays visible behind the ego, seconds. */
const TRAIL_S = 8;

/** Vulnerable road users get their own style class and their own KPI. */
const VRU: Record<string, true> = { pedestrian: true, cyclist: true, motorcycle: true };

export const STREAMS = {
  pose: "/vehicle_pose",
  lidar: "/lidar/points",
  carriageway: "/road/carriageway",
  centerline: "/road/centerline",
  objectShape: "/object/shape",
  objectLabel: "/object/label",
  objectCenter: "/object/tracked_point",
  trajectory: "/ego/trajectory",
  trail: "/ego/trail",
  velocity: "/vehicle/velocity",
  acceleration: "/vehicle/acceleration",
  turnSignal: "/vehicle/turn_signal",
  trackedObjects: "/perception/tracked_objects",
  nearestObject: "/perception/nearest_object",
  vruRange: "/perception/nearest_vru",
  events: "/scene/events",
} as const;

const round = (n: number, digits = 3): number => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

/** Wall-clock timestamp of frame `frame` of the `sceneIndex`th log. */
export function frameTime(hz: number, sceneIndex: number, frame: number): number {
  return round(LOG_EPOCH_S + sceneIndex * SCENE_EPOCH_STRIDE_S + frame / hz, 3);
}

export function frameCount(scene: Scene): number {
  return scene.ego.track.length;
}

// ------------------------------------------------------------------ metadata

function streamMetadata(): Record<string, XVIZStreamMetadata> {
  return {
    [STREAMS.pose]: { category: "POSE" },

    [STREAMS.lidar]: {
      category: "PRIMITIVE",
      primitive_type: "POINT",
      // The scan carries its own per-point colour (carriageway, verge, hit), so
      // no `point_color_mode` — an elevation ramp would throw that away.
      stream_style: { radius_pixels: 2.5, opacity: 0.9 },
    },

    [STREAMS.carriageway]: {
      category: "PRIMITIVE",
      primitive_type: "POLYGON",
      stream_style: { fill_color: "#2a2f38c0", stroked: false, extruded: false },
    },

    [STREAMS.centerline]: {
      category: "PRIMITIVE",
      primitive_type: "POLYLINE",
      stream_style: { stroke_color: "#d8c46b", stroke_width: 0.12, stroke_width_min_pixels: 1 },
    },

    [STREAMS.objectShape]: {
      category: "PRIMITIVE",
      primitive_type: "POLYGON",
      stream_style: { extruded: true, fill_color: "#1bb07a90", stroked: false },
      style_classes: [
        // A VRU is drawn in the same red the safety review uses.
        { name: "vru", style: { fill_color: "#d63a3ac0" } },
        // Outside the scene's usable lidar range: the sensor model says this
        // object would not have been detected, so it is drawn as a ghost.
        { name: "missed", style: { fill_color: "#8a8a8455", extruded: false } },
        { name: "selected", style: { fill_color: "#ff8000cc" } },
      ],
    },

    [STREAMS.objectCenter]: {
      category: "PRIMITIVE",
      primitive_type: "CIRCLE",
      stream_style: { fill_color: "#ffffffcc", radius_min_pixels: 2, radius_max_pixels: 6, stroked: false },
      style_classes: [{ name: "missed", style: { fill_color: "#8a8a8466" } }],
    },

    [STREAMS.objectLabel]: {
      category: "PRIMITIVE",
      primitive_type: "TEXT",
      stream_style: { fill_color: "#f2f2f0", text_size: 15, text_anchor: "MIDDLE", text_baseline: "BOTTOM" },
      style_classes: [{ name: "missed", style: { fill_color: "#9a9a94" } }],
    },

    [STREAMS.trajectory]: {
      category: "PRIMITIVE",
      primitive_type: "POLYLINE",
      stream_style: { stroke_color: "#2a78d6", stroke_width: 0.4, stroke_width_min_pixels: 2 },
    },

    [STREAMS.trail]: {
      category: "PRIMITIVE",
      primitive_type: "POLYLINE",
      stream_style: { stroke_color: "#eb6834", stroke_width: 0.25, stroke_width_min_pixels: 1 },
    },

    [STREAMS.velocity]: { category: "TIME_SERIES", scalar_type: "FLOAT", units: "m/s" },
    [STREAMS.acceleration]: { category: "TIME_SERIES", scalar_type: "FLOAT", units: "m/s^2" },
    [STREAMS.turnSignal]: { category: "TIME_SERIES", scalar_type: "STRING" },
    [STREAMS.trackedObjects]: { category: "TIME_SERIES", scalar_type: "INT32", units: "objects" },
    [STREAMS.nearestObject]: { category: "TIME_SERIES", scalar_type: "FLOAT", units: "m" },
    [STREAMS.vruRange]: { category: "TIME_SERIES", scalar_type: "FLOAT", units: "m" },

    [STREAMS.events]: { category: "UI_PRIMITIVE" },
  };
}

function uiConfig(scene: Scene): Record<string, XVIZUIComponent> {
  return {
    Metrics: {
      type: "panel",
      name: "Metrics",
      children: [
        {
          type: "metric",
          title: "Speed",
          description: "Ego speed over ground. The dips are the braking events listed in the Events panel.",
          streams: [STREAMS.velocity],
        },
        {
          type: "metric",
          title: "Longitudinal acceleration",
          description: "Differentiated from the speed profile; the safety rules trigger below -3 m/s².",
          streams: [STREAMS.acceleration],
        },
        {
          type: "metric",
          title: "Range to nearest object",
          description: `Straight-line range to the nearest actor, and to the nearest vulnerable road user. Usable lidar range in this scene is ${scene.sensor.lidar_range_m} m.`,
          streams: [STREAMS.nearestObject, STREAMS.vruRange],
        },
        {
          type: "metric",
          title: "Objects inside sensor range",
          description: "Actors the sensor model would have returned at this frame, out of the scene's full cast.",
          streams: [STREAMS.trackedObjects],
        },
      ],
    },
    Events: {
      type: "panel",
      name: "Events",
      children: [
        {
          type: "treetable",
          title: "Scene events",
          description: "Rows appear as playback reaches them; the newest is first.",
          stream: STREAMS.events,
        },
      ],
    },
  };
}

/** The `xviz/metadata` payload: stream declarations, styling and panel layout. */
export function buildMetadata(scene: Scene, sceneIndex: number): XVIZMetadata {
  return {
    version: "2.0.0",
    streams: streamMetadata(),
    ui_config: uiConfig(scene),
    log_info: {
      start_time: frameTime(scene.hz, sceneIndex, 0),
      end_time: frameTime(scene.hz, sceneIndex, frameCount(scene) - 1),
    },
  };
}

// -------------------------------------------------------------------- frames

/** Corners of an actor's footprint, closed for a polygon, in world metres. */
function footprint(actor: SceneActor, frame: number): number[][] {
  const pose = actor.track[Math.min(frame, actor.track.length - 1)];
  const c = Math.cos(pose.heading);
  const s = Math.sin(pose.heading);
  const hl = actor.length_m / 2;
  const hw = actor.width_m / 2;
  return [
    [hl, hw],
    [hl, -hw],
    [-hl, -hw],
    [-hl, hw],
  ].map(([u, v]) => [round(pose.x + u * c - v * s, 2), round(pose.y + u * s + v * c, 2), 0]);
}

/** Left and right kerb lines joined into one ring. */
function centerline(scene: Scene): number[][] {
  return scene.road.centerline.map((p) => [p.x, p.y, 0.02]);
}

function carriageway(scene: Scene): number[][] {
  const line = scene.road.centerline;
  const half = (scene.road.lanes * scene.road.lane_width_m) / 2;
  const left: number[][] = [];
  const right: number[][] = [];
  for (let i = 0; i < line.length; i += 1) {
    const a = line[Math.max(0, i - 1)];
    const b = line[Math.min(line.length - 1, i + 1)];
    const h = Math.atan2(b.y - a.y, b.x - a.x);
    left.push([round(line[i].x - Math.sin(h) * half, 2), round(line[i].y + Math.cos(h) * half, 2), 0]);
    right.push([round(line[i].x + Math.sin(h) * half, 2), round(line[i].y - Math.cos(h) * half, 2), 0]);
  }
  return left.concat(right.reverse());
}

/**
 * Turn signal from the ego's own yaw rate. There is no signal channel in the
 * scene description — this is what an ADAS log would carry, derived from the
 * path the ego actually takes, and it is what drives the HUD indicator.
 */
export function turnSignal(scene: Scene, frame: number): string {
  const track = scene.ego.track;
  const i = Math.min(frame, track.length - 1);
  // Look a second ahead: a driver signals before the wheel moves.
  const j = Math.min(i + scene.hz, track.length - 1);
  if (j === i) return "none";
  let delta = track[j].heading - track[i].heading;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  const rate = delta / ((j - i) / scene.hz);
  if (rate > 0.12) return "left";
  if (rate < -0.12) return "right";
  return "none";
}

/** Central difference of the speed profile, m/s². */
function acceleration(scene: Scene, frame: number): number {
  const track = scene.ego.track;
  const i = Math.min(frame, track.length - 1);
  const a = track[Math.max(0, i - 1)];
  const b = track[Math.min(track.length - 1, i + 1)];
  const dt = (b.t - a.t) || 1 / scene.hz;
  return round((b.speed_mps - a.speed_mps) / dt, 3);
}

/** Events at or before `t`, newest first — what the Events table shows. */
function eventNodes(events: SceneEvent[], t: number): XVIZTreeTableNode[] {
  const nodes: XVIZTreeTableNode[] = [];
  const seen = events.filter((e) => e.t <= t).reverse();
  seen.forEach((event, i) => {
    nodes.push({ id: i, column_values: [event.t.toFixed(1), event.class, event.severity, event.description] });
  });
  return nodes;
}

export interface FrameOptions {
  /** Scale on the simulated return count. 0 omits the lidar stream entirely. */
  lidarDensity?: number;
}

/**
 * One `xviz/state_update` message. `context` carries the per-scene work that is
 * the same for every frame; build it once with {@link sceneContext}.
 */
export function buildFrame(
  scene: Scene,
  sceneIndex: number,
  frame: number,
  context: SceneContext,
  options: FrameOptions = {},
): XVIZStateUpdate {
  const { lidarDensity = 1 } = options;
  const frames = frameCount(scene);
  const index = Math.min(Math.max(frame, 0), frames - 1);
  const timestamp = frameTime(scene.hz, sceneIndex, index);
  const ego = scene.ego.track[index];

  const shapes: XVIZPolygon[] = [];
  const labels: XVIZText[] = [];
  const centers = [];
  let tracked = 0;
  let nearest = Infinity;
  let nearestVru = Infinity;

  for (const actor of scene.actors) {
    const range = rangeAt(scene, actor, index);
    const detected = range <= scene.sensor.lidar_range_m;
    const classes: string[] = [];
    if (!detected) classes.push("missed");
    else if (VRU[actor.class]) classes.push("vru");

    if (detected) {
      tracked += 1;
      nearest = Math.min(nearest, range);
      if (VRU[actor.class]) nearestVru = Math.min(nearestVru, range);
    }

    const base = { object_id: actor.actor_id, classes };
    shapes.push({
      base: { ...base, style: { height: actor.height_m } },
      vertices: footprint(actor, index),
    });

    const pose = actor.track[Math.min(index, actor.track.length - 1)];
    centers.push({
      base,
      center: [round(pose.x, 2), round(pose.y, 2), round(actor.height_m / 2, 2)],
      radius: 0.35,
    });
    labels.push({
      base,
      position: [round(pose.x, 2), round(pose.y, 2), round(actor.height_m + LABEL_CLEARANCE_M, 2)],
      text: detected ? `${actor.actor_id}  ${range.toFixed(1)} m` : `${actor.actor_id}  not detected`,
    });
  }

  // Ego path behind and ahead. Both come from the same integrated track: the
  // "trajectory" is the plan the ego does in fact follow, which is what makes
  // the near-miss frames legible — the ribbon runs straight through the actor.
  const trailFrom = Math.max(0, index - TRAIL_S * scene.hz);
  const horizonTo = Math.min(frames - 1, index + TRAJECTORY_HORIZON_S * scene.hz);
  const path = (from: number, to: number): number[][] =>
    scene.ego.track.slice(from, to + 1).map((p) => [round(p.x, 2), round(p.y, 2), 0.05]);

  const polylines: XVIZPolyline[] = [{ vertices: path(index, horizonTo) }];
  const trail: XVIZPolyline[] = [{ vertices: path(trailFrom, index) }];

  const timeSeries: XVIZTimeSeriesEntry[] = [
    {
      timestamp,
      streams: [STREAMS.velocity, STREAMS.acceleration, STREAMS.nearestObject, STREAMS.vruRange],
      values: {
        doubles: [
          ego.speed_mps,
          acceleration(scene, index),
          Number.isFinite(nearest) ? round(nearest, 2) : scene.sensor.lidar_range_m,
          Number.isFinite(nearestVru) ? round(nearestVru, 2) : scene.sensor.lidar_range_m,
        ],
      },
    },
    { timestamp, streams: [STREAMS.trackedObjects], values: { int32s: [tracked] } },
    { timestamp, streams: [STREAMS.turnSignal], values: { strings: [turnSignal(scene, index)] } },
  ];

  const streamSet: XVIZStreamSet = {
    timestamp,
    poses: {
      [STREAMS.pose]: {
        timestamp,
        map_origin: { longitude: scene.origin.lon, latitude: scene.origin.lat, altitude: 0 },
        position: [ego.x, ego.y, 0],
        orientation: [0, 0, ego.heading],
      },
    },
    primitives: {
      [STREAMS.carriageway]: { polygons: [{ vertices: context.carriageway }] },
      [STREAMS.centerline]: { polylines: [{ vertices: context.centerline }] },
      [STREAMS.objectShape]: { polygons: shapes },
      [STREAMS.objectCenter]: { circles: centers },
      [STREAMS.objectLabel]: { texts: labels },
      [STREAMS.trajectory]: { polylines },
      [STREAMS.trail]: { polylines: trail },
    },
    time_series: timeSeries,
    ui_primitives: {
      [STREAMS.events]: {
        treetable: {
          columns: [
            { display_text: "t (s)", type: "string" },
            { display_text: "class", type: "string" },
            { display_text: "severity", type: "string" },
            { display_text: "description", type: "string" },
          ],
          nodes: eventNodes(scene.events, ego.t),
        },
      },
    },
  };

  if (lidarDensity > 0) {
    const points = scan(scene, index, context.scan, lidarDensity);
    streamSet.primitives![STREAMS.lidar] = {
      points: [
        {
          points: points.positions.map((v) => round(v, 2)),
          // RGBA, four channels per point: the viewer infers the colour format
          // from the buffer length and reads a three-channel buffer as RGBA.
          colors: rgba(points.colors),
        },
      ],
    };
  }

  return { update_type: "snapshot", updates: [streamSet] };
}

/**
 * Interleaved rgb, 0-255 floats → interleaved rgba, integers.
 *
 * Truncated rather than rounded, because the deck.gl scene viewer pushes the
 * same floats through a `Uint8Array`, which truncates. Rounding here would put
 * the two viewers a shade apart on half the returns for no reason.
 */
function rgba(rgb: number[]): number[] {
  const out = new Array<number>((rgb.length / 3) * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    out[j] = rgb[i] | 0;
    out[j + 1] = rgb[i + 1] | 0;
    out[j + 2] = rgb[i + 2] | 0;
    out[j + 3] = 255;
  }
  return out;
}

/**
 * Per-scene work that does not change between frames: the lidar scan's spatial
 * indexes, and the road geometry.
 *
 * The road is re-sent in every frame rather than published once as a
 * `persistent` update. Each frame then stands on its own, which is what the
 * seek path of the WebSocket transport wants — a client that jumps into the
 * middle of a log gets a complete picture from the first message it receives,
 * with no ordering requirement between transports. The cost is a few kB of
 * repeated centreline per frame, well under what one lidar scan carries.
 */
export function sceneContext(scene: Scene): SceneContext {
  return { scan: scanContext(scene), carriageway: carriageway(scene), centerline: centerline(scene) };
}

export interface SceneContext {
  scan: ScanContext;
  carriageway: number[][];
  centerline: number[][];
}

/**
 * The timings file `XVIZFileLoader` fetches first: one `[start, end, index,
 * name]` row per *data* frame. Frame files are 1-based with the metadata at
 * index 1, so row `i` here is served as file `i + 2`.
 */
export function buildTimings(scene: Scene, sceneIndex: number): { timing: [number, number, number, string][] } {
  const timing: [number, number, number, string][] = [];
  for (let i = 0; i < frameCount(scene); i += 1) {
    const t = frameTime(scene.hz, sceneIndex, i);
    timing.push([t, t, i, `${i + 2}-frame`]);
  }
  return { timing };
}
