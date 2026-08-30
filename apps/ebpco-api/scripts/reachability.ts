/**
 * Which exported functions and public methods does PRODUCTION code actually
 * reach — and which are reached only by their own tests?
 *
 * Three sweeps of this codebase found the same defect three times: something
 * built correctly, tested thoroughly, and wired to nothing. The password-reset
 * repository whose table was never written. `readContent`, whose integrity
 * check had never run outside a test because the route that would have called
 * it did not exist. `evaluation-stage-passed`, in the catalog with copy and a
 * deep link and no emitter. In every case the tests passed, because a test
 * calls the service directly and cannot tell whether anything else does.
 *
 * So this is the check the tests structurally cannot perform.
 *
 * ── Why the compiler and not grep ──────────────────────────────────────
 *
 * Because I have made the grep mistake repeatedly and it points BOTH ways. A
 * name that appears nowhere may still be reached — through an interface, a DI
 * token, a decorator. A name that appears everywhere may be reached by nothing,
 * because the reference sits in a branch that never runs or in a test. Only the
 * type checker knows that `this.store.verifySignedUrl(...)` on a port resolves
 * to the interface member that the filesystem adapter implements.
 *
 * ── What counts as reachable ───────────────────────────────────────────
 *
 * Reachability is TRANSITIVE, and the first version of this script got that
 * wrong in a way worth recording: it counted references, treating "referred to
 * by another file" as reached. That flags `Scheduler.tick` — which is called by
 * a timer its own class starts — while a whole dead subsystem that calls itself
 * would pass. Counting references answers a different question than the one
 * this file asks.
 *
 * So: build the call graph and walk it from the roots. An edge runs from the
 * declaration a reference sits INSIDE to the declaration it names. `tick` is
 * reached because the constructor names it, the constructor's class is named by
 * scheduling.module.ts, and that module is reached from main.ts.
 *
 * Framework entry points are roots, because the caller is Nest rather than our
 * code and its call is invisible to the checker:
 *   - every method of an @Controller class (routes)
 *   - every method of an @Injectable / @Module / @Catch / @Injectable-like class
 *     that Nest itself invokes (lifecycle hooks, guards, pipes, filters)
 *   - main.ts, which nothing imports
 *
 * A class method that implements an interface member is judged by the
 * INTERFACE member's reachability, not its own. Adapters behind a port have no
 * direct callers by design; reporting them would be reporting the pattern.
 *
 * ── What this does NOT prove ───────────────────────────────────────────
 *
 * Reached is not the same as REACHABLE AT RUNTIME. An edge sitting in a branch
 * that never executes is still an edge — this cannot see `if (false)`, which
 * was verified against the notification catalog gate rather than assumed. It
 * answers a narrower question honestly: is there any path from an entry point
 * to this at all, or does only the test suite know it exists? Every finding is
 * a lead to confirm by reading, not a verdict.
 *
 * Private methods are not tracked, and references inside them are attributed to
 * their class. That errs toward calling things reached, which is the safe
 * direction for a gate: a false positive here costs someone an investigation
 * and a false negative costs nothing visible, so the bias belongs on the side
 * that stays quiet.
 */

import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import * as ts from 'typescript';

const ROOT = resolve(__dirname, '..');

/** The other scripts write to the stream directly rather than via console; so does this. */
const say = (line = ''): void => void process.stdout.write(`${line}\n`);
const warn = (line: string): void => void process.stderr.write(`${line}\n`);

interface Declared {
  readonly name: string;
  readonly kind: 'function' | 'method' | 'class' | 'const' | 'interface' | 'type';
  readonly file: string;
  readonly line: number;
  readonly exported: boolean;
  /** Nest calls it; our code need not. */
  readonly root: string | null;
  /** Judged by the interface member instead. */
  readonly viaInterface: boolean;
  /** Declarations this one names. */
  readonly calls: Set<ts.Declaration>;
  testRefs: Set<string>;
}

/** Nest invokes these itself, so no caller of ours is expected. */
const FRAMEWORK_METHODS = new Set([
  'onModuleInit', 'onModuleDestroy', 'onApplicationBootstrap', 'onApplicationShutdown',
  'beforeApplicationShutdown', 'configure', 'use', 'canActivate', 'intercept',
  'transform', 'catch',
]);

