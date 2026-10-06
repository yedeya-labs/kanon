import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  GATE_CANDIDATE_QUERY, GATE_DECLINED_LABEL, exitPlan, gateCandidateDecision, renderSummary, run,
} from '../../scripts/gate-candidate-exit.mjs';
import { gateCandidatesFrom, readGateCandidates, renderGateCandidates } from '../../scripts/weekly-digest.mjs';

/**
 * kanon#171: `gate-candidate` comes off once the Stakeholder has decided (`K-WORK-10`). Placed
 * means a roadmap milestone (open and dated); declined means `gate:declined`. The dispatch sweep
 * removes the label, and the weekly digest lists only what still waits, from one predicate.
 */
const ROOT = process.cwd();
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

const GATE = { title: 'Launch', due_on: '2026-12-31T00:00:00Z', state: 'open' };
const BUCKET = { title: 'Product Backlog', due_on: null, state: 'open' };
const MET = { title: 'Old gate', due_on: '2026-08-31T00:00:00Z', state: 'closed' };
type Item = { number: number; state?: string; pull_request?: unknown; labels: { name: string }[]; milestone?: typeof GATE | typeof BUCKET | null; created_at?: string; html_url?: string; title?: string };
const issue = (number: number, labels: string[], milestone: Item['milestone'] = BUCKET, extra: Partial<Item> = {}): Item => ({
  number, state: 'open', labels: labels.map((name) => ({ name })), milestone,
  created_at: '2026-10-01T00:00:00Z', html_url: `https://github.com/o/r/issues/${number}`, title: `t${number}`, ...extra,
});

describe('gateCandidateDecision', () => {
  it('reads a roadmap milestone as placed, gate:declined as declined, both as a conflict, neither as waiting', () => {
    expect(gateCandidateDecision(issue(1, ['gate-candidate'], GATE))).toBe('placed');
    expect(gateCandidateDecision(issue(2, ['gate-candidate', 'gate:declined']))).toBe('declined');
    expect(gateCandidateDecision(issue(3, ['gate-candidate', 'gate:declined'], GATE))).toBe('conflict');
    expect(gateCandidateDecision(issue(4, ['gate-candidate']))).toBeNull();
  });

  it('a bucket, no milestone, or a met (closed) gate is not a placement', () => {
    expect(gateCandidateDecision(issue(5, ['gate-candidate'], null))).toBeNull();
    expect(gateCandidateDecision(issue(6, ['gate-candidate'], MET as never))).toBeNull();
  });

  it('matches gate:declined case-insensitively, as GitHub does', () => {
    expect(gateCandidateDecision(issue(7, ['gate-candidate', 'Gate:Declined']))).toBe('declined');
  });
});

describe('exitPlan', () => {
  const items = [
    issue(1, ['gate-candidate'], GATE),
    issue(2, ['gate-candidate', 'gate:declined']),
    issue(3, ['gate-candidate', 'gate:declined'], GATE),
    issue(4, ['gate-candidate', 'sev:critical']),
    issue(5, ['gate-candidate'], GATE, { pull_request: {} }),
    issue(6, ['gate-candidate'], GATE, { state: 'closed' }),
    issue(7, ['gate:declined'], GATE),
  ];

  it('retires the placed and the declined, leaves the contradictory and the waiting, ignores the rest', () => {
    expect(exitPlan(items)).toEqual({
      retire: [{ number: 1, decision: 'placed', milestone: 'Launch' }, { number: 2, decision: 'declined', milestone: null }],
      conflicts: [3],
      awaiting: [4],
    });
  });

  it('renders every state, and a dry run says it removed nothing', () => {
    const out = renderSummary(exitPlan(items), { apply: false });
    expect(out).toContain('1 awaiting the Stakeholder, 2 decided, 1 contradictory.');
    expect(out).toContain('#1: placed on Launch; would remove the label (dry run)');
    expect(out).toContain('#2: declined (`gate:declined`); would remove the label (dry run)');
    expect(out).toContain('#3: on a roadmap milestone AND `gate:declined`; label left on');
  });
});

