import { test, describe } from "node:test";
import assert from "node:assert";
import { parseTool, Tool } from "./generate.js";

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
});
