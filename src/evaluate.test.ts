import assert from "node:assert";
import { describe, test } from "node:test";
import { calculateMetrics, type LabeledEdgeCase } from "./evaluate.js";

describe("Labeled edge evaluation", () => {
  test("calculates precision, recall, F1, and accuracy", () => {
    const cases: LabeledEdgeCase[] = [
      { from: "A", to: "B", label: "id", expected: true, reason: "positive" },
      { from: "A", to: "C", label: "id", expected: true, reason: "missed positive" },
      { from: "D", to: "B", label: "id", expected: false, reason: "false positive" },
      { from: "D", to: "C", label: "id", expected: false, reason: "negative" },
    ];

    const metrics = calculateMetrics(cases, [
      { from: "A", to: "B", label: "id" },
      { from: "D", to: "B", label: "id" },
    ]);

    assert.deepStrictEqual(metrics, {
      total: 4,
      truePositives: 1,
      falsePositives: 1,
      trueNegatives: 1,
      falseNegatives: 1,
      precision: 0.5,
      recall: 0.5,
      f1: 0.5,
      accuracy: 0.5,
    });
  });
});
