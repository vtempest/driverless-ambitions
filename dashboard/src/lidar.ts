/**
 * Server-side lidar simulation for the demo scenes.
 *
 * `public/scenes.js` casts the same rays in the browser, because the deck.gl
 * scene viewer only ever receives the scene *description* from /api/scenes/:id
 * and cannot afford to download a point cloud per frame. The XVIZ log served to
 * streetscape.gl is the opposite arrangement: XVIZ frames are produced by the
 * server, so the scan has to happen here.
 *
 * The two implementations are therefore deliberate duplicates, and
 * `test/lidar.test.ts` pins them together — it loads `public/scenes.js` in a
 * sandbox and asserts this port returns the identical scan for a given scene
 * and frame. Change one, and that test tells you to change the other.
 *
 * Cost is bounded by construction: a scan is `RINGS * azimuths` rays against
 * the handful of boxes within reach, and the XVIZ routes generate exactly one
 * frame per request, which keeps a request inside the Workers CPU budget.
 */
import type { Scene, SceneActor } from "./scenes";

const SENSOR_HEIGHT_M = 1.8;
const RINGS = 32;
/** Elevation sweep of the simulated scanner, radians. */
const ELEVATION = { from: (-24 * Math.PI) / 180, to: (2.5 * Math.PI) / 180 };

/** Point colours, matched to the deck.gl viewer so the two look like one sensor. */
export const LIDAR_COLOR = {
  road: [96, 110, 126],
  verge: [122, 104, 74],
  hit: [235, 176, 60],
} as const;

/** An oriented box with its rotation and bounding sphere precomputed. */
export interface Box {
  x: number;
  y: number;
  z: number;
  hl: number;
  hw: number;
  hh: number;
  heading: number;
  cos: number;
  sin: number;
  r2: number;
  radius: number;
  post?: boolean;
}

/** Deterministic PRNG, so a frame always scans the same way. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bound(hl: number, hw: number, hh: number): { r2: number; radius: number } {
  const r2 = hl * hl + hw * hw + hh * hh;
  return { r2, radius: Math.sqrt(r2) };
}

/** Oriented box for one actor at a frame, in world metres. */
export function actorBox(actor: SceneActor, frame: number): Box {
  const pose = actor.track[Math.min(frame, actor.track.length - 1)];
  return {
    x: pose.x,
    y: pose.y,
    z: actor.height_m / 2,
    hl: actor.length_m / 2,
    hw: actor.width_m / 2,
    hh: actor.height_m / 2,
    heading: pose.heading,
    cos: Math.cos(-pose.heading),
    sin: Math.sin(-pose.heading),
    ...bound(actor.length_m / 2, actor.width_m / 2, actor.height_m / 2),
  };
}

/** Delineator posts down the outer verge — static targets that make the road read as a road. */
export function vergePosts(scene: Scene): Box[] {
  const out: Box[] = [];
  const line = scene.road.centerline;
  const edge = (scene.road.lanes * scene.road.lane_width_m) / 2 + 1.2;
  for (let i = 4; i < line.length - 1; i += 4) {
    const a = line[i];
    const b = line[i + 1];
    const h = Math.atan2(b.y - a.y, b.x - a.x);
    for (const side of [edge, -edge]) {
      out.push({
        x: a.x - Math.sin(h) * side,
        y: a.y + Math.cos(h) * side,
        z: 0.5,
        hl: 0.06,
        hw: 0.06,
        hh: 0.5,
        heading: h,
        cos: Math.cos(-h),
        sin: Math.sin(-h),
        ...bound(0.06, 0.06, 0.5),
        post: true,
      });
    }
  }
  return out;
}

/**
 * Slab test: nearest positive hit of a ray against an oriented box, or
 * Infinity. Written out per axis rather than looping over arrays — this runs a
 * few hundred thousand times per frame, and the allocations a loop needs cost
 * more than the arithmetic does.
 */
