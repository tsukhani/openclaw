/**
 * Health and connectivity probes for the Neo4j memory client.
 *
 * Standalone functions that verify connectivity and fetch summary counts
 * without triggering the full initialization flow (indexes + migrations).
 */

import neo4j, { type Driver, type Session } from "neo4j-driver";
import type { Logger } from "./schema.js";

/**
 * Create a raw Neo4j session from an initialized driver.
 * Caller is responsible for closing it.
 */
export function createSession(driver: Driver): Session {
  return driver.session();
}

/**
 * Run a lightweight probe query that fetches Memory and Entity counts.
 */
async function runProbe(session: Session): Promise<{ memories: number; entities: number }> {
  const result = await session.run(
    "OPTIONAL MATCH (m:Memory) WITH count(m) AS memories OPTIONAL MATCH (e:Entity) RETURN memories, count(e) AS entities",
  );
  const row = result.records[0];
  return {
    memories: row?.get("memories") ?? 0,
    entities: row?.get("entities") ?? 0,
  };
}

/**
 * Lightweight status probe that verifies connectivity and fetches summary counts
 * without triggering the full ensureInitialized() (indexes + migrations).
 * Returns null if the connection fails.
 *
 * When a driver is provided, uses it directly. Otherwise creates a temporary
 * driver from the connection parameters.
 */
export async function probeStatusCounts(
  driver: Driver | null,
  uri: string,
  username: string,
  password: string,
): Promise<{ memories: number; entities: number } | null> {
  if (driver) {
    const session = driver.session();
    try {
      return await runProbe(session);
    } catch {
      return null;
    } finally {
      await session.close();
    }
  }
  let tempDriver: Driver | null = null;
  try {
    tempDriver = neo4j.driver(uri, neo4j.auth.basic(username, password), {
      maxConnectionPoolSize: 1,
      connectionAcquisitionTimeout: 5000,
    });
    const session = tempDriver.session();
    try {
      return await runProbe(session);
    } finally {
      await session.close();
    }
  } catch {
    return null;
  } finally {
    await tempDriver?.close();
  }
}

/**
 * Verify Neo4j connectivity by running a simple RETURN 1 query.
 *
 * When a driver is provided, uses it directly. Otherwise creates a temporary
 * driver from the connection parameters for a lightweight reachability check
 * to avoid the heavyweight ensureInitialized() (indexes + migrations).
 */
export async function verifyConnection(
  driver: Driver | null,
  uri: string,
  username: string,
  password: string,
  logger: Logger,
): Promise<boolean> {
  if (!driver) {
    let tempDriver: Driver | null = null;
    try {
      tempDriver = neo4j.driver(uri, neo4j.auth.basic(username, password), {
        maxConnectionPoolSize: 1,
        connectionAcquisitionTimeout: 5000,
      });
      const session = tempDriver.session();
      try {
        await session.run("RETURN 1");
        return true;
      } finally {
        await session.close();
      }
    } catch {
      return false;
    } finally {
      await tempDriver?.close();
    }
  }
  const session = driver.session();
  try {
    await session.run("RETURN 1");
    return true;
  } catch (err) {
    logger.error(`memory-neo4j: connection verification failed: ${String(err)}`);
    return false;
  } finally {
    await session.close();
  }
}
