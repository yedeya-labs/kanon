import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { issueTitle, failureText } from '../../scripts/deploy-report.mjs';
import { commentRules, failedLogs, LOG_CHARS, namesRun, REPORT_AUTHOR, reportedIssues, runUrl, tail } from '../../scripts/deploy-diagnose.mjs';
import { writeStub } from './helpers/stub-bin.js';

/**
 * Plan 0010 step D8 (§9, decision 13): the deploy diagnose lane, `agent-deploy-diagnose.yml`. It
 * runs only after a deploy run FAILED, as a separate run, holding no cloud credential, running no
 * hook and dispatching nothing, with a shell that runs nothing from the tree (its allow-list is
 * pinned in tests/unit/lead-shell.test.ts); and it comments only on the issues the deploy lane's
 * `report` jobs wrote on for that run (`scripts/deploy-diagnose.mjs`).
 *
 * `problems` is the shape, as a list of what is wrong, so each mutation the plan names is a case
 * below that changes a copy of the parsed lane and must name its problem (`K-PRIN-11`).
 */

const FILE = '.github/workflows/agent-deploy-diagnose.yml';
type Step = { id?: string; name?: string; uses?: string; run?: string; if?: string; env?: Record<string, unknown> };
type Job = { needs?: string | string[]; if?: string; uses?: string; environment?: unknown; permissions?: Record<string, string>; steps?: Step[]; with?: Record<string, unknown>; secrets?: unknown; outputs?: Record<string, string> };
type Workflow = { on: Record<string, { secrets?: Record<string, unknown>; inputs?: Record<string, unknown> } | undefined>; permissions?: Record<string, string>; jobs: Record<string, Job> };
const PARSED = parse(readFileSync(FILE, 'utf8')) as Workflow;
const load = () => structuredClone(PARSED);

/** The one admission the plan allows: a `workflow_run` that concluded `failure`. */
const ONLY_FAILURE = "github.event_name == 'workflow_run' && github.event.workflow_run.conclusion == 'failure'";

