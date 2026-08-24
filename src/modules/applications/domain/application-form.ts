/**
 * What an applicant typed into the permit wizard.
 *
 * There are two different kinds of validation here and only one of them is
 * possible today.
 *
 * **Structural** — how big, how deep, how many fields, how long a value. None
 * of that depends on knowing what a Fencing Permit asks for, and all of it is
 * necessary: an endpoint that accepts arbitrary JSON with no bounds accepts a
 * ten-megabyte nested object, and a client that can send one can exhaust a
 * server that has to parse it.
 *
 * **Semantic** — is `numberOfStoreys` an integer, is `lotArea` required for a
 * Fencing Permit, does this field set match the unified DPWH/JMC form. That
 * needs the forms, and they have not been supplied (M-10). Inventing a field
 * set here would reject applications the LGU would have accepted, which is a
 * worse failure than accepting one it would have queried.
 *
 * So this bounds the shape and records that nothing checked the meaning. The
 * registry below is the seam the real schemas drop into.
 */

export interface FormViolation {
  readonly pointer: string;
  readonly message: string;
}

/**
 * Bounds chosen against what a real wizard produces, with room to spare.
 *
 * A large permit application is a few hundred fields and perhaps twenty
 * kilobytes. These are roughly an order of magnitude above that, which is the
 * right place for a limit: high enough that no honest applicant meets it, low
 * enough that meeting it is a signal rather than a slow afternoon.
 */
export const FORM_LIMITS = {
  maxSerialisedBytes: 256 * 1024,
  maxDepth: 8,
  maxFields: 500,
  maxStringLength: 8_000,
  maxArrayLength: 200,
} as const;

export function validateStructure(form: unknown): readonly FormViolation[] {
  if (form === null || typeof form !== 'object' || Array.isArray(form)) {
    return [{ pointer: '/form', message: 'must be an object' }];
  }

  const violations: FormViolation[] = [];
  const size = Buffer.byteLength(JSON.stringify(form) ?? '', 'utf8');
  if (size > FORM_LIMITS.maxSerialisedBytes) {
    violations.push({
      pointer: '/form',
      message: `is ${Math.round(size / 1024)}KB; the limit is `
        + `${FORM_LIMITS.maxSerialisedBytes / 1024}KB`,
    });
    // Returned early. Walking a structure that is already too large to accept
    // is work done on behalf of a caller who has already been refused.
    return violations;
  }

  let fields = 0;

  const walk = (value: unknown, pointer: string, depth: number): void => {
    if (violations.length >= 20) return; // Enough to act on; a wall of errors is not more useful.

    if (depth > FORM_LIMITS.maxDepth) {
      violations.push({ pointer, message: `is nested deeper than ${FORM_LIMITS.maxDepth} levels` });
      return;
    }

    if (typeof value === 'string' && value.length > FORM_LIMITS.maxStringLength) {
      violations.push({
        pointer,
        message: `is ${value.length} characters; the limit is ${FORM_LIMITS.maxStringLength}`,
      });
      return;
    }

    if (Array.isArray(value)) {
      if (value.length > FORM_LIMITS.maxArrayLength) {
        violations.push({
          pointer,
          message: `has ${value.length} entries; the limit is ${FORM_LIMITS.maxArrayLength}`,
        });
        return;
      }
      value.forEach((item, index) => walk(item, `${pointer}/${index}`, depth + 1));
      return;
    }

    if (value !== null && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        fields += 1;
        if (fields > FORM_LIMITS.maxFields) {
          violations.push({ pointer: '/form', message: `has more than ${FORM_LIMITS.maxFields} fields` });
          return;
        }
        // RFC 6901: `~` and `/` are escaped so a pointer to a field literally
        // named "a/b" is not read as two levels.
        walk(nested, `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, depth + 1);
      }
    }
  };

  walk(form, '/form', 0);
  return violations;
}

/**
 * Semantic schemas, by permit type.
 *
 * Deliberately empty. Every entry here has to come from the LGU's published
 * form (M-10), and the point of the registry existing while empty is that the
 * absence is visible and typed rather than being an omission somebody has to
 * notice.
 */
export interface FormSchema {
  /** Recorded on the application, so an operator can tell what checked it. */
  readonly version: string;
  validate(form: Record<string, unknown>): readonly FormViolation[];
}

export const FORM_SCHEMAS: Readonly<Record<string, FormSchema>> = {};

export function schemaFor(permitType: string): FormSchema | undefined {
  return FORM_SCHEMAS[permitType];
}
