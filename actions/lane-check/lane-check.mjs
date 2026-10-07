// lane-check's rules, in one Node process (kanon#381). `lane-check.sh` checks it can run and
// starts this; see it for what lane-check is and how it is run.
//
// Until kanon#381 the shell script did this work itself, with a `yq` and several `jq` processes
// per caller, per input, per secret and per permission: about a second a run, most of it process
// starts. This does the same checks, in the same order and with the same messages, and parses
// YAML with `yq` (mikefarah v4, decision 6) in one batch for the adopter's files and one for
// Kanon's: the action has no `node_modules`, so `yq` stays the YAML parser. The App register and
// the test-database declaration are still read by their awk programs, which the lanes run too,
// and the declarations by `declarations.mjs`'s readers, in this process.
//
//   node lane-check.mjs <stack section>...
//     each argument `<heading>|<its default>` ('' when it has none): the stack document's
//     sections, which lane-check.sh lists (tests/unit/helpers/requirements.ts reads them there)
//
// ENV  KANON_ROOT   Kanon's tree (default: this script's ../..)
//      ACTION_REF   the ref this action was called at
//
// Prints one `::error` per violation and exits 1 if there is any; exits 2 when it cannot run.
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { declarationFindings } from './declarations.mjs';
import { LEDGER, readCapabilityWatch } from '../../scripts/lib/capability-watch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const KANON_ROOT = process.env.KANON_ROOT || join(HERE, '../..');
const ACTION_REF = process.env.ACTION_REF ?? '';
const SPINE = 'agent-lane';
const SPINE_JOB = 'lane-agent-job';
const HOOK = '.github/actions/project-setup/action.yml';
const REGISTER = 'docs/qa/agent-identities.md';
const DATABASE = 'docs/qa/test-database.md';
/** `heading|default` per stack section, as lane-check.sh's STACK_SECTIONS lists them. */
const STACK_SECTIONS = process.argv.slice(2);

/** @param {string} s */
const out = (s) => process.stdout.write(`${s}\n`);
/** @param {string} msg @returns {never} */
const die = (msg) => {
  out(`::error title=lane-check::${msg}`);
  process.exit(2);
};
let ERRORS = 0;
let DEFAULTS = 0;
/** @param {string} file @param {string} msg */
const fail = (file, msg) => {
  out(`::error file=${file},title=lane-check::${msg}`);
  ERRORS += 1;
};
/** A default taken (plan 0005 §5.2). @param {string} file @param {string} msg */
const note = (file, msg) => {
  out(`::notice file=${file},title=lane-check::${msg}`);
  DEFAULTS += 1;
};

// ── jq's semantics, where the shell script's messages depend on them ────────────────────
/** @param {unknown} v */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** jq's `a // b`: `b` when `a` is null or false. @param {unknown} a @param {unknown} b @returns {any} */
const alt = (a, b) => (a === null || a === undefined || a === false ? b : a);
/** jq's `tostring`. @param {unknown} v */
const tostring = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? null));
/** jq's `-r` output of one value, as `$(...)` keeps it. @param {unknown} v */
const raw = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? null, null, 2)).replace(/\n+$/, '');
/** jq's `keys`: sorted by codepoint. @param {Record<string, unknown>} o */
const keys = (o) => Object.keys(o).sort(cmp);
/** Codepoint order, as jq's `sort` and `sort -u` in the C locale. @param {string} a @param {string} b */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** `sort -u`. @param {string[]} xs */
const sortU = (xs) => [...new Set(xs)].sort(cmp);
/** jq's `@tsv` escaping of one field. @param {string} s */
const tsv = (s) => s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
/** jq's `index($x) != null` on an array (an element) or a string (a substring). @param {unknown} v @param {string} x */
const has = (v, x) => {
  if (Array.isArray(v)) return v.includes(x);
  if (typeof v === 'string') return v.includes(x);
  if (v === null || v === undefined) return false;
  throw new Error('jq: cannot index');
};
/** POSIX `[[:space:]]` in the C locale. */
const SP = '[ \\t\\n\\v\\f\\r]';

