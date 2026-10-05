// Labels on first use (plan 0005 §5.3, `K-WORK-12`). A lane that is about to apply a label the
// repository lacks creates it first, with the taxonomy's colour and description, and says so.
//
// THE TAXONOMY IS `rulebook/labels.json`, the machine-readable twin of `K-WORK-12`'s table;
// `tests/unit/labels.test.ts` fails when the two disagree. Nothing here names a label.
//
// A NAME OUTSIDE THE TAXONOMY IS NEVER CREATED. It is a bug in whatever applies it, so it fails
// by name, before anything is created: one unknown name in a batch creates none of the batch.
// A label the repository already has is left alone whatever it is, so an adopter's own labels,
// which a brief may name, still apply as they did.
//
// AN UNREADABLE LABEL LIST CREATES NOTHING AND STOPS NOTHING. The apply that follows then
// behaves exactly as it did before this file existed: it succeeds on a label that exists and
// fails, loudly and by name, on one that doesn't. Refusing the apply over a failed read would
// turn a reporting surface into an outage.

import { appendFileSync, readFileSync } from 'node:fs';

/** @typedef {{ name: string, family: string, color: string, description: string, createdBy?: string }} TaxonomyLabel */
/** @typedef {(args: string[]) => string} GhRun */

/** @type {TaxonomyLabel[]} */
export const TAXONOMY = JSON.parse(readFileSync(new URL('../../rulebook/labels.json', import.meta.url), 'utf8')).labels;

/** A label name, quoted for a message. */
const q = (/** @type {string} */ name) => `\`${name}\``;

/**
 * The taxonomy entry for a concrete label name, with a template filled in (`project:27` gets
 * `project:<n>`'s colour and its description for project #27), or null for a name outside it.
 * @param {string} name
 * @returns {TaxonomyLabel | null}
 */
export function taxonomyLabel(name) {
  const exact = TAXONOMY.find((l) => l.name === name);
  if (exact) return exact;
  for (const l of TAXONOMY) {
    const m = /^([^<]*)<([a-z]+)>$/.exec(l.name);
    if (!m || !name.startsWith(m[1] ?? '')) continue;
    const value = name.slice((m[1] ?? '').length);
    // `<n>` is a number; any other placeholder is a lowercase slug.
    if (!(m[2] === 'n' ? /^[1-9]\d*$/ : /^[a-z][a-z0-9-]*$/).test(value)) continue;
    return { ...l, name, description: l.description.replace(new RegExp(`#${m[2]}\\b`), `#${value}`) };
  }
  return null;
}

/** Thrown for a name the taxonomy doesn't hold, or one no lane creates; nothing is created. */
export class LabelError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'LabelError';
  }
}

/**
 * The labels a `gh` invocation applies: `issue|pr create|edit` with `--label`/`-l` or
 * `--add-label`, in the separate or the `=` form, comma-separated lists split. Anything else
 * (a `list --label` filter, a `--remove-label`) applies nothing.
 * @param {readonly string[]} args
 * @returns {string[]}
 */
export function appliedByArgs(args) {
  if (!['issue', 'pr'].includes(args[0] ?? '') || !['create', 'edit'].includes(args[1] ?? '')) return [];
  const out = [];
  for (let i = 2; i < args.length; i++) {
    const a = args[i] ?? '';
    const eq = /^--(?:add-)?label=(.*)$/s.exec(a);
    const value = eq ? eq[1] : ['--label', '-l', '--add-label'].includes(a) ? args[++i] : undefined;
    if (value != null) out.push(...value.split(',').map((s) => s.trim()).filter(Boolean));
  }
  return out;
}

/** The `--repo` an invocation names, or undefined. @param {readonly string[]} args */
const repoOf = (args) => {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo' || args[i] === '-R') return args[i + 1];
    const m = /^--repo=(.+)$/.exec(args[i] ?? '');
    if (m) return m[1];
  }
  return undefined;
};

