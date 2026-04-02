/**
 * Ontological constraint enforcement for the memory knowledge graph.
 *
 * Supports uniqueness, mutual exclusion, temporal ordering, cardinality,
 * and type constraints. Runs at capture-time (inline), during sleep
 * Phase 16 (batch audit), and on-demand via the logic_query tool.
 */

import type { Session } from "neo4j-driver";
import type { Logger } from "./schema.js";
import { toJsNumber } from "./schema.js";

// ============================================================================
// Types
// ============================================================================

export type ConstraintType =
  | "uniqueness"
  | "mutual_exclusion"
  | "temporal_ordering"
  | "cardinality"
  | "type_constraint";

export type ConstraintSeverity = "error" | "warning";

export type ConstraintDefinition = {
  name: string;
  type: ConstraintType;
  severity: ConstraintSeverity;
  /** Entity type this constraint applies to (e.g. "person"). */
  entityType?: string;
  /** Primary relationship type (e.g. "HAS_BIRTHDATE"). */
  relationshipType: string;
  /** Secondary relationship type (for mutual exclusion). */
  secondaryRelationshipType?: string;
  /** Max allowed simultaneous relationships (for cardinality). */
  maxCardinality?: number;
  /** Required entity type for the target (for type constraints). */
  requiredTargetType?: string;
  /** Agent scope. */
  agentId: string;
};

export type ConstraintViolation = {
  type: ConstraintType;
  constraintName: string;
  severity: ConstraintSeverity;
  offendingEntityId: string;
  offendingEntityName?: string;
  conflictingMemoryId?: string;
  message: string;
};

export type ConsistencyCheckResult = {
  violations: ConstraintViolation[];
  checked: number;
};

// ============================================================================
// Constraint Validation
// ============================================================================

/** Check a uniqueness constraint: entity has at most one relationship of a given type. */
async function checkUniqueness(
  session: Session,
  constraint: ConstraintDefinition,
  logger: Logger,
): Promise<ConstraintViolation[]> {
  const violations: ConstraintViolation[] = [];
  try {
    const result = await session.executeRead((tx) =>
      tx.run(
        `MATCH (e:Entity {agentId: $agentId})-[r1:${constraint.relationshipType}]->(t1)
         MATCH (e)-[r2:${constraint.relationshipType}]->(t2)
         WHERE t1 <> t2
           AND ($entityType IS NULL OR e.type = $entityType)
           AND (r1.validUntil IS NULL AND r2.validUntil IS NULL)
         RETURN DISTINCT e.id AS entityId, e.name AS entityName,
                count(DISTINCT t1) + count(DISTINCT t2) AS relCount
         LIMIT 50`,
        {
          agentId: constraint.agentId,
          entityType: constraint.entityType ?? null,
        },
      ),
    );

    for (const rec of result.records) {
      violations.push({
        type: "uniqueness",
        constraintName: constraint.name,
        severity: constraint.severity,
        offendingEntityId: rec.get("entityId") as string,
        offendingEntityName: rec.get("entityName") as string,
        message: `Entity "${rec.get("entityName")}" has multiple active ${constraint.relationshipType} relationships (uniqueness constraint violated)`,
      });
    }
  } catch (err) {
    logger.warn(
      `memory-neo4j: [consistency] uniqueness check failed for "${constraint.name}": ${String(err)}`,
    );
  }
  return violations;
}

