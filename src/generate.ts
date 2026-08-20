import OpenAI from "openai";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";

export type Tool = Record<string, any>;

export interface Node {
  id: string;
  label?: string;
  domain?: string;
  description?: string;
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

export interface GraphConfig {
  title?: string;
  subtitle?: string;
  nodePrefixToRemove?: string;
  domains?: Record<string, string>;
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

export const llmConfig = {
  askLLM: async (prompt: string) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required for LLM refinement");
    }

    const openai = new OpenAI({
      apiKey,
      baseURL: process.env.OPENAI_BASE_URL,
    });

    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });
    let content = response.choices[0].message.content || "{}";
    content = content.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
    return JSON.parse(content);
  }
};

// The catalog path is the final CLI argument.
const CATALOG_PATH = process.argv.length > 2 ? process.argv[process.argv.length - 1] : undefined;
const OUT_PATH = "dependency_graph.json";

export function loadCatalog(path?: string): Tool[] {
  const targetPath = path || CATALOG_PATH;
  if (!targetPath) {
    throw new Error("Provide a tool catalog path as the first argument.");
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

const ENTITY_RULES: Record<string, { all: string[]; none?: string[] }> = {
  run_id: { all: ["WORKFLOW", "RUN"], none: ["CHECK", "RUNNER"] },
  job_id: { all: ["JOB"] },
  release_id: { all: ["RELEASE"], none: ["ASSET"] },
  deployment_id: { all: ["DEPLOYMENT"], none: ["STATUS"] },
  column_id: { all: ["COLUMN"], none: ["CARD"] },
  card_id: { all: ["CARD"] },
  review_id: { all: ["REVIEW"], none: ["COMMENT"] },
};

function producerMatchesEntity(slug: string, requiredInput: string): boolean {
  const rule = ENTITY_RULES[requiredInput.toLowerCase()];
  if (!rule) return true;

  const upper = slug.toUpperCase();
  return rule.all.every((token) => upper.includes(token)) &&
    !(rule.none ?? []).some((token) => upper.includes(token));
}

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
            if (!producerMatchesEntity(producer.slug, requiredInput)) {
              continue;
            }

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

export function detectAndRemoveCycles(nodes: Node[], edges: Edge[]): Edge[] {
  const adj = new Map<string, Array<{ to: string; edge: Edge }>>();
  for (const n of nodes) {
    adj.set(n.id, []);
  }
  for (const e of edges) {
    adj.get(e.from)?.push({ to: e.to, edge: e });
  }

  const visited = new Set<string>();
  const recStack = new Set<string>();
  const edgesToRemove = new Set<Edge>();

  function dfs(u: string) {
    visited.add(u);
    recStack.add(u);

    const neighbors = adj.get(u) || [];
    for (const { to, edge } of neighbors) {
      if (!visited.has(to)) {
        dfs(to);
      } else if (recStack.has(to)) {
        edgesToRemove.add(edge);
      }
    }

    recStack.delete(u);
  }

  for (const n of nodes) {
    if (!visited.has(n.id)) {
      dfs(n.id);
    }
  }

  if (edgesToRemove.size > 0) {
    console.warn(`[Cycle Detection] Removed ${edgesToRemove.size} back edges to produce a DAG.`);
  }

  return edges.filter(e => !edgesToRemove.has(e));
}

async function generate(tools: Tool[]): Promise<Graph> {
  const parsedTools = parseToolCatalog(tools);
  const nodes: Node[] = parsedTools.map(t => ({ id: t.slug }));
  const heuristicEdges = inferHeuristicEdges(parsedTools);
  const refinedEdges = await refineEdgesWithLLM(parsedTools, heuristicEdges);
  const edges = detectAndRemoveCycles(nodes, refinedEdges);
  return { nodes, edges };
}

export function writeVisualizationHTML(nodes: Node[], edges: Edge[], path: string = "visualization.html"): void {
  const graphConfig: GraphConfig = {
    title: "Tool Dependency Graph",
    subtitle: "Interactive visualization of API tool dependencies",
    nodePrefixToRemove: "GITHUB_",
    domains: {
      Issues: "#f59e0b",
      PullRequests: "#10b981",
      Repositories: "#3b82f6",
      Organizations: "#8b5cf6",
      Projects: "#ec4899",
      Actions: "#ef4444",
      General: "#6b7280",
    },
    nodes,
    edges,
  };

  const htmlTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Tool Dependency Graph Visualizer</title>
    <script type="text/javascript" src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
    <style type="text/css">
        body {
            margin: 0;
            padding: 0;
            background-color: #0b0f19;
            color: #f3f4f6;
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            overflow: hidden;
        }
        #header {
            position: absolute;
            top: 20px;
            left: 20px;
            z-index: 10;
            background: rgba(17, 24, 39, 0.75);
            backdrop-filter: blur(12px);
            border: 1px solid rgba(255, 255, 255, 0.08);
            padding: 15px 25px;
            border-radius: 12px;
            box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);
        }
        h1 {
            margin: 0 0 5px 0;
            font-size: 20px;
            font-weight: 600;
            letter-spacing: -0.5px;
            background: linear-gradient(135deg, #60a5fa, #3b82f6);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        p {
            margin: 0;
            font-size: 12px;
            color: #9ca3af;
        }
        #network {
            width: 100vw;
            height: 100vh;
        }
        #search-results {
            display: none;
            position: absolute;
            top: 100%;
            left: 0;
            width: 100%;
            max-height: 200px;
            overflow-y: auto;
            background: rgba(17, 24, 39, 0.95);
            backdrop-filter: blur(12px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 8px;
            margin-top: 5px;
            padding: 5px 0;
            list-style: none;
            z-index: 100;
            box-shadow: 0 10px 25px rgba(0,0,0,0.5);
        }
        #search-results li {
            padding: 8px 12px;
            font-size: 11px;
            color: #d1d5db;
            cursor: pointer;
            text-align: left;
            transition: background 0.15s, color 0.15s;
        }
        #search-results li:hover {
            background: rgba(59, 130, 246, 0.8);
            color: white;
        }
        #search-results::-webkit-scrollbar {
            width: 6px;
        }
        #search-results::-webkit-scrollbar-track {
            background: rgba(0, 0, 0, 0.1);
        }
        #search-results::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.2);
            border-radius: 3px;
        }
    </style>