export function rayBox(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  box: Pick<Box, "x" | "y" | "z" | "hl" | "hw" | "hh" | "heading"> & Partial<Pick<Box, "cos" | "sin">>,
): number {
  const c = box.cos !== undefined ? box.cos : Math.cos(-box.heading);
  const s = box.sin !== undefined ? box.sin : Math.sin(-box.heading);
  // Into the box's frame.
  const ex = ox - box.x;
  const ey = oy - box.y;
  const px = ex * c - ey * s;
  const py = ex * s + ey * c;
  const pz = oz - box.z;
  const vx = dx * c - dy * s;
  const vy = dx * s + dy * c;

  let near = -Infinity;
  let far = Infinity;
  let t1: number;
  let t2: number;
  let swap: number;

  if (vx > -1e-9 && vx < 1e-9) {
    if (px < -box.hl || px > box.hl) return Infinity;
  } else {
    t1 = (-box.hl - px) / vx;
    t2 = (box.hl - px) / vx;
    if (t1 > t2) { swap = t1; t1 = t2; t2 = swap; }
    if (t1 > near) near = t1;
    if (t2 < far) far = t2;
    if (near > far) return Infinity;
  }

  if (vy > -1e-9 && vy < 1e-9) {
    if (py < -box.hw || py > box.hw) return Infinity;
  } else {
    t1 = (-box.hw - py) / vy;
    t2 = (box.hw - py) / vy;
    if (t1 > t2) { swap = t1; t1 = t2; t2 = swap; }
    if (t1 > near) near = t1;
    if (t2 < far) far = t2;
    if (near > far) return Infinity;
  }

  if (dz > -1e-9 && dz < 1e-9) {
    if (pz < -box.hh || pz > box.hh) return Infinity;
  } else {
    t1 = (-box.hh - pz) / dz;
    t2 = (box.hh - pz) / dz;
    if (t1 > t2) { swap = t1; t1 = t2; t2 = swap; }
    if (t1 > near) near = t1;
    if (t2 < far) far = t2;
    if (near > far) return Infinity;
  }

  return near > 0 ? near : Infinity;
}

const CELL_M = 8;
const cellKey = (x: number, y: number): string => Math.floor(x / CELL_M) + ":" + Math.floor(y / CELL_M);

/**
 * Bucket centreline vertices into an 8 m grid, registering each into its own
 * cell and the eight around it. A return then only has to test the handful of
 * vertices in its own cell, rather than scanning the whole centreline.
 */
function roadIndex(scene: Scene): Map<string, number[]> {
  const index = new Map<string, number[]>();
  const line = scene.road.centerline;
  for (let i = 0; i < line.length; i += 1) {
    const cx = Math.floor(line[i].x / CELL_M);
    const cy = Math.floor(line[i].y / CELL_M);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const key = cx + dx + ":" + (cy + dy);
        let bucket = index.get(key);
        if (!bucket) index.set(key, (bucket = []));
        bucket.push(i);
      }
    }
  }
  return index;
}

/**
 * Signed distance from the road centreline, using the nearest sampled vertex.
 * Returns Infinity well away from the road, which reads as verge.
 */
export function offsetFromRoad(scene: Scene, x: number, y: number, index: Map<string, number[]>): number {
  const line = scene.road.centerline;
  const bucket = index.get(cellKey(x, y));
  if (!bucket) return Infinity;
  let best = Infinity;
  let idx = -1;
  for (let k = 0; k < bucket.length; k += 1) {
    const i = bucket[k];
    const d = (line[i].x - x) ** 2 + (line[i].y - y) ** 2;
    if (d < best) { best = d; idx = i; }
  }
  if (idx < 0) return Infinity;
  const a = line[Math.max(0, idx - 1)];
  const b = line[Math.min(line.length - 1, idx + 1)];
  const h = Math.atan2(b.y - a.y, b.x - a.x);
  return -Math.sin(h) * (x - line[idx].x) + Math.cos(h) * (y - line[idx].y);
}

