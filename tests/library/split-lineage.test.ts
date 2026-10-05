import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADOPTER, ROOT } from './helpers/adopter.js';
const {
  HUMAN_LABEL, SPLIT_LABEL, SPLIT_WORKFLOW,
  childrenMissingMarker, exhaustedRoute, projectOf, splitBranch, splitBranches, splitGate, splitMarker, splitOf,
} = await import('../../scripts/split-lineage.mjs');
const { declaresMembership, parseProposed } = await import('../../scripts/lead-reconcile.mjs');
import { writeStub } from '../unit/helpers/stub-bin.js';
import { laneBlockOf, stepsAsRun } from '../unit/helpers/spine.js';
import { readFlattened, workflowText } from '../unit/helpers/called-workflow.js';
const { isPreStandard } = await import('../../scripts/brief-guard.mjs');

/**
 * RA-1781 — an issue too big for one implementer run is split through the brief, once.
 *
 * The routing is one function shared by the crash job, the dispatch sweep and the split
 * lane's gate; these tests pin each branch both ways, then the wiring that makes the
 * lane reachable at all — a decision nothing calls is the guard that cannot fail.
 */

const MEMBER = 'work\n\n<!-- qa:project 27 -->';
const CHILD = `work\n\n${splitMarker(1694)}\n\ncriteria\n\n<!-- qa:project 27 -->`;

describe('the lineage marker', () => {
  it('is read from a line of its own', () => {
    expect(splitOf(CHILD)).toBe(1694);
    expect(splitOf(`  ${splitMarker(5)}  `)).toBe(5);
  });

  it('is NOT read from prose quoting the convention inline (RA-1066’s lesson)', () => {
    expect(splitOf(`a child carries \`${splitMarker(1694)}\` in its body`)).toBeNull();
    expect(splitOf('no marker')).toBeNull();
    expect(splitOf(undefined)).toBeNull();
  });

  it('survives the file arm: an item body carrying it parses with the marker intact', () => {
    const brief = [
      '## Decomposition', '',
      '### Issue C1 — Smaller piece',
      '**Milestone:** Development Automation · **Labels:** `pipeline-improvement`', '',
      splitMarker(1694), '',
      'Acceptance criteria:', '', '- `[QA-1]` — something', '',
    ].join('\n');
    const [item] = parseProposed(brief);
    expect(item.closes, 'a split child adopts nothing').toEqual([]);
    expect(splitOf(item.body)).toBe(1694);
  });
});

describe('childrenMissingMarker — the split PR is checked for lineage', () => {
  const diff = (child: string[]) => ['diff --git a/docs/projects/2040.md b/docs/projects/2040.md', '--- a/docs/projects/2040.md', '+++ b/docs/projects/2040.md', '@@ -1,3 +1,9 @@',
    '-### Issue A — Big', ...child, ' ### Issue B — Untouched', ' body'].join('\n');
  it('passes when every added child carries the marker', () => {
    expect(childrenMissingMarker(diff(['+### Issue A1 — One', `+${splitMarker(9)}`, '+### Issue A2 — Two', '+', `+${splitMarker(9)}`]))).toEqual([]);
  });
  it('names each added child without one, and ignores unchanged headings', () => {
    expect(childrenMissingMarker(diff(['+### Issue A1 — One', `+${splitMarker(9)}`, '+### Issue A2 — Two', '+body']))).toEqual(['### Issue A2 — Two']);
  });
  it('runs from the lane’s own step', () => {
    const wf = workflowText(join(ROOT, `.github/workflows/${SPLIT_WORKFLOW}`));
    expect(wf).toContain('node "$KANON/scripts/split-lineage.mjs" check-pr');
  });
});

