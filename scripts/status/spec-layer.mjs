// The spec layer, and the tests that cite it, as they stand on the default branch (project #1327,
// `[STAT-2]`, `[STAT-4]`). The same reading rules as the checkout's tools, `spec-lib.mjs` and
// `spec-coverage.mjs`, over files read through the injected reader rather than from a checkout.

import { declaredPrefix, idPatternOf, parseSpecText, SPEC_DIR } from '../spec-lib.mjs';
import { citationsIn } from '../spec-coverage.mjs';
import { STACK_FILE, UNDECLARED, parseCodeAreas } from '../lib/code-areas.mjs';
import { isTestFile } from '../lib/test-conventions.mjs';
import { ReadError, graphqlRead, ownerAndName } from './reader.mjs';

/**
 * @typedef {{ id: string, status: string, file: string, text: string }} Clause one invariant
 * @typedef {{ prefixes: string[], clauses: Map<string, Clause> }} SpecLayer
 */

/**
 * Every invariant the spec layer declares, by id. No spec directory is no invariants; a spec that
 * declares no area prefix throws by its name, as `loadPrefixes` does for the checkout.
 * @param {import('../lib/declarations.mjs').BranchFiles} files
 * @returns {Promise<SpecLayer>}
 */
export async function readSpecLayer(files) {
  const names = (await files.list(SPEC_DIR)).filter((e) => e.type === 'file' && e.name.endsWith('.md')).map((e) => e.name).sort();
  /** @type {string[]} */
  const prefixes = [];
  /** @type {Map<string, Clause>} */
  const clauses = new Map();
  for (const name of names) {
    const text = await files.read(`${SPEC_DIR}/${name}`);
    if (text === null) continue;
    const { prefix, problems } = declaredPrefix(text.split('\n'), name);
    if (!prefix) throw new Error(`${SPEC_DIR}/${name} on \`${files.branch}\`: ${problems.join('; ')}`);
    prefixes.push(prefix);
    for (const d of parseSpecText(name, text)) {
      if (d.legend || !d.id) continue;
      clauses.set(d.id, { id: d.id, status: d.status, file: `${SPEC_DIR}/${name}`, text: d.text });
    }
  }
  return { prefixes, clauses };
}

/** How many blobs one GraphQL read asks for. */
const BLOBS_PER_QUERY = 50;
const OID = /^[0-9a-f]{40}$/;

/**
 * ID → the test files that cite it in a title, as `spec-coverage.mjs`'s `citations()` reads the
 * checkout: the test files are the ones the stack document's `tests` trees declare (`K-LAYOUT-17`),
 * read from the default branch's tree. A tree GitHub cut short, or a file it sent truncated, is a
 * failed read (`[STAT-3]`), never fewer citations.
 * @param {import('./reader.mjs').Reader} reader
 * @param {string} repo
 * @param {import('../lib/declarations.mjs').BranchFiles} files
 * @param {string[]} prefixes the spec layer's area prefixes
 * @returns {Promise<Map<string, Set<string>>>}
 */
export async function readCitations(reader, repo, files, prefixes) {
  if (!prefixes.length) return new Map();
  const stack = await files.read(STACK_FILE);
  const trees = (stack === null ? UNDECLARED : parseCodeAreas(stack)).tests;
  const treeRead = `repos/${repo}/git/trees/${encodeURIComponent(files.branch)}?recursive=1`;
  const tree = /** @type {{ tree?: Array<{ path?: string, type?: string, sha?: string }>, truncated?: boolean }} */ (await reader.get(treeRead));
  if (!Array.isArray(tree?.tree)) throw new ReadError(`GET ${treeRead}`, 'the answer has no tree');
  if (tree.truncated) throw new ReadError(`GET ${treeRead}`, 'GitHub cut the tree short, so not every test file was listed');
  const tests = tree.tree.filter((e) => e.type === 'blob' && typeof e.path === 'string' && isTestFile(e.path, trees));
  /** @type {{ file: string, text: string }[]} */
  const texts = [];
  for (let at = 0; at < tests.length; at += BLOBS_PER_QUERY) {
    const batch = tests.slice(at, at + BLOBS_PER_QUERY);
    const fields = batch.map((e, i) => {
      if (!OID.test(String(e.sha))) throw new ReadError(`GET ${treeRead}`, `${e.path} has no blob id`);
      return `b${i}: object(oid: "${e.sha}") { ... on Blob { text isTruncated isBinary } }`;
    });
    const query = `query TestFiles($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields.join(' ')} } }`;
    const repository = /** @type {any} */ (await reader.graphql(query, ownerAndName(repo)))?.repository;
    batch.forEach((e, i) => {
      const blob = repository?.[`b${i}`];
      if (!blob) throw new ReadError(graphqlRead(query), `${e.path} came back empty`);
      if (blob.isBinary) return;
      if (blob.isTruncated || typeof blob.text !== 'string') throw new ReadError(graphqlRead(query), `${e.path} came back truncated`);
      texts.push({ file: /** @type {string} */ (e.path), text: blob.text });
    });
  }
  return citationsIn(texts, idPatternOf(prefixes));
}
