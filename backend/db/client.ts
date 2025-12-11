import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

/**
 * Create a Drizzle ORM instance for D1 database
 */
export function createDbClient(db: D1Database) {
  return drizzle(db, { schema });
}

// Type export for the database client
export type DbClient = ReturnType<typeof createDbClient>;