describe('exhaustedRoute', () => {
  it('a project member goes to the split lane', () => {
    expect(exhaustedRoute({ project: 27, body: MEMBER }).label).toBe(SPLIT_LABEL);
  });

  it('a split child goes to a human — one split per lineage', () => {
    const r = exhaustedRoute({ project: 27, body: CHILD });
    expect(r.label).toBe(HUMAN_LABEL);
    expect(r.why).toMatch(/already a split of #1694/);
  });

  it('a non-member goes to a human — there is no brief to split', () => {
    expect(exhaustedRoute({ project: null, body: 'x' }).label).toBe(HUMAN_LABEL);
  });

  it('projectOf reads membership by position', () => {
    expect(projectOf(MEMBER)).toBe(27);
    expect(projectOf('<!-- qa:project 27 -->\nappended')).toBeNull();
  });

  it('PARITY: projectOf agrees with lead-reconcile’s declaresMembership on every shape', () => {
    const bodies = [MEMBER, CHILD, '<!-- qa:project 27 -->\nappended', 'no marker', '', '  <!-- qa:project 27 -->  \n\n',
      'x\n<!-- qa:project 27-->', 'x\n<!-- qa:project 270 -->', `x\n\`<!-- qa:project 27 -->\``];
    for (const b of bodies) expect(projectOf(b) === 27, JSON.stringify(b)).toBe(declaresMembership(b, 27));
  });
});

describe('splitGate', () => {
  const ok = { state: 'OPEN', labels: [SPLIT_LABEL], project: 27, body: MEMBER, briefExists: true, openPr: null };

  it('splits the plain case', () => {
    expect(splitGate(ok).act).toBe('split');
  });

  it('skips a closed issue, an unlabelled one, and one whose split PR is already open', () => {
    expect(splitGate({ ...ok, state: 'CLOSED' }).act).toBe('skip');
    expect(splitGate({ ...ok, labels: [] }).act).toBe('skip');
    expect(splitGate({ ...ok, openPr: 12 }).act).toBe('skip');
  });

  it('skips an issue somebody re-dispatched instead — no split PR racing an implementer PR', () => {
    expect(splitGate({ ...ok, labels: [SPLIT_LABEL, 'agent:implement'] }).act).toBe('skip');
  });

  it('refuses a member of a PRE-STANDARD brief — those stay byte-identical (§5.3, developer ruling on RA-2407)', () => {
    const v = splitGate({ ...ok, project: 1019, body: 'w\n<!-- qa:project 1019 -->', preStandard: true });
    expect(v.act).toBe('refuse');
    expect(v.why).toMatch(/predates the RA-1742 standard/);
    // The gate asks brief-guard's own list, not a copy of it.
    expect(readFileSync(join(ROOT, 'scripts/split-lineage.mjs'), 'utf8'))
      .toMatch(/const \{ isPreStandard \} = await import\('\.\/brief-guard\.mjs'\);\n(?:.*\n){1,2}.*isPreStandard\(`docs\/projects\/\$\{project\}\.md`\)/);
    expect(isPreStandard('docs/projects/2.md')).toBe(true);
    expect(isPreStandard('docs/projects/2040.md')).toBe(false);
  });

  it("refuses, naming why, when the exemptions file can't be read (kanon#54)", () => {
    const v = splitGate({ ...ok, preStandardUnread: 'docs/qa/exemptions.md doesn\'t exist' });
    expect(v.act).toBe('refuse');
    expect(v.why).toMatch(/can't be decided \(docs\/qa\/exemptions\.md doesn't exist\)/);
    // Only once the issue is the lane's at all: a closed issue is still a skip.
    expect(splitGate({ ...ok, state: 'CLOSED', preStandardUnread: 'x' }).act).toBe('skip');
  });

  it('refuses a split child, a non-member and a project with no brief — to a human', () => {
    expect(splitGate({ ...ok, body: CHILD }).act).toBe('refuse');
    expect(splitGate({ ...ok, project: null, body: 'x' }).act).toBe('refuse');
    expect(splitGate({ ...ok, briefExists: false }).act).toBe('refuse');
  });

  it('branches are per issue, so a second run finds the first one’s PR', () => {
    expect(splitBranch(1694)).toBe('lead/split-1694');
  });

  it('a split opened before the rename is still found, on its old branch (#53)', () => {
    expect(splitBranches(1694)).toEqual(['lead/split-1694', 'bezalel/split-1694']);
  });
});