</head>
<body>
    <div id="header">
        <h1>Tool Dependency Graph</h1>
        <p>Interactive visualization of API tool dependencies</p>
        <p id="stats"></p>
        <div style="margin-top: 10px; display: flex; gap: 8px; position: relative;">
            <div style="position: relative;">
                <input type="text" id="search-input" placeholder="Search tool (e.g. issue)" style="background: rgba(31, 41, 55, 0.8); border: 1px solid rgba(255,255,255,0.1); color: white; padding: 6px 12px; border-radius: 6px; font-size: 12px; width: 180px; outline: none;" autocomplete="off" />
                <ul id="search-results"></ul>
            </div>
            <button onclick="searchNode()" style="background: #3b82f6; border: none; color: white; padding: 6px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; font-weight: 500;">Search</button>
        </div>
        <div style="margin-top: 10px;">
            <label for="graph-file-input" style="display: inline-block; font-size: 11px; color: #d1d5db; margin-bottom: 4px;">Load graph JSON</label>
            <input type="file" id="graph-file-input" accept=".json,application/json" style="display: block; width: 100%; font-size: 11px; color: #d1d5db;" />
        </div>
        <div style="margin-top: 15px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 12px;">
            <p style="font-weight: 600; font-size: 11px; margin-bottom: 8px; color: #e5e7eb; text-align: left;">Domain Legend</p>
            <div id="legend-items" style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; font-size: 10px; text-align: left;">
            </div>
        </div>
    </div>
    <div id="network"></div>
    <script type="text/javascript">
        const defaultGraphConfig = __GRAPH_CONFIG_JSON__;
        const defaultColorPalette = defaultGraphConfig.domains || {};
        let network = null;
        let nodeData = null;
        let edgeData = null;
        let currentGraphConfig = defaultGraphConfig;
        let currentNodes = [];
        let currentEdges = [];
        let labeledEdgeIds = [];
        let currentSearchQuery = "";
        let currentSearchMatches = [];
        let currentSearchIndex = 0;

        const searchInput = document.getElementById('search-input');
        const resultsList = document.getElementById('search-results');
        const titleEl = document.querySelector('#header h1');
        const subtitleEl = document.querySelector('#header p');
        const statsEl = document.getElementById('stats');
        const legendItemsEl = document.getElementById('legend-items');
        const fileInput = document.getElementById('graph-file-input');

        function normalizeSearchValue(value) {
            return String(value || '')
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '_')
                .replace(/^_+|_+$/g, '');
        }

        function prettifyDomainName(domain) {
            return String(domain || '')
                .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
                .replace(/_/g, ' ')
                .trim() || 'General';
        }

        function hashColor(input) {
            let hash = 0;
            const text = String(input || 'General');
            for (let i = 0; i < text.length; i += 1) {
                hash = ((hash << 5) - hash) + text.charCodeAt(i);
                hash |= 0;
            }
            const hue = Math.abs(hash) % 360;
            return \`hsl(\${hue} 65% 55%)\`;
        }

        function getPalette(config) {
            return Object.assign({}, defaultColorPalette, config.domains || {});
        }

        function getNodeLabel(node, config) {
            if (node.label) return node.label;
            const prefix = config.nodePrefixToRemove || '';
            return prefix && node.id.startsWith(prefix) ? node.id.slice(prefix.length) : node.id;
        }

        function inferToolDomain(node) {
            const upper = String(node.id || '').toUpperCase();
            if (upper.includes("PROJECT")) return "Projects";
            if (upper.includes("WORKFLOW") || upper.includes("ACTION") || upper.includes("RUN")) return "Actions";
            if (upper.includes("ISSUE") || upper.includes("COMMENT")) return "Issues";
            if (upper.includes("PULL") || upper.includes("PR") || upper.includes("MERGE")) return "PullRequests";
            if (upper.includes("TEAM") || upper.includes("ORG") || upper.includes("MEMBER")) return "Organizations";
            if (upper.includes("REPO") || upper.includes("REPOSITORY") || upper.includes("MIGRAT")) return "Repositories";
            return "General";
        }

        function getNodeDomain(node) {
            return node.domain || inferToolDomain(node);
        }

        function getNodeColor(domain, palette) {
            return palette[domain] || hashColor(domain);
        }

        function getNodeSearchBlob(node, config) {
            return [
                node.id,
                getNodeLabel(node, config),
                node.description || '',
                getNodeDomain(node),
            ].map(normalizeSearchValue).join(' ');
        }

        function updateStats(extra) {
            const summary = \`Nodes: \${currentNodes.length} | Edges: \${currentEdges.length}\`;
            statsEl.innerText = extra ? \`\${summary} | \${extra}\` : summary;
        }

        function renderLegend(config) {
            const palette = getPalette(config);
            const seen = new Set();
            const domainsInGraph = currentNodes.map(getNodeDomain).filter(Boolean);
            const orderedDomains = [
                ...Object.keys(palette),
                ...domainsInGraph,
            ].filter((domain) => {
                if (seen.has(domain)) return false;
                seen.add(domain);
                return domainsInGraph.includes(domain) || domain === 'General';
            });

            legendItemsEl.innerHTML = orderedDomains.map((domain) => {
                const color = getNodeColor(domain, palette);
                const label = prettifyDomainName(domain);
                return \`<div style="display: flex; align-items: center; gap: 6px; color: #d1d5db;">
                    <span style="display: inline-block; width: 8px; height: 8px; background: \${color}; border-radius: 2px;"></span> \${label}
                </div>\`;
            }).join('');
        }

        function clearDependencyLabels() {
            if (!edgeData || labeledEdgeIds.length === 0) return;
            edgeData.update(labeledEdgeIds.map((id) => ({ id, label: undefined })));
            labeledEdgeIds = [];
        }

        function showDependencyLabels(nodeId) {
            if (!network || !edgeData) return;
            clearDependencyLabels();
            labeledEdgeIds = network.getConnectedEdges(nodeId);
            edgeData.update(labeledEdgeIds.map((id) => {
                const edge = edgeData.get(id);
                return {
                    id,
                    label: edge.dependencyLabel,
                    font: { color: '#d1d5db', size: 10, align: 'top', strokeWidth: 3, strokeColor: '#0b0f19' }
                };
            }));
        }

        function focusNode(node, meta) {
            if (!network) return;
            network.selectNodes([node.id]);
            showDependencyLabels(node.id);
            network.focus(node.id, {
                scale: 1.2,
                animation: {
                    duration: 1000,
                    easingFunction: 'easeInOutQuad'
                }
            });
            updateStats(meta || \`Focused: \${getNodeLabel(node, currentGraphConfig)}\`);
        }

        function renderSearchResults(matches) {
            resultsList.innerHTML = '';
            if (matches.length === 0) {
                resultsList.style.display = 'none';
                return;
            }

            matches.slice(0, 8).forEach((match) => {
                const li = document.createElement('li');
                li.textContent = getNodeLabel(match, currentGraphConfig);
                li.onclick = () => {
                    searchInput.value = getNodeLabel(match, currentGraphConfig);
                    resultsList.style.display = 'none';
                    focusNode(match);
                };
                resultsList.appendChild(li);
            });
            resultsList.style.display = 'block';
        }

        function getSearchMatches(rawQuery) {
            const normalizedQuery = normalizeSearchValue(rawQuery);
            if (!normalizedQuery) return [];
            const queryTokens = normalizedQuery.split('_').filter(Boolean);
            return currentNodes.filter((node) => {
                const haystack = getNodeSearchBlob(node, currentGraphConfig);
                return queryTokens.every((token) => haystack.includes(token));
            });
        }

        function normalizeGraphConfig(input) {
            const baseConfig = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
            const normalizedNodes = Array.isArray(baseConfig.nodes) ? baseConfig.nodes : [];
            const normalizedEdges = Array.isArray(baseConfig.edges) ? baseConfig.edges : [];

            return {
                title: typeof baseConfig.title === 'string' && baseConfig.title.trim() ? baseConfig.title : defaultGraphConfig.title,
                subtitle: typeof baseConfig.subtitle === 'string' && baseConfig.subtitle.trim() ? baseConfig.subtitle : defaultGraphConfig.subtitle,
                nodePrefixToRemove: typeof baseConfig.nodePrefixToRemove === 'string' ? baseConfig.nodePrefixToRemove : defaultGraphConfig.nodePrefixToRemove,
                domains: baseConfig.domains && typeof baseConfig.domains === 'object' ? baseConfig.domains : defaultGraphConfig.domains,
                nodes: normalizedNodes,
                edges: normalizedEdges,
            };
        }

        function renderGraph(nextConfig) {
            currentGraphConfig = normalizeGraphConfig(nextConfig);
            currentNodes = currentGraphConfig.nodes;
            currentEdges = currentGraphConfig.edges;
            currentSearchQuery = '';
            currentSearchMatches = [];
            currentSearchIndex = 0;
            searchInput.value = '';
            resultsList.style.display = 'none';
            clearDependencyLabels();

            titleEl.innerText = currentGraphConfig.title || 'Dependency Graph';
            subtitleEl.innerText = currentGraphConfig.subtitle || 'Interactive visualization';
            updateStats();
            renderLegend(currentGraphConfig);

            const palette = getPalette(currentGraphConfig);
            const connectedNodeIds = new Set(currentEdges.flatMap((edge) => [edge.from, edge.to]));
            const isolatedNodes = currentNodes.filter((node) => !connectedNodeIds.has(node.id));
            const isolatedPositions = new Map();
            const ringCount = 3;
            const nodesPerRing = Math.max(1, Math.ceil(isolatedNodes.length / ringCount));

            isolatedNodes.forEach((node, index) => {
                const ring = index % ringCount;
                const positionInRing = Math.floor(index / ringCount);
                const angle = (positionInRing / nodesPerRing) * Math.PI * 2 + ring * 0.08;
                const radius = 3400 + ring * 650;
                isolatedPositions.set(node.id, {
                    x: Math.cos(angle) * radius,
                    y: Math.sin(angle) * radius
                });
            });

            const visNodes = currentNodes.map((node) => {
                const domain = getNodeDomain(node);
                const isolatedPosition = isolatedPositions.get(node.id);
                return {
                    id: node.id,
                    label: getNodeLabel(node, currentGraphConfig),
                    title: node.description || node.id,
                    color: {
                        background: '#1f2937',
                        border: getNodeColor(domain, palette),
                        highlight: {
                            background: '#374151',
                            border: '#ffffff'
                        }
                    },
                    font: { color: '#f3f4f6', size: 12 },
                    borderWidth: 2,
                    shape: 'box',
                    ...(isolatedPosition ? {
                        x: isolatedPosition.x,
                        y: isolatedPosition.y,
                        physics: false
                    } : {})
                };
            });

            const visEdges = currentEdges.map((edge, index) => ({
                id: index,
                from: edge.from,
                to: edge.to,
                dependencyLabel: edge.label || '',
                arrows: 'to',
                color: { color: 'rgba(75, 85, 99, 0.28)', highlight: '#3b82f6' },
                width: 0.7,
                hoverWidth: 1.5,
                selectionWidth: 2,
                title: edge.label || '',
                smooth: { type: 'continuous', roundness: 0.15 }
            }));

            if (network) {
                network.destroy();
            }

            nodeData = new vis.DataSet(visNodes);
            edgeData = new vis.DataSet(visEdges);
            network = new vis.Network(document.getElementById('network'), { nodes: nodeData, edges: edgeData }, {
                physics: {
                    stabilization: {
                        enabled: true,
                        iterations: 250,
                        updateInterval: 25
                    },
                    barnesHut: {
                        gravitationalConstant: -12000,
                        centralGravity: 0.15,
                        springLength: 240,
                        springConstant: 0.02,
                        damping: 0.45,
                        avoidOverlap: 0.25
                    }
                },
                interaction: {
                    hover: true,
                    tooltipDelay: 200,
                    dragNodes: true,
                    dragView: true,
                    zoomView: true,
                    hideEdgesOnDrag: false
                }
            });

            let layoutReady = false;
            function finishLayout() {
                if (layoutReady || !network) return;
                layoutReady = true;
                network.setOptions({ physics: false });
                network.redraw();
            }

            network.fit({ animation: false });
            network.once('stabilized', finishLayout);
            setTimeout(finishLayout, 5000);
            network.on('selectNode', (params) => showDependencyLabels(params.nodes[0]));
            network.on('deselectNode', () => clearDependencyLabels());
        }

        searchInput.addEventListener('input', () => {
            const query = searchInput.value.trim();
            if (!query) {
                resultsList.style.display = 'none';
                return;
            }
            renderSearchResults(getSearchMatches(query));
        });

        document.addEventListener('click', (e) => {
            if (!document.getElementById('header').contains(e.target)) {
                resultsList.style.display = 'none';
            }
        });

        function searchNode() {
            const query = searchInput.value.trim();
            if (!query) return;
            resultsList.style.display = 'none';
            const normalizedQuery = normalizeSearchValue(query);
            const exactMatch = currentNodes.find((node) => {
                const exactCandidates = [
                    normalizeSearchValue(node.id),
                    normalizeSearchValue(getNodeLabel(node, currentGraphConfig)),
                ];
                return exactCandidates.includes(normalizedQuery);
            });
            if (exactMatch) {
                focusNode(exactMatch);
                return;
            }

            if (normalizedQuery !== currentSearchQuery) {
                currentSearchQuery = normalizedQuery;
                currentSearchMatches = getSearchMatches(query);
                currentSearchIndex = 0;
            }

            if (currentSearchMatches.length > 0) {
                const match = currentSearchMatches[currentSearchIndex];
                focusNode(match, \`Match \${currentSearchIndex + 1} of \${currentSearchMatches.length}\`);
                currentSearchIndex = (currentSearchIndex + 1) % currentSearchMatches.length;
            } else {
                updateStats('No matches found');
            }
        }

        searchInput.addEventListener('keypress', function (e) {
            if (e.key === 'Enter') {
                searchNode();
            }
        });

        fileInput.addEventListener('change', async (event) => {
            const file = event.target.files && event.target.files[0];
            if (!file) return;

            try {
                const text = await file.text();
                const parsed = JSON.parse(text);
                const parsedConfig = parsed && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)
                    ? parsed
                    : parsed && parsed.graphConfig && Array.isArray(parsed.graphConfig.nodes) && Array.isArray(parsed.graphConfig.edges)
                        ? parsed.graphConfig
                        : null;

                if (!parsedConfig) {
                    throw new Error('Expected JSON with top-level nodes/edges or graphConfig.nodes/graphConfig.edges.');
                }

                renderGraph(parsedConfig);
                updateStats(\`Loaded: \${file.name}\`);
            } catch (error) {
                const message = error && error.message ? error.message : 'Unable to load JSON graph file.';
                updateStats(message);
                console.error(error);
            } finally {
                event.target.value = '';
            }
        });

        renderGraph(defaultGraphConfig);
    </script>
</body>
</html>`;

  const finalHtml = htmlTemplate
    .replace("__GRAPH_CONFIG_JSON__", JSON.stringify(graphConfig));

  writeFileSync(path, finalHtml, "utf-8");
}

async function main() {
  if (!CATALOG_PATH) {
    console.error("Usage: npm run generate -- path/to/tool_catalog.json");
    process.exitCode = 1;
    return;
  }
  const graph = await generate(loadCatalog());
  writeFileSync(OUT_PATH, JSON.stringify(graph, null, 2), "utf-8");
  console.error(
    `wrote ${graph.nodes.length} nodes, ${graph.edges.length} edges to ${OUT_PATH}`,
  );
  
  const visPath = "visualization.html";
  writeVisualizationHTML(graph.nodes, graph.edges, visPath);
  console.error(`wrote interactive visualizer to ${visPath}`);
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