// ── YAML, through yq, in batches ────────────────────────────────────────────────────────
/** @type {Map<string, { ok: boolean, doc?: unknown }>} */
const parsed = new Map();
/** Parse `files` with one yq process, or, if any fails to parse, one per file. @param {string[]} files */
const parseAll = (files) => {
  const todo = files.filter((f) => !parsed.has(f) && isFile(f));
  for (const f of files) if (!parsed.has(f) && !isFile(f)) parsed.set(f, { ok: false });
  if (todo.length === 0) return;
  const r = spawnSync('yq', ['-o=json', '-I=0', '{"f": filename, "i": document_index, "d": .}', ...todo], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) {
    if (todo.length === 1) parsed.set(/** @type {string} */ (todo[0]), { ok: false });
    else for (const f of todo) parseAll([f]);
    return;
  }
  /** @type {Map<string, unknown>} */
  const docs = new Map();
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    const { f, i, d } = JSON.parse(line);
    if (i === 0) docs.set(f, d);
  }
  // An empty file, or one of only comments, is `null` to `yq '.'`.
  for (const f of todo) parsed.set(f, { ok: true, doc: docs.has(f) ? docs.get(f) : null });
};
/** The JSON of a YAML file, or `undefined` when it doesn't parse (or doesn't exist). @param {string} f */
const json = (f) => {
  parseAll([f]);
  const p = /** @type {{ ok: boolean, doc?: unknown }} */ (parsed.get(f));
  return p.ok ? p.doc : undefined;
};
/** `[ -f ]`. @param {string} f */
function isFile(f) {
  try { return statSync(f).isFile(); } catch { return false; }
}
/** `sed -n 's/^<prefix>//p'`. @param {string} file @param {string} prefix */
const marked = (file, prefix) => readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length));
/** Unquoted `$(...)` in a `for`: split on whitespace. @param {string[]} xs */
const words = (xs) => xs.flatMap((x) => x.split(/[ \t\n]+/)).filter(Boolean);
/** awk, with stdout and stderr as `$(... 2>&1)` keeps them. @param {string[]} args */
const awk = (args) => {
  const r = spawnSync('awk', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\n+$/, '') };
};

// ── Every Kanon reference under .github/ names one exact version ────────────────────────
// Comments are skipped: a commented-out example is not a pin.
/** `find <dir> -type f -name '*.yml' -o -name '*.yaml'`. @param {string} dir @returns {string[]} */
const ymlFiles = (dir) => {
  /** @type {string[]} */
  let found = [];
  /** @type {string[]} */
  let entries;
  try { entries = readdirSync(dir); } catch { return found; }
  for (const e of entries) {
    const p = join(dir, e);
    let st;
    try { st = lstatSync(p); } catch { continue; }
    if (st.isDirectory()) found = found.concat(ymlFiles(p));
    else if (st.isFile() && (e.endsWith('.yml') || e.endsWith('.yaml'))) found.push(p);
  }
  return found;
};
const REF = new RegExp(`yedeya-labs/kanon/[^@ \\t\\n\\v\\f\\r]+@[^ \\t\\n\\v\\f\\r"']+`, 'g');
const TAGS = sortU(ymlFiles('.github').flatMap((f) => readFileSync(f, 'utf8').split('\n')
  .filter((l) => l.includes('yedeya-labs/kanon/') && !new RegExp(`^${SP}*#`).test(l))
  .flatMap((l) => [...l.matchAll(REF)].map((m) => m[0].slice(m[0].lastIndexOf('@') + 1)))));
const EXACT = /^v[0-9]+\.[0-9]+\.[0-9]+$/;
for (const tag of TAGS) {
  if (!EXACT.test(tag)) fail('.github', `a Kanon reference pins '${tag}', not an exact version vX.Y.Z (K-ADOPT-11)`);
}
if (TAGS.length > 1) {
  fail('.github', `Kanon references pin ${TAGS.join(',')}: every caller, action and lane must pin one version`);
}
if (EXACT.test(ACTION_REF) && TAGS.length > 0 && TAGS.join('\n') !== ACTION_REF) {
  fail('.github', `lane-check runs at ${ACTION_REF}, but the Kanon references pin ${TAGS.join(',')}`);
}

// ── The callers ─────────────────────────────────────────────────────────────────────────
/** @param {unknown} v */
const level = (v) => (v === 'write' ? 2 : v === 'read' ? 1 : 0);
/**
 * Is this workflow document a reusable workflow? `on: workflow_call`, as a key, a list item or
 * the one event. @param {unknown} doc
 */
const isReusable = (doc) => {
  if (!isObject(doc)) return false;
  const o = /** @type {Record<string, unknown>} */ (doc).on;
  return (isObject(o) && Object.hasOwn(/** @type {object} */ (o), 'workflow_call')) || (Array.isArray(o) && o.includes('workflow_call')) || o === 'workflow_call';
};
/** The workflow files, as the shell's two globs list them. @param {string} ext */
const glob = (ext) => {
  try {
    return readdirSync('.github/workflows').filter((f) => !f.startsWith('.') && f.endsWith(ext)).sort(cmp).map((f) => `.github/workflows/${f}`);
  } catch { return []; }
};
const WORKFLOWS = [...glob('.yml'), ...glob('.yaml')];
// One yq for Kanon's lanes and the spine's agent job, and one for the adopter's files: its
// workflows, the hooks, and the Dependabot file.
const kanonWorkflows = join(KANON_ROOT, '.github/workflows');
/** @type {string[]} */
let kanonLanes = [];
try { kanonLanes = readdirSync(kanonWorkflows).filter((f) => f.endsWith('.yml')).sort(cmp).map((f) => join(kanonWorkflows, f)); } catch { /* none */ }
parseAll(kanonLanes);
const neededHooks = kanonLanes.flatMap((f) => { try { return words(marked(f, '# NEEDS HOOK: ')); } catch { return []; } });
parseAll([...WORKFLOWS, HOOK, ...neededHooks, '.github/dependabot.yml']);