/** What is wrong with the lane's shape, or nothing. */
const problems = (wf: Workflow): string[] => {
  const out: string[] = [];
  if (Object.keys(wf.on).join() !== 'workflow_call') out.push('a trigger of its own: only its caller triggers it');
  const grants = [['(workflow)', wf.permissions ?? {}] as const, ...Object.entries(wf.jobs).map(([n, j]) => [n, j.permissions ?? {}] as const)];
  for (const [n, p] of grants) {
    if ('id-token' in p) out.push(`${n} holds id-token`);
    for (const [k, v] of Object.entries(p)) if (v === 'write') out.push(`${n} grants the workflow token ${k}: write`);
  }
  for (const [n, j] of Object.entries(wf.jobs)) {
    if (j.environment !== undefined) out.push(`${n} sets an environment`);
    if (j.secrets === 'inherit') out.push(`${n} inherits secrets`);
    for (const s of j.steps ?? []) if (/^\.\//.test(String(s.uses ?? ''))) out.push(`${n} runs the project's ${s.uses}`);
  }
  // Every job waits for the gate, which admits a failed deploy run alone.
  const gate = wf.jobs.gate;
  if (gate?.if !== ONLY_FAILURE) out.push(`the gate admits more than a failed run: ${gate?.if}`);
  for (const [n, j] of Object.entries(wf.jobs)) if (n !== 'gate' && ![j.needs ?? []].flat().includes('gate')) out.push(`${n} doesn't wait for the gate`);
  const agent = wf.jobs.diagnose;
  if (agent?.uses !== '$/.github/workflows/agent-lane.yml') out.push('the agent job is not the spine');
  if (agent?.with?.['project-setup'] !== false) out.push('the agent job runs the project-setup hook');
  if (!/needs\.gate\.outputs\.member == 'true'/.test(String(agent?.if)) || !/needs\.gate\.outputs\.issues != ''/.test(String(agent?.if))) out.push('the agent runs without a member or an issue');
  // Its App token: the tree and the issues, no Actions (so it re-runs and dispatches nothing).
  const perms = Object.fromEntries(Object.entries(agent?.with ?? {}).filter(([k]) => k.startsWith('permission-')));
  if (JSON.stringify(perms) !== JSON.stringify({ 'permission-contents': 'read', 'permission-issues': 'write' })) out.push(`the agent's token is ${JSON.stringify(perms)}`);
  const text = JSON.stringify(wf);
  if (/gh (workflow|run (rerun|cancel))|\/dispatches|\/rerun|createWorkflowDispatch/.test(text)) out.push('it dispatches or re-runs');
  if (/Bash\(gh issue comment:\*\)|Bash\(gh issue comment \*\)/.test(String(agent?.with?.claude_args))) out.push('the agent may comment on any issue');
  return out;
};

describe('the diagnose lane\'s shape (plan 0010 D8)', () => {
  it('holds', () => {
    expect(problems(load())).toEqual([]);
  });

  it('is called by its caller alone, with the Author App\'s secrets and a Claude credential', () => {
    expect(Object.keys(PARSED.on.workflow_call?.secrets ?? {}).sort()).toEqual(['ANTHROPIC_API_KEY', 'AUTHOR_APP_ID', 'AUTHOR_APP_PRIVATE_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
    expect(readFileSync(FILE, 'utf8')).toMatch(/^# KANON ROLE: Explorer$/m);
  });

  it('hands the agent the gate\'s issues, log and comment rules, from the script and no other step', () => {
    const gate = PARSED.jobs.gate!;
    expect(gate.outputs).toMatchObject({ issues: '${{ steps.run.outputs.issues }}', rules: '${{ steps.run.outputs.rules }}', log: '${{ steps.run.outputs.log }}' });
    const run = gate.steps!.find((s) => s.id === 'run')!;
    expect(run.run).toBe('node "$KANON/scripts/deploy-diagnose.mjs"');
    expect(run.if).toBe("steps.gate.outputs.member == 'true'");
    const args = String(PARSED.jobs.diagnose!.with?.claude_args);
    expect(args).toContain('${{ needs.gate.outputs.rules }}');
    expect(String(PARSED.jobs.diagnose!.with?.prompt)).toContain('${{ needs.gate.outputs.log }}');
  });

  // Each mutation the plan names, and the others the shape forbids, is named.
  const MUTATIONS: Array<[string, (wf: Workflow) => void, RegExp]> = [
    ['`id-token: write` on its agent job', (wf) => { wf.jobs.diagnose!.permissions = { contents: 'read', 'id-token': 'write' }; }, /diagnose holds id-token/],
    ['`id-token: write` on the gate', (wf) => { wf.jobs.gate!.permissions!['id-token'] = 'write'; }, /gate holds id-token/],
    ['a trigger on any conclusion', (wf) => { wf.jobs.gate!.if = "github.event_name == 'workflow_run'"; }, /admits more than a failed run/],
    ['a trigger on a success too', (wf) => { wf.jobs.gate!.if = `${ONLY_FAILURE} || github.event.workflow_run.conclusion == 'success'`; }, /admits more than a failed run/],
    ['a trigger of its own', (wf) => { wf.on.workflow_dispatch = {}; }, /a trigger of its own/],
    ['an environment', (wf) => { wf.jobs.diagnose!.environment = 'production'; }, /sets an environment/],
    ['the project-setup hook', (wf) => { wf.jobs.diagnose!.with!['project-setup'] = true; }, /runs the project-setup hook/],
    ['a deploy hook', (wf) => { wf.jobs.gate!.steps!.push({ uses: './.github/actions/deploy' }); }, /runs the project's/],
    ['inherited secrets', (wf) => { wf.jobs.diagnose!.secrets = 'inherit'; }, /inherits secrets/],
    ['an Actions grant on its token', (wf) => { wf.jobs.diagnose!.with!['permission-actions'] = 'write'; }, /the agent's token is/],
    ['`gh workflow run` in its allow-list', (wf) => { wf.jobs.diagnose!.with!.claude_args += '\n--allowedTools "Bash(gh workflow run:*)"'; }, /dispatches or re-runs/],
    ['a comment on any issue', (wf) => { wf.jobs.diagnose!.with!.claude_args += '\n--allowedTools "Bash(gh issue comment:*)"'; }, /comment on any issue/],
    ['an agent with no issue to comment on', (wf) => { wf.jobs.diagnose!.if = "needs.gate.outputs.member == 'true'"; }, /without a member or an issue/],
    ['a job that skips the gate', (wf) => { wf.jobs.diagnose!.needs = []; }, /doesn't wait for the gate/],
  ];
  it.each(MUTATIONS)('names %s', (_, mutate, problem) => {
    const wf = load();
    mutate(wf);
    expect(problems(wf).join('\n')).toMatch(problem);
  });
});

/** A fake API over issues, comments, jobs and logs. */
const api = (data: { issues?: unknown[]; comments?: Record<number, unknown[]>; jobs?: unknown[]; logs?: Record<number, string> }) => {
  const calls: string[] = [];
  const fn = (path: string) => {
    calls.push(path);
    if (/\/issues\?/.test(path)) return /page=1(&|$)/.test(path) ? data.issues ?? [] : [];
    const c = /\/issues\/(\d+)\/comments/.exec(path);
    if (c) return /page=1(&|$)/.test(path) ? data.comments?.[Number(c[1])] ?? [] : [];
    if (/\/attempts\/\d+\/jobs/.test(path)) return { jobs: /page=1(&|$)/.test(path) ? data.jobs ?? [] : [] };
    const l = /\/actions\/jobs\/(\d+)\/logs$/.exec(path);
    if (l) {
      const text = data.logs?.[Number(l[1])];
      if (text === undefined) throw new Error('HTTP 410: gone');
      return text;
    }
    throw new Error(`unexpected ${path}`);
  };
  return Object.assign(fn, { calls });
};

const REPO = 'acme/app';
const URL = runUrl('https://github.com', REPO, 123);
const BOT = { login: REPORT_AUTHOR };
const filed = (n: number, environment: string, body: string, extra: Record<string, unknown> = {}) =>
  ({ number: n, title: issueTitle(environment), body, labels: [{ name: 'bug' }, { name: 'sev:high' }], user: BOT, ...extra });
const text = (runId: number) => failureText({ environment: 'staging', role: 'pre-production', position: 1, outcome: 'failed', failed_stage: 'deploy', release: 'v1.2.0', runUrl: runUrl('https://github.com', REPO, runId) });

describe("the issues the run's report jobs wrote on", () => {
  it('reads the run line exactly as the report jobs write it, and never a longer run id', () => {
    expect(namesRun(text(123), URL)).toBe(true);
    expect(namesRun(text(1234), URL)).toBe(false);
    expect(namesRun(text(12), URL)).toBe(false);
    expect(namesRun(`see Run: ${URL}`, URL)).toBe(false);
  });

  it('finds an issue the run filed, and one it commented on, and nothing else', () => {
    const a = api({
      issues: [
        filed(5, 'staging', text(123)),
        filed(9, 'production', text(77)),
        filed(11, 'preview', text(77)),
        // A person's issue with the same title and the run's line: not the report's.
        filed(13, 'qa', text(123), { user: { login: 'someone' } }),
        // The run's line, but not the report's title, or not labelled `bug`, or a pull request.
        { ...filed(14, 'staging', text(123)), title: 'Deploy to staging broke' },
        { ...filed(15, 'staging', text(123)), labels: [{ name: 'sev:high' }] },
        filed(16, 'staging', text(123), { pull_request: {} }),
      ],
      comments: {
        9: [{ user: BOT, body: text(123) }],
        // The run's line pasted by a person is not the report's.
        11: [{ user: { login: 'someone' }, body: text(123) }],
        13: [{ user: { login: 'someone' }, body: 'me too' }],
      },
    });
    expect(reportedIssues({ api: a, repo: REPO, url: URL, since: '2026-10-15T10:00:00Z' })).toEqual([{ number: 5, environment: 'staging' }, { number: 9, environment: 'production' }]);
    // Comments are read only since the run started, and only open bug issues are listed.
    expect(a.calls.filter((c) => c.includes('/comments')).every((c) => c.includes('since=2026-10-15T10%3A00%3A00Z'))).toBe(true);
    expect(a.calls[0]).toMatch(/^repos\/acme\/app\/issues\?state=open&labels=bug&per_page=100&page=1$/);
  });

  it('finds none for a run that filed nothing', () => {
    expect(reportedIssues({ api: api({ issues: [filed(5, 'staging', text(77))] }), repo: REPO, url: URL, since: '2026-10-15T10:00:00Z' })).toEqual([]);
  });

  it('allows a comment on each issue by its number, and on no other', () => {
    const rules = commentRules([5, 9]);
    expect(rules).toBe('--allowedTools "Bash(gh issue comment 5 --body:*)" "Bash(gh issue comment 9 --body:*)"');
    // A rule for #5 doesn't admit #55: the number is followed by ` --body`.
    expect('gh issue comment 55 --body x'.startsWith('gh issue comment 5 --body')).toBe(false);
    expect(commentRules([])).toBe('');
  });
});

describe("the failed jobs' logs", () => {
  it('keeps the last lines of each failed job, without the runner\'s timestamps', () => {
    const log = Array.from({ length: 400 }, (_, i) => `2026-10-15T10:00:${String(i % 60).padStart(2, '0')}.1234567Z line ${i}`).join('\n');
    const t = tail(log).split('\n');
    expect(t).toHaveLength(150);
    expect(t.at(-1)).toBe('line 399');
    expect(t[0]).toBe('line 250');
  });

  it('reads only the failed jobs, says when a log is gone, and cuts the whole to its size', () => {
    const big = Array.from({ length: 150 }, () => 'x'.repeat(600)).join('\n');
    const a = api({
      jobs: [
        { id: 1, name: 'release / gate', conclusion: 'success' },
        { id: 2, name: 'staging / deploy', conclusion: 'failure' },
        { id: 3, name: 'staging / record', conclusion: 'failure' },
        { id: 4, name: 'production / deploy', conclusion: 'skipped' },
      ],
      logs: { 1: 'fine', 2: big },
    });
    const r = failedLogs({ api: a, repo: REPO, id: 123, attempt: 2 });
    expect(r.jobs).toEqual(['staging / deploy', 'staging / record']);
    expect(a.calls).toContain('repos/acme/app/actions/runs/123/attempts/2/jobs?per_page=100&page=1');
    expect(a.calls.some((c) => c.endsWith('/jobs/1/logs'))).toBe(false);
    expect(r.log.startsWith('=== staging / deploy ===\n')).toBe(true);
    expect(r.log).toContain('(cut)');
    expect(r.log.length).toBeLessThanOrEqual(LOG_CHARS + 10);
  });
});

describe('the gate step, end to end with a stub gh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-diagnose-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const issues = JSON.stringify([filed(5, 'staging', text(123))]);
  writeFileSync(join(dir, 'issues.json'), issues);
  writeFileSync(join(dir, 'jobs.json'), JSON.stringify({ jobs: [{ id: 2, name: 'staging / deploy', conclusion: 'failure' }] }));
  writeStub(join(dir, 'gh'), `#!/usr/bin/env bash
case "$*" in
  *"/issues?"*page=1) cat '${join(dir, 'issues.json')}' ;;
  *"/issues?"*) echo '[]' ;;
  *"/comments"*) echo '[]' ;;
  *"/attempts/"*page=1) cat '${join(dir, 'jobs.json')}' ;;
  *"/attempts/"*) echo '{"jobs":[]}' ;;
  *"/jobs/2/logs"*) printf '2026-10-15T10:00:00.0Z Error: the stack failed\\n' ;;
  *) echo "unexpected $*" >&2; exit 1 ;;
esac
`);
  const run = (env: Record<string, string>) => {
    const out = join(dir, `out-${Math.random().toString(36).slice(2)}`);
    writeFileSync(out, '');
    const r = spawnSync(process.execPath, ['scripts/deploy-diagnose.mjs'], {
      encoding: 'utf8',
      env: { PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: REPO, GITHUB_SERVER_URL: 'https://github.com', GITHUB_OUTPUT: out, RUN_ATTEMPT: '1', RUN_STARTED_AT: '2026-10-15T10:00:00Z', ...env },
    });
    return { ...r, outputs: readFileSync(out, 'utf8') };
  };

  it('writes the issues, their comment rules and the log', () => {
    const r = run({ RUN_ID: '123' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.outputs).toContain('issues=5\n');
    expect(r.outputs).toContain('rules=--allowedTools "Bash(gh issue comment 5 --body:*)"\n');
    expect(r.outputs).toMatch(/log<<(KANON_[0-9a-f]+)\n=== staging \/ deploy ===\nError: the stack failed\n\1\n/);
  });

  it('writes no issue and no rule for another run, so no agent runs', () => {
    const r = run({ RUN_ID: '124' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.outputs).toContain('issues=\n');
    expect(r.outputs).toContain('rules=\n');
    expect(r.stdout).toContain('nothing to diagnose');
  });

  it('refuses to run without the run it reads', () => {
    const r = run({ RUN_ID: '' });
    expect(r.status).toBe(2);
  });
});
