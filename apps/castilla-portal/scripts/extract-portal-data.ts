/**
 * Extracts the portal's committed data AND its sourcing comments.
 *
 * TAB 15 calls seeding the place this repository's discipline is most likely to
 * be destroyed, "because the sourcing lives in comments and comments are
 * exactly what an importer drops". So this does not drop them: it walks the
 * TypeScript AST and captures, for every entity and every property, the comment
 * that sits above it.
 *
 * ── Why the compiler API and not a regex ────────────────────────────────
 *
 * A regex over this source would be wrong in ways that look right. `name:` also
 * appears inside a head object; apostrophes appear inside descriptions
 * ("Citizen's Charter"); a comment mentioning `slug:` would be read as data.
 * The compiler already knows where a property ends and a comment begins, and
 * `getLeadingCommentRanges` is the only honest way to say which comment belongs
 * to which fact.
 *
 * ── Read from a COMMIT, never the working tree ──────────────────────────
 *
 * The portal is another lane's repository and it moves: this file has been
 * written against three different commits in one day. Extracting from a dirty
 * tree records a specification that was never published. The commit is stamped
 * on the output so a reader can check what was read rather than trust it.
 *
 *   npm run extract:portal
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ts from 'typescript';

const PORTAL_REPO = process.env['EBPCO_WEBSITE_REPO'] ?? '/Users/user/eBPCO-Website';
const DATA_DIR = 'castilla-lgu-portal/src/app/core/data';
const FILES = ['municipality.data.ts', 'offices.data.ts', 'officials.data.ts', 'permits.data.ts'];

export interface ExtractedEntity {
  /** The exported constant this entity came from, e.g. MUNICIPAL_OFFICES. */
  readonly source: string;
  /** Position in the array. Order is meaningful and is preserved. */
  readonly ordinal: number;
  /** Literal property values, by name. Nested objects are kept as objects. */
  readonly fields: Record<string, unknown>;
  /** The comment above the whole entity, if any. */
  readonly comment: string | null;
  /**
   * The comment above the declaration this entity belongs to -- provenance that
   * covers a whole group, such as the note naming the 2025 election results as
   * the source for every Sangguniang Bayan member.
   */
  readonly scopeComment?: string;
  /** The comment at the head of the file, if any. Read last, and verbatim. */
  readonly fileComment?: string;
  /** Comments above individual properties, keyed by property name. */
  readonly fieldComments: Record<string, string>;
}

function git(args: string[]): string {
  return execFileSync('git', ['-C', PORTAL_REPO, ...args], { encoding: 'utf8' });
}

function commentTextAt(source: ts.SourceFile, position: number): string | null {
  const ranges = ts.getLeadingCommentRanges(source.getFullText(), position);
  if (ranges === undefined || ranges.length === 0) return null;
  const text = ranges
    .map((r) => source.getFullText().slice(r.pos, r.end))
    .join('\n')
    // Strip the comment syntax, keep the words. The wrapping is an artefact of
    // an 80-column file, not of the sentence.
    .replace(/^\s*\/\*\*?|\*\/\s*$/g, '')
    .split('\n')
    .map((line) => line.replace(/^\s*(\/\/|\*)\s?/, '').trimEnd())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length === 0 ? null : text;
}

/** Literal values only. A call expression or identifier is recorded as such. */
function valueOf(node: ts.Expression, source: ts.SourceFile): unknown {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((e) => valueOf(e, source));
  }
  if (ts.isObjectLiteralExpression(node)) {
    const out: Record<string, unknown> = {};
    const spreads: unknown[] = [];
    const dropped: string[] = [];
    for (const p of node.properties) {
      if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
        out[p.name.text] = valueOf(p.initializer, source);
        continue;
      }
      // `{ ...placeholderContact(), hours: '...' }`. Recorded, not merged: the
      // spread carries isPlaceholder AND a default location, and dropping it
      // silently let an office the source calls a placeholder be confirmed as
      // a sourced fact. Resolution stays a seeding decision, like any helper.
      if (ts.isSpreadAssignment(p)) {
        spreads.push(valueOf(p.expression, source));
        continue;
      }
      // Anything this extractor cannot represent — shorthand, a computed name,
      // a method. NAMED rather than dropped: the spread above was invisible
      // for exactly as long as it was silent.
      dropped.push(p.getText(source).split('\n')[0]!.trim());
    }
    if (spreads.length > 0) out['__spread'] = spreads;
    if (dropped.length > 0) out['__unrepresented'] = dropped;
    return out;
  }
  // A helper call such as placeholderHead('Municipal Mayor') or a reference
  // such as MAYOR. Recorded verbatim rather than resolved: what it MEANS is a
  // seeding decision, and burying that decision in an extractor would hide it.
  return { __expression: node.getText(source) };
}