describe('run', () => {
  const fake = (items: Item[], opts: { failOn?: number; goneOn?: number; readFails?: boolean } = {}) => {
    const calls: string[][] = [];
    const gh = (args: string[]): string => {
      calls.push(args);
      if (args.includes('DELETE')) {
        const n = Number(/issues\/(\d+)\/labels/.exec(args.join(' '))?.[1]);
        if (n === opts.failOn) throw Object.assign(new Error('gh: HTTP 403'), { stderr: 'HTTP 403: Resource not accessible by integration' });
        if (n === opts.goneOn) throw Object.assign(new Error('gh: HTTP 404'), { stderr: 'Label does not exist (HTTP 404)' });
        return '[]';
      }
      if (opts.readFails) throw new Error('HTTP 502');
      return JSON.stringify(items);
    };
    return { gh, calls, deletes: () => calls.filter((c) => c.includes('DELETE')).map((c) => c.at(-1)) };
  };
  const items = [issue(1, ['gate-candidate'], GATE), issue(2, ['gate-candidate', 'gate:declined']), issue(3, ['gate-candidate', 'gate:declined'], GATE), issue(4, ['gate-candidate'])];

  it('with apply, removes gate-candidate from exactly the decided issues, and nothing else', () => {
    const f = fake(items);
    let text = '';
    const r = run({ repo: 'o/r', apply: true, gh: f.gh, summary: (t) => { text = t; } });
    expect(f.deletes()).toEqual(['repos/o/r/issues/1/labels/gate-candidate', 'repos/o/r/issues/2/labels/gate-candidate']);
    expect(r.removed).toEqual([1, 2]);
    expect(text).toContain('#1: placed on Launch; label removed');
    // Never a write other than that one DELETE: no label added, no milestone, no close.
    expect(f.calls.filter((c) => !c.includes('DELETE')).every((c) => c.length === 2 && c[0] === 'api' && /\/issues\?state=open&labels=gate-candidate/.test(c[1] ?? ''))).toBe(true);
  });

  it('without apply, removes nothing', () => {
    const f = fake(items);
    run({ repo: 'o/r', apply: false, gh: f.gh });
    expect(f.deletes()).toEqual([]);
  });

  it('a failed removal is reported and does not stop the rest; one already gone counts as removed', () => {
    const f = fake([...items, issue(5, ['gate-candidate'], GATE)], { failOn: 1, goneOn: 2 });
    let text = '';
    const r = run({ repo: 'o/r', apply: true, gh: f.gh, summary: (t) => { text = t; } });
    expect(r.failed).toEqual([1]);
    expect(r.removed).toEqual([2, 5]);
    expect(text).toContain('#1: placed on Launch; removal FAILED, retried next tick');
  });

  it('an unreadable list removes nothing, never throws, and names the query to run by hand', () => {
    const f = fake(items, { readFails: true });
    let text = '';
    expect(() => run({ repo: 'o/r', apply: true, gh: f.gh, summary: (t) => { text = t; } })).not.toThrow();
    expect(f.deletes()).toEqual([]);
    expect(text).toContain(GATE_CANDIDATE_QUERY);
  });

  it('reads to the last page', () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => issue(1000 * n + i, ['gate-candidate'], GATE));
    const pages = [page(100), page(3)];
    const calls: string[] = [];
    const r = run({ repo: 'o/r', apply: false, gh: (args) => { calls.push(args[1] ?? ''); return JSON.stringify(pages[calls.length - 1] ?? []); } });
    expect(calls.map((c) => /[?&]page=(\d+)/.exec(c)?.[1])).toEqual(['1', '2']);
    expect(r.plan?.retire).toHaveLength(103);
  });
});

describe('the weekly digest reads the same decision', () => {
  const now = new Date('2026-10-06T00:00:00Z');

  it('lists only candidates awaiting a decision, keeping a contradictory one', () => {
    const items = [issue(1, ['gate-candidate'], GATE), issue(2, ['gate-candidate', 'gate:declined']), issue(3, ['gate-candidate', 'gate:declined'], GATE), issue(4, ['gate-candidate'])];
    expect(gateCandidatesFrom(items, now).map((c: { number: number }) => c.number)).toEqual([3, 4]);
  });

  it('counts declined candidates whose label is not off yet, and says so', async () => {
    const items = [issue(1, ['gate-candidate'], GATE), issue(2, ['gate-candidate', 'gate:declined']), issue(4, ['gate-candidate'])];
    const api = async (path: string) => (path.includes('/labels/') ? { name: 'gate-candidate' } : items);
    const r = await readGateCandidates({ api, repo: 'o/r', now });
    expect(r).toMatchObject({ ok: true, placed: 1, declined: 1 });
    expect(renderGateCandidates(r)).toContain('1 more already declined (`gate:declined`)');
  });
});

