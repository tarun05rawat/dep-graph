import { test, describe } from "node:test";
import assert from "node:assert";
import { parseTool, Tool, isStaticParameter, inferHeuristicEdges, ToolMetadata, getToolDomain } from "./generate.js";

describe("Tool Catalog Parser", () => {
  test("extracts slug, description, and required parameters", () => {
    const mockTool: Tool = {
      slug: "TEST_TOOL",
      description: "A tool to test parsing",
      inputParameters: {
        type: "object",
        properties: {
          param1: { type: "string", description: "Parameter one" },
          param2: { type: "integer" }
        },
        required: ["param1"]
      }
    };

    const metadata = parseTool(mockTool);

    assert.strictEqual(metadata.slug, "TEST_TOOL");
    assert.strictEqual(metadata.description, "A tool to test parsing");
    assert.deepStrictEqual(metadata.requiredInputs, ["param1"]);
    assert.strictEqual(metadata.inputProperties.param1.type, "string");
    assert.strictEqual(metadata.inputProperties.param1.description, "Parameter one");
    assert.strictEqual(metadata.inputProperties.param2.type, "integer");
  });

  test("recursively resolves properties from $defs", () => {
    const mockTool: Tool = {
      slug: "NESTED_TOOL",
      description: "A tool with nested outputs",
      outputParameters: {
        type: "object",
        properties: {
          data: {
            $ref: "#/$defs/NestedData"
          },
          status: { type: "string" }
        },
        $defs: {
          NestedData: {
            type: "object",
            properties: {
              nestedId: { type: "integer", description: "A nested ID" },
              details: {
                $ref: "#/$defs/DeepDetails"
              }
            }
          },
          DeepDetails: {
            type: "object",
            properties: {
              name: { type: "string" }
            }
          }
        }
      }
    };

    const metadata = parseTool(mockTool);

    assert.strictEqual(metadata.outputProperties.status.type, "string");
    assert.strictEqual(metadata.outputProperties.nestedId.type, "integer");
    assert.strictEqual(metadata.outputProperties.nestedId.description, "A nested ID");
    assert.strictEqual(metadata.outputProperties.name.type, "string");
  });

  test("identifies static and dynamic parameters correctly", () => {
    assert.strictEqual(isStaticParameter("owner"), true);
    assert.strictEqual(isStaticParameter("REPO"), true);
    assert.strictEqual(isStaticParameter("per_page"), true);
    assert.strictEqual(isStaticParameter("page"), true);
    assert.strictEqual(isStaticParameter("limit"), true);
    assert.strictEqual(isStaticParameter("cursor"), true);
    assert.strictEqual(isStaticParameter("sort"), true);
    assert.strictEqual(isStaticParameter("direction"), true);
    assert.strictEqual(isStaticParameter("state"), true);

    assert.strictEqual(isStaticParameter("issue_number"), false);
    assert.strictEqual(isStaticParameter("pull_number"), false);
    assert.strictEqual(isStaticParameter("comment_id"), false);
    assert.strictEqual(isStaticParameter("migrationId"), false);
    assert.strictEqual(isStaticParameter("some_other_field"), false);
  });

  test("infers heuristic edges correctly", () => {
    const mockTools: ToolMetadata[] = [
      {
        slug: "GITHUB_LIST_REPOSITORY_ISSUES",
        description: "List issues",
        requiredInputs: ["owner", "repo"],
        inputProperties: {},
        outputProperties: {
          number: { type: "integer", description: "The issue number" }
        }
      },
      {
        slug: "GITHUB_CREATE_AN_ISSUE_COMMENT",
        description: "Create issue comment",
        requiredInputs: ["owner", "repo", "issue_number"],
        inputProperties: {},
        outputProperties: {
          id: { type: "integer" }
        }
      },
      {
        slug: "GITHUB_ABORT_REPOSITORY_MIGRATION",
        description: "Abort migration",
        requiredInputs: ["migration_id"],
        inputProperties: {},
        outputProperties: {}
      },
      {
        slug: "GITHUB_START_REPOSITORY_MIGRATION",
        description: "Start migration",
        requiredInputs: [],
        inputProperties: {},
        outputProperties: {
          migrationId: { type: "string" }
        }
      }
    ];

    const edges = inferHeuristicEdges(mockTools);

    const migrationEdge = edges.find(e => e.to === "GITHUB_ABORT_REPOSITORY_MIGRATION");
    assert.ok(migrationEdge);
    assert.strictEqual(migrationEdge.from, "GITHUB_START_REPOSITORY_MIGRATION");
    assert.strictEqual(migrationEdge.label, "migration_id");

    const issueEdge = edges.find(e => e.to === "GITHUB_CREATE_AN_ISSUE_COMMENT");
    assert.ok(issueEdge);
    assert.strictEqual(issueEdge.from, "GITHUB_LIST_REPOSITORY_ISSUES");
    assert.strictEqual(issueEdge.label, "issue_number");
  });

  test("categorizes tools into domains correctly", () => {
    assert.strictEqual(getToolDomain("GITHUB_CREATE_AN_ISSUE_COMMENT"), "Issues");
    assert.strictEqual(getToolDomain("GITHUB_MERGE_A_PULL_REQUEST"), "PullRequests");
    assert.strictEqual(getToolDomain("GITHUB_START_REPOSITORY_MIGRATION"), "Repositories");
    assert.strictEqual(getToolDomain("GITHUB_REMOVE_TEAM_MEMBERSHIP_FOR_A_USER"), "Organizations");
    assert.strictEqual(getToolDomain("GITHUB_CREATE_A_PROJECT_CARD"), "Projects");
    assert.strictEqual(getToolDomain("GITHUB_DISPATCH_REPOSITORY_WORKFLOW"), "Actions");
    assert.strictEqual(getToolDomain("GITHUB_SOME_GENERIC_OPERATION"), "General");
  });
});
