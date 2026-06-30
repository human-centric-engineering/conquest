import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

/**
 * Database utility functions
 */

/**
 * Check if database connection is working
 */
export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    logger.error('Database connection failed', error);
    return false;
  }
}

/**
 * Disconnect from database
 * Call this when shutting down the application
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}

/**
 * Get database health status
 * Useful for health check endpoints
 */
export async function getDatabaseHealth(): Promise<{
  connected: boolean;
  latency?: number;
}> {
  const start = Date.now();

  try {
    await prisma.$queryRaw`SELECT 1`;
    const latency = Date.now() - start;

    return {
      connected: true,
      latency,
    };
  } catch (error) {
    logger.error('Database health check failed', error);
    return {
      connected: false,
    };
  }
}

/**
 * Execute a database transaction
 * Wrapper for Prisma transactions with error handling
 *
 * Pass `options` to override Prisma's interactive-transaction defaults (5000 ms `timeout`,
 * 2000 ms `maxWait`) for unusually heavy callbacks — e.g. a bulk import whose many writes can
 * exceed the default budget under production DB latency.
 *
 * Example:
 * ```ts
 * await executeTransaction(async (tx) => {
 *   await tx.user.create({ data: { ... } })
 *   await tx.post.create({ data: { ... } })
 * })
 *
 * // heavy callback needing more headroom:
 * await executeTransaction(work, { timeout: 20_000, maxWait: 10_000 })
 * ```
 */
export async function executeTransaction<T>(
  callback: (
    tx: Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>
  ) => Promise<T>,
  options?: {
    timeout?: number;
    maxWait?: number;
    isolationLevel?: Prisma.TransactionIsolationLevel;
  }
): Promise<T> {
  return await prisma.$transaction(callback, options);
}