/** One simulated scan: interleaved xyz metres and per-point rgb, 0-255. */
export interface Scan {
  positions: number[];
  colors: number[];
  count: number;
}

/** Reusable per-scene geometry, so a multi-frame render builds it once. */
export interface ScanContext {
  posts: Box[];
  road: Map<string, number[]>;
}

export function scanContext(scene: Scene): ScanContext {
  return { posts: vergePosts(scene), road: roadIndex(scene) };
}

/**
 * Simulate one scan. Rays sweep elevation in rings and azimuth around the ego,
 * and stop at the nearest of the ground plane, an actor or a post.
 *
 * `density` scales the azimuth count: the XVIZ log ships every return as JSON,
 * so the routes turn it down from what the browser-side viewer draws.
 */
export function scan(scene: Scene, frame: number, context: ScanContext, density = 1): Scan {
  const ego = scene.ego.track[Math.min(frame, scene.ego.track.length - 1)];
  const range = scene.sensor.lidar_range_m;
  const reach = (range + 12) ** 2;
  const boxes = scene.actors
    .map((a) => actorBox(a, frame))
    .concat(context.posts)
    .filter((b) => (b.x - ego.x) ** 2 + (b.y - ego.y) ** 2 <= reach);
  const azimuths = Math.max(24, Math.round((scene.sensor.lidar_points_per_frame * density) / RINGS));
  const rnd = mulberry32(scene.seed + frame * 7919);
  const halfRoad = (scene.road.lanes * scene.road.lane_width_m) / 2;

  const positions: number[] = [];
  const colors: number[] = [];
  const oz = SENSOR_HEIGHT_M;
  for (let r = 0; r < RINGS; r += 1) {
    const elev = ELEVATION.from + ((ELEVATION.to - ELEVATION.from) * r) / (RINGS - 1);
    const dz = Math.sin(elev);
    const horizontal = Math.cos(elev);
    for (let a = 0; a < azimuths; a += 1) {
      // Jitter the azimuth so rings do not moiré into visible spokes.
      const az = ((a + rnd() * 0.6) / azimuths) * Math.PI * 2;
      const dx = Math.cos(az) * horizontal;
      const dy = Math.sin(az) * horizontal;

      let t = dz < -1e-6 ? oz / -dz : Infinity;
      let kind = "ground";
      for (let i = 0; i < boxes.length; i += 1) {
        const b = boxes[i];
        // Reject against the bounding sphere first: a handful of flops rather
        // than the full slab test, and most rays miss most boxes.
        const wx = b.x - ego.x;
        const wy = b.y - ego.y;
        const wz = b.z - oz;
        const proj = wx * dx + wy * dy + wz * dz;
        if (proj <= 0 || proj - b.radius > t) continue;
        if (wx * wx + wy * wy + wz * wz - proj * proj > b.r2) continue;
        const hit = rayBox(ego.x, ego.y, oz, dx, dy, dz, b);
        if (hit < t) { t = hit; kind = b.post ? "post" : "actor"; }
      }
      if (!isFinite(t) || t > range) continue;
      // Returns thin out with range, and rain and fog drop them outright.
      if (rnd() > 1 - (t / range) * 0.55) continue;

      const noise = scene.sensor.noise_m * (rnd() + rnd() + rnd() - 1.5);
      const d = t + noise;
      const x = ego.x + dx * d;
      const y = ego.y + dy * d;
      const z = Math.max(0, oz + dz * d);
      positions.push(x, y, z);

      let color: readonly number[] = LIDAR_COLOR.hit;
      if (kind === "ground") {
        color = Math.abs(offsetFromRoad(scene, x, y, context.road)) <= halfRoad ? LIDAR_COLOR.road : LIDAR_COLOR.verge;
      }
      const shade = 1 - (t / range) * 0.45;
      colors.push(color[0] * shade, color[1] * shade, color[2] * shade);
    }
  }
  return { positions, colors, count: positions.length / 3 };
}