const CONTROLLER_DECORATORS = new Set(['Controller']);
const NEST_CLASS_DECORATORS = new Set(['Controller', 'Module', 'Injectable', 'Catch', 'Global']);

function isTestFile(file: string): boolean {
  return file.includes('.spec.') || file.includes('.e2e-') || file.startsWith('test/');
}

function decoratorNames(node: ts.Node): string[] {
  const found: string[] = [];
  for (const decorator of ts.getDecorators?.(node as ts.HasDecorators) ?? []) {
    const call = decorator.expression;
    const target = ts.isCallExpression(call) ? call.expression : call;
    if (ts.isIdentifier(target)) found.push(target.text);
  }
  return found;
}

function main(): void {
  const configPath = ts.findConfigFile(ROOT, (f) => ts.sys.fileExists(f), 'tsconfig.json');
  if (configPath === undefined) throw new Error('no tsconfig.json');
  const parsed = ts.parseJsonConfigFileContent(
    ts.readConfigFile(configPath, (p) => readFileSync(p, 'utf8')).config,
    ts.sys,
    ROOT,
  );

  // scripts/ is NOT in tsconfig's `include`, so the program would not see it and
  // everything only a script calls would read as test-only. `stabilise` did
  // exactly that. An audit blind to a whole directory reports confidently about
  // a tree it cannot see, so the directory is added explicitly here.
  const scripts = ts.sys.readDirectory(resolve(ROOT, 'scripts'), ['.ts']);
  const program = ts.createProgram([...parsed.fileNames, ...scripts], parsed.options);
  const checker = program.getTypeChecker();

  const declared = new Map<ts.Declaration, Declared>();

  const rel = (file: string): string => relative(ROOT, file);

  /** Interface members whose names are implemented by a class, keyed by name. */
  const interfaceMemberNames = new Set<string>();

  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile) continue;
    const file = rel(source.fileName);
    if (!file.startsWith('src/')) continue;
    // Specs live beside the code they test. Collecting their locals as
    // declarations buried the real findings under every fixture in the suite.
    if (isTestFile(file)) continue;

    const record = (
      node: ts.Declaration, name: string, kind: Declared['kind'],
      exported: boolean, root: string | null, viaInterface: boolean,
    ): void => {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      declared.set(node, {
        name, kind, file, line: line + 1, exported, root, viaInterface,
        calls: new Set(), testRefs: new Set(),
      });
    };

    const isExported = (node: ts.Node): boolean =>
      (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;

    source.forEachChild((node) => {
      if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
        record(node, node.name.text, 'function', isExported(node),
          file === 'src/main.ts' ? 'main.ts entry point' : null, false);
        return;
      }
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            record(decl, decl.name.text, 'const', isExported(node), null, false);
          }
        }
        return;
      }
      if (ts.isInterfaceDeclaration(node)) {
        record(node, node.name.text, 'interface', isExported(node), null, false);
        for (const member of node.members) {
          if (member.name !== undefined && ts.isIdentifier(member.name)) {
            interfaceMemberNames.add(member.name.text);
          }
        }
        return;
      }
      if (ts.isTypeAliasDeclaration(node)) {
        record(node, node.name.text, 'type', isExported(node), null, false);
        return;
      }
      if (ts.isClassDeclaration(node) && node.name !== undefined) {
        const decorators = decoratorNames(node);
        const nestClass = decorators.some((d) => NEST_CLASS_DECORATORS.has(d));
        const isController = decorators.some((d) => CONTROLLER_DECORATORS.has(d));
        record(node, node.name.text, 'class', isExported(node),
          nestClass ? `@${decorators.find((d) => NEST_CLASS_DECORATORS.has(d))!} — constructed by Nest` : null,
          false);

        const implemented = new Set<string>();
        for (const clause of node.heritageClauses ?? []) {
          if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue;
          for (const expr of clause.types) {
            const symbol = checker.getTypeAtLocation(expr).getSymbol();
            for (const member of symbol?.members?.keys() ?? []) implemented.add(String(member));
          }
        }

        for (const member of node.members) {
          if (!ts.isMethodDeclaration(member) || member.name === undefined) continue;
          if (!ts.isIdentifier(member.name)) continue;
          const memberName = member.name.text;
          const isPrivate =
            (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Private) !== 0
            || memberName.startsWith('#');
          if (isPrivate) continue;

          let root: string | null = null;
          if (isController) root = 'route handler — called by Nest';
          else if (FRAMEWORK_METHODS.has(memberName)) root = 'framework lifecycle hook';
          else if (decoratorNames(member).length > 0) root = 'decorated — called by Nest';

          record(member, `${node.name.text}.${memberName}`, 'method',
            true, root, implemented.has(memberName));
        }
      }
    });
  }

  // ── edges ─────────────────────────────────────────────────────────────
  // A reference is attributed to the declaration it sits INSIDE, so the graph
  // records who calls what rather than merely what is mentioned where.
  const MODULE_SCOPE = Symbol('module scope');
  const moduleScope = new Map<string, Set<ts.Declaration>>();

  function ownerOf(node: ts.Node): Declared | typeof MODULE_SCOPE {
    for (let current = node.parent; current !== undefined; current = current.parent) {
      const entry = declared.get(current as ts.Declaration);
      if (entry !== undefined) return entry;
      // A constructor or a private method is not tracked; its references belong
      // to the class, which is the thing DI actually constructs.
      if (ts.isClassDeclaration(current)) {
        const cls = declared.get(current);
        if (cls !== undefined) return cls;
      }
    }
    return MODULE_SCOPE;
  }

  /** Import and export clauses are plumbing, not use. */
  function isPlumbing(node: ts.Node): boolean {
    for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
      if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current)
        || ts.isImportEqualsDeclaration(current)) return true;
      if (ts.isSourceFile(current)) return false;
    }
    return false;
  }

  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile) continue;
    const file = rel(source.fileName);
    if (file.startsWith('node_modules/') || file.startsWith('dist/')) continue;
    const fromTest = isTestFile(file);

    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && !isPlumbing(node)) {
        let symbol = checker.getSymbolAtLocation(node);
        if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
          symbol = checker.getAliasedSymbol(symbol);
        }
        for (const decl of symbol?.declarations ?? []) {
          const target = declared.get(decl);
          if (target === undefined) continue;
          if (node.getStart() === (decl as ts.NamedDeclaration).name?.getStart()
            && decl.getSourceFile() === source) continue;

          if (fromTest) {
            target.testRefs.add(file);
            continue;
          }
          const owner = ownerOf(node);
          if (owner === MODULE_SCOPE) {
            const set = moduleScope.get(file) ?? new Set<ts.Declaration>();
            set.add(decl);
            moduleScope.set(file, set);
          } else {
            owner.calls.add(decl);
          }
        }
      }
      node.forEachChild(visit);
    };
    visit(source);
  }

  // ── walk from the roots ───────────────────────────────────────────────
  const reached = new Set<ts.Declaration>();
  const queue: ts.Declaration[] = [];

  const enter = (decl: ts.Declaration): void => {
    if (reached.has(decl)) return;
    reached.add(decl);
    queue.push(decl);
  };

  for (const [decl, entry] of declared) {
    // Nest calls these; nothing of ours has to.
    if (entry.root !== null) enter(decl);
    // An adapter behind a port is judged by its interface member, not itself.
    if (entry.viaInterface) enter(decl);
  }
  // Entry points are the files nothing imports because something RUNS them:
  // main.ts, and every script behind an npm command. Their module scope is a
  // root; every other file's is not, or importing something would make it
  // reached and the whole graph would collapse to "everything".
  for (const [file, decls] of moduleScope) {
    if (file !== 'src/main.ts' && !file.startsWith('scripts/')) continue;
    for (const decl of decls) enter(decl);
  }

  while (queue.length > 0) {
    const decl = queue.pop()!;
    for (const next of declared.get(decl)?.calls ?? []) enter(next);
  }

  // ── report ────────────────────────────────────────────────────────────
  const all = [...declared.values()];
  const entryOf = new Map<Declared, ts.Declaration>();
  for (const [decl, entry] of declared) entryOf.set(entry, decl);

  const isReached = (entry: Declared): boolean => reached.has(entryOf.get(entry)!);
  const judged = all.filter((entry) => entry.root === null && !entry.viaInterface);

  const unreached = judged.filter((entry) => !isReached(entry));
  const testOnly = unreached.filter((entry) => entry.testRefs.size > 0);
  const orphaned = unreached.filter((entry) => entry.testRefs.size === 0 && entry.exported);

  const show = (entries: Declared[]): void => {
    for (const entry of entries.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
      const seen = entry.testRefs.size > 0 ? `  [${entry.testRefs.size} test file(s)]` : '';
      say(`  ${entry.file}:${entry.line}  ${entry.name}  (${entry.kind})${seen}`);
    }
  };

  say('REACHABILITY AUDIT — what production code actually reaches\n');
  say(`  declarations examined      ${all.length}`);
  say(`  framework roots (exempt)   ${all.filter((d) => d.root !== null).length}`);
  say(`  judged by an interface     ${all.filter((d) => d.viaInterface).length}`);
  say(`  judged here                ${judged.length}`);
  say(`  reached from an entry point ${judged.filter(isReached).length}\n`);

  say(`UNREACHED — ${unreached.length}, of which:\n`);
  say(`REACHED ONLY BY TESTS — ${testOnly.length}`);
  say('  No path from any entry point. The suite is the only caller.\n');
  show(testOnly);

  say(`\nREFERENCED NOWHERE — ${orphaned.length}`);
  say('  Exported, and named by no file at all — not even a test.\n');
  show(orphaned);

  // The two lists above are the exported cases, which are the readable ones.
  // The register covers ALL of `unreached`, module-private declarations
  // included — a dead helper behind a dead export is dead too, and leaving it
  // out would let the count drift down while the code stayed.
  const rest = unreached.filter((entry) => !testOnly.includes(entry) && !orphaned.includes(entry));
  say(`\nUNREACHED AND NOT EXPORTED — ${rest.length}`);
  say('  Module-private, and nothing reached still calls them.\n');
  show(rest);

  // ── the register ──────────────────────────────────────────────────────
  // A count alone rots: it drifts upward one plausible addition at a time. So
  // every unreached declaration carries a REASON, and the register is checked
  // in both directions — a new one fails until it is explained, and one that
  // has since been wired fails until its line is removed. Same shape as the
  // notification catalog's gate, for the same reason.
  const registerPath = resolve(__dirname, 'reachability-register.json');
  const keyOf = (entry: Declared): string => `${entry.file}::${entry.name}`;

  if (process.argv.includes('--keys')) {
    for (const entry of unreached.sort((a, b) => keyOf(a).localeCompare(keyOf(b)))) {
      say(keyOf(entry));
    }
    return;
  }

  let register: Record<string, string> = {};
  try {
    const parsedRegister: unknown = JSON.parse(readFileSync(registerPath, 'utf8'));
    register = parsedRegister as Record<string, string>;
  } catch {
    say('\n  no register at scripts/reachability-register.json — nothing checked');
    return;
  }

  const keys = new Set(unreached.map(keyOf));
  const unexplained = [...keys].filter((key) => register[key] === undefined).sort();
  const stale = Object.keys(register).filter((key) => !keys.has(key)).sort();
  const thin = Object.entries(register).filter(([, reason]) => reason.length < 30).map(([key]) => key);

  say(`\nREGISTER — ${Object.keys(register).length} explained, ${keys.size} unreached`);
  for (const key of unexplained) say(`  UNEXPLAINED  ${key}`);
  for (const key of stale) say(`  NOW REACHED  ${key}  — remove it from the register`);
  for (const key of thin) say(`  NO REASON    ${key}`);

  if (unexplained.length + stale.length + thin.length > 0) {
    warn('\n  FAIL  the register and the tree disagree.');
    process.exit(1);
  }
  say('  ok   every unreached declaration is explained, and every explanation still applies');

}

main();
