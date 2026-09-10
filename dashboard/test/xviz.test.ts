import { test } from "node:test";
import assert from "node:assert/strict";
import { SCENE_IDS, buildScene } from "../src/scenes";
import {
  LOG_EPOCH_S,
  STREAMS,
  buildFrame,
  buildMetadata,
  buildTimings,
  frameCount,
  frameTime,
  sceneContext,
  turnSignal,
} from "../src/xviz/log";

const scene = buildScene("thimphu_junction")!;
const context = sceneContext(scene);
const frame = (i: number, density = 0.35) => buildFrame(scene, 0, i, context, { lidarDensity: density });

test("metadata declares every stream the frames actually carry", () => {
  const metadata = buildMetadata(scene, 0);
  assert.equal(metadata.version, "2.0.0");

  const update = frame(30).updates[0];
  const used = new Set<string>([
    ...Object.keys(update.poses),
    ...Object.keys(update.primitives ?? {}),
    ...Object.keys(update.ui_primitives ?? {}),
    ...(update.time_series ?? []).flatMap((entry) => entry.streams),
  ]);
  for (const name of used) {
    assert.ok(metadata.streams[name], `${name} is sent but not declared in metadata`);
  }
  // And nothing is declared that never appears — a stream with no data shows up
  // in the settings panel as a permanently empty toggle.
  for (const name of Object.keys(metadata.streams)) {
    assert.ok(used.has(name), `${name} is declared but never sent`);
  }
});

test("every declarative-UI panel references a declared stream", () => {
  const metadata = buildMetadata(scene, 0);
  for (const panel of Object.values(metadata.ui_config!)) {
    for (const child of panel.children ?? []) {
      for (const name of child.streams ?? []) {
        assert.ok(metadata.streams[name], `panel "${child.title}" charts undeclared stream ${name}`);
      }
      if (child.stream) assert.ok(metadata.streams[child.stream], `panel "${child.title}" reads undeclared ${child.stream}`);
    }
  }
});

test("log_info spans exactly the frames that exist", () => {
  for (let index = 0; index < SCENE_IDS.length; index += 1) {
    const s = buildScene(SCENE_IDS[index])!;
    const metadata = buildMetadata(s, index);
    assert.equal(metadata.log_info.start_time, frameTime(s.hz, index, 0));
    assert.equal(metadata.log_info.end_time, frameTime(s.hz, index, frameCount(s) - 1));
    // Logs are anchored to a real date, not to zero: a zero-based XVIZ log
    // renders as 1 January 1970 on the playback control.
    assert.ok(metadata.log_info.start_time >= LOG_EPOCH_S);
    // Distinct logs never overlap on the clock.
    if (index > 0) {
      const previous = buildScene(SCENE_IDS[index - 1])!;
      assert.ok(metadata.log_info.start_time > buildMetadata(previous, index - 1).log_info.end_time);
    }
  }
});

test("the timings index lines up with the frame files that serve it", () => {
  const timings = buildTimings(scene, 0);
  assert.equal(timings.timing.length, frameCount(scene));
  // XVIZFileLoader loads getFilePath(0) as metadata and then timing.length more
  // files, so data frame i is file i + 2.
  assert.deepEqual(timings.timing[0], [frameTime(scene.hz, 0, 0), frameTime(scene.hz, 0, 0), 0, "2-frame"]);
  const last = timings.timing[timings.timing.length - 1];
  assert.equal(last[2], frameCount(scene) - 1);
  assert.equal(last[3], `${frameCount(scene) + 1}-frame`);
});

test("a frame carries a pose, geometry and one time-series sample per stream", () => {
  const update = frame(60).updates[0];
  const pose = update.poses[STREAMS.pose];
  assert.equal(pose.timestamp, update.timestamp);
  assert.deepEqual(pose.map_origin, { longitude: scene.origin.lon, latitude: scene.origin.lat, altitude: 0 });
  assert.equal(pose.position[0], scene.ego.track[60].x);
  assert.equal(pose.orientation[2], scene.ego.track[60].heading);

  const primitives = update.primitives!;
  assert.equal(primitives[STREAMS.objectShape].polygons!.length, scene.actors.length);
  assert.ok(primitives[STREAMS.carriageway].polygons![0].vertices.length > 3);
  assert.ok(primitives[STREAMS.lidar].points![0].points.length > 0);

  // Every time series carries one value per named stream at this timestamp.
  for (const entry of update.time_series!) {
    const values = entry.values.doubles ?? entry.values.int32s ?? entry.values.strings!;
    assert.equal(values.length, entry.streams.length, `${entry.streams} sent ${values.length} values`);
    assert.equal(entry.timestamp, update.timestamp);
  }
});