// Kanon's own source tree: the spine as a reusable workflow, and this check's own script, at
// the paths Kanon ships them. No adopter's repository holds both.
const KANON_TREE = isFile('actions/lane-check/lane-check.sh') && isFile(`.github/workflows/${SPINE}.yml`) && isReusable(json(`.github/workflows/${SPINE}.yml`));
let CALLERS = 0;
/** @type {string[]} */
const CALLED = [];
/** @type {string[]} */
const ROLES = [];
/** @type {Array<[string, string]>} */
const DOCS = [];
/** @type {Array<[string, string]>} */
const READS = [];
/** @type {Array<[string, string]>} */
const HOOKS = [];
/**
 * A Kanon workflow's file, then every workflow of Kanon's it calls through `$/`, transitively
 * (kanon#279: a lane's agent job runs in a called workflow, beside the job that mints its token).
 * @param {string} f @param {string[]} seen @returns {string[]}
 */
const laneFiles = (f, seen = []) => {
  const files = [f];
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { return files; }
  const called = sortU(text.split('\n').flatMap((l) => {
    const m = /^ *uses: \$\/\.github\/workflows\/([A-Za-z0-9_.-]*\.ya*ml) *$/.exec(l);
    return m ? [/** @type {string} */ (m[1])] : [];
  }));
  let mine = [...seen];
  for (const c of called) {
    if (mine.includes(c)) continue;
    mine = [...mine, c];
    files.push(...laneFiles(join(KANON_ROOT, '.github/workflows', c), mine));
  }
  return files;
};
const DOC_RE = /docs\/qa\/(stack|capability-ledger|[a-z]+(-[a-z]+)*-playbook)\.md/g;
const LANE_RE = /^yedeya-labs\/kanon\/\.github\/workflows\/([A-Za-z0-9_.-]+)\.ya?ml@/;

