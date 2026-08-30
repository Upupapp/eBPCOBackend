import { SqlClient } from './sql-client';

/**
 * The RA 10173 records of processing, generated from the schema itself.
 *
 * Every column holding personal data carries a COMMENT beginning `pii:`, and
 * this reads them back out of the PostgreSQL catalog. The point is that the
 * register and the database cannot drift: a hand-maintained inventory is
 * accurate on the day it is written and wrong by the next migration, and TAB 20
 * has to file it with the National Privacy Commission.
 *
 * The convention is `pii:<category>:<subtype> — <note>`, or `credential:<kind>`
 * for material that is not personal data but must never be exported or logged.
 */

export interface PersonalDataColumn {
  readonly table: string;
  readonly column: string;
  readonly classification: 'pii' | 'credential';
  readonly category: string;
  readonly subtype: string;
  readonly note: string;
}

export interface InventoryGap {
  readonly table: string;
  readonly column: string;
  readonly reason: string;
}

/**
 * Column names that hold personal data by convention, and therefore must carry
 * a tag. A column matching one of these with no `pii:` comment is a finding,
 * not an omission to be argued about later.
 */
const SUSPECT_NAMES = [
  'email', 'mobile', 'phone', 'first_name', 'last_name', 'full_name',
  'street', 'barangay', 'address', 'claimant_name', 'file_name',
  'birth', 'tin', 'philsys',
];

/**
 * Suffixes that mark a column as metadata ABOUT a personal-data field rather
 * than the field itself. `email_verified_at` is a timestamp; the personal datum
 * is `email`, which is tagged. Including these would fill the register with
 * timestamps and obscure the actual categories of data being processed, which
 * is what the NPC filing is for.
 *
 * The line is drawn here rather than at "everything in a table about a person",
 * because by that reading every column is personal data and the register stops
 * distinguishing anything.
 */
const METADATA_SUFFIXES = ['_at', '_on', '_count', '_id'];

export async function inventory(db: SqlClient): Promise<PersonalDataColumn[]> {
  const result = await db.query<{ table_name: string; column_name: string; comment: string }>(
    `select c.relname as table_name,
            a.attname as column_name,
            d.description as comment
       from pg_description d
       join pg_class c    on c.oid = d.objoid
       join pg_attribute a on a.attrelid = c.oid and a.attnum = d.objsubid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and d.objsubid > 0
        and (d.description like 'pii:%' or d.description like 'credential:%')
      order by c.relname, a.attname`,
  );

  return result.rows.map((row) => {
    const [head, ...noteParts] = row.comment.split('—');
    const segments = (head ?? '').trim().split(':');
    return {
      table: row.table_name,
      column: row.column_name,
      classification: segments[0] === 'credential' ? 'credential' : 'pii',
      category: segments[1] ?? 'unclassified',
      subtype: (segments[2] ?? '').trim(),
      note: noteParts.join('—').trim(),
    };
  });
}

/**
 * Columns that look like personal data but carry no tag.
 *
 * Run as a test, so adding an untagged `email` column fails the build rather
 * than quietly leaving it out of the register filed with the NPC.
 */
export async function gaps(db: SqlClient): Promise<InventoryGap[]> {
  const tagged = new Set((await inventory(db)).map((entry) => `${entry.table}.${entry.column}`));

  const result = await db.query<{ table_name: string; column_name: string }>(
    `select table_name, column_name
       from information_schema.columns
      where table_schema = 'public'
      order by table_name, column_name`,
  );

  return result.rows
    .filter((row) => SUSPECT_NAMES.some((needle) => row.column_name.includes(needle)))
    .filter((row) => !METADATA_SUFFIXES.some((suffix) => row.column_name.endsWith(suffix)))
    .filter((row) => !tagged.has(`${row.table_name}.${row.column_name}`))
    .map((row) => ({
      table: row.table_name,
      column: row.column_name,
      reason: 'looks like personal data but carries no pii: tag',
    }));
}