/** Check a mutual exclusion constraint: two relationship types cannot coexist on the same entity. */
async function checkMutualExclusion(
  session: Session,
  constraint: ConstraintDefinition,
  logger: Logger,
): Promise<ConstraintViolation[]> {
  if (!constraint.secondaryRelationshipType) return [];
  const violations: ConstraintViolation[] = [];
  try {
    const result = await session.executeRead((tx) =>
      tx.run(
        `MATCH (e:Entity {agentId: $agentId})-[r1:${constraint.relationshipType}]->()
         MATCH (e)-[r2:${constraint.secondaryRelationshipType}]->()
         WHERE ($entityType IS NULL OR e.type = $entityType)
           AND (r1.validUntil IS NULL AND r2.validUntil IS NULL)
         RETURN DISTINCT e.id AS entityId, e.name AS entityName
         LIMIT 50`,
        {
          agentId: constraint.agentId,
          entityType: constraint.entityType ?? null,
          secondaryRelationshipType: constraint.secondaryRelationshipType,
        },
      ),
    );

    for (const rec of result.records) {
      violations.push({
        type: "mutual_exclusion",
        constraintName: constraint.name,
        severity: constraint.severity,
        offendingEntityId: rec.get("entityId") as string,
        offendingEntityName: rec.get("entityName") as string,
        message: `Entity "${rec.get("entityName")}" has both ${constraint.relationshipType} and ${constraint.secondaryRelationshipType} active (mutual exclusion violated)`,
      });
    }
  } catch (err) {
    logger.warn(
      `memory-neo4j: [consistency] mutual exclusion check failed for "${constraint.name}": ${String(err)}`,
    );
  }
  return violations;
}

/** Check a temporal ordering constraint: relationship A's validFrom must precede B's. */
async function checkTemporalOrdering(
  session: Session,
  constraint: ConstraintDefinition,
  logger: Logger,
): Promise<ConstraintViolation[]> {
  if (!constraint.secondaryRelationshipType) return [];
  const violations: ConstraintViolation[] = [];
  try {
    const result = await session.executeRead((tx) =>
      tx.run(
        `MATCH (e:Entity {agentId: $agentId})-[r1:${constraint.relationshipType}]->()
         MATCH (e)-[r2:${constraint.secondaryRelationshipType}]->()
         WHERE ($entityType IS NULL OR e.type = $entityType)
           AND r1.validFrom IS NOT NULL AND r2.validFrom IS NOT NULL
           AND r1.validFrom > r2.validFrom
         RETURN DISTINCT e.id AS entityId, e.name AS entityName,
                r1.validFrom AS firstDate, r2.validFrom AS secondDate
         LIMIT 50`,
        {
          agentId: constraint.agentId,
          entityType: constraint.entityType ?? null,
          secondaryRelationshipType: constraint.secondaryRelationshipType,
        },
      ),
    );

    for (const rec of result.records) {
      violations.push({
        type: "temporal_ordering",
        constraintName: constraint.name,
        severity: constraint.severity,
        offendingEntityId: rec.get("entityId") as string,
        offendingEntityName: rec.get("entityName") as string,
        message: `Entity "${rec.get("entityName")}": ${constraint.relationshipType} (${rec.get("firstDate")}) occurs after ${constraint.secondaryRelationshipType} (${rec.get("secondDate")}) — temporal ordering violated`,
      });
    }
  } catch (err) {
    logger.warn(
      `memory-neo4j: [consistency] temporal ordering check failed for "${constraint.name}": ${String(err)}`,
    );
  }
  return violations;
}

/** Check a cardinality constraint: entity has at most N relationships of a given type simultaneously. */
async function checkCardinality(
  session: Session,
  constraint: ConstraintDefinition,
  logger: Logger,
): Promise<ConstraintViolation[]> {
  const max = constraint.maxCardinality ?? 1;
  const violations: ConstraintViolation[] = [];
  try {
    const result = await session.executeRead((tx) =>
      tx.run(
        `MATCH (e:Entity {agentId: $agentId})-[r:${constraint.relationshipType}]->()
         WHERE ($entityType IS NULL OR e.type = $entityType)
           AND r.validUntil IS NULL
         WITH e, count(r) AS relCount
         WHERE relCount > $max
         RETURN e.id AS entityId, e.name AS entityName, relCount
         LIMIT 50`,
        {
          agentId: constraint.agentId,
          entityType: constraint.entityType ?? null,
          max,
        },
      ),
    );

    for (const rec of result.records) {
      violations.push({
        type: "cardinality",
        constraintName: constraint.name,
        severity: constraint.severity,
        offendingEntityId: rec.get("entityId") as string,
        offendingEntityName: rec.get("entityName") as string,
        message: `Entity "${rec.get("entityName")}" has ${toJsNumber(rec.get("relCount"))} active ${constraint.relationshipType} relationships (max ${max})`,
      });
    }
  } catch (err) {
    logger.warn(
      `memory-neo4j: [consistency] cardinality check failed for "${constraint.name}": ${String(err)}`,
    );
  }
  return violations;
}

