import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FILER_LABELS, OUTCOME_LABELS, outcomeOf, precisionOf, readSignals, render, run, signalOf, tally, toJson,
} from '../../scripts/signal-outcomes.mjs';
import { readFlattened } from './helpers/called-workflow.js';

/**
 * kanon#466: precision per signal was unmeasurable. The only writer of an outcome label is the
 * triage lane, which runs on an Explorer finding only, so a repository that resolves its signals
 * through the implement lane or by hand recorded none, and the Overseer's ratio was 0/0.
 * `signal-outcomes` counts what the issues already record: an outcome label wins, a signal a
 * merged pull request closed counts as confirmed, and anything else that is closed is listed for
 * whoever closed it to label.
 */

type Issue = Parameters<typeof outcomeOf>[0];
const issue = (number: number, labels: string[], extra: Partial<Issue> = {}): Issue => ({
  number, state: 'OPEN', stateReason: null, labels: { nodes: labels.map((name) => ({ name })) },
  closedByPullRequestsReferences: { nodes: [] }, ...extra,
});
const closed = (number: number, labels: string[], reason: 'COMPLETED' | 'NOT_PLANNED', prs: { number: number; merged: boolean }[] = []) =>
  issue(number, labels, { state: 'CLOSED', stateReason: reason, closedByPullRequestsReferences: { nodes: prs } });
const MERGED = [{ number: 900, merged: true }];
const UNMERGED = [{ number: 901, merged: false }];

describe('signalOf', () => {
  it('is the filer label and its signal labels, sorted', () => {
    expect(signalOf(issue(1, ['bug', 'signal:security', 'agent:explorer', 'signal:contract']))).toBe('agent:explorer signal:contract signal:security');
    expect(signalOf(issue(2, ['follow-up', 'agent:reviewer', 'sev:low']))).toBe('agent:reviewer');
  });

  it('is null for an issue no lane filed, whatever dispatch label it carries', () => {
    expect(signalOf(issue(3, ['agent:implement', 'enhancement']))).toBeNull();
    expect(signalOf(issue(4, ['agent:triage', 'signal:contract']))).toBeNull();
  });

  it('matches labels case-insensitively, as GitHub does', () => {
    expect(signalOf(issue(5, ['Agent:Reviewer']))).toBe('agent:reviewer');
  });
});

describe('outcomeOf', () => {
  it('reads each outcome label as its outcome, open or closed', () => {
    expect(outcomeOf(issue(1, ['agent:explorer', 'qa:reproduced']))).toBe('reproduced');
    expect(outcomeOf(closed(2, ['agent:explorer', 'qa:false-positive'], 'NOT_PLANNED'))).toBe('falsePositive');
    expect(outcomeOf(closed(3, ['agent:explorer', 'qa:cannot-reproduce'], 'NOT_PLANNED'))).toBe('cannotReproduce');
  });

  it('lets an outcome label win over a merged pull request', () => {
    expect(outcomeOf(closed(4, ['agent:reviewer', 'qa:false-positive'], 'COMPLETED', MERGED))).toBe('falsePositive');
  });

  it('reads two outcome labels as a contradiction, not as either', () => {
    expect(outcomeOf(closed(5, ['qa:reproduced', 'qa:false-positive'], 'COMPLETED', MERGED))).toBe('conflict');
  });

  it('counts a signal closed by a merged pull request as fixed', () => {
    expect(outcomeOf(closed(6, ['agent:reviewer'], 'COMPLETED', [...UNMERGED, ...MERGED]))).toBe('fixed');
  });

  it('leaves a signal closed without a merged fix unrecorded: only whoever closed it knows', () => {
    expect(outcomeOf(closed(7, ['agent:reviewer'], 'COMPLETED'))).toBe('unrecorded');
    expect(outcomeOf(closed(8, ['agent:reviewer'], 'COMPLETED', UNMERGED))).toBe('unrecorded');
    // Not planned is a person's call even when a merged pull request mentions it.
    expect(outcomeOf(closed(9, ['agent:reviewer'], 'NOT_PLANNED', MERGED))).toBe('unrecorded');
  });

  it('reads an open signal with no label as open, even when a merged pull request references it', () => {
    expect(outcomeOf(issue(10, ['agent:reviewer'], { closedByPullRequestsReferences: { nodes: MERGED } }))).toBe('open');
  });
});

