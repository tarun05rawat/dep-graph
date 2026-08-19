import OpenAI from "openai";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";

export type Tool = Record<string, any>;

export interface Node {
  id: string;
  service?: string;
}

export interface Edge {
  from: string;
  to: string;
  label?: string;
}

export interface Graph {
  nodes: Node[];
  edges: Edge[];
}

export interface ToolMetadata {
  slug: string;
  description: string;
  requiredInputs: string[];
  inputProperties: Record<string, { type: string; description?: string }>;
  outputProperties: Record<string, { type: string; description?: string }>;
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});

export async function askLLM(prompt: string) {
  const response = await openai.chat.completions.create({
    model: "openai/gpt-4o",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  });
  return JSON.parse(response.choices[0].message.content || "{}");
}

// The catalog path is the last CLI argument
const CATALOG_PATH = process.argv.length > 2 ? process.argv[process.argv.length - 1] : undefined;
const OUT_PATH = "dependency_graph.json";

export function loadCatalog(path?: string): Tool[] {
  const targetPath = path || CATALOG_PATH;
  if (!targetPath) {
    throw new Error("pass the toolkit catalog path as the first argument");
  }
  const data = JSON.parse(readFileSync(targetPath, "utf-8"));
  return Array.isArray(data) ? data : (data.tools ?? data.items ?? []);
}

export function slugOf(tool: Tool): string | undefined {
  return tool.slug ?? tool.name ?? tool.function?.name;
}

export function resolveSchemaProperties(
  schema: any,
  defs: Record<string, any>,
  visited: Set<string> = new Set(),
  result: Record<string, { type: string; description?: string }> = {}
): Record<string, { type: string; description?: string }> {
  if (!schema) return result;

  if (schema.$ref) {
    const refName = schema.$ref.replace("#/$defs/", "");
    if (visited.has(refName)) return result;
    visited.add(refName);
    const resolvedSchema = defs[refName];
    if (resolvedSchema) {
      resolveSchemaProperties(resolvedSchema, defs, visited, result);
    }
    visited.delete(refName);
    return result;
  }

  if (schema.type === "object" && schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      const prop = propSchema as any;
      if (prop.type && prop.type !== "object" && prop.type !== "array") {
        result[key] = {
          type: prop.type,
          description: prop.description,
        };
      }
      resolveSchemaProperties(prop, defs, visited, result);
    }
  } else if (schema.type === "array" && schema.items) {
    resolveSchemaProperties(schema.items, defs, visited, result);
  }

  return result;
}



export const STATIC_PARAMETERS = new Set([
  "owner",
  "repo",
  "page",
  "per_page",
  "limit",
  "cursor",
  "sort",
  "direction",
  "state",
]);

export function isStaticParameter(name: string): boolean {
  return STATIC_PARAMETERS.has(name.toLowerCase());
}

export function parseTool(tool: Tool): ToolMetadata {
  const slug = slugOf(tool) || "";
  const description = tool.description || "";

  const inputSchema = tool.inputParameters || {};
  const requiredInputs = inputSchema.required || [];
  const inputProperties: Record<string, { type: string; description?: string }> = {};

  if (inputSchema.properties) {
    for (const [key, val] of Object.entries(inputSchema.properties)) {
      const prop = val as any;
      inputProperties[key] = {
        type: prop.type || "string",
        description: prop.description,
      };
    }
  }

  const outputSchema = tool.outputParameters || {};
  const defs = outputSchema.$defs || {};
  const outputProperties = resolveSchemaProperties(outputSchema, defs);

  return {
    slug,
    description,
    requiredInputs,
    inputProperties,
    outputProperties,
  };
}

export function parseToolCatalog(tools: Tool[]): ToolMetadata[] {
  return tools.map(parseTool);
}

async function generate(tools: Tool[]): Promise<Graph> {
  const nodes: Node[] = tools
    .map(slugOf)
    .filter((s): s is string => !!s)
    .map((id) => ({ id }));
  const edges: Edge[] = [];
  return { nodes, edges };
}

async function main() {
  if (!CATALOG_PATH) {
    return;
  }
  const graph = await generate(loadCatalog());
  writeFileSync(OUT_PATH, JSON.stringify(graph, null, 2), "utf-8");
  console.error(
    `wrote ${graph.nodes.length} nodes, ${graph.edges.length} edges to ${OUT_PATH}`,
  );
}

const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith("generate.ts") ||
  process.argv[1].endsWith("generate")
);

if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