for (const f of WORKFLOWS) {
  if (!isFile(f)) continue;
  const parsedDoc = json(f);
  if (parsedDoc === undefined) { fail(f, 'is not valid YAML'); continue; }
  const doc = /** @type {any} */ (parsedDoc);
  const jobsOf = (/** @type {any} */ d) => (isObject(d) ? alt(d.jobs, {}) : {});
  const jobs = jobsOf(doc);
  const lanes = Object.values(jobs).flatMap((j) => {
    const uses = isObject(j) ? alt(/** @type {any} */ (j).uses, undefined) : undefined;
    const m = typeof uses === 'string' ? LANE_RE.exec(uses) : null;
    return m ? [/** @type {string} */ (m[1])] : [];
  });
  // Only a call to a LANE makes a file a caller, and a lane is an `agent-*` workflow. Kanon's
  // other reusable workflows (the release workflow, apps-check) are not lanes: they take
  // their own secrets, or none, and their callers are held to no lane caller rule, only to
  // the pin above and the secrets rule just below (kanon#152). The spine is called by lanes
  // that have not moved yet; it is not a lane either, and its callers are not trigger-only.
  const lane = lanes.find((l) => l.startsWith('agent-') && l !== SPINE) ?? '';
  // Not a lane, but still Kanon's code: a job that calls any other Kanon workflow maps the
  // secrets it passes by name, or passes none, and never `secrets: inherit` (plan 0001
  // decision 7, K-AGENT-47). A lane caller is held to the same below, with its lane's names,
  // so only the job calling the lane picked above is left to that rule: a call to the spine, or
  // to any lane but that one, is held here (kanon#500).
  for (const [name, value] of Object.entries(jobs)) {
    if (!isObject(value)) continue;
    const v = /** @type {any} */ (value);
    const m = LANE_RE.exec(tostring(alt(v.uses, '')));
    if (!m) continue;
    const wf = /** @type {string} */ (m[1]);
    if (wf === lane || !Object.hasOwn(v, 'secrets') || isObject(v.secrets)) continue;
    if (!tsv(name)) continue;
    fail(f, `the job \`${tsv(name)}\` calls Kanon's ${tsv(wf)} workflow with \`secrets: ${tsv(tostring(v.secrets))}\`; map each secret it takes by name, or pass none (\`secrets: inherit\` would hand every secret to Kanon's code; plan 0001 decision 7)`);
  }
  if (!lane) continue;
  CALLERS += 1;
  CALLED.push(lane);
  const laneFile = join(KANON_ROOT, '.github/workflows', `${lane}.yml`);
  if (!isFile(laneFile)) {
    fail(f, `calls Kanon lane '${lane}', which this Kanon version does not ship`);
    continue;
  }
  const laneParsed = json(laneFile);
  if (laneParsed === undefined) die(`Kanon's ${lane}.yml does not parse`);
  const laneDoc = /** @type {any} */ (laneParsed);

  // Every caller lives at its lane's own file name (K-LAYOUT-18, kanon#207). Kanon's scripts
  // find a lane's runs, and dispatch it, by the caller's file name: the review lane's
  // (`merge-gate.mjs`, the review-run evidence), the revise lanes' (the reconciler), and every
  // caller's (the health check, which watches `agent-*.yml`). Under another name those reads
  // come back empty, which the recoveries read as "nothing is parked".
  //
  // GitHub files a run under the TOP-LEVEL workflow's file name, so a caller that is itself a
  // reusable workflow, a wrapper some other workflow calls, has its runs filed under that other
  // name even at the right path (kanon#217). It is refused.
  if (isReusable(doc)) {
    fail(f, `calls the Kanon lane ${lane} but is itself a reusable workflow (\`on: workflow_call\`): GitHub files its runs under the workflow that calls it, so Kanon's scripts can't find them by this file name. Put the lane's triggers here and call the lane from this file (K-LAYOUT-18)`);
  }
  // The one exception to the path: Kanon's own repository, where `.github/workflows/<lane>.yml`
  // holds the lane itself, so its caller can't take that path (its review caller is
  // `review.yml`). Recognised by the checkout being Kanon's source tree (`KANON_TREE` above),
  // and the file at the lane's path being a reusable workflow, never by a name or setting an
  // adopter could share by accident (kanon#217).
  if (f !== `.github/workflows/${lane}.yml`) {
    const taken = json(`.github/workflows/${lane}.yml`) ?? {};
    if (!(KANON_TREE && isReusable(taken))) {
      fail(f, `calls the Kanon lane ${lane}, so it lives at .github/workflows/${lane}.yml: Kanon's scripts find this lane's runs, and dispatch it, by that file name (K-LAYOUT-18)`);
    }
  }
  // The workflows of the adopter's own that the lane reads by file name, on `# READS WORKFLOW:
  // <file>` lines in the lane (the review lane and the reconciler read CI's runs from `ci.yml`).
  for (const w of words(marked(laneFile, '# READS WORKFLOW: '))) READS.push([w, lane]);
  // The hooks of the adopter's own that only some lanes call, on `# NEEDS HOOK: <path>` lines
  // in the lane (the Explorer's sweep hook, plan 0004 decision 5). The project-setup hook,
  // which every lane that checks out calls, is checked on its own below.
  for (const h of words(marked(laneFile, '# NEEDS HOOK: '))) HOOKS.push([h, lane]);

  // Only `on`, `permissions` and one job (and a `name` and a `run-name`). No `concurrency`:
  // the lane holds its own group, and the same group on the caller would deadlock the two
  // (decision 11).
  const extra = keys(doc).filter((k) => !['name', 'run-name', 'on', 'permissions', 'jobs'].includes(k)).join(', ');
  if (extra) fail(f, `a lane caller holds only name, run-name, on, permissions and one job; it also has: ${extra}`);

  // A run's title is its caller's: a called workflow's `run-name` is ignored. A lane whose
  // title is read by another program (the review lane's, by the review-run evidence) says
  // what the caller's title must end with, on a `# CALLER RUN-NAME ENDS WITH: <text>` line.
  const wantTitle = marked(laneFile, '# CALLER RUN-NAME ENDS WITH: ')[0] ?? '';
  if (wantTitle) {
    const title = raw(alt(doc['run-name'], ''));
    if (!title.endsWith(` ${wantTitle}`)) {
      fail(f, `its run-name must end with \` ${wantTitle}\`, as the last token: the Kanon lane ${lane}'s runs are found by it`);
    }
  }
  // A check is reported under its caller's `name:`, and a lane whose checks another program
  // tells apart by that name (the Merger's, by `merge-gate.mjs`, which must not wait on itself)
  // says what the caller's name must be, on a `# CALLER NAME: <name>` line (plan 0004 step 7).
  const wantName = marked(laneFile, '# CALLER NAME: ')[0] ?? '';
  if (wantName) {
    const name = raw(alt(doc.name, ''));
    if (name !== wantName) {
      fail(f, `its name must be \`${wantName}\`, not \`${name}\`: GitHub reports the Kanon lane ${lane}'s checks under its caller's name, and the lane tells its own checks from the rest by it (docs/lanes.md)`);
    }
  }
  // The project documents this lane's prompt reads, at their fixed paths (K-LAYOUT-17).
  // Read from the lane itself, so a lane that starts reading one makes it required here, and
  // from the workflows it calls: a lane's agent job, with its prompt, is a called workflow of
  // its own since kanon#279 kept the App key out of it (`K-AGENT-49`).
  const docsRead = laneFiles(laneFile).flatMap((lf) => {
    try { return [...readFileSync(lf, 'utf8').matchAll(DOC_RE)].map((m) => m[0]); } catch { return []; }
  });
  for (const d of sortU(docsRead)) DOCS.push([d, lane]);
  const njobs = Array.isArray(doc.jobs) || typeof doc.jobs === 'string' ? doc.jobs.length : isObject(doc.jobs) ? Object.keys(doc.jobs).length : 0;
  if (String(njobs) !== '1') fail(f, `a lane caller has exactly one job, not ${njobs}`);
  const job = /** @type {any} */ (Object.values(isObject(doc.jobs) ? doc.jobs : {})[0] ?? null);
  const jobExtra = isObject(job) ? keys(job).filter((k) => !['name', 'uses', 'with', 'secrets', 'permissions'].includes(k)).join(', ') : '';
  if (jobExtra) fail(f, `the calling job holds only uses, with, secrets and permissions; it also has: ${jobExtra}`);

  // `with:` only passes the caller's own inputs through, by the same name.
  const onCall = isObject(laneDoc) && isObject(laneDoc.on) ? laneDoc.on.workflow_call : null;
  const declared = keys(alt(isObject(onCall) ? onCall.inputs : null, {}));
  const withs = isObject(job) ? alt(job.with, {}) : {};
  for (const [rk, rv] of Object.entries(isObject(withs) ? withs : {})) {
    const k = tsv(rk);
    const v = tsv(tostring(rv));
    if (!k) continue;
    // `smoke` is declared by every lane, but only Kanon's lanes smoke sets it: any value gives
    // the run a concurrency group of its own, so a caller passing it would run beside its own
    // real runs and lose each group's serialisation (kanon#321).
    if (k === 'smoke') {
      fail(f, "passes `smoke`, which only Kanon's lanes smoke sets: any value gives the run a concurrency group of its own, beside your real runs. Remove it (docs/lanes.md, \"Inputs pass through, by name\")");
      continue;
    }
    if (!declared.includes(k)) fail(f, `passes \`${k}\`, which the Kanon lane ${lane} does not declare`);
    // The key is part of the pattern, as the shell's `[[ =~ ]]` had it; one that isn't a
    // pattern at all matches nothing.
    const through = (() => {
      try { return new RegExp(`^\\$\\{\\{${SP}*inputs\\.${k}${SP}*\\}\\}$`).test(v); } catch { return false; }
    })();
    if (!through) fail(f, `passes \`${k}: ${v}\`; a caller only passes its own input through, as \`\${{ inputs.${k} }}\` (ADR 0002)`);
  }

  // Secrets: exactly the lane's, by their fixed names, each mapped explicitly, except that a
  // caller may leave out one the lane marks `# OPTIONAL SECRET:` and declares `required: false`
  // (kanon#433): the QA store's, which only a repository with a store hook has. GitHub passes an
  // unmapped one empty. Any other optional secret is still mapped, as before.
  const secrets = isObject(job) ? job.secrets : null;
  if (!isObject(secrets)) {
    fail(f, "maps no secrets explicitly (`secrets: inherit` would hand every secret to Kanon's code; plan 0001 decision 7)");
  } else {
    const declared = alt(isObject(onCall) ? onCall.secrets : null, {});
    const declaredKeys = isObject(declared) ? keys(declared) : [];
    const markedOptional = words(marked(laneFile, '# OPTIONAL SECRET: '));
    const optional = declaredKeys.filter((k) => markedOptional.includes(k) && isObject(declared[k]) && declared[k].required === false);
    const got = keys(secrets);
    const want = declaredKeys.filter((k) => !optional.includes(k) || got.includes(k)).join(',');
    if (want !== got.join(',')) {
      const may = optional.length ? `, and may leave out [${optional.join(',')}]` : '';
      fail(f, `maps secrets [${got.join(',')}]; the Kanon lane ${lane} takes exactly [${declaredKeys.join(',')}]${may}`);
    }
    // THE ROLE-NAMED SECRETS ARE GONE (plan 0005 §3.5, step L4): the lanes mint as the Author or
    // the Judge, by fixed names. Named on its own, so an adopter moving the pin reads the rename
    // it has to make rather than only a set difference.
    for (const old of keys(secrets).filter((k) => /^(EXPLORER|IMPLEMENTER|REVIEWER|MERGER|LEAD|OVERSEER)_APP_(ID|PRIVATE_KEY)$/.test(k))) {
      const author = /^(EXPLORER|IMPLEMENTER|LEAD|OVERSEER)_/.test(old);
      const rest = old.slice(old.indexOf('_') + 1);
      fail(f, `maps the role-named secret \`${old}\`; since plan 0005's two Apps the lane takes \`${author ? 'AUTHOR' : 'JUDGE'}_${rest}\` (the ${author ? 'Author' : 'Judge'} App's). Rename the secret and its mapping (docs/apps.md)`);
    }
    for (const [rk, rv] of Object.entries(secrets)) {
      const k = tsv(rk);
      const v = tsv(tostring(rv));
      if (!k) continue;
      if (!new RegExp(`^\\$\\{\\{${SP}*secrets\\.[A-Za-z0-9_]+${SP}*\\}\\}$`).test(v)) fail(f, `maps \`${k}\` to \`${v}\`; map each one to a single repository secret`);
    }
    // The role the lane mints for: its `# KANON ROLE:` line (plan 0005 §3.5). The App secrets
    // name the Author or the Judge, which two or four roles share, so they no longer say it.
    const laneRole = marked(laneFile, '# KANON ROLE: ')[0] ?? '';
    if (laneRole) ROLES.push(laneRole);
  }

  // The permissions ceiling: the calling job must grant at least what the lane declares, at
  // its top level or on any one of its jobs. A job-level grant in a called workflow is still
  // held to the caller's ceiling, so the implement lane's crash recovery, which writes issues
  // on the default token, needs the caller to grant that too.
  const jobPerms = isObject(job) ? job.permissions : null;
  const perms = jobPerms !== null && jobPerms !== undefined ? jobPerms : doc.permissions;
  if (!isObject(perms)) {
    fail(f, "grants no explicit permissions; the calling job's `permissions:` is the lane's ceiling (plan 0001 §3)");
  } else {
    /** @type {Map<string, unknown>} */
    const needs = new Map();
    const grants = [laneDoc.permissions, ...Object.values(isObject(laneDoc.jobs) ? laneDoc.jobs : {}).map((j) => (isObject(j) ? /** @type {any} */ (j).permissions : null))];
    for (const g of grants.filter(isObject)) {
      for (const [scope, need] of Object.entries(g)) {
        if (!needs.has(scope) || level(need) > level(needs.get(scope))) needs.set(scope, need);
      }
    }
    for (const scope of [...needs.keys()].sort(cmp)) {
      const need = tsv(tostring(needs.get(scope)));
      if (!tsv(scope)) continue;
      const have = raw(alt(perms[tsv(scope)], 'none'));
      if (!(level(have) >= level(need))) fail(f, `grants ${tsv(scope)}: ${have}; the Kanon lane ${lane} needs ${tsv(scope)}: ${need}`);
    }
  }
}

