import { asAgent } from './helpers/sign.js';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
const { REVIEW_EVENT_CHECKS, SELF_CHECKS, apply, mergeVerdict: kanonMergeVerdict } = await import('../../scripts/merge-gate.mjs');
import { writeStub } from '../unit/helpers/stub-bin.js';
import { LEGACY } from '../../scripts/lib/protocol-spellings.mjs';
import { CALLER_DIRS, kanonLaneOf, readKanonLane } from './helpers/kanon-lane.js';
import { ESCALATE_PATHS } from './helpers/escalations.js';
/** A value of the untyped library, as the reference adopter's helper named it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LibraryValue = any;

/** The verdict with this repository's escalating paths (Kanon v0.17, kanon#135). */
const mergeVerdict = (p: LibraryValue) => kanonMergeVerdict(p, { escalations: ESCALATE_PATHS });

/**
 * RA-1177 — the Merger's merge-on-approval path could never merge.
 *
 * He wakes on `pull_request_review`, and so do other workflows. Their first jobs are
 * necessarily still running at the instant he reads the rollup, and they were counted as
 * pending: PR RA-979, head `d9d9e01`, the Reviewer APPROVED, and the Merger decided
 * `wait (checks-pending): filter, revise, filter still running` — all green and CLEAN a
 * minute later. Every merge fell through to the sweep.
 */

const HEAD = 'd9d9e01'.padEnd(40, '0');

type Pr = Parameters<typeof kanonMergeVerdict>[0];
const pr = (checks: Record<string, unknown>[]): Pr => ({
  number: 979,
  author: 'example-implementer[bot]',
  // The Implementer's marker and status (plan 0005 §3.3, L4).
  body: asAgent('example-implementer', 'Closes #1'),
  headStatuses: [{ context: 'kanon/role: implementer', state: 'success', creator: 'example-implementer[bot]' }],
  state: 'OPEN',
  isDraft: false,
  labels: ['agent:implement'],
  files: ['src/app/page.tsx'],
  headSha: HEAD,
  reviews: [{ state: 'APPROVED', sha: HEAD, author: 'example-reviewer[bot]', body: asAgent('example-reviewer', 'Approved.') }],
  checks,
  mergeStateStatus: 'CLEAN',
  mergeable: 'MERGEABLE',
  rebaseAttempted: false,
  closing: { mergeClosesUndeclared: [], unverifiable: false },
  workflowRuns: [],
}) as unknown as Pr;

const green = { name: 'E2E (Playwright)', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' };
const running = (workflowName: string, name: string) => ({ name, workflowName, status: 'IN_PROGRESS', conclusion: null });

type Job = { needs?: unknown; if?: unknown };
/**
 * Every review-triggered caller, with its ROOT jobs — the ones that start on the event itself.
 * An adopter's callers, so the fixture callers an adopter copies, one per lane: what races the
 * Merger is whatever Kanon's lanes start on a review, under the names those callers give them.
 */
function reviewTriggered(): { name: string; file: string; roots: [string, Job][] }[] {
  const files = CALLER_DIRS.flatMap((dir) => readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => join(dir, f)));
  if (files.length < 10) throw new Error(`only ${files.length} caller files found — re-point CALLER_DIRS`);
  return files.flatMap((file) => {
    const doc = parse(readFileSync(file, 'utf8')) as { name?: string; on?: unknown; jobs?: Record<string, Job> };
    const on = doc.on;
    const events = typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys((on ?? {}) as object);
    if (!events.includes('pull_request_review')) return [];
    // A root job that calls one of Kanon's lanes (RA-2709) runs the LANE's root jobs, which
    // GitHub reports as `<job> / <lane job>`: those are what race the review event.
    const roots = Object.entries(doc.jobs ?? {}).filter(([, j]) => !j.needs).flatMap(([name, j]): [string, Job][] =>
      kanonLaneOf(j)
        ? Object.entries(readKanonLane(j).jobs as Record<string, Job>).filter(([, lj]) => !lj.needs).map(([ln, lj]) => [`${name} / ${ln}`, lj])
        : [[name, j]]);
    return [{ name: String(doc.name ?? file), file, roots }];
  });
}

/** A job-level `if:` that can only pass for a changes-request is SKIPPED at once on an approval. */
const gatedOnChangesRequested = (j: Job) => /review\.state == 'changes_requested'/.test(String(j.if ?? ''));

