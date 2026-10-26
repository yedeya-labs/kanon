import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';
import ts from 'typescript';

/**
 * kanon#1345: the local modules a hosted function links, directly or through another, so each
 * one can be held to an `always` escalation path. A change to any of them changes the deployed
 * function's code, and reaches it through the release and the Owner's deploy dispatch unread
 * unless the Owner merges it.
 *
 * From each entry it follows, transitively and from the module's syntax alone, never its
 * comments (so a JSDoc `import('…')` type is no edge):
 *
 * - a static `import … from '…'`, a bare `import '…'`, and an `export … from '…'`;
 * - a dynamic `import('…')` whose specifier is a literal (a string, or a template with no
 *   substitution), which `scripts/status/views.mjs` uses to load a view only when it is asked for;
 * - a `new URL('…', import.meta.url)` with a literal specifier, which is how a module names a
 *   file it loads another way, the promotion view's worker among them.
 *
 * A `node:` built-in or a package is the runtime's or the lock file's, so it is skipped. Anything
 * this can't follow to a file is a problem, never a silent gap: a dynamic `import()`, a
 * `require()` or a `new URL(…, import.meta.url)` whose specifier isn't a literal, a `new Worker()`
 * whose script isn't a literal `new URL()`, and a relative specifier that names no file.
 */

export const ROOT = process.cwd();

/** This tree's files, with `overrides` (repository-relative path to text) laid over them. */
export type Tree = { isFile: (rel: string) => boolean; text: (rel: string) => string };
export function treeOf(overrides: Readonly<Record<string, string>> = {}): Tree {
  return {
    isFile: (rel) => rel in overrides || (existsSync(join(ROOT, rel)) && statSync(join(ROOT, rel)).isFile()),
    text: (rel) => overrides[rel] ?? readFileSync(join(ROOT, rel), 'utf8'),
  };
}

/** What the walk found: each linked module, and each load it could not follow. */
export type Closure = { modules: string[]; problems: string[] };

const literal = (node: ts.Node | undefined): string | null =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;

const isImportMetaUrl = (node: ts.Node | undefined) =>
  !!node && ts.isPropertyAccessExpression(node) && node.name.text === 'url'
  && ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword;

/** Whether a node is a `new URL(…, import.meta.url)`: a file named next to the module. */
const isModuleUrl = (node: ts.Node | undefined): node is ts.NewExpression =>
  !!node && ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL'
  && isImportMetaUrl(node.arguments?.[1]);

/** A `new URL(<literal>, import.meta.url)`'s specifier, or null. */
const urlSpecifier = (node: ts.Node | undefined): string | null => (isModuleUrl(node) ? literal(node.arguments?.[0]) : null);

/**
 * One module's local loads, one step on: the specifiers it links, and what it loads by a
 * specifier this can't read. `dynamicImports: false` stops following `import()`, which only a
 * mutation check of the guard asks for.
 */
export function moduleLoads(file: string, text: string, options: { dynamicImports?: boolean } = {}): { specifiers: string[]; unreadable: string[] } {
  const followDynamic = options.dynamicImports ?? true;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /\.ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const specifiers: string[] = [];
  const unreadable: string[] = [];
  const where = (node: ts.Node) => `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const s = literal(node.moduleSpecifier);
      if (s !== null) specifiers.push(s);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const s = literal(node.arguments[0]);
      if (s === null) unreadable.push(`${where(node)}: a dynamic import() whose specifier isn't a literal`);
      else if (followDynamic) specifiers.push(s);
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      const s = literal(node.arguments[0]);
      if (s === null) unreadable.push(`${where(node)}: a require() whose specifier isn't a literal`);
      else specifiers.push(s);
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Worker') {
      const arg = node.arguments?.[0];
      if (urlSpecifier(arg) === null && literal(arg) === null) unreadable.push(`${where(node)}: a new Worker() whose script isn't a literal new URL(…, import.meta.url)`);
      else if (literal(arg) !== null) specifiers.push(literal(arg)!);
    } else if (isModuleUrl(node)) {
      const s = urlSpecifier(node);
      if (s === null) unreadable.push(`${where(node)}: a new URL(…, import.meta.url) whose specifier isn't a literal`);
      else specifiers.push(s);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { specifiers, unreadable };
}

const rel = (abs: string) => relative(ROOT, abs).split(sep).join('/');

/**
 * Every local module the entries link, the entries included, sorted, with what the walk could
 * not follow. A specifier that isn't relative (`node:fs`, `yaml`) is the runtime's or a package's.
 */
export function importClosure(entries: readonly string[], options: { tree?: Tree; dynamicImports?: boolean } = {}): Closure {
  const tree = options.tree ?? treeOf();
  const seen = new Set<string>();
  const problems: string[] = [];
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const { specifiers, unreadable } = moduleLoads(file, tree.text(file), options);
    problems.push(...unreadable);
    for (const s of specifiers) {
      if (!/^\.{1,2}\//.test(s)) continue;
      const target = rel(normalize(join(ROOT, dirname(file), s)));
      const resolved = [target, target.replace(/\.js$/, '.ts')].find((f) => tree.isFile(f));
      if (resolved === undefined) problems.push(`${file}: '${s}' names no file in this tree`);
      else if (!seen.has(resolved)) queue.push(resolved);
    }
  }
  return { modules: [...seen].sort(), problems };
}

/** Every code file under a directory, repository-relative: a hosted function's entries. */
export function codeFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(join(ROOT, d))) {
      const p = `${d}/${name}`;
      if (statSync(join(ROOT, p)).isDirectory()) walk(p);
      else if (/\.(?:mjs|cjs|js|ts)$/.test(name)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}
