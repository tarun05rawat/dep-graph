/**
 * Runs ToolGraph against the included sample catalog and reports structural and
 * provenance metrics. Usage: `npm run selfcheck`.
 */
import { readFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";

const CATALOG = "github_catalog.json";
const OUT = "dependency_graph.json";

if (!existsSync(CATALOG)) {
  console.error(`Missing sample catalog: ${CATALOG}`);
  process.exit(1);
}

// Exercise the same CLI entry point used for normal graph generation.
execFileSync("node", ["--import", "tsx", "src/generate.ts", CATALOG], {
  stdio: "inherit",
});

const raw = JSON.parse(readFileSync(CATALOG, "utf-8"));
const tools = Array.isArray(raw) ? raw : (raw.tools ?? []);
const slugs = new Set<string>(
  tools
    .map((t: any) => String(t.slug ?? t.name ?? t.function?.name ?? "").toUpperCase())
    .filter(Boolean),
);

const g = JSON.parse(readFileSync(OUT, "utf-8"));
const nodes = g.nodes ?? [];
const edges = g.edges ?? [];
const inCatalog = nodes.filter((n: any) => slugs.has(String(n.id).toUpperCase())).length;
const provenance = nodes.length ? inCatalog / nodes.length : 0;

console.log(
  JSON.stringify(
    {
      nodes: nodes.length,
      edges: edges.length,
      provenance_ratio: Number(provenance.toFixed(3)),
      labeled_edges: edges.filter((e: any) => e.label).length,
    },
    null,
    2,
  ),
);

if (provenance < 0.8) {
  console.error(
    "WARNING: provenance < 0.8. Node IDs should originate from the source catalog.",
  );
}
if (edges.length === 0) {
  console.error("WARNING: no dependency edges were generated.");
}
