import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * Builds `requirements.json`, the requirements file each release ships (plan 0005 §5.4 and §5.5),
 * from Kanon's own files, the way `lane-check` reads them: every lane's inputs, secrets, the
 * grant its caller must make, the project documents and workflows it reads, the hooks it calls,
 * the name and run-name it asks of its caller, and the identities whose secrets it takes. So the
 * file can't say anything the lanes don't, and `tests/unit/requirements.test.ts` fails when the
 * two disagree.
 *
 * `kanon init` reads this file at the release it runs from, with Node's built-ins only, so it
 * never parses a lane's YAML itself; `kanon doctor` (step L10) checks an installation against
 * a release's copy, read at its tag.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a parsed workflow, read field by field
type Doc = Record<string, any>;

const level = (v: unknown) => (v === 'write' ? 2 : v === 'read' ? 1 : 0);

/** The lanes: every `agent-*.yml` that is a reusable workflow, except the spine and the smoke runs. */
export const laneFiles = (root: string): string[] =>
  readdirSync(join(root, '.github/workflows'))
    .filter((f) => /^agent-.+\.yml$/.test(f) && f !== 'agent-lane.yml' && !f.endsWith('-smoke.yml'))
    .filter((f) => {
      const on = (parse(readFileSync(join(root, '.github/workflows', f), 'utf8')) as Doc).on;
      return on && typeof on === 'object' && 'workflow_call' in on;
    })
    .sort();

/** A lane's file, then every Kanon workflow it calls through `$/`, transitively, as lane-check's `lane_files`. */
export const laneTree = (root: string, file: string, seen = new Set<string>()): string[] => {
  seen.add(file);
  const text = readFileSync(join(root, '.github/workflows', file), 'utf8');
  const called = [...text.matchAll(/^ *uses: \$\/\.github\/workflows\/([A-Za-z0-9_.-]+\.ya?ml) *$/gm)].map((m) => m[1]!);
  return [file, ...[...new Set(called)].sort().filter((c) => !seen.has(c)).flatMap((c) => laneTree(root, c, seen))];
};

const comment = (text: string, key: string): string[] =>
  [...text.matchAll(new RegExp(`^# ${key}: (.+)$`, 'gm'))].map((m) => m[1]!.trim());

