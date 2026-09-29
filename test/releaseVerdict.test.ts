import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVerdict } from "../src/mappers/releaseVerdict.js";

const f = (priority: "P1" | "P2" | "P3") => ({ priority });

test("buildVerdict: worst priority present decides the tier", () => {
  assert.equal(buildVerdict([f("P3"), f("P1"), f("P2")]), "BLOCKED");
  assert.equal(buildVerdict([f("P3"), f("P2")]), "CONDITIONAL");
  assert.equal(buildVerdict([f("P3")]), "ADVISORY");
  assert.equal(buildVerdict([]), "CLEAR");
});
