import assert from "node:assert/strict";
import test from "node:test";
import { chunks, percentile, stableKey } from "../src/utils.js";
import { operationCost } from "../src/google.js";

test("chunks preserves all values", () => {
  assert.deepEqual(chunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test("percentile interpolates and handles empty input", () => {
  assert.equal(percentile([], 0.5), 0);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([10, 20, 30], 0.9), 28);
});

test("stable cache keys are deterministic", () => {
  assert.equal(stableKey("x", { a: 1 }), stableKey("x", { a: 1 }));
  assert.notEqual(stableKey("x", { a: 1 }), stableKey("x", { a: 2 }));
});

test("2026 YouTube quota buckets are classified", () => {
  assert.deepEqual(operationCost("search", "list"), { bucket: "search", cost: 1 });
  assert.deepEqual(operationCost("videos", "insert"), { bucket: "upload", cost: 1 });
  assert.deepEqual(operationCost("videos", "list"), { bucket: "data", cost: 1 });
  assert.deepEqual(operationCost("captions", "update"), { bucket: "data", cost: 450 });
});
