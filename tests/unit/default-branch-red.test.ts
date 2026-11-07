import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CI_WORKFLOW, MARKER, nextStep, declaredWatcher, notedRuns, ownIssue, ownTexts } from '../../scripts/default-branch-red.mjs';

// kanon#1568 (the Owner's decision of 2026-11-06): two pull requests, each green on its own base,
// merged minutes apart and turned the default branch red, and nothing said so. A red push run of
// CI on the default branch is one issue, noted per red run, closed once the branch is green; a
// repository that watches its own declares it, so the two never both file.
const red = { id: 41, conclusion: 'failure', url: 'https://example.invalid/runs/41', sha: 'abcdef1234567' };
const green = { ...red, id: 42, conclusion: 'success' };
const job = { name: 'Unit tests (shard 2/4)', url: 'https://example.invalid/jobs/9' };

describe('a red default branch (#1568)', () => {
  it('files one issue naming the run and its first failing job', () => {
    const d = nextStep({ run: red, job, open: null, branch: 'main' });
    expect(d.act).toBe('file');
    if (d.act !== 'file') return;
    expect(d.title).toBe('CI is red on main');
    expect(d.body).toContain(MARKER);
    expect(d.body).toContain('<!-- kanon:default-branch-red run=41 -->');
    expect(d.body).toContain('[run 41](https://example.invalid/runs/41)');
    expect(d.body).toContain('its first failing job is [Unit tests (shard 2/4)](https://example.invalid/jobs/9)');
    expect(d.body).toContain('## What must be true');
    for (const conclusion of ['timed_out', 'startup_failure']) expect(nextStep({ run: { ...red, conclusion }, job, open: null, branch: 'main' }).act).toBe('file');
  });

  it('notes each new red run on the open issue once, and closes it when the branch is green', () => {
    const open = { number: 7, texts: [`${MARKER}\n<!-- kanon:default-branch-red run=41 -->`] };
    expect(nextStep({ run: red, job, open, branch: 'main' }).act).toBe('none');
    const later = nextStep({ run: { ...red, id: 43 }, job, open, branch: 'main' });
    expect(later).toMatchObject({ act: 'comment', issue: 7 });
    expect(later.act === 'comment' && later.body).toContain('<!-- kanon:default-branch-red run=43 -->');
    expect(nextStep({ run: green, job: null, open, branch: 'main' })).toMatchObject({ act: 'close', issue: 7 });
    expect(nextStep({ run: green, job: null, open: null, branch: 'main' }).act).toBe('none');
    expect(nextStep({ run: { ...red, conclusion: 'cancelled' }, job, open: null, branch: 'main' }).act).toBe('none');
    expect(nextStep({ run: null, job: null, open: null, branch: 'main' }).act).toBe('none');
    expect([...notedRuns(['<!-- kanon:default-branch-red run=1 --> x <!-- kanon:default-branch-red run=2 -->'])]).toEqual([1, 2]);
  });

  it('files nothing where the adoption record names a watcher of its own, under ## Choices only', () => {
    expect(declaredWatcher('# R\n\n## Choices\n\n- **Default-branch watcher:** `main-red.yml`\n')).toBe('main-red.yml');
    expect(declaredWatcher('# R\n\n## Data\n\n- **Default-branch watcher:** `main-red.yml`\n')).toBeNull();
    expect(declaredWatcher('# R\n\n## Choices\n\n- **Overseer:** `installed`\n\n## Data\n\n- **Default-branch watcher:** `x.yml`\n')).toBeNull();
    expect(declaredWatcher(null)).toBeNull();
  });

  // K-AGENT-45: an issue a person files that quotes the marker is not the sweep's, so it is never
  // commented on or closed, and a run marker a person quotes in a comment holds nothing.
  it("keeps only the Lead's own issue, and the run markers in the Lead's own comments", () => {
    const lead = 'example-lead';
    const quoted = { number: 3, body: `About \`${MARKER}\``, author: { login: 'a-person' } };
    const own = { number: 7, body: `${MARKER}\nred`, author: { login: 'app/example-lead' } };
    expect(ownIssue([quoted], lead)).toBeNull();
    expect(ownIssue([quoted, own], lead)?.number).toBe(7);
    expect(ownIssue([{ ...own, author: { login: 'example-lead[bot]' } }], lead)?.number).toBe(7);
    expect(ownIssue([{ ...own, body: 'red' }], lead)).toBeNull();
    const comments = [
      { body: '<!-- kanon:default-branch-red run=41 -->', author: { login: 'example-lead' } },
      { body: '<!-- kanon:default-branch-red run=43 -->', author: { login: 'a-person' } },
    ];
    expect([...notedRuns(ownTexts(comments, lead))]).toEqual([41]);
  });

  it('signs every post as the Lead, and refuses to run without GITHUB_REPOSITORY', () => {
    const src = readFileSync('scripts/default-branch-red.mjs', 'utf8');
    for (const verb of ['create', 'comment', 'close']) expect(src, verb).toMatch(new RegExp(`'issue', '${verb}'[^\\n]*signed\\(d\\.body, 'Lead', appPersona\\('Lead'\\)\\)`));
    expect(src).not.toMatch(/GITHUB_REPOSITORY \?\?/);
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
    // #1671: the same check red on the base clears the PR only when the same tests or steps fail.
    const text = job.replace(/\s+/g, ' ');
    expect(text).toContain('compare the FAILURES, not only the check\'s name (kanon#1671)');
    expect(text).toContain('`gh run view <run id> --log-failed`, on the PR\'s run and on the base\'s');
    expect(text).toContain('Only when every failure on the PR is also a failure on the base did the PR not cause it');
    expect(text).toContain('A failure the PR\'s run shows and the base\'s doesn\'t is the PR\'s: name it as a finding against the PR');
    expect(text).toContain('treat the check as the PR\'s and say why');
    expect(job).toMatch(/Still\s+never APPROVE over red/);
    // The verdict when the base's red check is the only block: REQUEST_CHANGES, not an open item.
    expect(job).toMatch(/When the base's\s+red check is your only block, the event is REQUEST_CHANGES/);
    expect(job).toMatch(/that block is not an open item, so it doesn't count in `<!-- qa:open-items N -->`/);
  });
});
