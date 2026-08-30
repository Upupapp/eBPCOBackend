import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Applies the schema, in filename order.
 *
 * Deliberately small. This service's migrations are not yet deployed anywhere,
 * and a ledger, checksums and a rollback story are the `ebpco-api` migrator's
 * job, which is a solved problem next door. When this service gains a
 * deployment it should adopt that one rather than grow a second half-version
 * here -- noted so the omission reads as a decision rather than an oversight.
 */
export interface Sql {
  exec(sql: string): Promise<unknown>;
}

export function migrationFiles(directory: string): string[] {
  return readdirSync(directory).filter((f) => f.endsWith('.sql')).sort();
}

export async function migrate(db: Sql, directory: string): Promise<number> {
  const files = migrationFiles(directory);
  for (const file of files) {
    await db.exec(readFileSync(join(directory, file), 'utf8'));
  }
  return files.length;
}
