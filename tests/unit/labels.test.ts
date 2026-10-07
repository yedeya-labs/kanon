import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { LabelError, TAXONOMY, appliedByArgs, beforeApply, ensureLabels, forgetLiveLabels, taxonomyLabel } from '../../scripts/lib/labels.mjs';
import { writeStub } from './helpers/stub-bin.js';

/**
 * Labels on first use (plan 0005 §5.3, step L7). `rulebook/labels.json` is `K-WORK-12`'s
 * table in a form code reads; a lane about to apply a taxonomy label the repository lacks
 * creates it first, and a name outside the taxonomy is never created. These tests hold the
 * file to the table, every label the library applies to the file, and every lane that labels
 * to a create-before-apply step, then run the create on a fake repository.
 */
const ROOT = process.cwd();
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

type Row = { family: string; names: string[]; color: string; description: string };

/** `K-WORK-12`'s taxonomy table, row by row. Throws when the table can't be found. */
const taxonomyTable = (): Row[] => {
  const text = read('rulebook/01-work-items.md');
  const lines = text.slice(text.indexOf('### `K-WORK-12`')).split('\n');
  const head = lines.findIndex((l) => l === '| Family | Label | Colour | Description |');
  if (head < 0) throw new Error("rulebook/01-work-items.md: K-WORK-12's taxonomy table header was not found");
  const rows: Row[] = [];
  let family = '';
  for (let i = head + 2; lines[i]?.startsWith('|'); i++) {
    const c = (lines[i] ?? '').split('|').slice(1, -1).map((s) => s.trim());
    if (c.length !== 4) throw new Error(`K-WORK-12 table row ${i - head - 1} needs 4 cells, has ${c.length}`);
    family = c[0] || family;
    const color = /`([0-9a-f]{6})`/.exec(c[2] ?? '')?.[1];
    if (!color) throw new Error(`K-WORK-12 table row ${i - head - 1} has no colour`);
    rows.push({ family, names: [...(c[1] ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? ''), color, description: (c[3] ?? '').replace(/`/g, '') });
  }
  return rows;
};

describe("K-WORK-12's table and rulebook/labels.json agree (K-PRIN-2)", () => {
  const rows = taxonomyTable();
  const fromTable = rows.flatMap((r) => r.names.map((name) => ({ name, family: r.family, color: r.color, description: r.description })));

  it('reads every row, so the checks below are not vacuous', () => {
    expect(rows.length).toBeGreaterThanOrEqual(36);
    expect(fromTable.map((l) => l.name)).toContain('qa:needs-split');
  });

  it('holds exactly the table, in order: each name, family, colour and description', () => {
    expect(TAXONOMY.map(({ name, family, color, description }) => ({ name, family, color, description }))).toEqual(fromTable);
  });

  it('marks as never created by a lane exactly the labels the rule gives another creator', () => {
    const rule = read('rulebook/01-work-items.md');
    expect(rule).toContain('A `signal:<name>` label is created with the project\'s signal list');
    expect(rule).toContain("The release tool's labels are created by the release tool.");
    expect(TAXONOMY.filter((l) => l.createdBy).map((l) => l.name)).toEqual(['signal:<name>', 'autorelease: pending', 'autorelease: tagged']);
  });

  it('fits what GitHub accepts: a six-digit colour and a description of at most 100 characters', () => {
    for (const l of TAXONOMY) {
      expect(l.color, l.name).toMatch(/^[0-9a-f]{6}$/);
      expect(l.description.length, l.name).toBeLessThanOrEqual(100);
    }
  });
});

// ── Every label the library applies is in the taxonomy ───────────────────────────────────────

const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(join(ROOT, dir))) {
    const p = join(dir, e);
    if (statSync(join(ROOT, p)).isDirectory()) walk(p, out);
    else if (/\.(mjs|yml|sh|md)$/.test(e)) out.push(p);
  }
  return out;
};

/** Comments blanked: a comment ABOUT a label applies nothing. Prompts (YAML strings, Markdown) are kept. */
const stripComments = (file: string, text: string): string => {
  if (file.endsWith('.md')) return text;
  // Line comments first: one can quote a glob (`docs/**/*.md`) that would open a block.
  if (file.endsWith('.mjs')) return text.replace(/(^|\s)\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, (b) => b.replace(/[^\n]/g, ' '));
  return text.replace(/(^|\s)#(\s.*)?$/gm, '$1');
};

const LABELISH = /^[a-z][a-z0-9:-]*$/;

/**
 * Every label name the library's scripts, blocks, lanes and playbooks apply or tell an agent to
 * apply, with the files that do: a namespaced literal, a `--label`/`--add-label` value, a
 * `*_LABEL(S)` constant, and a prompt's `Labels:` line. The helper that creates labels is left
 * out, because it names no label.
 */
export const libraryLabels = (): Map<string, Set<string>> => {
  const found = new Map<string, Set<string>>();
  const add = (name: string, file: string): void => {
    if (!LABELISH.test(name)) return;
    if (!found.has(name)) found.set(name, new Set());
    found.get(name)?.add(file);
  };
  const files = ['scripts', 'actions', '.github/workflows', 'docs/qa'].flatMap((d) => walk(d)).filter((f) => f !== join('scripts', 'lib', 'labels.mjs'));
  for (const file of files) {
    const text = stripComments(file, read(file));
    for (const m of text.matchAll(/['"`]((?:agent|qa|sev|signal|needs|review|project):[a-z0-9-]+)['"`]/g)) add(m[1] ?? '', file);
    for (const m of text.matchAll(/--(?:add-)?label[= ]+['"]?([a-z][a-z0-9:-]*)(?![\w${])/g)) add(m[1] ?? '', file);
    for (const m of text.matchAll(/'--(?:add-)?label',\s*'([^']+)'/g)) add(m[1] ?? '', file);
    for (const m of text.matchAll(/const (?:[A-Z][A-Z_]*_LABELS?|LABELS)\s*=\s*(\[[^\]]*\]|'[^']*')/g)) {
      for (const q of (m[1] ?? '').matchAll(/'([^']+)'/g)) add(q[1] ?? '', file);
    }
    for (const line of text.match(/\bLabels:[^\n]*/g) ?? []) for (const q of line.matchAll(/`([^`]+)`/g)) add(q[1] ?? '', file);
  }
  return found;
};

describe('every label the library applies is in the taxonomy', () => {
  const found = libraryLabels();

  it('finds labels in every shape the scanner reads, so the check below is not vacuous', () => {
    // A `'--add-label', 'needs:human'` literal, a `*_LABEL` constant, a `LABELS` array, a
    // prompt's backticked list, and a namespaced literal in a lane.
    for (const name of ['needs:human', 'qa:needs-split', 'pipeline-improvement', 'follow-up', 'qa:fix-proposed', 'signal:spec-violation']) {
      expect([...found.keys()], name).toContain(name);
    }
    expect(found.size).toBeGreaterThanOrEqual(30);
  });

  it('names no label outside rulebook/labels.json', () => {
    const outside = [...found].filter(([name]) => !taxonomyLabel(name)).map(([name, files]) => `${name} (${[...files].join(', ')})`);
    expect(outside).toEqual([]);
  });
});

// ── Every lane that labels creates before it applies ─────────────────────────────────────────

const LABEL_STEP = "Create the lane's labels the repository lacks";
const ENSURE = /^node "\$KANON\/scripts\/ensure-labels\.mjs"((?: [a-z:-]+)+)$/;

/**
 * The taxonomy labels a lane's file names: what its agent's prompt may tell it to apply. A family
 * wildcard (`sev:*`, "a sev:* you can justify") names every member of that family a lane creates,
 * because the agent picks one at run time; for `signal:*` that is only the fixed ones,
 * `signal:spec-violation`, `signal:security` and `signal:contract`, since a project's own signals
 * are created with its signal list, never by a lane.
 */
const promptLabels = (file: string): string[] => {
  const text = stripComments(file, read(file));
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wildcards = new Set([...text.matchAll(/(?<![\w:-])([a-z]+):\*/g)].map((m) => `${m[1]}:`));
  return TAXONOMY.filter((l) => !l.createdBy && !l.name.includes('<'))
    .filter((l) => [...wildcards].some((w) => l.name.startsWith(w))
      || new RegExp(`[\`'"]${esc(l.name)}[\`'"]|--(?:add-)?label[ =]+['"]?${esc(l.name)}(?![\\w:-])|Labels:[^\\n]*(?<![\\w:-])${esc(l.name)}(?![\\w:-])`).test(text))
    .map((l) => l.name);
};

type Step = { name?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Job = { uses?: string; with?: Record<string, unknown>; steps?: Step[] };
const jobsOf = (file: string): Record<string, Job> => (parse(read(file)) as { jobs: Record<string, Job> }).jobs;

/** The labels a lane creates before its agent runs: its spine `labels` input, or its label step. */
const declared = (file: string): string[] =>
  Object.values(jobsOf(file)).flatMap((job) => {
    if (/agent-lane\.yml$/.test(job.uses ?? '')) return String(job.with?.labels ?? '').split(/\s+/).filter(Boolean);
    const step = (job.steps ?? []).find((s) => s.name === LABEL_STEP);
    return step ? (ENSURE.exec(String(step.run))?.[1] ?? '').trim().split(' ') : [];
  });

const runsAgent = (file: string): boolean =>
  Object.values(jobsOf(file)).some((job) => /agent-lane\.yml$/.test(job.uses ?? '') || (job.steps ?? []).some((s) => s.uses === '$/actions/agent-run'));

/** A lane whose agent names labels and holds no write that applies one. */
const READ_ONLY_AGENTS: Record<string, string> = {
  'agent-project-digest.yml': 'its agent runs on the default token with issues: read, and names `agent:implement` only to read the queue',
  // Plan 0004 step 14: the lane's `file` job files, and `telemetry-file.mjs` creates each label
  // before it applies it, from its gh wrapper (the check below).
  'explore-telemetry-agent-job.yml': "its agent's token reads only, and the lane's filing step applies the labels its prompt names",
};

describe('every lane whose agent labels creates the labels first (plan 0005 §5.3)', () => {
  // A lane's agent runs in its caller (the spine's callers, and the lanes that still run it in
  // place) or in its `<lane>-agent-job.yml`; the spine's own two files carry no prompt.
  const lanes = readdirSync(join(ROOT, '.github/workflows'))
    .filter((f) => (/^agent-.*\.yml$/.test(f) && f !== 'agent-lane.yml') || (/-agent-job\.yml$/.test(f) && f !== 'lane-agent-job.yml'))
    .map((f) => `.github/workflows/${f}`).filter(runsAgent);

  it('reads a family wildcard as every lane-created member of the family', () => {
    expect(promptLabels('.github/workflows/explore-agent-job.yml')).toEqual(expect.arrayContaining(['sev:critical', 'sev:high', 'sev:medium', 'sev:low']));
    // `signal:*` reaches only the signal labels the taxonomy fixes; a project's own are never a lane's to create.
    expect(promptLabels('.github/workflows/explore-agent-job.yml').filter((n) => n.startsWith('signal:'))).toEqual(['signal:spec-violation', 'signal:security', 'signal:contract']);
  });

  it("creates every signal the code audit's prompt applies, each a fixed member of the taxonomy (kanon#561)", () => {
    const file = '.github/workflows/code-audit-agent-job.yml';
    const applied = [...stripComments(file, read(file)).matchAll(/`(signal:[a-z0-9-]+)`/g)].map((m) => m[1] ?? '');
    expect([...new Set(applied)].sort()).toEqual(['signal:contract', 'signal:security', 'signal:spec-violation']);
    for (const name of applied) {
      expect(TAXONOMY.find((l) => l.name === name), name).toMatchObject({ name, family: 'Signal that produced a finding' });
      expect(TAXONOMY.find((l) => l.name === name)?.createdBy, name).toBeUndefined();
    }
    expect(declared(file)).toEqual(expect.arrayContaining(applied));
  });

  it('finds the agent lanes, so the checks below are not vacuous', () => {
    expect(lanes.length).toBeGreaterThanOrEqual(14);
    expect(lanes.filter((f) => promptLabels(f).length).length).toBeGreaterThanOrEqual(13);
  });

  it.each(lanes)('%s creates, before its agent runs, every taxonomy label its prompt names', (file) => {
    const named = promptLabels(file);
    const exempt = READ_ONLY_AGENTS[file.replace('.github/workflows/', '')];
    if (exempt) {
      const perms = JSON.stringify((parse(read(file)) as { permissions?: unknown }).permissions ?? {});
      expect(perms, `${file}: exempt because ${exempt}`).not.toMatch(/"(issues|pull-requests)":"write"/);
      return;
    }
    const has = declared(file);
    expect(named.filter((n) => !has.includes(n)), `${file} names these labels and does not create them`).toEqual([]);
  });

  it.each(lanes)('%s declares only labels a lane may create', (file) => {
    for (const name of declared(file)) {
      const t = taxonomyLabel(name);
      expect(t, `${file}: ${name}`).not.toBeNull();
      expect(t?.createdBy, `${file}: ${name}`).toBeUndefined();
    }
  });

  const direct = lanes.filter((f) => !Object.values(jobsOf(f)).some((j) => /agent-lane\.yml$/.test(j.uses ?? '')))
    .filter((f) => promptLabels(f).length && !READ_ONLY_AGENTS[f.replace('.github/workflows/', '')]);
  it.each(direct)(
    '%s runs its label step right before the agent, under the same condition and token',
    (file) => {
      for (const job of Object.values(jobsOf(file))) {
        const steps = job.steps ?? [];
        const agent = steps.findIndex((s) => s.uses === '$/actions/agent-run');
        if (agent < 0) continue;
        const step = steps[agent - 1];
        expect(step?.name, file).toBe(LABEL_STEP);
        expect(step?.if, file).toBe(steps[agent]?.if);
        expect(step?.env?.GH_TOKEN, file).toBe(steps[agent]?.with?.['github-token']);
        expect(step?.env?.KANON, file).toBe('${{ steps.kanon.outputs.path }}');
      }
    },
  );

  it('threads the spine\'s `labels` input to a label step right before the agent', () => {
    const spine = parse(read('.github/workflows/agent-lane.yml')) as { on: { workflow_call: { inputs: Record<string, unknown> } }; jobs: Record<string, Job> };
    expect(spine.on.workflow_call.inputs).toHaveProperty('labels');
    expect(spine.jobs.run?.with?.labels).toBe('${{ inputs.labels }}');
    const job = parse(read('.github/workflows/lane-agent-job.yml')) as { on: { workflow_call: { inputs: Record<string, unknown> } }; jobs: Record<string, Job> };
    expect(job.on.workflow_call.inputs).toHaveProperty('labels');
    const steps = job.jobs.run?.steps ?? [];
    const agent = steps.findIndex((s) => s.uses === '$/actions/agent-run');
    const step = steps[agent - 1];
    expect(step?.name).toBe(LABEL_STEP);
    expect(step?.env?.LABELS).toBe('${{ inputs.labels }}');
    expect(step?.env?.GH_TOKEN).toBe(steps[agent]?.with?.['github-token']);
    expect(step?.run).toContain('node "$KANON/scripts/ensure-labels.mjs" "${names[@]}"');
  });
});

describe('every script that applies a label creates it first, from its gh wrapper', () => {
  const scripts = readdirSync(join(ROOT, 'scripts')).filter((f) => f.endsWith('.mjs')).map((f) => `scripts/${f}`);
  const applies = (file: string): boolean => {
    const text = stripComments(file, read(file));
    return /'--add-label'/.test(text) || (/'(?:issue|pr)', 'create'/.test(text) && /'--label'/.test(text));
  };

  it('finds the labelling scripts, so the check below is not vacuous', () => {
    expect(scripts.filter(applies).sort()).toEqual([
      'scripts/brief-revise-recovery.mjs', 'scripts/dispatch-sweep.mjs', 'scripts/implement-crash.mjs', 'scripts/lead-reconcile.mjs',
      'scripts/merge-gate.mjs', 'scripts/overseer-file.mjs', 'scripts/review-recovery.mjs', 'scripts/split-lineage.mjs', 'scripts/telemetry-file.mjs',
      'scripts/workflow-health.mjs',
    ]);
  });

  it.each(scripts.filter(applies))('%s calls beforeApply in its gh wrapper', (file) => {
    const text = stripComments(file, read(file));
    expect(text).toMatch(/import \{[^}]*\bbeforeApply\b[^}]*\} from '\.\/lib\/labels\.mjs'/);
    expect(text).toMatch(/beforeApply\(args, \(a\) => execFileSync\('gh', a,/);
  });
});

// ── The create itself ────────────────────────────────────────────────────────────────────────

/** A fake repository: its labels, and every `gh` call made against it. */
const fakeRepo = (labels: string[], opts: { listFails?: boolean; createFails?: string; raced?: string } = {}) => {
  const held = new Set(labels);
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    if (args[0] === 'label' && args[1] === 'list') {
      if (opts.listFails) throw Object.assign(new Error('gh: HTTP 403'), { stderr: 'HTTP 403: Resource not accessible by integration' });
      return JSON.stringify([...held].map((name) => ({ name })));
    }
    if (args[0] === 'label' && args[1] === 'create') {
      const name = args[2] ?? '';
      if (name === opts.createFails) throw Object.assign(new Error('gh: HTTP 403'), { stderr: 'HTTP 403: Resource not accessible by integration' });
      if (name === opts.raced) throw Object.assign(new Error('gh: HTTP 422'), { stderr: `label with name "${name}" already exists; use \`--force\` to update its color and description` });
      held.add(name);
      return '';
    }
    return '';
  };
  return { run, calls, held, creates: () => calls.filter((c) => c[1] === 'create') };
};

describe('ensureLabels', () => {
  afterEach(() => forgetLiveLabels());

  it("creates a missing taxonomy label with the taxonomy's colour and description", () => {
    const repo = fakeRepo(['bug']);
    expect(ensureLabels(['qa:needs-split', 'bug'], { repo: 'acme/widgets', run: repo.run })).toEqual(['qa:needs-split']);
    const t = TAXONOMY.find((l) => l.name === 'qa:needs-split');
    expect(repo.creates()).toEqual([['label', 'create', 'qa:needs-split', '--repo', 'acme/widgets', '--color', t?.color, '--description', t?.description]]);
    expect(t?.color).toBe('d4c5f9');
  });

  it('creates nothing when every label exists, and reads the list once per repository', () => {
    const repo = fakeRepo(['bug', 'follow-up']);
    expect(ensureLabels(['bug'], { repo: 'acme/widgets', run: repo.run })).toEqual([]);
    expect(ensureLabels(['follow-up'], { repo: 'acme/widgets', run: repo.run })).toEqual([]);
    expect(repo.calls.filter((c) => c[1] === 'list')).toHaveLength(1);
    expect(repo.creates()).toEqual([]);
  });

  it('fails by name for a missing label outside the taxonomy, and creates nothing of the batch', () => {
    const repo = fakeRepo([]);
    expect(() => ensureLabels(['qa:needs-split', 'qa:nonsense'], { repo: 'acme/widgets', run: repo.run })).toThrow(LabelError);
    expect(() => ensureLabels(['qa:needs-split', 'qa:nonsense'], { repo: 'acme/widgets', run: repo.run })).toThrow(/`qa:nonsense` is not in Kanon's label taxonomy/);
    expect(repo.creates()).toEqual([]);
  });

  it("leaves an adopter's own label alone: present, it applies; it is never created", () => {
    const repo = fakeRepo(['area:payments']);
    expect(ensureLabels(['area:payments'], { repo: 'acme/widgets', run: repo.run })).toEqual([]);
    expect(repo.creates()).toEqual([]);
  });

  it('refuses, by name, a missing label no lane creates', () => {
    const repo = fakeRepo([]);
    expect(() => ensureLabels(['signal:latency'], { repo: 'acme/widgets', run: repo.run })).toThrow(/`signal:latency` is created by the project's signal list/);
    expect(() => ensureLabels(['autorelease: pending'], { repo: 'acme/widgets', run: repo.run })).toThrow(/created by the release tool/);
    expect(repo.creates()).toEqual([]);
  });

  it("fills in a project label's number", () => {
    const repo = fakeRepo([]);
    ensureLabels(['project:27'], { repo: 'acme/widgets', run: repo.run });
    expect(repo.creates()[0]).toEqual(['label', 'create', 'project:27', '--repo', 'acme/widgets', '--color', 'bfd4f2', '--description', 'Project #27: mirrors the marker while the project is open; written by the Lead only']);
    expect(taxonomyLabel('project:0')).toBeNull();
    expect(taxonomyLabel('project:x')).toBeNull();
  });

  it('warns and creates nothing when the list cannot be read, so the apply behaves as before', () => {
    const repo = fakeRepo([], { listFails: true });
    expect(ensureLabels(['qa:needs-split', 'qa:nonsense'], { repo: 'acme/widgets', run: repo.run })).toEqual([]);
    expect(repo.creates()).toEqual([]);
  });

  it('warns on a failed create and goes on; a create another lane won is neither an error nor reported as created', () => {
    const repo = fakeRepo([], { createFails: 'bug', raced: 'follow-up' });
    expect(ensureLabels(['bug', 'follow-up', 'blocked'], { repo: 'acme/widgets', run: repo.run })).toEqual(['blocked']);
    // Known to exist now: a second apply in this process does not try again.
    expect(ensureLabels(['follow-up'], { repo: 'acme/widgets', run: repo.run })).toEqual([]);
    expect(repo.creates().filter((c) => c[2] === 'follow-up')).toHaveLength(1);
  });

  it('says so in the run summary', () => {
    const summary = join(mkdtempSync(join(tmpdir(), 'labels-')), 'summary.md');
    writeFileSync(summary, '');
    const before = process.env.GITHUB_STEP_SUMMARY;
    process.env.GITHUB_STEP_SUMMARY = summary;
    try {
      ensureLabels(['blocked'], { repo: 'acme/widgets', run: fakeRepo([]).run });
    } finally {
      if (before === undefined) delete process.env.GITHUB_STEP_SUMMARY;
      else process.env.GITHUB_STEP_SUMMARY = before;
    }
    expect(readFileSync(summary, 'utf8')).toMatch(/^Created the label `blocked` \(#b60205, .*\), which this repository lacked/);
  });
});

describe('appliedByArgs and beforeApply', () => {
  afterEach(() => forgetLiveLabels());

  it('reads every way gh applies a label, and nothing that only filters or removes one', () => {
    expect(appliedByArgs(['issue', 'create', '--title', 't', '--label', 'bug', '-l', 'follow-up,sev:low', '--label=blocked'])).toEqual(['bug', 'follow-up', 'sev:low', 'blocked']);
    expect(appliedByArgs(['pr', 'edit', '7', '--add-label', 'review:please', '--remove-label', 'needs:human'])).toEqual(['review:please']);
    expect(appliedByArgs(['issue', 'list', '--label', 'bug'])).toEqual([]);
    expect(appliedByArgs(['label', 'create', 'bug'])).toEqual([]);
  });

  it('creates before an apply, on the repository the call names, and does nothing for any other call', () => {
    const repo = fakeRepo([]);
    beforeApply(['issue', 'list', '--repo', 'acme/widgets', '--label', 'bug'], repo.run);
    expect(repo.calls).toEqual([]);
    beforeApply(['issue', 'edit', '4', '--repo', 'acme/widgets', '--add-label', 'needs:human'], repo.run);
    expect(repo.creates().map((c) => c.slice(2, 5))).toEqual([['needs:human', '--repo', 'acme/widgets']]);
  });
});

// ── The lanes, run against a fake repository ─────────────────────────────────────────────────

/** A stub `gh` over a repository whose labels live in a file: `issue edit --add-label` of a
 *  label it lacks fails as GitHub's does, so only a create before it lets the apply through. */
const stubRepo = (labels: string[]) => {
  const dir = mkdtempSync(join(tmpdir(), 'labels-lane-'));
  const log = join(dir, 'calls');
  const held = join(dir, 'labels');
  writeFileSync(log, '');
  writeFileSync(held, labels.map((l) => `${l}\n`).join(''));
  const view = JSON.stringify({ state: 'OPEN', labels: [{ name: 'agent:implement' }], comments: [], body: 'work\n\n<!-- qa:project 27 -->' });
  writeStub(join(dir, 'gh'), [
    '#!/usr/bin/env bash',
    `printf '%s|%s\\n' "$GH_TOKEN" "$*" >> '${log}'`,
    'case "$1 $2" in',
    `  "label list") printf '['; sep=; while IFS= read -r l; do printf '%s{"name":"%s"}' "$sep" "$l"; sep=,; done < '${held}'; printf ']' ;;`,
    `  "label create") echo "$3" >> '${held}' ;;`,
    `  "issue edit") prev=; for a in "$@"; do if [ "$prev" = "--add-label" ] && ! grep -qxF "$a" '${held}'; then echo "could not add label: '$a' not found" >&2; exit 1; fi; prev=$a; done ;;`,
    `  "api "*) echo '{"run_started_at":"2026-10-02T00:00:00Z"}' ;;`,
    `  "issue view") printf '%s' '${view}' ;;`,
    `  "pr list") echo '[]' ;;`,
    'esac',
    '',
  ].join('\n'));
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => {
    const [token, ...rest] = l.split('|');
    return `${token} ${rest.join('|')}`;
  });
  return { dir, calls };
};

describe('a lane on a repository without qa:needs-split (plan 0005 L7)', () => {
  it("creates it with the taxonomy's colour, on the token that applies it, then applies it", () => {
    const repo = stubRepo(['agent:implement']);
    const r = spawnSync('node', [join(ROOT, 'scripts/implement-crash.mjs')], {
      // In the fixture adopter, whose App register the script reads, as a lane runs it.
      cwd: join(ROOT, 'tests/fixtures/adopter'), encoding: 'utf8', timeout: 30_000,
      env: {
        ...process.env, PATH: `${repo.dir}:${process.env.PATH}`, GITHUB_REPOSITORY: 'example-org/example-repo', GITHUB_STEP_SUMMARY: '',
        ISSUE: '4242', RUN_ID: '7', KIND: 'exhausted', APPLY: '1', GH_TOKEN: 'workflow-token', LABEL_TOKEN: 'app-token',
      },
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const calls = repo.calls();
    const create = calls.findIndex((c) => c.startsWith('app-token label create qa:needs-split '));
    const apply = calls.findIndex((c) => c.startsWith('app-token issue edit 4242 --add-label qa:needs-split'));
    expect(create, calls.join('\n')).toBeGreaterThan(-1);
    expect(calls[create]).toContain('--color d4c5f9');
    expect(create).toBeLessThan(apply);
    expect(r.stdout).toContain('Created the label `qa:needs-split`');
  });

  it('the label step fails by name for a label outside the taxonomy, and creates nothing', () => {
    const repo = stubRepo([]);
    const r = spawnSync('node', [join(ROOT, 'scripts/ensure-labels.mjs'), 'qa:needs-split', 'qa:needs-splitt'], {
      encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, PATH: `${repo.dir}:${process.env.PATH}`, REPO: 'example-org/example-repo', GITHUB_STEP_SUMMARY: '' },
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('`qa:needs-splitt` is not in Kanon\'s label taxonomy');
    expect(repo.calls().filter((c) => / label create /.test(c))).toEqual([]);
  });

  it('the label step creates what is missing and exits 0', () => {
    const repo = stubRepo(['bug']);
    const r = spawnSync('node', [join(ROOT, 'scripts/ensure-labels.mjs'), 'bug', 'qa:needs-triage'], {
      encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, PATH: `${repo.dir}:${process.env.PATH}`, REPO: 'example-org/example-repo', GITHUB_STEP_SUMMARY: '', GH_TOKEN: 't' },
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(repo.calls().filter((c) => / label create /.test(c)).map((c) => c.split(' ').slice(3, 4)[0])).toEqual(['qa:needs-triage']);
  });
});

/**
 * kanon#192: `project:<n>` was described as mirroring the marker, but the mirror runs only
 * inside a tick, and the tick reconciles only projects whose tracking issue is open. So an
 * issue that gains the marker after close never gets the label. The rule now says the label
 * stops at close; these hold the wording to the behaviour that makes it true.
 */
describe('project:<n> is mirrored only while the project is open (kanon#192)', () => {
  /** One paragraph of `text`, found by its anchor. Throws when the anchor moves. */
  const paragraph = (path: string, anchor: string): string => {
    const text = read(path);
    const at = text.indexOf(anchor);
    if (at < 0) throw new Error(`${path}: anchor not found: ${anchor}`);
    const start = text.lastIndexOf('\n', at) + 1;
    const end = text.indexOf('\n', at);
    return text.slice(start, end < 0 ? undefined : end);
  };

  it('the reconcile tick picks only projects whose tracking issue is open', () => {
    const picker = paragraph('.github/workflows/agent-lead-reconcile.yml', 'if [ "$state" = "OPEN" ]; then');
    expect(picker.trim()).toBe('if [ "$state" = "OPEN" ]; then');
    const step = read('.github/workflows/agent-lead-reconcile.yml');
    expect(step).toContain('picked="${picked:+$picked,}$n"');
  });

  it("the taxonomy's description says the label mirrors the marker only while the project is open", () => {
    const row = taxonomyTable().find((r) => r.names.includes('project:<n>'));
    expect(row?.description).toContain('while the project is open');
  });

  it('the marker rule says the label stops at close and the marker is the record after it', () => {
    const rule = paragraph('rulebook/11-repository-layout.md', '- **The project marker.**');
    expect(rule).toContain('only while its tracking issue is open');
    expect(rule).toContain('never gets the label');
    expect(rule).toContain('the marker is its only complete membership record');
    const decomposition = paragraph('rulebook/07-projects.md', 'mirrored by the label `project:<n>`');
    expect(decomposition).toContain('only while the project is open');
  });
});