if (!(CALLERS > 0)) fail('.github/workflows', 'no workflow calls a Kanon lane (yedeya-labs/kanon/.github/workflows/<lane>.yml@vX.Y.Z)');

/** Each name, sorted, with the lanes that need it. @param {Array<[string, string]>} pairs */
const byName = (pairs) => sortU(pairs.map(([n]) => n)).map((n) => /** @type {[string, string]} */ ([n, sortU(pairs.filter(([m]) => m === n).map(([, l]) => l)).join(',')]));

// ── The workflows the called lanes read by file name (K-LAYOUT-18) ─────────────────────
for (const [w, by] of byName(READS)) {
  if (!isFile(`.github/workflows/${w}`)) fail(`.github/workflows/${w}`, `is missing; the Kanon lane(s) ${by} read its runs by that file name (K-LAYOUT-18)`);
}

// ── The project-setup hook ──────────────────────────────────────────────────────────────
if (!isFile(HOOK)) {
  fail(HOOK, 'the project-setup hook is missing; every lane that checks out calls it (plan 0001 §5)');
} else {
  const hook = /** @type {any} */ (json(HOOK));
  if (hook === undefined) fail(HOOK, 'is not valid YAML');
  // The inputs Kanon passes the hook are read from the spine's own call to it, which sits in
  // the spine's agent job (`lane-agent-job.yml`) since kanon#274 kept the App key out of it.
  const spine = /** @type {any} */ (json(join(KANON_ROOT, '.github/workflows', `${SPINE_JOB}.yml`)));
  const passed = sortU(Object.values(isObject(spine?.jobs) ? spine.jobs : {}).flatMap((j) => (Array.isArray(j?.steps) ? j.steps : []))
    .filter((s) => s?.uses === './.github/actions/project-setup')
    .flatMap((s) => Object.keys(alt(s.with, {}))));
  for (const k of passed) {
    const inputs = hook === undefined ? undefined : alt(hook?.inputs, {});
    if (!(isObject(inputs) && Object.hasOwn(inputs, k))) fail(HOOK, `does not declare the input \`${k}\`, which Kanon's lanes pass it`);
  }
  if ((hook === undefined ? '' : raw(alt(hook?.runs?.using, ''))) !== 'composite') fail(HOOK, 'must be a composite action');
}

