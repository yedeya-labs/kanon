import { describe, expect, it } from 'vitest';
import { checkJobs, checkReporters, mergeQueueOn } from '../../cli/check-reporters.mjs';

/**
 * #459: a ruleset with a merge queue waits for each required check on the queue's own
 * `merge_group` run, so the job that reports it must run on that event too. Doctor and init both
 * read it from cli/check-reporters.mjs.
 */
const job = { name: 'Lane check', 'runs-on': 'x' };
const one = (on: unknown) => new Map([['.github/workflows/x.yml', { on, jobs: { lanes: job } }]]);

describe('mergeQueueOn: whether the rulesets on a branch merge it through a merge queue (#459)', () => {
  it('is true only when one of them has the merge_queue rule', () => {
    expect(mergeQueueOn([{ rules: [{ type: 'pull_request' }] }, { rules: [{ type: 'merge_queue', parameters: {} }] }])).toBe(true);
    expect(mergeQueueOn([{ rules: [{ type: 'pull_request' }, { type: 'required_status_checks' }] }])).toBe(false);
    expect(mergeQueueOn([])).toBe(false);
    // A ruleset read without its rules has none.
    expect(mergeQueueOn([{ name: 'x' }, null])).toBe(false);
  });
});

describe('checkJobs and checkReporters through a merge queue (#459)', () => {
  it('asks nothing of merge_group without a merge queue', () => {
    expect(checkJobs(one({ pull_request: null }), 'Lane check', 'main')).toEqual([{ job: '.github/workflows/x.yml#lanes', filters: [], missing: [] }]);
    expect(checkReporters(one({ pull_request: null }), 'Lane check', 'main', false)).toEqual(['.github/workflows/x.yml#lanes']);
  });

  it('names merge_group as missing when the workflow lacks it, in each form of `on`', () => {
    for (const on of [{ pull_request: null }, 'pull_request', ['pull_request', 'push']]) {
      expect(checkJobs(one(on), 'Lane check', 'main', true), JSON.stringify(on)).toEqual([{ job: '.github/workflows/x.yml#lanes', filters: [], missing: ['merge_group'] }]);
      expect(checkReporters(one(on), 'Lane check', 'main', true), JSON.stringify(on)).toEqual([]);
    }
  });

  it('counts a workflow that runs on merge_group, in each form of `on`', () => {
    for (const on of [{ pull_request: null, merge_group: null }, { pull_request: {}, merge_group: { types: ['checks_requested'] } }, ['pull_request', 'merge_group'], { pull_request: null, merge_group: { branches: ['main'] } }]) {
      expect(checkReporters(one(on), 'Lane check', 'main', true), JSON.stringify(on)).toEqual(['.github/workflows/x.yml#lanes']);
    }
  });

  it("names the merge_group trigger's filters that skip a queued merge into the branch", () => {
    const filters = (mg: unknown) => checkJobs(one({ pull_request: null, merge_group: mg }), 'Lane check', 'main', true).map((j) => [j.filters, j.missing]);
    expect(filters({ branches: ['release/**'] })).toEqual([[['merge_group.branches'], []]]);
    expect(filters({ 'branches-ignore': ['ma*'] })).toEqual([[['merge_group.branches-ignore'], []]]);
    expect(filters({ 'branches-ignore': ['release'] })).toEqual([[[], []]]);
    expect(filters({ types: ['destroyed'] })).toEqual([[['merge_group.types'], []]]);
    expect(filters({ types: 'checks_requested' })).toEqual([[[], []]]);
    // Without the branch, any branch filter skips some.
    expect(checkJobs(one({ pull_request: null, merge_group: { branches: ['main'] } }), 'Lane check', undefined, true).map((j) => j.filters)).toEqual([['merge_group.branches']]);
    // GitHub filters merge_group by branch only: a paths key there skips nothing.
    expect(filters({ paths: ['src/**'] })).toEqual([[[], []]]);
    expect(checkReporters(one({ pull_request: null, merge_group: { branches: ['release'] } }), 'Lane check', 'main', true)).toEqual([]);
  });

  it("keeps the pull-request trigger's filters beside the merge_group ones, and a workflow on neither out", () => {
    expect(checkJobs(one({ pull_request: { paths: ['src/**'] }, merge_group: { branches: ['dev'] } }), 'Lane check', 'main', true)).toEqual([{ job: '.github/workflows/x.yml#lanes', filters: ['pull_request.paths', 'merge_group.branches'], missing: [] }]);
    // merge_group alone isn't a pull request's run: the check is never reported on the pull request.
    expect(checkJobs(one({ merge_group: null }), 'Lane check', 'main', true)).toEqual([]);
    expect(checkJobs(one('merge_group'), 'Lane check', 'main', true)).toEqual([]);
  });
});
