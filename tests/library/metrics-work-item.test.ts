import { describe, expect, it } from 'vitest';
import { WorkItemError, checkWorkItemRow, workItemRow } from '../../scripts/metrics/work-item.mjs';
import { STAGE_FIELDS } from '../../scripts/metrics/stages.mjs';
import { roleMarker } from '../../scripts/lib/role-marker.mjs';
import { UNDECLARED, parseCodeAreas } from '../../scripts/lib/code-areas.mjs';
import { parseEscalationFile } from '../../scripts/lib/escalation-paths.mjs';
import { validate } from '../../actions/agent-telemetry/schema.mjs';

/**
 * Plan 0003 §3.3: one PR's work-item row, assembled from the plain input shape
 * (`scripts/metrics/types.mjs`) and validated against the telemetry schema's work-item list,
 * version 1. Absent means unknown, never zero; no login, path or text reaches the row.
 */

const T0 = Date.parse('2026-09-10T00:00:00Z');
const t = (s: number) => new Date(T0 + s * 1000).toISOString();

const REGISTER = new Map([
  ['Implementer', 'acme-author'], ['Lead', 'acme-author'], ['Explorer', 'acme-author'], ['Overseer', 'acme-author'],
  ['Reviewer', 'acme-judge'], ['Merger', 'acme-judge'],
]);
const AUTHOR = { login: 'acme-author[bot]', type: 'Bot' };
const JUDGE = { login: 'acme-judge[bot]', type: 'Bot' };
const HUMAN = { login: 'octocat', type: 'User' };
const codeAreas = parseCodeAreas('# Stack\n\n## Code areas\n\n- `app/` — code: the app\n- `checks/` `vitest` — tests: the suite\n');
const escalationFile = parseEscalationFile('# E\n\n## Escalation paths\n\n- `^app/billing/` `payments` — billing\n');

const verdict = (state: string, at: number, commit_id: string) => ({ state, submitted_at: t(at), author: JUDGE, commit_id, body: `**Reviewer** ${roleMarker('Reviewer')}\n\nok` });

const PR = () => ({
  number: 41,
  state: 'closed' as const,
  created_at: t(100),
  closed_at: t(5000),
  merged_at: t(5000),
  merge_commit_sha: 'm1',
  author: AUTHOR,
  merged_by: JUDGE,
  body: `**Implementer** ${roleMarker('Implementer')}\n\nCloses #4`,
  labels: ['review:please'],
  files: [
    { path: 'app/billing/charge.ts', status: 'modified', additions: 120, deletions: 30 },
    { path: 'checks/charge.test.ts', status: 'added', additions: 80, deletions: 0 },
    { path: 'package-lock.json', status: 'modified', additions: 2000, deletions: 1500 },
    { path: 'README.md', status: 'modified', additions: 5, deletions: 1 },
  ],
  closing_issues: [{
    number: 4,
    labels: ['project:2', 'follow-up', 'agent:reviewer', 'sev:medium'],
    body: 'Fix `app/billing/charge.ts` and `app/billing/refund.ts:10`.',
    author: JUDGE,
    blocked_by: 1,
    timeline: [{ event: 'labeled', label: 'agent:implement', created_at: t(0), actor: HUMAN }],
  }, { number: 5, labels: [] }],
  timeline: [
    { event: 'labeled', label: 'review:please', created_at: t(1000), actor: AUTHOR },
    { event: 'labeled', label: 'needs:human', created_at: t(3000), actor: JUDGE },
    { event: 'labeled', label: 'qa:verify', created_at: t(3100), actor: HUMAN },
    { event: 'labeled', label: 'bug', created_at: t(3150), actor: HUMAN },
    { event: 'unlabeled', label: 'needs:human', created_at: t(3500), actor: HUMAN },
    { event: 'head_ref_force_pushed', created_at: t(2000), actor: AUTHOR },
    { event: 'merged', created_at: t(5000), actor: JUDGE },
  ],
  commits: [
    { sha: 'h1', message: 'feat: charge', committed_at: t(900), author: AUTHOR, committer: AUTHOR },
    { sha: 'h2', message: 'fix: review', committed_at: t(2000), author: AUTHOR, committer: AUTHOR },
    { sha: 'h3', message: 'tweak', committed_at: t(3400), author: HUMAN, committer: HUMAN },
  ],
  reviews: [
    verdict('CHANGES_REQUESTED', 1500, 'h1'),
    { state: 'CHANGES_REQUESTED', submitted_at: t(1600), author: HUMAN, commit_id: 'h1' },
    { ...verdict('COMMENTED', 1800, 'h1') },
    verdict('CHANGES_REQUESTED', 2500, 'h2'),
    verdict('APPROVED', 2700, 'h2'),
    { state: 'COMMENTED', submitted_at: t(3200), author: HUMAN, commit_id: 'h2' },
    { state: 'CHANGES_REQUESTED', submitted_at: t(3300), author: HUMAN, commit_id: 'h2' },
  ],
});

