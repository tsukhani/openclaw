/**
 * Cypher template module for CausalModel and CausalVariable CRUD operations.
 */

import type { Session } from "neo4j-driver";
import type {
  CausalModelNode,
  CausalVariableDomain,
  CausalVariableNode,
  CausalVariableType,
} from "./schema.js";
import { toJsNumber } from "./schema.js";

// ============================================================================
// Input Types
// ============================================================================

export type StoreCausalModelInput = {
  id: string;
  name: string;
  description: string;
  agentId: string;
};

export type StoreCausalVariableInput = {
  id: string;
  name: string;
  type: CausalVariableType;
  domain: CausalVariableDomain;
  observedValue?: string;
  agentId: string;
  modelId: string;
};

export type StoreCausalEdgeInput = {
  sourceVariableId: string;
  targetVariableId: string;
  coefficient?: number;
  mechanism?: string;
  functionalForm?: string;
};

// ============================================================================
// CausalModel CRUD
// ============================================================================

/** Create or update a causal model node. */
export async function storeCausalModel(
  session: Session,
  input: StoreCausalModelInput,
): Promise<string> {
  const now = new Date().toISOString();
  const result = await session.executeWrite((tx) =>
    tx.run(
      `MERGE (cm:CausalModel {id: $id})
       ON CREATE SET
         cm.name = $name, cm.description = $description,
         cm.agentId = $agentId,
         cm.createdAt = $now, cm.updatedAt = $now
       ON MATCH SET
         cm.name = $name, cm.description = $description,
         cm.updatedAt = $now
       RETURN cm.id AS id`,
      {
        id: input.id,
        name: input.name,
        description: input.description,
        agentId: input.agentId,
        now,
      },
    ),
  );
  return (result.records[0]?.get("id") as string) ?? input.id;
}

/** List causal models for an agent. */
export async function listCausalModels(
  session: Session,
  agentId: string,
): Promise<CausalModelNode[]> {
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (cm:CausalModel {agentId: $agentId})
       RETURN cm
       ORDER BY cm.updatedAt DESC`,
      { agentId },
    ),
  );
  return result.records.map((rec) => rec.get("cm").properties as CausalModelNode);
}

/** Get a causal model by ID. */
export async function getCausalModel(
  session: Session,
  modelId: string,
  agentId: string,
): Promise<CausalModelNode | null> {
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (cm:CausalModel {id: $modelId, agentId: $agentId})
       RETURN cm`,
      { modelId, agentId },
    ),
  );
  if (result.records.length === 0) {
    return null;
  }
  return result.records[0].get("cm").properties as CausalModelNode;
}

/** Delete a causal model and all its variables and edges. */
export async function deleteCausalModel(
  session: Session,
  modelId: string,
  agentId: string,
): Promise<boolean> {
  const result = await session.executeWrite((tx) =>
    tx.run(
      `MATCH (cm:CausalModel {id: $modelId, agentId: $agentId})
       OPTIONAL MATCH (cv:CausalVariable)-[:PART_OF_MODEL]->(cm)
       DETACH DELETE cv, cm
       RETURN count(*) AS deleted`,
      { modelId, agentId },
    ),
  );
  return toJsNumber(result.records[0]?.get("deleted")) > 0;
}

// ============================================================================
// CausalVariable CRUD
// ============================================================================

/** Store a causal variable and link it to its model. */
export async function storeCausalVariable(
  session: Session,
  input: StoreCausalVariableInput,
): Promise<string> {
  const result = await session.executeWrite((tx) =>
    tx.run(
      `MERGE (cv:CausalVariable {id: $id})
       ON CREATE SET
         cv.name = $name, cv.type = $type,
         cv.domain = $domain, cv.observedValue = $observedValue,
         cv.agentId = $agentId
       ON MATCH SET
         cv.name = $name, cv.type = $type,
         cv.domain = $domain, cv.observedValue = $observedValue
       WITH cv
       MATCH (cm:CausalModel {id: $modelId})
       MERGE (cv)-[:PART_OF_MODEL]->(cm)
       RETURN cv.id AS id`,
      {
        id: input.id,
        name: input.name,
        type: input.type,
        domain: input.domain,
        observedValue: input.observedValue ?? null,
        agentId: input.agentId,
        modelId: input.modelId,
      },
    ),
  );
  return (result.records[0]?.get("id") as string) ?? input.id;
}

