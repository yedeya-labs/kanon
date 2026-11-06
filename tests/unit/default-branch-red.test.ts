import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CI_WORKFLOW, MARKER, decide, declaredWatcher, notedRuns } from '../../scripts/default-branch-red.mjs';

// kanon#1568 (the Owner's decision of 2026-11-06): two pull requests, each green on its own base,
// merged minutes apart and turned the default branch red, and nothing said so. A red push run of
// CI on the default branch is one issue, noted per red run, closed once the branch is green; a
// repository that watches its own declares it, so the two never both file.
const red = { id: 41, conclusion: 'failure', url: 'https://example.invalid/runs/41', sha: 'abcdef1234567' };
const green = { ...red, id: 42, conclusion: 'success' };
const job = { name: 'Unit tests (shard 2/4)', url: 'https://example.invalid/jobs/9' };

describe('a red default branch (#1568)', () => {
  it('files one issue naming the run and its first failing job', () => {
    const d = decide({ run: red, job, open: null, branch: 'main' });
    expect(d.act).toBe('file');
    if (d.act !== 'file') return;
    expect(d.title).toBe('CI is red on main');
    expect(d.body).toContain(MARKER);
    expect(d.body).toContain('<!-- kanon:default-branch-red run=41 -->');
    expect(d.body).toContain('[run 41](https://example.invalid/runs/41)');
    expect(d.body).toContain('its first failing job is [Unit tests (shard 2/4)](https://example.invalid/jobs/9)');
    expect(d.body).toContain('## What must be true');
    for (const conclusion of ['timed_out', 'startup_failure']) expect(decide({ run: { ...red, conclusion }, job, open: null, branch: 'main' }).act).toBe('file');
  });

  it('notes each new red run on the open issue once, and closes it when the branch is green', () => {
    const open = { number: 7, texts: [`${MARKER}\n<!-- kanon:default-branch-red run=41 -->`] };
    expect(decide({ run: red, job, open, branch: 'main' }).act).toBe('none');
    const later = decide({ run: { ...red, id: 43 }, job, open, branch: 'main' });
    expect(later).toMatchObject({ act: 'comment', issue: 7 });
    expect(later.act === 'comment' && later.body).toContain('<!-- kanon:default-branch-red run=43 -->');
    expect(decide({ run: green, job: null, open, branch: 'main' })).toMatchObject({ act: 'close', issue: 7 });
    expect(decide({ run: green, job: null, open: null, branch: 'main' }).act).toBe('none');
    expect(decide({ run: { ...red, conclusion: 'cancelled' }, job, open: null, branch: 'main' }).act).toBe('none');
    expect(decide({ run: null, job: null, open: null, branch: 'main' }).act).toBe('none');
    expect([...notedRuns(['<!-- kanon:default-branch-red run=1 --> x <!-- kanon:default-branch-red run=2 -->'])]).toEqual([1, 2]);
  });

  it('files nothing where the adoption record names a watcher of its own, under ## Choices only', () => {
    expect(declaredWatcher('# R\n\n## Choices\n\n- **Default-branch watcher:** `main-red.yml`\n')).toBe('main-red.yml');
    expect(declaredWatcher('# R\n\n## Data\n\n- **Default-branch watcher:** `main-red.yml`\n')).toBeNull();
    expect(declaredWatcher('# R\n\n## Choices\n\n- **Overseer:** `installed`\n\n## Data\n\n- **Default-branch watcher:** `x.yml`\n')).toBeNull();
    expect(declaredWatcher(null)).toBeNull();
  });

  it('runs from the dispatch sweep on its Lead token, and watches the CI workflow init writes', () => {
    expect(CI_WORKFLOW).toBe('ci.yml');
    const sweep = parse(readFileSync('.github/workflows/agent-dispatch-sweep.yml', 'utf8'));
    const step = sweep.jobs.sweep.steps.find((s: { run?: string }) => String(s.run ?? '').includes('default-branch-red.mjs'));
    expect(step.env.GH_TOKEN).toBe('${{ steps.app-token.outputs.token }}');
    expect(step.if).toBe("${{ !cancelled() && steps.app-token.outcome == 'success' }}");
  });

  it('has the Reviewer check the base branch before blaming a pull request for a red check', () => {
    const job = readFileSync('.github/workflows/review-agent-job.yml', 'utf8');
    expect(job).toMatch(/BUT A RED CHECK MAY BE THE BASE BRANCH'S, NOT THIS PR'S \(kanon#1568\)/);
    expect(job).toMatch(/`kanon:default-branch-red`\), and ask nothing of the PR for that check/);
    expect(job).toMatch(/Still\s+never APPROVE over red/);
  });
});