// ── The hooks only some lanes call ─────────────────────────────────────────────────────
for (const [h, by] of byName(HOOKS)) {
  if (!isFile(h)) {
    fail(h, `is missing; the Kanon lane(s) ${by} call it`);
  } else {
    const d = /** @type {any} */ (json(h));
    if ((d === undefined ? '' : raw(alt(d?.runs?.using, ''))) !== 'composite') fail(h, `must be a composite action; the Kanon lane(s) ${by} call it`);
  }
}

// ── The project documents the lanes read (K-LAYOUT-17) ────────────────────────────────
// Each one a called lane's prompt names must exist, unless Kanon ships a baseline for it: a
// missing playbook is Kanon's baseline for the role, which the lane's agent-setup block puts in
// its place (plan 0005 §5.2). The stack document must exist, with `## Gates` exactly once outside
// a fenced block: it has no default. Its other three sections may be left out, and then mean
// none; each that is present is there once, because the prompts send the agent to a section by
// its heading.
const BASELINES = join(KANON_ROOT, 'rulebook/templates/playbooks');
const FENCE = /^[ \t]*(```|~~~)/;
/** awk's `tolower`, on ASCII. @param {string} s */
const lower = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
// The capability ledger is needed only where the capability watch is on (kanon#477): the
// adoption record's `Capability watch:` choice, off by default. A malformed choice is named below,
// with the record's other declarations, and the ledger is held as needed meanwhile.
const watchOn = (() => {
  try { return readCapabilityWatch(process.cwd()) === 'on'; } catch { return true; }
})();
for (const [d, by] of byName(DOCS)) {
  if (!isFile(d) && d === LEDGER && !watchOn) {
    note(d, `doesn't exist, which is fine: the adoption record doesn't turn the capability watch on under \`## Choices\`, so the Kanon lane(s) ${by} skip the capability review and don't read it (K-LAYOUT-10, kanon#477)`);
    continue;
  }
  if (!isFile(d)) {
    if (isFile(join(BASELINES, basename(d)))) note(d, `doesn't exist, so the Kanon lane(s) ${by} read Kanon's baseline for it (plan 0005 §5.2, K-LAYOUT-17)`);
    else fail(d, `is missing; the Kanon lane(s) ${by} read it (K-LAYOUT-17)`);
    continue;
  }
  if (d !== 'docs/qa/stack.md') continue;
  const lines = readFileSync(d, 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const s of STACK_SECTIONS) {
    const h = s.slice(0, s.indexOf('|'));
    const means = s.slice(s.indexOf('|') + 1);
    let n = 0;
    let near = 0;
    let fenced = false;
    for (const l of lines) {
      if (FENCE.test(l)) { fenced = !fenced; continue; }
      if (fenced) continue;
      if (l === h) n += 1;
      else if (lower(l.replace(/[ \t\r]+$/, '')) === lower(h)) near += 1;
    }
    if (n === 1) continue;
    // A near miss (trailing spaces, CRLF, a different case) looks present and matches nothing,
    // so it is a malformed section, never an omitted one.
    if (n === 0 && near === 0 && means) {
      note(d, `has no \`${h}\`, so Kanon's default applies: ${means} (K-LAYOUT-17)`);
      continue;
    }
    const hint = near === 0 ? '' : ` (${near} more line(s) match it once trailing spaces, a CR and case are ignored: write it exactly)`;
    if (means) fail(d, `has the heading \`${h}\` ${n} times${hint}; the stack document has it at most once, and the lanes read that section (K-LAYOUT-17)`);
    else fail(d, `has the heading \`${h}\` ${n} times${hint}; the stack document has it exactly once, with no default, and the lanes read that section (K-LAYOUT-17)`);
  }
}

