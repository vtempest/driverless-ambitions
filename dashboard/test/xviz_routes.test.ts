import { test } from "node:test";
import assert from "node:assert/strict";
import type { RouteContext } from "../src/router";
import { SCENE_IDS, buildScene } from "../src/scenes";
import { frameCount } from "../src/xviz/log";
import { getLogFile, listLogs } from "../src/routes/xviz";
import { HttpError } from "../src/util";

/** These handlers touch neither D1 nor R2, so a request and a URL is the whole context. */
function context(path: string, params: Record<string, string>): RouteContext {
  const url = new URL(`https://atlas.example${path}`);
  return { request: new Request(url), env: {} as never, ctx: {} as never, params, url };
}

const file = (id: string, name: string, profile?: string) =>
  getLogFile(context(`/api/xviz/logs/${id}/${profile ? `${profile}/` : ""}${name}`, profile ? { id, profile, file: name } : { id, file: name }));

test("the log catalog hands out URLs the loaders can use as they are", async () => {
  const body = (await listLogs(context("/api/xviz/logs", {})).json()) as { logs: Record<string, string>[] };
  assert.equal(body.logs.length, SCENE_IDS.length);
  const first = body.logs[0];
  assert.equal(first.log_id, SCENE_IDS[0]);
  assert.equal(first.timings_url, `https://atlas.example/api/xviz/logs/${SCENE_IDS[0]}/0-frame.json`);
  assert.match(first.frame_url_template, /\{profile\}\/\{index\}-frame\.json$/);
  // The socket URL has to switch scheme, keeping TLS, or a browser on an
  // https page refuses the upgrade as mixed content.
  assert.equal(first.socket_url, `wss://atlas.example/api/xviz/ws?log=${SCENE_IDS[0]}`);
});

test("file 0 is the timings index, file 1 the metadata, file n>=2 a frame", async () => {
  const id = SCENE_IDS[0];
  const scene = buildScene(id)!;

  const timings = (await file(id, "0-frame.json").json()) as { timing: unknown[] };
  assert.equal(timings.timing.length, frameCount(scene));

  const metadata = (await file(id, "1-frame.json").json()) as { type: string; data: { version: string } };
  assert.equal(metadata.type, "xviz/metadata");
  assert.equal(metadata.data.version, "2.0.0");

  const first = (await file(id, "2-frame.json").json()) as { type: string; data: { updates: { timestamp: number }[] } };
  assert.equal(first.type, "xviz/state_update");
  assert.equal(first.data.updates[0].timestamp, timings.timing[0][0]);

  // The last row of the timings index has to name a file that exists.
  const lastName = (timings.timing[timings.timing.length - 1] as [number, number, number, string])[3];
  const last = (await file(id, `${lastName}.json`).json()) as { data: { updates: { timestamp: number }[] } };
  assert.equal(last.data.updates[0].timestamp, (timings.timing[timings.timing.length - 1] as number[])[1]);
});

test("frames are served immutable so a replay comes from the edge cache", () => {
  const response = file(SCENE_IDS[0], "60-frame.json");
  assert.match(response.headers.get("cache-control") || "", /immutable/);
});

test("the lidar profile selects a density and 0 drops the point cloud", async () => {
  const id = SCENE_IDS[0];
  const points = async (profile?: string) => {
    const body = (await file(id, "60-frame.json", profile).json()) as {
      data: { updates: { primitives: Record<string, { points?: { points: number[] }[] }> }[] };
    };
    return body.data.updates[0].primitives["/lidar/points"]?.points?.[0].points.length ?? 0;
  };
  const dense = await points("lidar-1");
  assert.ok(dense > (await points()), "the default is not turned down from a full scan");
  assert.ok((await points()) > 0);
  assert.equal(await points("lidar-0"), 0);
});

test("bad ids, frames and profiles are rejected rather than guessed at", () => {
  assert.throws(() => file("no-such-scene", "1-frame.json"), (e: HttpError) => e.status === 404);
  assert.throws(() => file(SCENE_IDS[0], "index.html"), (e: HttpError) => e.status === 404);
  assert.throws(() => file(SCENE_IDS[0], "99999-frame.json"), (e: HttpError) => e.status === 404);
  assert.throws(() => file(SCENE_IDS[0], "2-frame.json", "sparse"), (e: HttpError) => e.status === 404);
  assert.throws(() => file(SCENE_IDS[0], "2-frame.json", "lidar-4"), (e: HttpError) => e.status === 400);
});
