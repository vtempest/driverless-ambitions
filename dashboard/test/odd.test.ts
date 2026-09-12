import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  PRESET_VISIBILITY,
  geometryForRouteClass,
  lightingClassOf,
  presetsFor,
  routeClassOf,
  routeClasses,
  timesFor,
  timesForPreset,
  visibilityClassOf,
} from "../src/odd";

const libraryPath = fileURLToPath(new URL("../../toolkit/scenarios/library.json", import.meta.url));
const library = JSON.parse(readFileSync(libraryPath, "utf8")) as {
  taxonomy_version: string;
  scenarios: Array<{ id: string; params: Record<string, number | string>; visibility_class: string; lighting_class: string; route_class: string }>;
};

/**
 * The classification tables here are a port of bhutan_sim/weather.py and
 * ScenarioParameters.route_class. The generated library is the Python's own
 * output, so every template in it has to classify the same way.
 */
test("every template in the toolkit library classifies the same way in TypeScript", () => {
  assert.ok(library.scenarios.length >= 100, "library fixture looks empty");
  for (const s of library.scenarios) {
    const preset = String(s.params.weather_preset);
    const time = String(s.params.time_of_day);
    assert.equal(visibilityClassOf(preset), s.visibility_class, `${s.id}: ${preset}`);
    assert.equal(lightingClassOf(time), s.lighting_class, `${s.id}: ${time}`);
    assert.equal(routeClassOf(Number(s.params.road_curvature), Number(s.params.grade_pct)), s.route_class, s.id);
  }
});

test("the library only uses presets the table knows, and the table stays a superset", () => {
  const used = new Set(library.scenarios.map((s) => String(s.params.weather_preset)));
  for (const preset of used) assert.ok(preset in PRESET_VISIBILITY, `preset ${preset} is missing from PRESET_VISIBILITY`);
  // dust_haze is declared by no family yet, but weather.py scores it as dust.
  assert.equal(visibilityClassOf("dust_haze"), "dust");
  assert.ok(!used.has("dust_haze"));
});

test("presets that encode a sun position are only offered at the matching time of day", () => {
  assert.deepEqual(timesForPreset("clear_night"), ["night"]);
  assert.deepEqual(timesForPreset("low_sun"), ["dawn", "dusk"]);
  assert.deepEqual(timesForPreset("heavy_rain"), ["dawn", "day", "dusk", "night"]);
  for (const preset of Object.keys(PRESET_VISIBILITY)) {
    for (const time of timesForPreset(preset)) {
      assert.ok(["dawn", "day", "dusk", "night"].includes(time), `${preset} offers ${time}`);
    }
  }
});

test("a cell resolves to the presets that render it, the most specific first", () => {
  // clear_night encodes darkness; clear_day merely tolerates it.
  assert.equal(presetsFor("clear", "night")[0], "clear_night");
  assert.deepEqual(presetsFor("clear", "daylight"), ["clear_day", "overcast"]);
  assert.equal(presetsFor("wet", "night")[0], "wet_night");
  assert.deepEqual(presetsFor("heavy_rain", "night"), ["heavy_rain", "monsoon_storm"]);
  assert.deepEqual(presetsFor("fog", "low_light"), ["dense_fog", "valley_fog"]);
  // Low sun is a low-light condition only.
  assert.ok(presetsFor("clear", "low_light").includes("low_sun"));
  assert.ok(!presetsFor("clear", "daylight").includes("low_sun"));
});

test("no preset renders snow, which is what makes that cell a driving job", () => {
  assert.deepEqual(presetsFor("snow", "daylight"), []);
  assert.deepEqual(presetsFor("snow", "night"), []);
});

test("every preset a cell offers has a time of day inside that cell", () => {
  for (const visibility of ["clear", "wet", "rain", "heavy_rain", "fog", "dust"]) {
    for (const lighting of ["daylight", "low_light", "night"]) {
      for (const preset of presetsFor(visibility, lighting)) {
        const times = timesFor(preset, lighting);
        assert.ok(times.length > 0, `${preset} in ${visibility}/${lighting}`);
        for (const time of times) {
          assert.equal(lightingClassOf(time), lighting);
          assert.equal(visibilityClassOf(preset), visibility);
        }
      }
    }
  }
});

test("route geometry round-trips: the curvature and grade for a class classify back to it", () => {
  for (const routeClass of routeClasses()) {
    const geometry = geometryForRouteClass(routeClass);
    assert.ok(geometry, routeClass);
    assert.equal(routeClassOf(geometry!.road_curvature, geometry!.grade_pct), routeClass);
  }
  assert.equal(geometryForRouteClass("not_a_class"), null);
  assert.equal(geometryForRouteClass("hairpin_unlabelled"), null);
});

test("the route classes the plan can target are the nine the toolkit describes", () => {
  assert.equal(routeClasses().length, 9);
  const fromLibrary = new Set(library.scenarios.map((s) => s.route_class));
  for (const routeClass of fromLibrary) assert.ok(routeClasses().includes(routeClass), routeClass);
});