describe('the gate, run as a CLI — module evaluation is part of the contract (the Reviewer, RA-2407)', () => {
  // A pure `splitGate` test cannot see a module-evaluation deadlock: the first option-(b)
  // push exited 13 with no verdict for EVERY project member and stayed green.
  //
  // IN A COPY OF THE FIXTURE ADOPTER, with a post-standard brief (2040) and the one its
  // exemptions file declares pre-standard (2): the gate reads `docs/projects/<n>.md` from its
  // working directory, as the lane runs it in the adopter's checkout.
  const adopter = mkdtempSync(join(tmpdir(), 'split-adopter-'));
  cpSync(ADOPTER, adopter, { recursive: true });
  for (const n of [2040, 2]) writeFileSync(join(adopter, `docs/projects/${n}.md`), `# Project ${n} (fixture)\n`);
  const run = (project: number, openOn = '') => {
    const dir = mkdtempSync(join(tmpdir(), 'split-gate-'));
    const out = join(dir, 'out');
    writeFileSync(out, '');
    const body = `work\\n\\n<!-- qa:project ${project} -->`;
    writeStub(join(dir, 'gh'), [
      '#!/usr/bin/env bash',
      'if [ "$1" = issue ] && [ "$2" = view ]; then',
      `  printf '%s' '{"state":"OPEN","labels":[{"name":"qa:needs-split"}],"body":"${body}"}'`,
      `elif [ "$1" = pr ] && [ "$2" = list ]; then case "$*" in *"--head ${openOn || 'none'} "*) echo '[{"number":77}]' ;; *) echo "[]" ;; esac`,
      'else echo "unexpected: $*" >&2; exit 9; fi',
      '',
    ].join('\n'));
    const r = spawnSync('node', [join(ROOT, 'scripts/split-lineage.mjs'), 'gate'], {
      encoding: 'utf8', timeout: 30_000, cwd: adopter,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: 'example-org/example-repo', ISSUE: '4242', GITHUB_OUTPUT: out, APPLY: '' },
    });
    return { status: r.status, stdout: r.stdout, outputs: readFileSync(out, 'utf8') };
  };

  it('splits a post-standard member, exit 0', () => {
    const r = run(2040);
    expect(r.status, r.stdout).toBe(0);
    expect(r.outputs).toContain('act=split');
  });

  it.each(['lead/split-4242', 'bezalel/split-4242'])('skips an issue whose split PR is already open on %s (#53)', (branch) => {
    const r = run(2040, branch);
    expect(r.status, r.stdout).toBe(0);
    expect(r.outputs).toContain('act=skip');
    expect(r.stdout).toContain('split PR #77 is already open');
    // The lane always pushes to the current spelling.
    expect(r.outputs).toContain('branch=lead/split-4242');
  });

  it('refuses a pre-standard member to a human, exit 0 — never a split', () => {
    const r = run(2);
    expect(r.status, r.stdout).toBe(0);
    expect(r.outputs).toContain('act=refuse');
    expect(r.stdout).toMatch(/predates the RA-1742 standard/);
  });

  it("refuses to a human, by name and with no stack trace, when the exemptions file is malformed (kanon#54)", () => {
    writeFileSync(join(adopter, 'docs/qa/exemptions.md'), '## Pre-standard briefs\n\n## Pre-standard briefs\n');
    try {
      const r = run(2040);
      expect(r.status, r.stdout).toBe(0);
      expect(r.outputs).toContain('act=refuse');
      expect(r.stdout).toMatch(/can't be decided \(docs\/qa\/exemptions\.md has the `## Pre-standard briefs` heading 2 times/);
      expect(r.stdout).not.toMatch(/\n\s+at /);
    } finally {
      cpSync(join(ADOPTER, 'docs/qa/exemptions.md'), join(adopter, 'docs/qa/exemptions.md'));
    }
  });

  it("reads a missing exemptions file as Kanon's default, nothing exempt, and splits (plan 0005 §5.2)", () => {
    rmSync(join(adopter, 'docs/qa/exemptions.md'));
    try {
      expect(run(2040).outputs).toContain('act=split');
      // The brief the file declared pre-standard is no longer exempt.
      expect(run(2).outputs).toContain('act=split');
    } finally {
      cpSync(join(ADOPTER, 'docs/qa/exemptions.md'), join(adopter, 'docs/qa/exemptions.md'));
    }
  });

  it('refuses a project with no brief, exit 0', () => {
    const r = run(99999);
    expect(r.status).toBe(0);
    expect(r.outputs).toContain('act=refuse');
  });
});

