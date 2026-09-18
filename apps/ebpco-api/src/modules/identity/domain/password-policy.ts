/**
 * Password policy.
 *
 * NIST SP 800-63B's own position is that composition rules ("one uppercase,
 * one digit, one symbol") and forced periodic rotation both measurably
 * reduce security -- they push people toward predictable transformations of
 * one password, and toward writing it down. This service required composition
 * rules anyway, a deliberate product decision to require them explicitly
 * alongside the length and breach/pattern/context screening below, not an
 * oversight of the NIST guidance.
 */

export interface PasswordRejection {
  readonly code: PasswordRejectionCode;
  readonly message: string;
}

export type PasswordRejectionCode =
  | 'too-short'
  | 'too-long'
  | 'missing-uppercase'
  | 'missing-lowercase'
  | 'missing-digit'
  | 'missing-punctuation'
  | 'breached'
  | 'context-specific'
  | 'repetitive'
  | 'sequential';

/** Screens a candidate against passwords known to have appeared in breaches. */
export interface BreachedPasswordScreen {
  isBreached(password: string): Promise<boolean>;
}

export interface PasswordContext {
  /** The applicant's own details, which must not be their password. */
  readonly email?: string;
  readonly firstName?: string;
  readonly lastName?: string;
}

/** NIST's floor is 8. Twelve, because this account can file a building permit. */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * NIST requires accepting at least 64. The upper bound exists only to stop a
 * multi-megabyte string being fed to a memory-hard hash as a denial of service.
 */
export const MAX_PASSWORD_LENGTH = 256;

/** Words that are guessable from the service itself rather than from the user. */
const SERVICE_WORDS = ['ebpco', 'permit', 'building', 'occupancy', 'quezon', 'philippines'];

// Unicode property classes, not [A-Z]/[a-z]/[0-9] — the length check above
// already accepts all Unicode, and an ASCII-only composition check would
// reject a perfectly good uppercase/lowercase letter from an accented or
// non-Latin script while still counting it toward length.
const UPPERCASE = /\p{Lu}/u;
const LOWERCASE = /\p{Ll}/u;
const DIGIT = /\p{Nd}/u;
// "Punctuation" as this policy means it: any character that is not a letter,
// number, or whitespace -- broader than \p{P} alone, so it also covers
// symbols like $ + = ~ that Unicode classifies as "Symbol" rather than
// "Punctuation" but a user would call punctuation just the same.
const PUNCTUATION = /[^\p{L}\p{N}\s]/u;

export class PasswordPolicy {
  constructor(private readonly breachScreen: BreachedPasswordScreen) {}

  async evaluate(password: string, context: PasswordContext = {}): Promise<PasswordRejection[]> {
    const rejections: PasswordRejection[] = [];

    // Length is measured in code points, not UTF-16 units: NIST requires
    // accepting all Unicode, and counting surrogate pairs as two would make an
    // emoji-containing password mysteriously "longer" than it looks.
    const length = [...password].length;

    if (length < MIN_PASSWORD_LENGTH) {
      rejections.push({
        code: 'too-short',
        message: `Use at least ${MIN_PASSWORD_LENGTH} characters. A longer phrase is easier to remember and harder to guess than a short one with symbols in it.`,
      });
    }
    if (length > MAX_PASSWORD_LENGTH) {
      rejections.push({ code: 'too-long', message: `Use at most ${MAX_PASSWORD_LENGTH} characters.` });
    }

    // Everything below is pointless on a password that is already too short.
    if (length < MIN_PASSWORD_LENGTH) return rejections;

    if (!UPPERCASE.test(password)) {
      rejections.push({ code: 'missing-uppercase', message: 'Include at least one uppercase letter.' });
    }
    if (!LOWERCASE.test(password)) {
      rejections.push({ code: 'missing-lowercase', message: 'Include at least one lowercase letter.' });
    }
    if (!DIGIT.test(password)) {
      rejections.push({ code: 'missing-digit', message: 'Include at least one number.' });
    }
    if (!PUNCTUATION.test(password)) {
      rejections.push({ code: 'missing-punctuation', message: 'Include at least one punctuation character (e.g. ! ? . , -).' });
    }

    if (isRepetitive(password)) {
      rejections.push({
        code: 'repetitive',
        message: 'This is a single character repeated. Choose something with more variety.',
      });
    }
    if (isSequential(password)) {
      rejections.push({
        code: 'sequential',
        message: 'This is a simple sequence. Choose something less predictable.',
      });
    }
    if (containsContextWords(password, context)) {
      rejections.push({
        code: 'context-specific',
        message: 'This contains your own details or the name of this service, both of which are easy to guess.',
      });
    }
    if (await this.breachScreen.isBreached(password)) {
      rejections.push({
        code: 'breached',
        message: 'This password has appeared in a known data breach and is on attackers’ lists. Choose a different one.',
      });
    }

    return rejections;
  }
}

function isRepetitive(password: string): boolean {
  const characters = [...password];
  const first = characters[0];
  return first !== undefined && characters.every((character) => character === first);
}

function isSequential(password: string): boolean {
  const lower = password.toLowerCase();
  let ascending = true;
  let descending = true;

  for (let i = 1; i < lower.length; i += 1) {
    const previous = lower.codePointAt(i - 1);
    const current = lower.codePointAt(i);
    if (previous === undefined || current === undefined) return false;
    if (current !== previous + 1) ascending = false;
    if (current !== previous - 1) descending = false;
    if (!ascending && !descending) return false;
  }
  return ascending || descending;
}

function containsContextWords(password: string, context: PasswordContext): boolean {
  const lower = password.toLowerCase();
  const candidates = [
    ...SERVICE_WORDS,
    context.firstName?.toLowerCase(),
    context.lastName?.toLowerCase(),
    context.email?.toLowerCase().split('@')[0],
  ].filter((word): word is string => typeof word === 'string' && word.length >= 4);

  return candidates.some((word) => lower.includes(word));
}
