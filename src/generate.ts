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

export const llmConfig = {
  askLLM: async (prompt: string) => {
    const response = await openai.chat.completions.create({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });
    return JSON.parse(response.choices[0].message.content || "{}");
  }
};

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
  "username",
  "branch",
  "email",
  "title",
  "body",
  "name",
  "description",
  "path",
  "ref",
  "message",
  "content",
  "url",
  "id",
  "number",
  "base",
  "head",
  "tag_name",
  "tag",
  "type",
  "login",
  "org",
  "key",
  "value",
  "visibility",
  "package_type",
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

export function getToolDomain(slug: string): string {
  const upper = slug.toUpperCase();
  if (upper.includes("PROJECT")) return "Projects";
  if (upper.includes("WORKFLOW") || upper.includes("ACTION") || upper.includes("RUN")) return "Actions";
  if (upper.includes("ISSUE") || upper.includes("COMMENT")) return "Issues";
  if (upper.includes("PULL") || upper.includes("PR") || upper.includes("MERGE")) return "PullRequests";
  if (upper.includes("TEAM") || upper.includes("ORG") || upper.includes("MEMBER")) return "Organizations";
  if (upper.includes("REPO") || upper.includes("REPOSITORY") || upper.includes("MIGRAT")) return "Repositories";
  return "General";
}

export const PRODUCER_KEYWORDS = ["GET", "LIST", "CREATE", "START", "QUEUE", "SEARCH", "FIND"];
export const SUB_ENTITIES = ["COMMENT", "EVENT", "REACTION", "REVIEW", "ALERT", "COMMIT", "FILE"];

export function inferHeuristicEdges(tools: ToolMetadata[]): Edge[] {
  const edges: Edge[] = [];

  for (const consumer of tools) {
    const consumerDomain = getToolDomain(consumer.slug);

    for (const requiredInput of consumer.requiredInputs) {
      if (isStaticParameter(requiredInput)) {
        continue;
      }

      for (const producer of tools) {
        if (producer.slug === consumer.slug) {
          continue;
        }

        // Constraint 1: Must belong to the same domain
        const producerDomain = getToolDomain(producer.slug);
        if (producerDomain !== consumerDomain) {
          continue;
        }

        // Constraint 2: Producer must be a source/getter/creator
        const prodUpper = producer.slug.toUpperCase();
        const isSource = PRODUCER_KEYWORDS.some(kw => prodUpper.includes(kw));
        if (!isSource) {
          continue;
        }

        // Rule 1: Exact case-insensitive match after stripping underscores
        const normalizedInput = requiredInput.toLowerCase().replace(/_/g, "");
        
        let matchedLabel: string | null = null;
        for (const outputName of Object.keys(producer.outputProperties)) {
          if (isStaticParameter(outputName)) {
            continue;
          }
          const normalizedOutput = outputName.toLowerCase().replace(/_/g, "");
          if (normalizedInput === normalizedOutput) {
            matchedLabel = requiredInput;
            break;
          }
        }

        // Rule 2: Context-aware mapping (e.g. matching generic 'number'/'id' if domain matches)
        if (!matchedLabel) {
          const isNumOrId = requiredInput.endsWith("_number") || requiredInput.endsWith("_id");
          if (isNumOrId) {
            const entityKeyword = requiredInput.split("_")[0].toUpperCase();
            
            let hasGenericOutput = false;
            if (requiredInput.endsWith("_number")) {
              hasGenericOutput = !!producer.outputProperties.number;
            } else if (requiredInput.endsWith("_id")) {
              hasGenericOutput = !!(producer.outputProperties.id || producer.outputProperties.node_id);
            }

            // Constraint 3: Strict sub-entity check (e.g. comment tools don't produce issue_number)
            let subEntityConflict = false;
            for (const sub of SUB_ENTITIES) {
              if (prodUpper.includes(sub) && !requiredInput.toUpperCase().includes(sub)) {
                subEntityConflict = true;
                break;
              }
            }

            const keywordMatches = prodUpper.includes(entityKeyword) || 
                                   (entityKeyword === "PULL" && prodUpper.includes("PULL_REQUEST"));

            if (hasGenericOutput && keywordMatches && !subEntityConflict) {
              matchedLabel = requiredInput;
            }
          }
        }

        if (matchedLabel) {
          edges.push({
            from: producer.slug,
            to: consumer.slug,
            label: requiredInput,
          });
        }
      }
    }
  }

  return edges;
}

export async function refineEdgesWithLLM(tools: ToolMetadata[], edges: Edge[]): Promise<Edge[]> {
  if (!process.env.OPENAI_API_KEY) {
    console.warn("OPENAI_API_KEY is not set. Skipping LLM refinement and returning heuristic edges.");
    return edges;
  }

  const requiredInputs = new Set<string>();
  for (const t of tools) {
    for (const input of t.requiredInputs) {
      if (!isStaticParameter(input)) {
        requiredInputs.add(input);
      }
    }
  }

  if (requiredInputs.size === 0) {
    return edges;
  }

  const candidateProducers = tools.filter(t => {
    const isSource = PRODUCER_KEYWORDS.some(kw => t.slug.toUpperCase().includes(kw));
    const hasOutputs = Object.keys(t.outputProperties).length > 0;
    return isSource && hasOutputs;
  });

  const producerSummaries = candidateProducers.map(t => {
    const outputsStr = Object.keys(t.outputProperties).join(", ");
    return `- ${t.slug}: ${t.description} (Outputs: [${outputsStr}])`;
  }).join("\n");

  const prompt = `You are building a tool dependency graph.
The toolkit has the following required dynamic input parameters that must be resolved at runtime:
[${Array.from(requiredInputs).join(", ")}]

Below is a list of candidate producer tools, their descriptions, and the properties they output:
${producerSummaries}

For each required parameter, identify the specific tools (from the list above) that are the correct producers/sources for it.
A producer/source is a tool that creates, retrieves, lists, or searches the corresponding entity. 
Avoid matching tools that modify, delete, or perform auxiliary actions on the entity (e.g., for "issue_number", do NOT match a comment-creation tool or event-listing tool, only match issue-creation or issue-fetching/listing tools).

Return a JSON object mapping each required parameter to an array of valid producer slugs. Output ONLY raw JSON matching this format:
{
  "parameter_name": ["PRODUCER_SLUG_1", "PRODUCER_SLUG_2"]
}
`;

  try {
    const mapping = await llmConfig.askLLM(prompt);
    
    const refinedEdges: Edge[] = [];
    for (const edge of edges) {
      const allowedProducers = mapping[edge.label || ""];
      if (allowedProducers && Array.isArray(allowedProducers)) {
        if (allowedProducers.includes(edge.from)) {
          refinedEdges.push(edge);
        }
      } else {
        refinedEdges.push(edge);
      }
    }
    return refinedEdges;
  } catch (error) {
    console.error("LLM Refinement failed, falling back to heuristic edges:", error);
    return edges;
  }
}

async function generate(tools: Tool[]): Promise<Graph> {
  const parsedTools = parseToolCatalog(tools);
  const nodes: Node[] = parsedTools.map(t => ({ id: t.slug }));
  const heuristicEdges = inferHeuristicEdges(parsedTools);
  const edges = await refineEdgesWithLLM(parsedTools, heuristicEdges);
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