// ── The test-database declaration (K-LAYOUT-16, kanon#18) ─────────────────────────────
// Read by the same program the lanes' test-database block reads it with, so a declaration
// this passes is one the lanes start. No file declares no database, which is valid.
if (isFile(DATABASE)) {
  const r = awk(['-f', join(KANON_ROOT, 'actions/test-database/declaration.awk'), DATABASE]);
  if (!r.ok) fail(DATABASE, `${r.out} (K-LAYOUT-16)`);
}

// ── The escalation and exemptions files (K-LAYOUT-8, K-LAYOUT-15; kanon#153), the ─────────
// ── reference environment's deploy in the adoption record (K-LAYOUT-10, plan 0004 P6), ────
// ── and the code areas in the stack document (K-LAYOUT-17, kanon#54) ──────────────────────
// Read by the library's own readers (`declarations.mjs`), so a file this passes is one the
// guards, the Merger and the reconciler accept. A missing file, or a missing section, is the
// reader's documented default (plan 0005 §5.2), and each default the reader takes is printed as
// a notice. A record that declares no reference environment passes: the reconciler fails on it
// when a project reaches its deploy phase.
//
// ── Whether the Overseer is installed (K-LAYOUT-10, plan 0004 step 13, decision 12) ────────
// The Overseer is an optional lane, so the adoption record says whether it is installed, and
// says what is true: `installed` with a caller of its lane, `not installed` without one. A
// record that doesn't say, or no record, is Kanon's default, `not installed` (plan 0005 §5.2),
// so a caller of the Overseer's lane still needs the record to say `installed`.
//
// So is the App register's optional `Persona` column (plan 0005 §3.3), when a caller's lane runs
// as a role and the register exists: a malformed persona fails by name here, on the pull request
// that wrote it, where the lanes would only warn and post as the role.
{
  const overseer = CALLED.includes('agent-overseer');
  const personas = ROLES.length > 0 && isFile(REGISTER);
  /** @type {string[]} */
  let found = [];
  try { found = declarationFindings(overseer, personas, process.cwd()); } catch { die(`could not run Kanon's declaration readers (${HERE}/declarations.mjs)`); }
  for (const line of found) {
    const [kind = '', file = '', ...msg] = line.split('\t');
    const m = msg.join('\t').replace(/^\t+|\t+$/g, '');
    if (kind === 'notice') note(file, m);
    else if (kind === 'error') fail(file, m);
  }
}