describe('the taxonomy and the lane carry it', () => {
  it('gate:declined is a taxonomy label, created at installation like any other', () => {
    const labels = JSON.parse(read('rulebook/labels.json')).labels as { name: string; createdBy?: string }[];
    const declined = labels.find((l) => l.name === GATE_DECLINED_LABEL);
    expect(declined).toBeDefined();
    expect(declined?.createdBy).toBeUndefined();
  });

  it('the dispatch sweep runs the exit on the Lead\'s App token, applying on the schedule only', () => {
    const wf = parse(read('.github/workflows/agent-dispatch-sweep.yml')) as { jobs: Record<string, { steps?: { name?: string; run?: string; if?: string; env?: Record<string, string> }[] }> };
    const steps = Object.values(wf.jobs).flatMap((j) => j.steps ?? []);
    const exit = steps.filter((s) => /scripts\/gate-candidate-exit\.mjs/.test(s.run ?? ''));
    expect(exit).toHaveLength(1);
    // No `--apply` on the line: whether it acts is APPLY's, so a dispatch stays a dry run.
    expect(exit[0]?.run?.trim()).toBe('node "$KANON/scripts/gate-candidate-exit.mjs"');
    expect(exit[0]?.env?.GH_TOKEN).toBe('${{ steps.app-token.outputs.token }}');
    expect(exit[0]?.env?.APPLY).toBe("${{ (github.event_name == 'schedule' || inputs.apply == 'true') && '1' || '' }}");
    expect(exit[0]?.if).toContain('!cancelled()');
  });

  it('K-WORK-10 states both exits and names the script', () => {
    const rule = read('rulebook/01-work-items.md');
    const start = rule.indexOf('### `K-WORK-10`');
    const end = rule.indexOf('### `K-WORK-11`');
    if (start < 0 || end < start) throw new Error('K-WORK-10 not found: re-anchor this test');
    const body = rule.slice(start, end);
    expect(body).toContain('- **Placed:** the issue is on a roadmap milestone');
    expect(body).toContain('- **Declined:** the issue carries `gate:declined`, which only a person applies.');
    expect(body).toContain('scripts/gate-candidate-exit.mjs');
  });
});

/**
 * Only a person applies `gate:declined`: the label is a Stakeholder's decision, and an agent
 * that applied it would be deciding a gate placement (`K-WORK-5`). So the library names it in
 * one file, the exit that reads it, and that file adds no label of any kind.
 */
describe('no lane, script or prompt applies gate:declined', () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(join(ROOT, dir))) {
      const p = join(dir, e);
      if (statSync(join(ROOT, p)).isDirectory()) walk(p, out);
      else if (/\.(mjs|js|ts|yml|yaml|sh|md)$/.test(e)) out.push(p);
    }
    return out;
  };
  const files = ['scripts', 'actions', '.github/workflows', '.github/ISSUE_TEMPLATE', 'docs/qa', 'cli', 'rulebook/templates']
    .filter((d) => { try { return statSync(join(ROOT, d)).isDirectory(); } catch { return false; } })
    .flatMap((d) => walk(d));

  it('reads the library, so the check below is not vacuous', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(join('scripts', 'gate-candidate-exit.mjs'));
  });

  // A comment about the label applies nothing; a prompt (a YAML string, Markdown) is kept.
  const code = (f: string): string => {
    const t = read(f);
    if (/\.(mjs|js|ts)$/.test(f)) return t.replace(/(^|\s)\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
    if (/\.(ya?ml|sh)$/.test(f)) return t.replace(/(^|\s)#(\s.*)?$/gm, '$1');
    return t;
  };

  it('names gate:declined only in the exit script, outside comments', () => {
    expect(files.filter((f) => code(f).includes('gate:declined'))).toEqual([join('scripts', 'gate-candidate-exit.mjs')]);
  });

  it('the exit script adds no label: its only write is the one DELETE of gate-candidate', () => {
    const code = read('scripts/gate-candidate-exit.mjs').replace(/(^|\s)\/\/.*$/gm, '$1');
    expect(code).not.toMatch(/--add-label|'--label'|'POST'|'PATCH'|'PUT'|issue', 'edit'|issue', 'close'/);
    expect([...code.matchAll(/'-X', '([A-Z]+)'/g)].map((m) => m[1])).toEqual(['DELETE']);
  });
});