test("the point cloud is rgba, four channels for every xyz", () => {
  const cloud = frame(40).updates[0].primitives![STREAMS.lidar].points![0];
  assert.equal(cloud.points.length % 3, 0);
  const count = cloud.points.length / 3;
  // Three channels per point would be read back as RGBA by the viewer and
  // shear the colours; four is what makes the format unambiguous.
  assert.equal(cloud.colors.length, count * 4);
  for (let i = 3; i < cloud.colors.length; i += 4) assert.equal(cloud.colors[i], 255);
  for (const c of cloud.colors) assert.ok(Number.isInteger(c) && c >= 0 && c <= 255);
});

test("lidar density scales the cloud and zero drops the stream", () => {
  const dense = frame(40, 1).updates[0].primitives![STREAMS.lidar].points![0].points.length;
  const sparse = frame(40, 0.35).updates[0].primitives![STREAMS.lidar].points![0].points.length;
  assert.ok(sparse < dense);
  assert.equal(frame(40, 0).updates[0].primitives![STREAMS.lidar], undefined);
});

test("actors outside the sensor envelope are marked missed, not dropped", () => {
  const fog = buildScene("night_fog_pass")!;
  const update = buildFrame(fog, 3, 0, sceneContext(fog), { lidarDensity: 0 }).updates[0];
  const shapes = update.primitives![STREAMS.objectShape].polygons!;
  assert.equal(shapes.length, fog.actors.length, "an undetected actor still gets a ghost box");

  const missed = shapes.filter((s) => s.base!.classes!.includes("missed"));
  assert.ok(missed.length > 0, "nothing was out of range at the start of the fog scene");

  const tracked = update.time_series!.find((e) => e.streams.includes(STREAMS.trackedObjects))!;
  assert.equal(tracked.values.int32s![0], shapes.length - missed.length);

  // The label says so too, so the state is readable without the legend.
  const labels = update.primitives![STREAMS.objectLabel].texts!;
  const ghost = labels.find((l) => l.base!.classes!.includes("missed"))!;
  assert.match(ghost.text, /not detected/);
});

test("the events table fills as playback reaches each event", () => {
  const rows = (i: number) =>
    buildFrame(scene, 0, i, context, { lidarDensity: 0 }).updates[0].ui_primitives![STREAMS.events].treetable!.nodes;
  assert.equal(rows(0).length, 0);
  const first = scene.events[0];
  assert.equal(rows(Math.round(first.t * scene.hz) - 1).length, 0);
  assert.equal(rows(Math.round(first.t * scene.hz)).length, 1);
  assert.equal(rows(frameCount(scene) - 1).length, scene.events.length);
  // Newest first, so the row that just appeared is the one on screen.
  assert.equal(rows(frameCount(scene) - 1)[0].column_values![3], scene.events[scene.events.length - 1].description);
});

test("the turn signal follows the ego's own path", () => {
  const hairpin = buildScene("dochula_switchback")!;
  const signals = new Set<string>();
  for (let i = 0; i < frameCount(hairpin); i += 1) signals.add(turnSignal(hairpin, i));
  // The hairpin turns hard left, so the indicator has to come on somewhere.
  assert.ok(signals.has("left"), `the hairpin never signalled: ${[...signals]}`);
  assert.ok(signals.has("none"));
  // A near-straight scene should not be flashing its indicator throughout.
  const straight = buildScene("night_fog_pass")!;
  const on = Array.from({ length: frameCount(straight) }, (_, i) => turnSignal(straight, i)).filter((s) => s !== "none");
  assert.ok(on.length < frameCount(straight) / 4, `${on.length} frames signalled on a straight road`);
});

test("frames are reproducible and clamped at both ends", () => {
  assert.deepEqual(frame(12), frame(12));
  const last = frameCount(scene) - 1;
  assert.deepEqual(buildFrame(scene, 0, last + 50, context), buildFrame(scene, 0, last, context));
  assert.deepEqual(buildFrame(scene, 0, -5, context), buildFrame(scene, 0, 0, context));
});

test("every scene encodes without a gap in its frames", () => {
  for (let index = 0; index < SCENE_IDS.length; index += 1) {
    const s = buildScene(SCENE_IDS[index])!;
    const ctx = sceneContext(s);
    let previous = -Infinity;
    for (let i = 0; i < frameCount(s); i += 1) {
      const update = buildFrame(s, index, i, ctx, { lidarDensity: 0 }).updates[0];
      assert.ok(update.timestamp > previous, `${SCENE_IDS[index]} frame ${i} went backwards`);
      previous = update.timestamp;
      assert.ok(update.poses[STREAMS.pose], `${SCENE_IDS[index]} frame ${i} has no pose`);
    }
  }
});