export const buildRequirements = (root: string) => {
  const permissions = JSON.parse(readFileSync(join(root, 'rulebook/agent-permissions.json'), 'utf8'));
  const labels = JSON.parse(readFileSync(join(root, 'rulebook/labels.json'), 'utf8')).labels as Array<{ name: string }>;
  const lanes: Record<string, unknown> = {};
  for (const file of laneFiles(root)) {
    const text = readFileSync(join(root, '.github/workflows', file), 'utf8');
    const doc = parse(text) as Doc;
    const call = doc.on.workflow_call ?? {};
    const inputs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries((call.inputs ?? {}) as Record<string, Doc>)) {
      if (k === 'smoke') continue;
      inputs[k] = { type: v.type ?? 'string', description: String(v.description ?? '').trim() };
    }
    const secrets = Object.keys(call.secrets ?? {}).sort();
    const grant: Record<string, string> = {};
    for (const p of [doc.permissions, ...Object.values((doc.jobs ?? {}) as Record<string, Doc>).map((j) => j.permissions)]) {
      if (!p || typeof p !== 'object') continue;
      for (const [k, v] of Object.entries(p as Record<string, string>)) if (level(v) > level(grant[k])) grant[k] = v;
    }
    const reads = [
      ...new Set(
        laneTree(root, file).flatMap((f) =>
          [...readFileSync(join(root, '.github/workflows', f), 'utf8').matchAll(/docs\/qa\/(?:stack|capability-ledger|[a-z]+(?:-[a-z]+)*-playbook)\.md/g)].map((m) => m[0]),
        ),
      ),
    ].sort();
    const lane: Record<string, unknown> = {
      identities: secrets.filter((s) => s.endsWith('_APP_ID')).map((s) => s.slice(0, -'_APP_ID'.length).toLowerCase()),
      secrets,
      inputs,
      grant: Object.fromEntries(Object.entries(grant).sort(([a], [b]) => a.localeCompare(b))),
      reads,
      readsWorkflows: comment(text, 'READS WORKFLOW'),
      hooks: comment(text, 'NEEDS HOOK'),
      // Whether the lane reaches a QA store, through the qa-store block in any file it runs: an
      // `id-token: write` grant alone doesn't say, since the telemetry Explorer's is for the
      // aggregate function (kanon#471).
      qaStore: laneTree(root, file).some((f) => /^\s*-?\s*uses: \$\/actions\/qa-store\s*$/m.test(readFileSync(join(root, '.github/workflows', f), 'utf8'))),
    };
    // The secrets a caller may leave out (kanon#433): the QA store's, which the lane marks and
    // declares `required: false`, as `lane-check` reads them.
    const optional = comment(text, 'OPTIONAL SECRET').filter((n) => secrets.includes(n) && call.secrets[n]?.required === false).sort();
    if (optional.length) lane.optionalSecrets = optional;
    const name = comment(text, 'CALLER NAME')[0];
    if (name) lane.callerName = name;
    const runName = comment(text, 'CALLER RUN-NAME ENDS WITH')[0];
    if (runName) lane.callerRunNameEndsWith = runName;
    lanes[file.replace(/\.yml$/, '')] = lane;
  }
  const spine = parse(readFileSync(join(root, '.github/workflows/lane-agent-job.yml'), 'utf8')) as Doc;
  const hookInputs = [
    ...new Set(
      Object.values((spine.jobs ?? {}) as Record<string, Doc>).flatMap((j) =>
        ((j.steps ?? []) as Doc[]).filter((s) => s.uses === './.github/actions/project-setup').flatMap((s) => Object.keys(s.with ?? {})),
      ),
    ),
  ].sort();
  // Each project document a lane reads (K-LAYOUT-17): whether Kanon ships a baseline a lane reads
  // in its place when it is missing (plan 0005 §5.2), and the sections it must hold because they
  // have no default, read from `lane-check` itself so the two can't disagree.
  const baselines = readdirSync(join(root, 'rulebook/templates/playbooks'));
  const stackSections = [...readFileSync(join(root, 'actions/lane-check/lane-check.sh'), 'utf8').matchAll(/^ {2}"(## [^|"]+)\|([^"]*)"$/gm)];
  const declarations = Object.fromEntries(
    [...new Set(Object.values(lanes).flatMap((l) => (l as { reads: string[] }).reads))].sort().map((d) => [
      d,
      {
        baseline: baselines.includes(d.slice('docs/qa/'.length)),
        requiredSections: d === 'docs/qa/stack.md' ? stackSections.filter((m) => m[2] === '').map((m) => m[1]!) : [],
      },
    ]),
  );
  // The telemetry collector (plan 0002 S7, #428): a caller `kanon init --telemetry` writes, and
  // `kanon doctor` recognises as Kanon's, with the repository variables it passes. Read from the
  // collector's own workflow and from the caller docs/telemetry.md gives, which init writes byte
  // for byte, so the file can't name a variable the caller doesn't pass. Its grant is what its jobs
  // ask for, which the caller's permissions: must cover (plan 0006 F4 added `contents: read`).
  const collector = 'telemetry-collect';
  const collectorDoc = parse(readFileSync(join(root, '.github/workflows', `${collector}.yml`), 'utf8')) as Doc;
  const callerBlock = readFileSync(join(root, 'docs/telemetry.md'), 'utf8').split('**The caller.**')[1]!.split('```yaml\n')[1]!.split('```')[0]!;
  const collectorGrant: Record<string, string> = {};
  for (const j of Object.values((collectorDoc.jobs ?? {}) as Record<string, Doc>)) {
    for (const [k, v] of Object.entries((j.permissions ?? {}) as Record<string, string>)) if (level(v) > level(collectorGrant[k])) collectorGrant[k] = v;
  }
  const telemetry = collectorDoc.on && typeof collectorDoc.on === 'object' && 'workflow_call' in collectorDoc.on
    ? {
      collector,
      variables: [...new Set([...callerBlock.matchAll(/\$\{\{ vars\.([A-Z0-9_]+) \}\}/g)].map((m) => m[1]!))].sort(),
      grant: Object.fromEntries(Object.entries(collectorGrant).sort(([a], [b]) => a.localeCompare(b))),
    }
    : undefined;
  // The QA store (kanon#433): the adopter's hook, which the `qa-store` block calls, and the
  // secrets the store-coupled lanes take for it. `kanon init` and `kanon doctor` ask for the
  // secrets only where the hook exists, and name the variables of the same names, which held
  // them before, as a step to move. `secretsOnly` (kanon#479): the block takes no `variables`, so
  // the hook can't fall back to them, and a store secret a variable still holds is missing. Read
  // from the block itself; a release's file without it (v0.34.x) still passed the variables.
  const block = readFileSync(join(root, 'actions/qa-store/action.yml'), 'utf8');
  const hookPath = /^ +uses: \.\/(\.github\/actions\/[a-z-]+)$/m.exec(block)?.[1];
  const qaStore = {
    hook: `${hookPath}/action.yml`,
    // The secrets the lanes hand the qa-store block (its `secrets:` input), so another optional
    // secret of a store-coupled lane, such as the Overseer's telemetry reader role (kanon#470),
    // is not taken for the store's.
    secrets: [...new Set(laneFiles(root).flatMap((f) => [...readFileSync(join(root, '.github/workflows', f), 'utf8')
      .matchAll(/^\s+secrets: \$\{\{ format\(.*$/gm)].flatMap((m) => [...m[0].matchAll(/toJSON\(secrets\.([A-Z0-9_]+)\)/g)].map((x) => x[1]!))))].sort(),
    ...('variables' in ((parse(block) as Doc).inputs ?? {}) ? {} : { secretsOnly: true }),
  };
  const lanesJson = JSON.parse(readFileSync(join(root, 'docs/lanes.json'), 'utf8')) as Doc;
  return {
    $comment:
      "What this release of Kanon needs of an adopter (plan 0005 §5.4, §5.5), read at the release's tag. Built from the lanes by tests/unit/requirements.test.ts, which fails when this file and the lanes disagree; rebuild it with KANON_WRITE_REQUIREMENTS=1 npx vitest run tests/unit/requirements.test.ts. `kanon init` writes callers, the hook and the App identities from it; `kanon doctor` checks an installation against a release's copy. `identities` are the names a lane's `<NAME>_APP_ID` secret carries: a role of rulebook/agent-permissions.json today, an App of it once the lanes take the Apps' secrets. `catalogue` is the lane catalogue, and `features` the fixed sets of lanes offered in place of a choice per lane (plan 0007 §2), both copied from docs/lanes.json.",
    lanes,
    hook: { path: '.github/actions/project-setup/action.yml', inputs: hookInputs },
    identities: {
      roles: Object.fromEntries(Object.entries(permissions.roles as Record<string, Doc>).map(([k, v]) => [k, { name: v.role, permissions: v.permissions }])),
      apps: Object.fromEntries(Object.entries(permissions.apps as Record<string, Doc>).map(([k, v]) => [k, { name: v.app, roles: v.roles, permissions: v.permissions }])),
    },
    labels: labels.map((l) => l.name),
    declarations,
    // The lane catalogue (kanon#428): what each lane does, its group, what it needs beyond what
    // the lanes declare, its cost and when it is recommended. Hand-written in docs/lanes.json,
    // the one source `kanon init`, the adopt skill and docs/lanes.md read, and copied here so a
    // release's copy carries it; the test fails when a lane has no entry or an entry no lane.
    catalogue: Object.fromEntries(Object.entries(lanesJson).filter(([k]) => k !== '$comment' && k !== 'features')),
    // The features (plan 0007 §2, step G2): the fixed sets of lanes `kanon init` and the adopt
    // skill offer in place of a choice per lane, hand-written in docs/lanes.json beside the
    // catalogue and copied here; the test holds them to the lanes (§2.6).
    features: lanesJson.features,
    // What this release's `dco` action does with the optional Releaser's release commits (#337):
    // `kanon doctor` asks an adopter to drop every other ruleset bypass actor (`K-MERGE-8`) only
    // against a release whose `dco` passes the release PR the Releaser opens. Read from the action
    // itself, so the file can't claim an exemption the action doesn't make.
    release: { dcoExemptsReleaser: /^export const RELEASER_ROLE = 'Releaser';$/m.test(readFileSync(join(root, 'actions/dco/dco.mjs'), 'utf8')) },
    telemetry,
    qaStore,
  };
};