/** The leading comment on the STATEMENT a declaration belongs to. */
function statementCommentFor(node: ts.VariableDeclaration, source: ts.SourceFile): string | null {
  let current: ts.Node = node;
  while (!ts.isVariableStatement(current) && current.parent !== undefined) {
    current = current.parent;
  }
  return commentTextAt(source, current.pos);
}

function entitiesIn(source: ts.SourceFile): ExtractedEntity[] {
  const found: ExtractedEntity[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined
        && ts.isIdentifier(node.name)) {
      const constName = node.name.text;
      const init = node.initializer;

      // A comment above `export const MAYOR = {...}` attaches to the STATEMENT,
      // not to the declaration -- the chain is VariableStatement >
      // VariableDeclarationList > VariableDeclaration, and reading the
      // declaration's parent lands on the list, which has no leading comment.
      // Getting this wrong silently loses the file-level sourcing note that
      // covers every elected official.
      const scopeComment = statementCommentFor(node, source);

      if (ts.isArrayLiteralExpression(init)) {
        init.elements.forEach((element, ordinal) => {
          if (!ts.isObjectLiteralExpression(element)) return;
          const fields = valueOf(element, source) as Record<string, unknown>;
          const fieldComments: Record<string, string> = {};
          for (const p of element.properties) {
            if (!ts.isPropertyAssignment(p)) continue;
            if (!ts.isIdentifier(p.name) && !ts.isStringLiteral(p.name)) continue;
            const c = commentTextAt(source, p.pos);
            if (c !== null) fieldComments[p.name.text] = c;
          }
          found.push({
            source: constName, ordinal, fields,
            comment: commentTextAt(source, element.pos),
            // The comment above the whole declaration. For SB_MEMBERS that is
            // the note naming the 2025 election results as the source for every
            // member, and it is the provenance for all of them.
            ...(scopeComment === null ? {} : { scopeComment }),
            fieldComments,
          });
        });
        return;
      }

      if (ts.isObjectLiteralExpression(init) || ts.isStringLiteral(init)) {
        found.push({
          source: constName, ordinal: 0,
          fields: ts.isStringLiteral(init)
            ? { value: init.text }
            : valueOf(init, source) as Record<string, unknown>,
          comment: statementCommentFor(node, source),
          fieldComments: {},
        });
        return;
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return found;
}

function main(): number {
  const commit = git(['rev-parse', 'HEAD']).trim();
  const scratch = mkdtempSync(join(tmpdir(), 'portal-data-'));
  const byFile: Record<string, ExtractedEntity[]> = {};

  for (const file of FILES) {
    const text = git(['show', `${commit}:${DATA_DIR}/${file}`]);
    const path = join(scratch, file);
    writeFileSync(path, text);
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true);
    // The header above the file's first DECLARATION -- not statements[0],
    // which is the import and carries no comment. In officials.data.ts that
    // header is the note naming the 2025 election results as the source for
    // every elected official: provenance for records that carry no comment of
    // their own, and lost entirely if only per-entity comments are read.
    //
    // Read LAST by the seeder and recorded verbatim, so a reader sees exactly
    // which words were relied on rather than a summary of them.
    const firstDeclaration = source.statements.find(ts.isVariableStatement);
    const header = firstDeclaration === undefined
      ? null : commentTextAt(source, firstDeclaration.pos);
    byFile[file] = entitiesIn(source).map((e) => (header === null ? e : { ...e, fileComment: header }));
  }

  const total = Object.values(byFile).reduce((n, e) => n + e.length, 0);
  if (total === 0) {
    process.stderr.write('extraction found nothing; the source shape has changed\n');
    return 1;
  }

  writeFileSync(join(__dirname, '../contract/portal-data.json'), `${JSON.stringify({
    _comment: 'Extracted by scripts/extract-portal-data.ts from the commit below. '
      + 'Do not hand-edit: re-run the script.',
    repo: 'Upupapp/eBPCO-Website', commit, dataDir: DATA_DIR, files: byFile,
  }, null, 2)}\n`);

  for (const [file, entities] of Object.entries(byFile)) {
    const withComments = entities.filter((e) => e.comment !== null
      || Object.keys(e.fieldComments).length > 0).length;
    process.stdout.write(
      `${file.padEnd(24)} ${String(entities.length).padStart(3)} entities, `
      + `${withComments} carrying a sourcing comment\n`,
    );
  }
  process.stdout.write(`portal commit ${commit.slice(0, 7)}\n`);
  return 0;
}

process.exitCode = main();
