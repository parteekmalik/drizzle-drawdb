import { drizzle } from 'drizzle-orm/sqlite-core';
import { Database } from 'sql.js';
import * as schema from '../schema';

// sql.js instance - note: this is for runtime use, drizzle-kit export reads the schema directly
let sqlite: Database | null = null;

export function getSqlite() {
  if (!sqlite) {
    sqlite = new Database();
  }
  return sqlite;
}

export const db = drizzle(getSqlite(), { schema });
export type { users, posts, categories } from '../schema';