/** List variables in a causal model. */
export async function listModelVariables(
  session: Session,
  modelId: string,
): Promise<CausalVariableNode[]> {
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (cv:CausalVariable)-[:PART_OF_MODEL]->(cm:CausalModel {id: $modelId})
       RETURN cv
       ORDER BY cv.name ASC`,
      { modelId },
    ),
  );
  return result.records.map((rec) => rec.get("cv").properties as CausalVariableNode);
}

// ============================================================================
// Causal Edge (CAUSES) CRUD
// ============================================================================

/** Create a CAUSES relationship between two variables. */
export async function storeCausalEdge(
  session: Session,
  input: StoreCausalEdgeInput,
): Promise<void> {
  await session.executeWrite((tx) =>
    tx.run(
      `MATCH (src:CausalVariable {id: $sourceId})
       MATCH (tgt:CausalVariable {id: $targetId})
       MERGE (src)-[r:CAUSES]->(tgt)
       SET r.coefficient = $coefficient,
           r.mechanism = $mechanism,
           r.functionalForm = $functionalForm`,
      {
        sourceId: input.sourceVariableId,
        targetId: input.targetVariableId,
        coefficient: input.coefficient ?? null,
        mechanism: input.mechanism ?? null,
        functionalForm: input.functionalForm ?? null,
      },
    ),
  );
}

/** Get all causal edges in a model as an adjacency list. */
export async function getCausalEdges(
  session: Session,
  modelId: string,
): Promise<
  Array<{
    sourceId: string;
    sourceName: string;
    targetId: string;
    targetName: string;
    coefficient: number | null;
    mechanism: string | null;
  }>
> {
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (src:CausalVariable)-[r:CAUSES]->(tgt:CausalVariable)
       WHERE (src)-[:PART_OF_MODEL]->(:CausalModel {id: $modelId})
       RETURN src.id AS sourceId, src.name AS sourceName,
              tgt.id AS targetId, tgt.name AS targetName,
              r.coefficient AS coefficient, r.mechanism AS mechanism`,
      { modelId },
    ),
  );
  return result.records.map((rec) => ({
    sourceId: rec.get("sourceId") as string,
    sourceName: rec.get("sourceName") as string,
    targetId: rec.get("targetId") as string,
    targetName: rec.get("targetName") as string,
    coefficient: rec.get("coefficient") as number | null,
    mechanism: rec.get("mechanism") as string | null,
  }));
}

/** Get incoming edges to a variable (for graph surgery / do-operator). */
export async function getIncomingCausalEdges(
  session: Session,
  variableId: string,
): Promise<Array<{ sourceId: string; sourceName: string }>> {
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (src:CausalVariable)-[:CAUSES]->(tgt:CausalVariable {id: $variableId})
       RETURN src.id AS sourceId, src.name AS sourceName`,
      { variableId },
    ),
  );
  return result.records.map((rec) => ({
    sourceId: rec.get("sourceId") as string,
    sourceName: rec.get("sourceName") as string,
  }));
}

/** Count entities in the graph (for rule learning skip check). */
export async function countEntities(session: Session, agentId: string): Promise<number> {
  const result = await session.executeRead((tx) =>
    tx.run(
      `MATCH (e:Entity {agentId: $agentId})
       RETURN count(e) AS cnt`,
      { agentId },
    ),
  );
  return toJsNumber(result.records[0]?.get("cnt"));
}