const INPUT = (over: object = {}, pr: object = {}) => ({
  pr: { ...PR(), ...pr },
  declarations: { register: REGISTER, codeAreas, escalationFile },
  tag: 'test',
  recorded_at: '2026-10-01T12:00:00.123Z',
  kanon_version: '0.35.0',
  runs: [
    { lane: 'implement', started_at: t(60), completed_at: t(900) },
    { lane: 'review', started_at: t(1100), completed_at: t(1550) },
  ],
  check_runs: [
    { name: 'test', head_sha: 'h1', started_at: t(910), completed_at: t(1200), conclusion: 'failure', required: true },
    { name: 'lint', head_sha: 'h1', started_at: t(910), completed_at: t(1000), conclusion: 'failure', required: false },
    { name: 'test', head_sha: 'h2', started_at: t(2010), completed_at: t(2300), conclusion: 'success', required: true },
  ],
  followups: [
    { labels: ['follow-up', 'agent:reviewer', 'sev:high'], state: 'closed', state_reason: 'completed' },
    { labels: ['follow-up', 'agent:reviewer', 'sev:low'], state: 'closed', state_reason: 'not_planned' },
    { labels: ['follow-up', 'agent:reviewer'], state: 'open' },
  ],
  links: { fix_prs: [50, 61], first_fix_days: 12 },
  wip_at_dispatch: 3,
  ...over,
}) as never;

