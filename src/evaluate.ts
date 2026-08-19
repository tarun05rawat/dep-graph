import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import {
  inferHeuristicEdges,
  loadCatalog,
  parseToolCatalog,
  type Edge,
} from "./generate.js";

export interface LabeledEdgeCase extends Edge {
  expected: boolean;
  reason: string;
}

export interface EvaluationMetrics {
  total: number;
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
}

function edgeKey(edge: Edge): string {
  return `${edge.from}\u0000${edge.to}\u0000${edge.label ?? ""}`;
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

export function calculateMetrics(
  cases: LabeledEdgeCase[],
  predictedEdges: Edge[],
): EvaluationMetrics {
  const predictions = new Set(predictedEdges.map(edgeKey));
  let truePositives = 0;
  let falsePositives = 0;
  let trueNegatives = 0;
  let falseNegatives = 0;

  for (const testCase of cases) {
    const predicted = predictions.has(edgeKey(testCase));
    if (testCase.expected && predicted) truePositives += 1;
    if (!testCase.expected && predicted) falsePositives += 1;
    if (!testCase.expected && !predicted) trueNegatives += 1;
    if (testCase.expected && !predicted) falseNegatives += 1;
  }

  const precision = truePositives / Math.max(1, truePositives + falsePositives);
  const recall = truePositives / Math.max(1, truePositives + falseNegatives);
  const f1 = (2 * precision * recall) / Math.max(Number.EPSILON, precision + recall);
  const accuracy = (truePositives + trueNegatives) / Math.max(1, cases.length);

  return {
    total: cases.length,
    truePositives,
    falsePositives,
    trueNegatives,
    falseNegatives,
    precision: round(precision),
    recall: round(recall),
    f1: round(f1),
    accuracy: round(accuracy),
  };
}

function loadCases(path: string): LabeledEdgeCase[] {
  if (!existsSync(path)) {
    throw new Error(`Missing labeled evaluation set: ${path}`);
  }

  const cases = JSON.parse(readFileSync(path, "utf-8")) as LabeledEdgeCase[];
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error("The labeled evaluation set must contain at least one case.");
  }
  return cases;
}

function validateCases(cases: LabeledEdgeCase[], catalogPath: string): void {
  const tools = parseToolCatalog(loadCatalog(catalogPath));
  const bySlug = new Map(tools.map((tool) => [tool.slug, tool]));

  for (const testCase of cases) {
    const producer = bySlug.get(testCase.from);
    const consumer = bySlug.get(testCase.to);
    if (!producer) throw new Error(`Unknown producer in evaluation set: ${testCase.from}`);
    if (!consumer) throw new Error(`Unknown consumer in evaluation set: ${testCase.to}`);
    if (!testCase.label || !consumer.requiredInputs.includes(testCase.label)) {
      throw new Error(
        `${testCase.to} does not require labeled input '${testCase.label ?? ""}'.`,
      );
    }
  }
}

function deterministicEdges(catalogPath: string): Edge[] {
  const tools = parseToolCatalog(loadCatalog(catalogPath));
  // Evaluate dependency classification before cycle removal. DAG conversion is a
  // separate structural pass that can intentionally prune otherwise valid edges.
  return inferHeuristicEdges(tools);
}

function printFailures(cases: LabeledEdgeCase[], predictedEdges: Edge[]): void {
  const predictions = new Set(predictedEdges.map(edgeKey));
  const failures = cases.filter(
    (testCase) => predictions.has(edgeKey(testCase)) !== testCase.expected,
  );

  if (failures.length === 0) return;
  console.log("\nMisclassified labeled cases:");
  for (const failure of failures) {
    const predicted = predictions.has(edgeKey(failure));
    console.log(
      `- expected=${failure.expected} predicted=${predicted} ${failure.from} -> ${failure.to} [${failure.label}]`,
    );
  }
}

async function main(): Promise<void> {
  const catalogPath = process.argv[2] || "github_catalog.json";
  const casesPath = process.argv[3] || "evaluation/labeled_edges.json";
  const cases = loadCases(casesPath);
  validateCases(cases, catalogPath);
  const predictedEdges = deterministicEdges(catalogPath);
  const metrics = calculateMetrics(cases, predictedEdges);

  console.log(JSON.stringify(metrics, null, 2));
  printFailures(cases, predictedEdges);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