/** The live label names of each repository this process has read. Repository facts, so one
 *  read serves every call and every token. @type {Map<string, Set<string>>} */
const LIVE = new Map();

/** For tests that run several fixtures in one process. */
export const forgetLiveLabels = () => LIVE.clear();

/** Above this many labels the list is treated as truncated, as `label-guard.mjs` does. */
const READ_CAP = 1000;

/** @param {string} line */
const report = (line) => {
  console.log(line);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    try { appendFileSync(summary, `${line.replace(/^::\w+ title=[^:]*::/, '')}\n\n`); } catch { /* a summary is never worth failing a lane */ }
  }
};

/**
 * Create every label in `names` the repository lacks, from the taxonomy. Throws `LabelError`,
 * having created nothing, when a missing name is outside the taxonomy or is one no lane
 * creates. Returns the names it created.
 *
 * @param {readonly string[]} names
 * @param {{ repo?: string, run: GhRun }} io  `run` executes one `gh` invocation and returns stdout
 * @returns {string[]}
 */
export function ensureLabels(names, { repo, run }) {
  const wanted = [...new Set(names)];
  if (!wanted.length) return [];
  const key = repo ?? '';
  const R = repo ? ['--repo', repo] : [];
  let live = LIVE.get(key);
  if (!live) {
    try {
      const listed = /** @type {{ name: string }[]} */ (JSON.parse(run(['label', 'list', ...R, '--limit', String(READ_CAP), '--json', 'name']))).map((l) => l.name);
      if (listed.length >= READ_CAP) throw new Error(`the list came back at its cap of ${READ_CAP}, so it may be truncated`);
      live = new Set(listed);
      LIVE.set(key, live);
    } catch (err) {
      console.log(`::warning title=labels::could not read the repository's labels, so none was created before applying ${wanted.map(q).join(', ')} — ${String(/** @type {Error} */ (err)?.message ?? err).split('\n')[0]}`);
      return [];
    }
  }
  const missing = wanted.filter((n) => !live.has(n));
  const refused = missing.flatMap((n) => {
    const t = taxonomyLabel(n);
    if (!t) return [`${q(n)} is not in Kanon's label taxonomy (K-WORK-12, rulebook/labels.json), so it is never created`];
    if (t.createdBy) return [`${q(n)} is created by ${t.createdBy}`];
    return [];
  });
  if (refused.length) throw new LabelError(`refusing to apply labels the repository lacks: ${refused.join('; ')}. Nothing was created.`);
  const created = [];
  for (const n of missing) {
    const t = /** @type {TaxonomyLabel} */ (taxonomyLabel(n));
    try {
      run(['label', 'create', n, ...R, '--color', t.color, '--description', t.description]);
    } catch (err) {
      const why = String(/** @type {{ stderr?: unknown }} */ (err)?.stderr ?? /** @type {Error} */ (err)?.message ?? err);
      // A concurrent lane created it between the read and now: it exists, which is the point.
      if (!/already exists/i.test(why)) {
        console.log(`::warning title=labels::could not create ${q(n)} — ${why.split('\n')[0]}`);
        continue;
      }
    }
    live.add(n);
    created.push(n);
    report(`::notice title=labels::Created the label ${q(n)} (#${t.color}, "${t.description}"), which this repository lacked, before applying it (K-WORK-12).`);
  }
  return created;
}

/**
 * Create-before-apply for one `gh` invocation: a no-op unless it applies labels. Each labelling
 * script calls this from its `gh` wrapper, with the runner that wrapper uses, so the label is
 * created with the same token that applies it.
 * @param {readonly string[]} args
 * @param {GhRun} run
 */
export function beforeApply(args, run) {
  const names = appliedByArgs(args);
  if (names.length) ensureLabels(names, { repo: repoOf(args) ?? process.env.REPO ?? process.env.GITHUB_REPOSITORY, run });
}