// ── App slugs: every role a caller's lane runs as has one row in the register ──────────
for (const role of sortU(words(ROLES))) {
  if (!isFile(REGISTER)) {
    fail(REGISTER, `the App register is missing (K-LAYOUT-6); the lanes read the ${role}'s App slug from it`);
    break;
  }
  const r = awk(['-v', `role=${role}`, '-f', join(HERE, 'app-register.awk'), REGISTER]);
  if (!r.ok) fail(REGISTER, r.out);
}
// Its optional `Persona` column is read with the declarations above, in the same process.

// ── The Dependabot entry that proposes Kanon upgrades (K-ADOPT-11) ─────────────────────
const DEP = '.github/dependabot.yml';
if (!isFile(DEP)) {
  fail(DEP, 'is missing; it holds the entry that proposes Kanon upgrades (K-ADOPT-11)');
} else {
  const dep = /** @type {any} */ (json(DEP));
  if (dep === undefined) fail(DEP, 'is not valid YAML');
  let ok;
  try {
    const updates = dep === undefined || dep === null ? [] : isObject(dep) ? dep.updates : null;
    const list = Array.isArray(updates) ? updates : isObject(updates) ? Object.values(updates) : [];
    /** jq indexes null to null, and stops on a scalar. @param {unknown} v */
    const obj = (v) => {
      if (v !== null && v !== undefined && !isObject(v)) throw new Error('jq: cannot index');
      return /** @type {any} */ (v ?? {});
    };
    ok = list.filter((entry) => {
      const u = obj(entry);
      if (u['package-ecosystem'] !== 'github-actions') return false;
      if (!(alt(u.directory, '') === '/' || has(alt(u.directories, []), '/'))) return false;
      const groups = alt(u.groups, {});
      if (!isObject(groups) && !Array.isArray(groups)) throw new Error('jq: groups');
      if (!Object.values(groups).some((g) => has(alt(obj(g).patterns, []), 'yedeya-labs/kanon*'))) return false;
      if (alt(obj(u['commit-message']).prefix, '') !== 'ci') return false;
      const allow = u.allow;
      if (!(allow === null || allow === undefined || Object.values(Array.isArray(allow) ? allow : obj(allow)).some((a) => {
        const n = alt(obj(a)['dependency-name'], '');
        if (typeof n !== 'string') throw new Error('jq: startswith');
        return n.startsWith('yedeya-labs/kanon');
      }))) return false;
      return has(alt(obj(u.cooldown).exclude, []), 'yedeya-labs/kanon*');
    }).length;
  } catch {
    // jq stopped on a value of the wrong type, and printed nothing: no entry.
    ok = 0;
  }
  if (!(ok > 0)) fail(DEP, "has no github-actions entry for `/` that groups yedeya-labs/kanon*, prefixes its commits `ci`, and excludes yedeya-labs/kanon* from its cooldown: with no `cooldown` at all, Dependabot's default of 3 days holds every Kanon release back (K-ADOPT-11)");
}

if (ERRORS > 0) {
  out(`lane-check: ${ERRORS} problem(s) in ${CALLERS} lane caller(s)`);
  process.exit(1);
}
out(`lane-check: ${CALLERS} lane caller(s) pass, with ${DEFAULTS} documented default(s) taken`);