describe('RA-1177 — the review event\'s racing jobs are not evidence about the merge', () => {
  it('merges on the PR RA-979 shape: approved, green, the racing filter jobs still running', () => {
    const v = mergeVerdict(pr([
      green,
      running('Implement (Implementer) — revise', 'revise / filter'),
      running('Merge Reconcile (Reviewer)', 'reconcile / filter'),
      running('Review (Reviewer)', 'review'),
      running('Merge (Merger)', 'merge'),
    ]));
    expect(v.action, v.why).toBe('merge');
  });

  it('still WAITS on a revise job that is actually revising — it pushes', () => {
    const v = mergeVerdict(pr([green, running('Implement (Implementer) — revise', 'revise / revise / run')]));
    expect(v.action).toBe('wait');
    expect(v.why).toContain('revise / revise / run');
  });

  it('still waits on a `filter` of any OTHER workflow — the key is workflow AND job', () => {
    const v = mergeVerdict(pr([green, running('Closing references', 'filter')]));
    expect(v.action).toBe('wait');
  });

  it('still waits on a real guard running beside the racers', () => {
    const v = mergeVerdict(pr([green, running('Implement (Implementer) — revise', 'revise / filter'), running('Closing references', 'check')]));
    expect(v.action).toBe('wait');
    expect(v.why).toContain('check');
    expect(v.why).not.toContain('filter');
  });
});

describe('RA-1177 — the exclusion is derived from the TRIGGER, not remembered by name', () => {
  it('finds the review-triggered workflows — so the parity below can fail', () => {
    expect(reviewTriggered().length).toBeGreaterThanOrEqual(4);
  });

  it('every root job of a review-triggered workflow is excluded, or skipped on an approval', () => {
    for (const { name, file, roots } of reviewTriggered()) {
      if (SELF_CHECKS.includes(name)) continue;
      for (const [job, def] of roots) {
        const listed = REVIEW_EVENT_CHECKS.some((r: LibraryValue) => r.workflow === name && r.job === job);
        expect(
          listed || gatedOnChangesRequested(def),
          `${file} job "${job}" starts on every pull_request_review, so it is in flight whenever the Merger looks. ` +
            'If it is not evidence about the merge, add it to REVIEW_EVENT_CHECKS; if it IS a real guard, the Merger ' +
            'must wait for it and this rule needs a deliberate exception.',
        ).toBe(true);
      }
    }
  });

  it('nothing is excluded that is not a root job of a review-triggered workflow', () => {
    const all = reviewTriggered();
    // The old spellings (kanon#53) name callers a run from before the rename still carries, not
    // a caller anyone writes now (docs/lanes.md, "Old spellings").
    const legacy = new Set(LEGACY.reviewEventChecks.map((r: { workflow: string }) => r.workflow));
    for (const r of REVIEW_EVENT_CHECKS.filter((c: { workflow: string }) => !legacy.has(c.workflow))) {
      const wf = all.find((w) => w.name === r.workflow);
      expect(wf, `${r.workflow} is no longer review-triggered — drop it`).toBeDefined();
      expect(wf!.roots.map(([j]) => j), `${r.workflow} has no root job "${r.job}"`).toContain(r.job);
    }
  });
});

describe('RA-1177 — a merge is pinned to the head the verdict read', () => {
  const applyWith = (stub: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'merge-1177-'));
    writeStub(join(dir, 'gh'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${dir}/calls"\n${stub}`);
    const prev = process.env.PATH;
    process.env.PATH = `${dir}:${prev}`;
    try {
      apply({ number: 979, headSha: HEAD }, { action: 'merge', rule: 'green-zone', why: 'x' }, 'o/r', { dryRun: false });
    } finally {
      process.env.PATH = prev;
    }
    return readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter(Boolean);
  };

  it('passes --match-head-commit <headSha>, so a racer\'s push refuses rather than merges', () => {
    const merge = applyWith('').find((l) => l.startsWith('pr merge'));
    expect(merge).toBeDefined();
    expect(merge).toContain(`--match-head-commit ${HEAD}`);
  });

  it('treats the pin refusing as a wait, not a crash of the whole sweep', () => {
    expect(() => applyWith('echo "GraphQL: Head branch was modified. Review and try the merge again." >&2; exit 1\n')).not.toThrow();
  });

  it('still throws any OTHER merge failure', () => {
    expect(() => applyWith('echo "HTTP 403: Resource not accessible by integration" >&2; exit 1\n')).toThrow();
  });
});
