import { types } from 'pg';

import { PgliteClient } from './pglite-client';
import { BIGINT_OID, NUMERIC_OID } from './numeric-parsing';
import './postgres-client';

/**
 * The two SqlClient adapters must be interchangeable.
 *
 * They were not. PGlite returned NUMERIC as the string "0" while the `pg`
 * driver returned the number 0, which meant every test that read a monetary
 * value was reading a different type than production would — and `a + b` on two
 * fee strings concatenates rather than adds, producing a plausible number
 * instead of an error. A test asserting a zero fee line found it.
 *
 * This is the standing guard.
 */
describe('adapter parity on exact numeric types', () => {
  it('the pg driver parses NUMERIC and BIGINT to numbers', () => {
    const numeric = types.getTypeParser(NUMERIC_OID) as (v: string) => number;
    const bigint = types.getTypeParser(BIGINT_OID) as (v: string) => number;

    expect(numeric('682000')).toBe(682_000);
    expect(bigint('42')).toBe(42);
  });

  it('PGlite parses them the same way', async () => {
    const db = await PgliteClient.create();
    try {
      await db.exec('create table probe (n numeric not null, b bigint not null)');
      await db.query('insert into probe values (682000, 42)');

      const result = await db.query<{ n: number; b: number }>('select n, b from probe');

      expect(result.rows[0]?.n).toBe(682_000);
      expect(result.rows[0]?.b).toBe(42);
      expect(typeof result.rows[0]?.n).toBe('number');
      expect(typeof result.rows[0]?.b).toBe('number');
    } finally {
      await db.close();
    }
  });

  it('a zero reads as the number 0, not the string "0"', async () => {
    // The exact case that surfaced the divergence: an unused fee line.
    const db = await PgliteClient.create();
    try {
      await db.exec('create table probe (n numeric not null)');
      await db.query('insert into probe values (0)');

      const result = await db.query<{ n: number }>('select n from probe');

      expect(result.rows[0]?.n).toBe(0);
      expect(result.rows[0]?.n).not.toBe('0');
    } finally {
      await db.close();
    }
  });

  it('both refuse a value they cannot represent exactly', async () => {
    const numeric = types.getTypeParser(NUMERIC_OID) as (v: string) => number;
    expect(() => numeric('682000.75')).toThrow(/not a whole number/);

    const db = await PgliteClient.create();
    try {
      await db.exec('create table probe (n numeric not null)');
      await db.query('insert into probe values (682000.75)');

      await expect(db.query('select n from probe')).rejects.toThrow(/not a whole number/);
    } finally {
      await db.close();
    }
  });
});