/** Check a type constraint: only entities of specified types can participate in a relationship. */
async function checkTypeConstraint(
  session: Session,
  constraint: ConstraintDefinition,
  logger: Logger,
): Promise<ConstraintViolation[]> {
  if (!constraint.requiredTargetType) return [];
  const violations: ConstraintViolation[] = [];
  try {
    const result = await session.executeRead((tx) =>
      tx.run(
        `MATCH (e:Entity {agentId: $agentId})-[r:${constraint.relationshipType}]->(t:Entity)
         WHERE ($entityType IS NULL OR e.type = $entityType)
           AND t.type <> $requiredTargetType
           AND r.validUntil IS NULL
         RETURN DISTINCT e.id AS entityId, e.name AS entityName,
                t.name AS targetName, t.type AS targetType
         LIMIT 50`,
        {
          agentId: constraint.agentId,
          entityType: constraint.entityType ?? null,
          requiredTargetType: constraint.requiredTargetType,
        },
      ),
    );

    for (const rec of result.records) {
      violations.push({
        type: "type_constraint",
        constraintName: constraint.name,
        severity: constraint.severity,
        offendingEntityId: rec.get("entityId") as string,
        offendingEntityName: rec.get("entityName") as string,
        message: `Entity "${rec.get("entityName")}"-[${constraint.relationshipType}]->"${rec.get("targetName")}" (${rec.get("targetType")}): target must be type "${constraint.requiredTargetType}"`,
      });
    }
  } catch (err) {
    logger.warn(
      `memory-neo4j: [consistency] type constraint check failed for "${constraint.name}": ${String(err)}`,
    );
  }
  return violations;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Run a constraint check against the graph.
 * Dispatches to the appropriate validation function based on constraint type.
 */
export async function checkConstraint(
  session: Session,
  constraint: ConstraintDefinition,
  logger: Logger,
): Promise<ConstraintViolation[]> {
  switch (constraint.type) {
    case "uniqueness":
      return checkUniqueness(session, constraint, logger);
    case "mutual_exclusion":
      return checkMutualExclusion(session, constraint, logger);
    case "temporal_ordering":
      return checkTemporalOrdering(session, constraint, logger);
    case "cardinality":
      return checkCardinality(session, constraint, logger);
    case "type_constraint":
      return checkTypeConstraint(session, constraint, logger);
    default:
      logger.warn(
        `memory-neo4j: [consistency] unknown constraint type: ${(constraint as ConstraintDefinition).type}`,
      );
      return [];
  }
}

/**
 * Run all provided constraints and return aggregated violations.
 */
export async function runConsistencyAudit(
  session: Session,
  constraints: ConstraintDefinition[],
  logger: Logger,
): Promise<ConsistencyCheckResult> {
  const allViolations: ConstraintViolation[] = [];

  for (const constraint of constraints) {
    const violations = await checkConstraint(session, constraint, logger);
    allViolations.push(...violations);
  }

  return {
    violations: allViolations,
    checked: constraints.length,
  };
}

/**
 * Check a candidate fact (described as text) against constraints.
 * Uses LLM-extracted entities from the text to check against existing constraints.
 * This is a simplified version for on-demand checking — full capture-time
 * validation integrates with the extraction pipeline.
 */
export async function checkCandidateFact(
  session: Session,
  entityName: string,
  relationshipType: string,
  constraints: ConstraintDefinition[],
  agentId: string,
  logger: Logger,
): Promise<ConstraintViolation[]> {
  // Filter constraints relevant to this entity/relationship
  const relevant = constraints.filter(
    (c) =>
      c.agentId === agentId &&
      (c.relationshipType === relationshipType || c.secondaryRelationshipType === relationshipType),
  );

  if (relevant.length === 0) return [];

  const violations: ConstraintViolation[] = [];
  for (const constraint of relevant) {
    const found = await checkConstraint(session, constraint, logger);
    violations.push(...found);
  }
  return violations;
}
