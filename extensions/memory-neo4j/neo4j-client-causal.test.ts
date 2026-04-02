/**
 * Tests for CausalModel and CausalVariable Cypher template operations.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  countEntities,
  deleteCausalModel,
  getCausalEdges,
  getCausalModel,
  getIncomingCausalEdges,
  listCausalModels,
  listModelVariables,
  storeCausalEdge,
  storeCausalModel,
  storeCausalVariable,
} from "./neo4j-client-causal.js";

function mockRecord(fields: Record<string, unknown>) {
  return { get: (key: string) => fields[key] };
}

function createMockSession() {
  const run = vi.fn().mockResolvedValue({ records: [] });
  return {
    run,
    executeRead: vi.fn(async (fn: (tx: { run: typeof run }) => Promise<unknown>) => fn({ run })),
    executeWrite: vi.fn(async (fn: (tx: { run: typeof run }) => Promise<unknown>) => fn({ run })),
    close: vi.fn(),
    _run: run,
  };
}

describe("storeCausalModel", () => {
  let session: ReturnType<typeof createMockSession>;

  beforeEach(() => {
    session = createMockSession();
  });

  it("creates a causal model and returns its ID", async () => {
    session._run.mockResolvedValueOnce({
      records: [mockRecord({ id: "model-1" })],
    });

    const id = await storeCausalModel(session as any, {
      id: "model-1",
      name: "sales-pipeline",
      description: "Causal model for sales pipeline dynamics",
      agentId: "agent-1",
    });

    expect(id).toBe("model-1");
    const cypher = session._run.mock.calls[0][0] as string;
    expect(cypher).toContain("MERGE (cm:CausalModel {id: $id})");
  });

  it("updates name and description on match", async () => {
    session._run.mockResolvedValueOnce({
      records: [mockRecord({ id: "model-1" })],
    });

    await storeCausalModel(session as any, {
      id: "model-1",
      name: "updated-name",
      description: "updated description",
      agentId: "agent-1",
    });

    const cypher = session._run.mock.calls[0][0] as string;
    expect(cypher).toContain("ON MATCH SET");
    expect(cypher).toContain("cm.updatedAt");
  });
});

describe("listCausalModels", () => {
  it("returns models ordered by updatedAt", async () => {
    const session = createMockSession();
    session._run.mockResolvedValueOnce({
      records: [
        mockRecord({ cm: { properties: { id: "m1", name: "Model A", updatedAt: "2026-04-02" } } }),
        mockRecord({ cm: { properties: { id: "m2", name: "Model B", updatedAt: "2026-04-01" } } }),
      ],
    });

    const models = await listCausalModels(session as any, "agent-1");
    expect(models).toHaveLength(2);
    expect(models[0].name).toBe("Model A");

    const cypher = session._run.mock.calls[0][0] as string;
    expect(cypher).toContain("ORDER BY cm.updatedAt DESC");
  });
});

describe("getCausalModel", () => {
  it("returns the model when found", async () => {
    const session = createMockSession();
    session._run.mockResolvedValueOnce({
      records: [
        mockRecord({ cm: { properties: { id: "m1", name: "Sales Model", agentId: "agent-1" } } }),
      ],
    });

    const model = await getCausalModel(session as any, "m1", "agent-1");
    expect(model).not.toBeNull();
    expect(model!.name).toBe("Sales Model");
  });

  it("returns null when model not found", async () => {
    const session = createMockSession();
    session._run.mockResolvedValueOnce({ records: [] });

    const model = await getCausalModel(session as any, "nonexistent", "agent-1");
    expect(model).toBeNull();
  });
});

describe("deleteCausalModel", () => {
  it("deletes model and its variables", async () => {
    const session = createMockSession();
    session._run.mockResolvedValueOnce({
      records: [mockRecord({ deleted: 3 })],
    });

    const result = await deleteCausalModel(session as any, "m1", "agent-1");
    expect(result).toBe(true);

    const cypher = session._run.mock.calls[0][0] as string;
    expect(cypher).toContain("DETACH DELETE cv, cm");
  });
});

describe("storeCausalVariable", () => {
  it("creates a variable linked to its model", async () => {
    const session = createMockSession();
    session._run.mockResolvedValueOnce({
      records: [mockRecord({ id: "var-1" })],
    });

    const id = await storeCausalVariable(session as any, {
      id: "var-1",
      name: "team_size",
      type: "endogenous",
      domain: "continuous",
      agentId: "agent-1",
      modelId: "model-1",
    });

    expect(id).toBe("var-1");
    const cypher = session._run.mock.calls[0][0] as string;
    expect(cypher).toContain("MERGE (cv:CausalVariable {id: $id})");
    expect(cypher).toContain("PART_OF_MODEL");
  });

  it("accepts optional observedValue", async () => {
    const session = createMockSession();
    session._run.mockResolvedValueOnce({
      records: [mockRecord({ id: "var-2" })],
    });

    await storeCausalVariable(session as any, {
      id: "var-2",
      name: "conversion_rate",
      type: "endogenous",
      domain: "continuous",
      observedValue: "0.15",
      agentId: "agent-1",
      modelId: "model-1",
    });

    const params = session._run.mock.calls[0][1] as Record<string, unknown>;
    expect(params.observedValue).toBe("0.15");
  });
});

describe("listModelVariables", () => {
  it("returns variables in a model ordered by name", async () => {
    const session = createMockSession();
    session._run.mockResolvedValueOnce({
      records: [
        mockRecord({ cv: { properties: { id: "v1", name: "conversion", type: "endogenous" } } }),
        mockRecord({ cv: { properties: { id: "v2", name: "team_size", type: "endogenous" } } }),
      ],
    });

    const vars = await listModelVariables(session as any, "model-1");
    expect(vars).toHaveLength(2);
    expect(vars[0].name).toBe("conversion");
  });
});

describe("storeCausalEdge", () => {
  it("creates a CAUSES relationship with properties", async () => {
    const session = createMockSession();

    await storeCausalEdge(session as any, {
      sourceVariableId: "var-1",
      targetVariableId: "var-2",
      coefficient: 0.75,
      mechanism: "Larger teams produce more proposals",
      functionalForm: "linear",
    });

    const cypher = session._run.mock.calls[0][0] as string;
    expect(cypher).toContain("MERGE (src)-[r:CAUSES]->(tgt)");
    const params = session._run.mock.calls[0][1] as Record<string, unknown>;
    expect(params.coefficient).toBe(0.75);
    expect(params.mechanism).toBe("Larger teams produce more proposals");
  });

  it("handles null optional properties", async () => {
    const session = createMockSession();

    await storeCausalEdge(session as any, {
      sourceVariableId: "var-1",
      targetVariableId: "var-2",
    });

    const params = session._run.mock.calls[0][1] as Record<string, unknown>;
    expect(params.coefficient).toBeNull();
    expect(params.mechanism).toBeNull();
    expect(params.functionalForm).toBeNull();
  });
});

describe("getCausalEdges", () => {
  it("returns all causal edges in a model", async () => {
    const session = createMockSession();
    session._run.mockResolvedValueOnce({
      records: [
        mockRecord({
          sourceId: "v1",
          sourceName: "team_size",
          targetId: "v2",
          targetName: "proposal_volume",
          coefficient: 0.8,
          mechanism: "More people = more proposals",
        }),
        mockRecord({
          sourceId: "v2",
          sourceName: "proposal_volume",
          targetId: "v3",
          targetName: "conversion",
          coefficient: 0.5,
          mechanism: null,
        }),
      ],
    });

    const edges = await getCausalEdges(session as any, "model-1");
    expect(edges).toHaveLength(2);
    expect(edges[0].sourceName).toBe("team_size");
    expect(edges[0].mechanism).toBe("More people = more proposals");
    expect(edges[1].mechanism).toBeNull();
  });
});

describe("getIncomingCausalEdges", () => {
  it("returns parents of a variable (for graph surgery)", async () => {
    const session = createMockSession();
    session._run.mockResolvedValueOnce({
      records: [
        mockRecord({ sourceId: "v1", sourceName: "team_size" }),
        mockRecord({ sourceId: "v3", sourceName: "budget" }),
      ],
    });

    const parents = await getIncomingCausalEdges(session as any, "v2");
    expect(parents).toHaveLength(2);
    expect(parents[0].sourceName).toBe("team_size");
  });
});

describe("countEntities", () => {
  it("returns entity count for an agent", async () => {
    const session = createMockSession();
    session._run.mockResolvedValueOnce({
      records: [mockRecord({ cnt: 57 })],
    });

    const count = await countEntities(session as any, "agent-1");
    expect(count).toBe(57);
  });

  it("returns 0 for empty graph", async () => {
    const session = createMockSession();
    session._run.mockResolvedValueOnce({
      records: [mockRecord({ cnt: 0 })],
    });

    const count = await countEntities(session as any, "agent-1");
    expect(count).toBe(0);
  });
});