describe('tally and precisionOf', () => {
  const issues = [
    closed(1, ['agent:reviewer'], 'COMPLETED', MERGED),
    closed(2, ['agent:reviewer'], 'COMPLETED', MERGED),
    closed(3, ['agent:reviewer', 'qa:false-positive'], 'NOT_PLANNED'),
    closed(4, ['agent:reviewer'], 'NOT_PLANNED'),
    issue(5, ['agent:reviewer']),
    issue(6, ['agent:explorer', 'signal:contract', 'qa:reproduced']),
    issue(7, ['agent:implement']),
  ];
  const t = tally(issues);

  it('groups by signal and leaves out what no lane filed', () => {
    expect([...t.keys()]).toEqual(['agent:explorer signal:contract', 'agent:reviewer']);
    const r = t.get('agent:reviewer')!;
    expect(r.fixed).toEqual([1, 2]);
    expect(r.falsePositive).toEqual([3]);
    expect(r.unrecorded).toEqual([4]);
    expect(r.open).toEqual([5]);
  });

  it('is confirmed over confirmed plus false positive, with a floor that counts the unrecorded as false', () => {
    expect(precisionOf(t.get('agent:reviewer')!)).toEqual({ confirmed: 2, falsePositive: 1, unrecorded: 1, precision: 2 / 3, floor: 2 / 4 });
    expect(precisionOf(t.get('agent:explorer signal:contract')!)).toMatchObject({ confirmed: 1, precision: 1, floor: 1 });
  });

  it('is undefined, not perfect, where nothing was confirmed or refuted', () => {
    const open = tally([issue(1, ['agent:overseer'])]).get('agent:overseer')!;
    expect(precisionOf(open)).toMatchObject({ precision: null, floor: null });
    const onlyUnrecorded = tally([closed(2, ['agent:overseer'], 'NOT_PLANNED')]).get('agent:overseer')!;
    expect(precisionOf(onlyUnrecorded)).toMatchObject({ precision: null, floor: 0 });
  });

  it('renders a status line, the table, the unrecorded list and the contradictions', () => {
    const out = render(tally([...issues, closed(8, ['agent:reviewer', 'qa:reproduced', 'qa:false-positive'], 'COMPLETED')]), 8);
    expect(out.split('\n')[0]).toBe('signal-outcomes: ok issues=8 signals=2');
    expect(out).toContain('| `agent:reviewer` | 0 | 2 | 1 | 0 | 1 | 1 | 67% (2/3) | 50% (2/4) |');
    expect(out).toContain('| `agent:explorer signal:contract` | 1 | 0 | 0 | 0 | 0 | 0 | 100% (1/1) | 100% (1/1) |');
    expect(out).toMatch(/^Unrecorded .*: #4$/m);
    expect(out).toMatch(/^Contradictory .*: #8$/m);
  });

  it('says so when no issue carries a filer label, rather than printing an empty table', () => {
    const out = render(tally([issue(1, ['enhancement'])]), 1);
    expect(out.split('\n')[0]).toBe('signal-outcomes: ok issues=1 signals=0');
    expect(out).toContain('no signal has an outcome to count');
  });

  it('carries the same counts as JSON', () => {
    const j = toJson(t, issues.length);
    expect(j.issues).toBe(7);
    expect(j.signals.find((s) => s.signal === 'agent:reviewer')).toMatchObject({
      fixed: [1, 2], falsePositive: [3], unrecorded: [4], precision: { confirmed: 2, falsePositive: 1, unrecorded: 1, precision: 2 / 3 },
    });
  });
});

describe('readSignals', () => {
  const page = (nodes: Issue[], next: string | null) => JSON.stringify({
    data: { repository: { issues: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes } } },
  });

  it('asks for every filer label and follows the cursor to the last page', () => {
    const calls: string[][] = [];
    const pages = [page([issue(1, ['agent:reviewer'])], 'c1'), page([issue(2, ['agent:explorer'])], null)];
    const got = readSignals('o/r', (args) => { calls.push(args); return pages[calls.length - 1]!; });
    expect(got.map((i) => i.number)).toEqual([1, 2]);
    for (const l of FILER_LABELS) expect(calls[0]).toContain(`labels[]=${l}`);
    expect(calls[0]).toContain('owner=o');
    expect(calls[0]).toContain('name=r');
    expect(calls[0]!.some((a) => a.startsWith('cursor='))).toBe(false);
    expect(calls[1]).toContain('cursor=c1');
  });

  it('refuses a truncated corpus rather than counting part of it', () => {
    expect(() => readSignals('o/r', () => page([issue(1, ['agent:reviewer'])], 'more'), 2)).toThrow(/truncated/);
  });

  it('refuses a reply with no issue list, and a repository that is not owner/name', () => {
    expect(() => readSignals('o/r', () => JSON.stringify({ data: { repository: null } }))).toThrow(/no issue list/);
    expect(() => readSignals('o', () => '{}')).toThrow(/owner\/name/);
  });
});

describe('run', () => {
  it('fails by name, never as an empty count, when the read fails', () => {
    const r = run({ repo: 'o/r', json: false, gh: () => { throw new Error('HTTP 401\nmore'); } });
    expect(r.code).toBe(1);
    expect(r.out).toBe('signal-outcomes: UNAVAILABLE — HTTP 401\n');
  });

  it('fails by name without a repository', () => {
    expect(run({ repo: undefined, json: false, gh: () => '' })).toEqual({ code: 1, out: 'signal-outcomes: UNAVAILABLE — GITHUB_REPOSITORY is not set\n' });
  });

  it('runs as a CLI, exiting 1 when it cannot read', () => {
    const env = { ...process.env };
    delete env.GITHUB_REPOSITORY;
    const r = spawnSync(process.execPath, ['scripts/signal-outcomes.mjs'], { encoding: 'utf8', env });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^signal-outcomes: UNAVAILABLE/);
  });
});