describe('workItemRow', () => {
  const row = workItemRow(INPUT());

  it('builds a row the schema accepts', () => {
    expect(validate(row)).toEqual({ ok: true });
    expect(checkWorkItemRow(row)).toEqual({ ok: true });
  });

  it('fills the row and join fields, times to the second', () => {
    expect(row).toMatchObject({
      schema_version: 1, row_kind: 'work_item', tag: 'test', recorded_at: '2026-10-01T12:00:00Z',
      pr_number: 41, closing_issues: '4,5', opened_at: t(100).replace('.000', ''), closed_at: t(5000).replace('.000', ''),
      dispatched_at: t(0).replace('.000', ''), fate: 'merged', kanon_version: '0.35.0',
    });
  });

  it('fills group 1: size, areas, risk, band, origin and author', () => {
    expect(row).toMatchObject({
      changed_lines: 236, changed_files: 3, changed_dirs: 3, excluded_lines: 3500,
      files_code: 1, files_tests: 1, files_deps: 1, files_docs: 1, files_config: 0,
      tests_added: 1, tests_changed: 0,
      esc_payments: true, esc_pipeline: false, esc_auth: false,
      band: 'M', band_version: 1,
      issue_body_chars: 59, issue_paths_named: 2, blocked_by_count: 1,
      // A Reviewer follow-up inside a project is still a follow-up (§3.3).
      origin: 'reviewer_followup',
      author_kind: 'implementer', commits: 3, force_pushes: 1,
    });
  });

  it('fills group 2 with stages that sum to the lead time', () => {
    expect(row.lead_time_s).toBe(5000);
    expect(Object.values(STAGE_FIELDS).reduce((a, f) => a + (row[f] as number), 0)).toBe(5000);
    expect(row).toMatchObject({ t_queue_s: 60, t_agent_s: 840, t_human_s: 500, human_waits: 1, wip_at_dispatch: 3 });
  });

  it('fills groups 3 to 5 from the reviews, commits and labels', () => {
    expect(row).toMatchObject({
      first_verdict: 'changes_requested', review_rounds: 3,
      // The first change request was answered by a push, the second by the approval at the same head.
      cr_acted: 1, cr_withdrawn: 1,
      ci_failures_before_review: 1,
      human_reviews: 3, human_cr_after_approval: 1, human_commits: 1,
      // One human commit, three human reviews, and the human's two label changes in the four
      // families (`bug` is in none).
      human_interventions: 6,
      escalations: 1, merged_by: 'merger',
      fix_prs: '50,61', first_fix_days: 12,
      followups_filed: 3, followups_sev_high: 1, followups_sev_low: 1, followups_sev_medium: 0,
      followups_completed: 1, followups_not_planned: 1, followups_open: 1,
    });
  });

  it('carries no login, path or text', () => {
    const text = JSON.stringify(row);
    for (const leak of ['octocat', 'acme', 'app/', 'billing', 'charge', 'Closes', 'feat']) expect(text).not.toContain(leak);
  });

  it('writes a closed-unmerged item, with no merge actor', () => {
    const r = workItemRow(INPUT({}, { merged_at: null, merged_by: null }));
    expect(r.fate).toBe('closed_unmerged');
    expect(r).not.toHaveProperty('merged_by');
  });

  it('refuses a PR that is still open, even one that was closed before and reopened', () => {
    expect(() => workItemRow(INPUT({}, { state: 'open', closed_at: null }))).toThrow(WorkItemError);
    expect(() => workItemRow(INPUT({}, { state: 'open' }))).toThrow(/is not closed/);
  });

  it('counts a change request answered by neither a push nor an approval at its head as neither', () => {
    const r = workItemRow(INPUT({}, {
      reviews: [verdict('CHANGES_REQUESTED', 1500, 'h1'), verdict('APPROVED', 1700, 'h9')],
      commits: [{ sha: 'h1', message: 'x', committed_at: t(900), author: AUTHOR, committer: AUTHOR }],
      timeline: [],
    }));
    expect(r).toMatchObject({ cr_acted: 0, cr_withdrawn: 0, review_rounds: 2, first_verdict: 'changes_requested' });
  });

  it('leaves group 2 out when the times contradict each other, rather than failing the row', () => {
    const r = workItemRow(INPUT({}, { closing_issues: [], created_at: t(6000) }));
    expect(r).not.toHaveProperty('lead_time_s');
  });

  it('leaves out what the reader did not fetch, never writing zero', () => {
    const r = workItemRow(INPUT({ runs: undefined, check_runs: undefined, followups: undefined, links: undefined, wip_at_dispatch: undefined, kanon_version: undefined },
      { files: undefined, reviews: undefined, commits: undefined, timeline: undefined }));
    expect(validate(r)).toEqual({ ok: true });
    for (const f of ['changed_lines', 'band', 'band_version', 'files_code', 'esc_payments', 'first_verdict', 'review_rounds', 'human_reviews',
      'human_commits', 'cr_acted', 'ci_failures_before_review', 'escalations', 'force_pushes', 'commits', 'human_interventions',
      'followups_filed', 'fix_prs', 'kanon_version', 'wip_at_dispatch']) {
      expect(r, f).not.toHaveProperty(f);
    }
    // The stages are still known: the events the reader didn't fetch open none, so they are other.
    expect(r.lead_time_s).toBe(5000);
  });

  it('leaves group 2 out when the dispatch is unknown, and starts it at opened_at when there was none', () => {
    const unread = workItemRow(INPUT({}, { closing_issues: [{ number: 4, labels: [] }] }));
    expect(unread).not.toHaveProperty('lead_time_s');
    expect(unread).not.toHaveProperty('t_other_s');
    const none = workItemRow(INPUT({ runs: [] }, { closing_issues: [] }));
    expect(none.lead_time_s).toBe(4900);
    expect(none).not.toHaveProperty('dispatched_at');
    expect(none).not.toHaveProperty('closing_issues');
  });

  it('leaves the escalation booleans out when the escalation file was not read, and the areas it could change (kanon#521)', () => {
    const r = workItemRow({ ...(INPUT() as object), declarations: { register: REGISTER, codeAreas } } as never);
    expect(validate(r)).toEqual({ ok: true });
    expect(r).not.toHaveProperty('esc_payments');
    // A declared migration path is checked before every area below it, so only deps and workflows are known.
    expect(r).toMatchObject({ files_deps: 1, files_workflows: 0 });
    for (const f of ['files_migrations', 'files_specs', 'files_tests', 'files_docs', 'files_config', 'files_code', 'tests_added', 'tests_changed']) {
      expect(r, f).not.toHaveProperty(f);
    }
  });

  it("leaves the areas the code areas decide out when they were not read, never taking Kanon's default (kanon#521)", () => {
    const r = workItemRow({ ...(INPUT() as object), declarations: { register: REGISTER, escalationFile } } as never);
    expect(validate(r)).toEqual({ ok: true });
    expect(r).toMatchObject({ files_deps: 1, files_workflows: 0, files_migrations: 0, files_specs: 0, esc_payments: true });
    for (const f of ['files_tests', 'files_docs', 'files_config', 'files_code', 'tests_added', 'tests_changed']) expect(r, f).not.toHaveProperty(f);
    // Undeclared is not unread: Kanon's default is the adopter's declaration, and every area is counted.
    const undeclared = workItemRow({ ...(INPUT() as object), declarations: { register: REGISTER, codeAreas: UNDECLARED, escalationFile } } as never);
    expect(undeclared).toMatchObject({ files_code: 1, files_tests: 1, files_docs: 1, tests_added: 1 });
  });

  it("counts no commit GitHub's web-flow committed for a bot as a human commit (kanon#521)", () => {
    const WEB_FLOW = { login: 'web-flow', type: 'User' };
    const DEPENDABOT = { login: 'dependabot[bot]', type: 'Bot' };
    const commits = [
      { sha: 'h1', message: 'feat: charge', committed_at: t(900), author: AUTHOR, committer: WEB_FLOW },
      { sha: 'h2', message: 'merge main', committed_at: t(2000), author: DEPENDABOT, committer: WEB_FLOW },
      // A person's web-UI commit is still theirs, by its author.
      { sha: 'h3', message: 'tweak', committed_at: t(3400), author: HUMAN, committer: WEB_FLOW },
    ];
    const r = workItemRow(INPUT({}, { commits }));
    expect(r.human_commits).toBe(1);
    expect(r.human_interventions).toBe(6);
  });

  it('leaves human_interventions out when the author\'s class is unknown, as human_commits is (kanon#521)', () => {
    for (const pr of [{ author: null }, { author: JUDGE, body: 'no marker' }]) {
      const r = workItemRow(INPUT({}, pr));
      expect(r).not.toHaveProperty('author_kind');
      expect(r).not.toHaveProperty('human_commits');
      expect(r).not.toHaveProperty('human_interventions');
      // What doesn't depend on the author's class is still counted.
      expect(r.human_reviews).toBe(3);
    }
  });

  it('counts no human commits on a human-authored PR, where they are the author\'s own', () => {
    const r = workItemRow(INPUT({}, { author: HUMAN, body: 'mine' }));
    expect(r.author_kind).toBe('human');
    expect(r).not.toHaveProperty('human_commits');
    expect(r.human_interventions).toBe(5);
  });

  it('reads an empty issue body as 0 characters, and an unread one as unknown', () => {
    const issue = PR().closing_issues[0];
    expect(workItemRow(INPUT({}, { closing_issues: [{ ...issue, body: null }] })).issue_body_chars).toBe(0);
    expect(workItemRow(INPUT({}, { closing_issues: [{ ...issue, body: undefined }] }))).not.toHaveProperty('issue_body_chars');
  });

  it('caps the closing issues and linked fixes at the schema\'s 20', () => {
    const many = Array.from({ length: 25 }, (_, k) => ({ number: 100 + k, labels: [] }));
    const r = workItemRow(INPUT({ links: { fix_prs: Array.from({ length: 25 }, (_, k) => 100 + k) } }, { closing_issues: [{ ...PR().closing_issues[0] }, ...many] }));
    expect(String(r.closing_issues).split(',')).toHaveLength(20);
    expect(String(r.fix_prs).split(',')).toHaveLength(20);
  });

  it('refuses a row the schema rejects, naming the field and not the value', () => {
    expect(() => workItemRow(INPUT({ tag: 'octocat' }))).toThrow(/tag \(enum\)/);
    expect(() => workItemRow(INPUT({ tag: 'octocat' }))).not.toThrow(/octocat/);
  });
});

describe('checkWorkItemRow', () => {
  const row = workItemRow(INPUT());

  it("fails a row whose stages don't sum to its lead time (§7 mutation)", () => {
    const bad = { ...row, t_other_s: (row.t_other_s as number) + 1 };
    expect(validate(bad)).toEqual({ ok: true });
    expect(checkWorkItemRow(bad)).toEqual({ ok: false, why: expect.stringMatching(/^stage partition: the stages sum to 5001 seconds/), fields: ['lead_time_s'] });
  });

  it('fails a row the schema rejects', () => {
    expect(checkWorkItemRow({ ...row, login: 'octocat' })).toEqual({ ok: false, why: 'login (unknown)', fields: ['login'] });
  });
});
