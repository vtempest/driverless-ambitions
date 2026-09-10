import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { buildScene } from "../src/scenes";
import { rayBox, scan, scanContext, vergePosts } from "../src/lidar";

/**
 * `src/lidar.ts` is a port of the ray caster in `public/scenes.js`: one runs in
 * the Worker to build XVIZ frames, the other in the browser to draw the deck.gl
 * scene viewer. They must stay identical, so this test loads the browser copy
 * in a sandbox and compares the two scans return for return.
 */
function loadViewer() {
  const code = readFileSync(new URL("../public/scenes.js", import.meta.url), "utf8");
  const sandbox: Record<string, unknown> = {
    window: {},
    document: { querySelector: () => null },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return (sandbox.window as { AtlasScenes: any }).AtlasScenes.__test;
}

const browser = loadViewer();

test("the ported slab test agrees with the browser one", () => {
  const box = { x: 10, y: 0, z: 1, hl: 2, hw: 1, hh: 1, heading: 0 };
  assert.equal(rayBox(0, 0, 1, 1, 0, 0, box), browser.rayBox(0, 0, 1, 1, 0, 0, box));
  assert.equal(rayBox(0, 0, 1, 1, 0, 0, box), 8);
  assert.equal(rayBox(0, 0, 1, -1, 0, 0, box), Infinity);
  const turned = { ...box, heading: Math.PI / 2 };
  assert.equal(rayBox(0, 0, 1, 1, 0, 0, turned), browser.rayBox(0, 0, 1, 1, 0, 0, turned));
});

test("verge posts are placed identically", () => {
  const scene = buildScene("dochula_switchback")!;
  const mine = vergePosts(scene);
  const theirs = browser.posts(scene);
  assert.equal(mine.length, theirs.length);
  assert.ok(mine.length > 0);
  for (let i = 0; i < mine.length; i += 1) {
    assert.equal(mine[i].x, theirs[i].x);
    assert.equal(mine[i].y, theirs[i].y);
  }
});

test("the server-side scan reproduces the browser scan exactly", () => {
  for (const id of ["thimphu_junction", "night_fog_pass"]) {
    const scene = buildScene(id)! as any;
    scene.postCache = browser.posts(scene);
    const context = scanContext(scene);

    for (const frame of [0, 60, 140]) {
      const mine = scan(scene, frame, context);
      const theirs = browser.scan(scene, frame);
      assert.equal(mine.count, theirs.count, `${id} frame ${frame} returned a different number of points`);
      assert.ok(mine.count > 0, `${id} frame ${frame} returned nothing`);
      // The browser keeps its scan in a Float32Array and a Uint8Array; this
      // port stays in float64 and narrows only when a frame is encoded. Compare
      // through the same narrowing, so the test is about the ray casting rather
      // than about storage width.
      for (let i = 0; i < mine.positions.length; i += 1) {
        assert.equal(Math.fround(mine.positions[i]), theirs.positions[i], `${id} frame ${frame} position ${i}`);
      }
      for (let i = 0; i < mine.colors.length; i += 1) {
        assert.equal(mine.colors[i] | 0, theirs.colors[i], `${id} frame ${frame} colour ${i}`);
      }
    }
  }
});

test("the sensor model thins the scan in fog", () => {
  const clear = buildScene("thimphu_junction")!;
  const fog = buildScene("night_fog_pass")!;
  const clearCount = scan(clear, 80, scanContext(clear)).count;
  const fogCount = scan(fog, 80, scanContext(fog)).count;
  assert.ok(fogCount < clearCount / 2, `fog returned ${fogCount} points against ${clearCount} in the clear scene`);
});

test("density scales the return count without changing the scene", () => {
  const scene = buildScene("monsoon_descent")!;
  const context = scanContext(scene);
  const full = scan(scene, 50, context, 1).count;
  const third = scan(scene, 50, context, 0.35).count;
  assert.ok(third < full, `${third} was not fewer than ${full}`);
  assert.ok(third > full / 6, `${third} is too few against ${full}`);
  // Still deterministic at a reduced density.
  assert.equal(scan(scene, 50, context, 0.35).count, third);
});