describe('the split lane’s wiring', () => {
  const wf = readFlattened(join(ROOT, `.github/workflows/${SPLIT_WORKFLOW}`)) as {
    on: Record<string, unknown>;
    concurrency?: unknown;
    jobs: {
      filter: { if: string; concurrency?: unknown; steps: Array<{ id?: string; uses?: string }> };
      split: { if: string; needs: string; concurrency?: { group: string }; steps: Array<{ id?: string; name?: string; uses?: string; if?: string; run?: string; env?: Record<string, string>; with?: Record<string, string> }> } };
  };
  const steps = wf.jobs.split.steps;
  const gateAt = steps.findIndex((s) => s.id === 'gate');
  const agent = steps.find((s) => s.id === 'agent');

  it('starts on the label and on a dispatch — the crash job labels as the Implementer (decision 21)', () => {
    // A Kanon lane is called, never triggered: the caller holds `issues: [labeled]` and the
    // dispatch, and the filter job admits the one label or a dispatch.
    expect(Object.keys(wf.on)).toEqual(['workflow_call']);
    expect(wf.jobs.filter.if).toBe(`github.event_name == 'workflow_dispatch' || github.event.label.name == '${SPLIT_LABEL}'`);
    // JOB-level (RA-1781 review): at workflow level every label event on the issue would
    // join the group and could replace a pending real run.
    expect(wf.concurrency).toBeUndefined();
    expect(wf.jobs.split.concurrency?.group).toMatch(/^agent-lead-split-/);
    // The membership gate's job holds no group: it would be a second place a label event
    // that only reaches the gate could join it.
    expect(wf.jobs.filter.concurrency).toBeUndefined();
    expect(wf.jobs.split.needs).toBe('filter');
    expect(wf.jobs.split.if).toBe("needs.filter.outputs.member == 'true'");
  });

  it('decides before it mints a token, and every costly step waits on the verdict', () => {
    expect(steps[gateAt]?.run).toBe('node "$KANON/scripts/split-lineage.mjs" gate');
    const mint = steps.findIndex((s) => s.id === 'app-token');
    expect(gateAt).toBeGreaterThanOrEqual(0);
    expect(mint).toBeGreaterThan(gateAt);
    // But the token's revoke, the job's last step (kanon#279): the token is minted in a job of
    // its own before this one, and a run the gate stood down still revokes it.
    const revoke = steps.at(-1)!;
    expect(revoke.name).toBe('Revoke the App token');
    for (const s of steps.slice(gateAt + 1, -1)) expect(s.if, s.name ?? s.uses ?? s.run).toContain("steps.gate.outputs.act == 'split'");
  });

  it('keeps the gate and the agent in ONE job, under the one per-issue group (RA-2658)', () => {
    // The group covers the gate AND the agent only while they share a job: a second
    // delivery waits for the first to finish, and ITS gate then finds the open split PR.
    // Split across jobs, each acquires the group on its own and a gate slips in between.
    // The membership gate's job before it holds nothing else (K-AGENT-45).
    expect(Object.keys(wf.jobs)).toEqual(['filter', 'split']);
    expect(wf.jobs.filter.steps.map((s) => s.id ?? s.uses)).toEqual(['$/actions/kanon-path', 'gate']);
    expect(gateAt).toBeGreaterThanOrEqual(0);
    expect(laneBlockOf(agent!)).toBe('agent-run');
    expect(steps.indexOf(agent!)).toBeGreaterThan(gateAt);
  });

  it('probes that the App can push, after the App-token checkout and the project setup (RA-2658, RA-2694)', () => {
    // The lane's own probe became `agent-setup`'s `push-probe` switch; resolved through the
    // block, the step must still run. Since RA-2694 it follows the project-setup hook, which
    // runs after the checkout and BEFORE `agent-setup` (Kanon plan 0001 §5) and holds the
    // install: the one ordering the hook boundary changes, still before any turn.
    const run = stepsAsRun(steps);
    const name = (s: { name?: string; uses?: string; run?: string }) => s.name ?? s.uses ?? s.run ?? '';
    const probe = run.findIndex((s) => name(s).startsWith('Probe that the App can push'));
    const appCheckout = run.findIndex((s) => String(s.uses).startsWith('actions/checkout') && String(s.with?.token).includes('steps.app-token.outputs.token'));
    const npmCi = run.findIndex((s) => s.run === 'npm ci');
    const action = run.findIndex((s) => String(s.uses).startsWith('anthropics/claude-code-action'));
    expect(probe, 'the split lane no longer runs the push probe').toBeGreaterThanOrEqual(0);
    expect(run[probe].run).toContain('git push --dry-run');
    expect(appCheckout).toBeGreaterThanOrEqual(0);
    expect(probe).toBeGreaterThan(appCheckout);
    expect(npmCi).toBeGreaterThanOrEqual(0);
    expect(probe).toBeGreaterThan(npmCi);
    expect(probe).toBeLessThan(action);
  });

  it('the prompt carries the lineage marker, closes the parent, and forbids adopting it', () => {
    const prompt = agent?.with?.prompt ?? '';
    expect(prompt).toContain('<!-- qa:split-of #${{ github.event.issue.number || inputs.issue }} -->');
    expect(prompt).toMatch(/carries NO `\*\*Closes #N\*\*`/);
    expect(prompt).toContain('`Closes #<issue>.`');
    expect(prompt).toContain('review:please');
    expect(prompt).toContain('node "$KANON/scripts/brief-guard.mjs"');
  });

  it('the prompt names the rule that allows the edit (the Reviewer, RA-2407)', () => {
    // The rule is Kanon's (K-PROJ-10) since kanon#36, not a section of the adopter's
    // document; the lane's half is that the prompt names it and no section number.
    const prompt = agent?.with?.prompt ?? '';
    expect(prompt).toContain('an approved brief is otherwise immutable, K-PROJ-10');
    expect(prompt).not.toMatch(/§\d/);
  });

  it('the sweep and the crash job both route through the shared function', () => {
    for (const f of ['scripts/dispatch-sweep.mjs', 'scripts/implement-crash.mjs']) {
      expect(readFileSync(join(ROOT, f), 'utf8'), f).toMatch(/exhaustedRoute\(\{ project/);
    }
  });
});