describe('the labels it reads are the taxonomy', () => {
  const taxonomy = (JSON.parse(readFileSync('rulebook/labels.json', 'utf8')) as { labels: { name: string; family: string; description: string }[] }).labels;

  it('reads every outcome label the taxonomy holds', () => {
    for (const l of Object.values(OUTCOME_LABELS)) expect(taxonomy.map((t) => t.name)).toContain(l);
  });

  it('counts exactly the Agent labels that say a lane filed the issue', () => {
    const filers = taxonomy.filter((t) => t.family === 'Agent' && /^Filed\b/.test(t.description)).map((t) => t.name);
    expect([...FILER_LABELS].sort()).toEqual(filers.sort());
  });
});

describe("the Overseer's prompt runs it", () => {
  const steps = ((readFlattened('.github/workflows/agent-overseer.yml') as { jobs: { overseer: { steps: { id?: string; with?: { prompt?: string } }[] } } })
    .jobs.overseer.steps);
  const flat = String(steps.find((s) => s.id === 'agent')?.with?.prompt).replace(/\s+/g, ' ');

  it('pastes its output under its own heading, names the unrecorded for a person, and sets no target', () => {
    expect(flat).toContain('run `node "$KANON/scripts/signal-outcomes.mjs"` and paste its output VERBATIM under a `## Precision per signal` heading');
    expect(flat).toContain('asking whoever closed each to label it `qa:false-positive` or `qa:reproduced`, and file nothing for them');
    expect(flat).toContain('say precision is UNAVAILABLE');
    expect(flat).toContain('propose no precision threshold');
  });
});
