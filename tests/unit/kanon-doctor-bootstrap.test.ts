import { describe, expect, it, vi } from 'vitest';
import { appsCheckFile, callerFile } from '../../cli/callers.mjs';
import { bootstrapEnded, EXIT, WAIVER_LABEL } from '../../cli/doctor.mjs';
import { checkout, fakeGitHub, HEALTHY_DEPLOY, healthyFiles, ids, PINNED, registerText, REQ, run, type Result } from './helpers/doctor.js';
import { SPAWNS } from './helpers/spawns.js';

/**
 * `kanon doctor` on the end of bootstrap (`K-ADOPT-6`, #706). Bootstrap ends when the Judge App is
 * installed and the default branch's ruleset requires an approving review, and never returns.
 *
 * - `ruleset.bootstrap-can-end`: the Judge App is in the register, the review lane's caller is on
 *   the default branch, so the Reviewer can approve, and the ruleset still requires no approval.
 * - `ruleset.approval-off`: the guard `K-ADOPT-6` promises. The adoption record says bootstrap
 *   ended, and the ruleset doesn't require an approving review.
 *
 * Each case is held in both directions (`K-PRIN-11`). The mutations that turn each red are in
 * the pull request that added them (#706): dropping the reminder, counting a ruleset with one
 * approval as off, dropping the review caller's default-branch condition, and dropping the guard.
 */
vi.setConfig({ testTimeout: SPAWNS.timeout });

const RECORD = `# Adoption record\n\n## People\n\n| Role | Who |\n|---|---|\n| Owner | \`@octo\` |\n\n${HEALTHY_DEPLOY}\n`;
const record = (bootstrap: string, choices = '- **Overseer:** `not installed`\n') => `${RECORD}## Bootstrap\n\n\`${bootstrap}\`\n\n## Choices\n\n${choices}`;

/** The fake GitHub, with the ruleset requiring `approvals` approving reviews. */
const github = (approvals: number, reviewOnDefault: boolean) => {
  const g = fakeGitHub();
  g.st.rulesets = g.st.rulesets.map((r) => ({
    ...r,
    rules: r.rules.map((x) => (x.type === 'pull_request' ? { ...x, parameters: { ...x.parameters, required_approving_review_count: approvals } } : x)),
  })) as typeof g.st.rulesets;
  // The review lane's caller merged to the default branch: the Reviewer can approve there.
  if (reviewOnDefault) g.st.defaultWorkflows!['agent-review.yml'] = healthyFiles()['.github/workflows/agent-review.yml']!;
  return g;
};

const has = (r: Result, id: string) => r.json.findings.filter((f: { id: string }) => f.id === id);

describe('kanon doctor, when bootstrap can end (K-ADOPT-6)', () => {
  it('reports a Judge App installed while the ruleset requires no approving review, with the fix', async () => {
    const r = await run(checkout(healthyFiles()), github(0, true), ['--json']);
    expect(ids(r)).toEqual(['ruleset.bootstrap-can-end main']);
    expect(r.status).toBe(EXIT.findings);
    const [f] = r.json.findings;
    expect(f).toMatchObject({ category: 'ruleset', blocking: true });
    expect(f.message).toContain('widgets-judge');
    expect(f.message).toContain('K-ADOPT-6');
    // The ruleset's update, with its rules as they are and the pull request rule asking one approval.
    expect(f.fix.commands[0]).toBe("gh api -X PUT repos/acme/widgets/rulesets/7 --input - <<'JSON'");
    const body = JSON.parse(f.fix.commands[1]);
    const pr = body.rules.find((x: { type: string }) => x.type === 'pull_request');
    expect(pr.parameters).toMatchObject({ required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, allowed_merge_methods: ['squash'] });
    expect(body.rules.map((x: { type: string }) => x.type)).toEqual(github(0, false).st.rulesets[0]!.rules.map((x) => x.type));
    expect(f.fix.commands[2]).toBe('JSON');
    // And the adoption record's end date.
    expect(f.fix.text).toContain('`ended YYYY-MM-DD`');
    expect(f.fix.text).toContain('docs/qa/adoption.md');
  });

  it("doesn't report it once the ruleset requires an approving review", async () => {
    const r = await run(checkout(healthyFiles()), github(1, true), ['--json']);
    expect(has(r, 'ruleset.bootstrap-can-end')).toEqual([]);
    expect(r.status, r.out).toBe(EXIT.healthy);
  });

  it("doesn't report it with no Judge App: no lane that runs as the Judge, and no register row for it", async () => {
    const files = healthyFiles();
    delete files['.github/workflows/agent-review.yml'];
    files['.github/workflows/apps-check.yml'] = appsCheckFile(['author'], PINNED);
    files['docs/qa/agent-identities.md'] = registerText(['author']);
    // The default branch still calls the review lane: only the Judge App is missing.
    const g = github(0, true);
    g.st.secrets = new Set(REQ.lanes['agent-code-audit']!.secrets);
    const r = await run(checkout(files), g, ['--json']);
    expect(has(r, 'ruleset.bootstrap-can-end')).toEqual([]);
    expect(r.status, r.out).toBe(EXIT.healthy);
  });

  it("doesn't report it while the review lane's caller is only on a branch: requiring approval then would lock out every pull request", async () => {
    const r = await run(checkout(healthyFiles()), github(0, false), ['--json']);
    expect(has(r, 'ruleset.bootstrap-can-end')).toEqual([]);
    expect(r.status, r.out).toBe(EXIT.healthy);
  });

  it('can be waived, as an adopter that stays in bootstrap says why', async () => {
    const files = healthyFiles();
    files['docs/qa/adoption.md'] += `- **${WAIVER_LABEL}:** \`ruleset.bootstrap-can-end\` on \`main\` (a person still merges while the Reviewer is calibrated)\n`;
    const r = await run(checkout(files), github(0, true), ['--json']);
    expect(r.json.findings).toEqual([]);
    expect(r.json.waived.map((w: { id: string }) => w.id)).toEqual(['ruleset.bootstrap-can-end']);
  });

  it('gives an organisation ruleset its page, not a command', async () => {
    const g = github(0, true);
    g.st.rulesets = g.st.rulesets.map((r) => ({ ...r, source_type: 'Organization', source: 'acme' }));
    const r = await run(checkout(healthyFiles()), g, ['--json']);
    const [f] = has(r, 'ruleset.bootstrap-can-end');
    expect(f.fix.commands).toEqual([]);
    expect(f.fix.url).toBe('https://github.com/organizations/acme/settings/rules/7');
  });
});

describe('kanon doctor, the guard K-ADOPT-6 promises: an ended bootstrap needs the approving review', () => {
  it('fails a record whose bootstrap ended while the ruleset requires no approving review', async () => {
    const files = healthyFiles();
    files['docs/qa/adoption.md'] = record('ended 2026-10-02');
    // With no Judge on the default branch too: a lost App is an incident, not a return to bootstrap.
    for (const reviewOnDefault of [false, true]) {
      const r = await run(checkout(files), github(0, reviewOnDefault), ['--json']);
      expect(ids(r)).toEqual(['ruleset.approval-off main']);
      expect(r.status).toBe(EXIT.findings);
      const [f] = r.json.findings;
      expect(f).toMatchObject({ category: 'ruleset', blocking: true });
      expect(f.message).toContain('ended 2026-10-02');
      // What it found, and not its opposite.
      expect(f.message).toContain('the ruleset on main (Kanon: default branch) requires no approving review.');
      expect(f.message).toContain('K-ADOPT-6');
      expect(JSON.parse(f.fix.commands[1]).rules.find((x: { type: string }) => x.type === 'pull_request').parameters.required_approving_review_count).toBe(1);
    }
  });

  it('passes a record whose bootstrap ended while the ruleset requires an approving review', async () => {
    const files = healthyFiles();
    files['docs/qa/adoption.md'] = record('ended 2026-10-02');
    const r = await run(checkout(files), github(1, true), ['--json']);
    expect(r.json.findings).toEqual([]);
    expect(r.status, r.out).toBe(EXIT.healthy);
  });

  it('passes a record still in bootstrap, whatever the ruleset requires', async () => {
    const files = healthyFiles();
    files['docs/qa/adoption.md'] = record('in bootstrap since 2026-10-01');
    const r = await run(checkout(files), github(0, false), ['--json']);
    expect(r.json.findings).toEqual([]);
  });

  it('fails an ended bootstrap where no ruleset covers the default branch at all', async () => {
    const files = healthyFiles();
    files['docs/qa/adoption.md'] = record('ended 2026-10-02');
    const g = github(0, false);
    g.st.rulesets = [];
    const r = await run(checkout(files), g, ['--json']);
    expect(ids(r)).toEqual(['ruleset.missing main', 'ruleset.approval-off main']);
    expect(has(r, 'ruleset.approval-off')[0].message).toContain('no active ruleset covers main, so nothing requires an approving review.');
  });

  // #1262: an organisation ruleset that couldn't be read may be the one that requires the
  // approval, so the finding says so, and its fix points at that ruleset, not at kanon init.
  const unreadOrg = { id: 8, name: 'org-main', target: 'branch', enforcement: 'active', source_type: 'Organization', source: 'acme', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, rules: [{ type: 'deletion' }] };

  it('names a ruleset it could not read beside the readable one that requires no approving review', async () => {
    const files = healthyFiles();
    files['docs/qa/adoption.md'] = record('ended 2026-10-02');
    const g = github(0, false);
    g.st.rulesets = [...g.st.rulesets, unreadOrg] as typeof g.st.rulesets;
    g.st.unreadableRulesets = [8];
    const r = await run(checkout(files), g, ['--json']);
    expect(ids(r)).toEqual(['ruleset.unreadable main', 'ruleset.approval-off main']);
    expect(has(r, 'ruleset.approval-off')[0].message).toContain('the ruleset on main (Kanon: default branch) requires no approving review ("org-main" could not be read, and may require one; ruleset.unreadable).');
  });

  it('points the fix at the ruleset it could not read when no readable one covers the default branch', async () => {
    const files = healthyFiles();
    files['docs/qa/adoption.md'] = record('ended 2026-10-02');
    const g = github(0, false);
    g.st.rulesets = [unreadOrg] as typeof g.st.rulesets;
    g.st.unreadableRulesets = [8];
    const r = await run(checkout(files), g, ['--json']);
    expect(ids(r)).toEqual(['ruleset.unreadable main', 'ruleset.approval-off main']);
    const [f] = has(r, 'ruleset.approval-off');
    expect(f.fix.url).toBe('https://github.com/organizations/acme/settings/rules/8');
    expect(f.fix.text).toContain('in the ruleset "org-main", on its page.');
    expect(f.fix.text).not.toContain('kanon init');
  });

  it('fails an ended bootstrap on a private repository whose plan has no rulesets', async () => {
    const files = healthyFiles();
    files['docs/qa/adoption.md'] = record('ended 2026-10-02');
    const g = github(0, false);
    g.st.noRulesetsOnPlan = true;
    const r = await run(checkout(files), g, ['--json']);
    const [f] = has(r, 'ruleset.approval-off');
    expect(f).toMatchObject({ subject: 'main', blocking: true });
    expect(f.message).toContain('acme/widgets has no rulesets on its plan, so nothing requires an approving review.');
    expect(f.fix.text).toContain('K-ADOPT-3');
    expect(r.status).toBe(EXIT.findings);
  });

  it("can't be waived: a waiver of it is malformed", async () => {
    const files = healthyFiles();
    files['docs/qa/adoption.md'] = record('ended 2026-10-02', `- **${WAIVER_LABEL}:** \`ruleset.approval-off\` on \`main\` (why)\n`);
    const r = await run(checkout(files), github(0, false), ['--json']);
    expect(ids(r)).toEqual(['declaration.malformed docs/qa/adoption.md', 'ruleset.approval-off main']);
  });

  it('reads the end date only from the line under ## Bootstrap, outside fences', () => {
    expect(bootstrapEnded(record('ended 2026-10-02'))).toBe('2026-10-02');
    expect(bootstrapEnded(record('in bootstrap since 2026-10-01'))).toBeNull();
    expect(bootstrapEnded(`${RECORD}## Bootstrap\n\n\`in bootstrap since 2026-10-01\`\n\nWe expect it \`ended 2026-12-01\` or so.\n`)).toBeNull();
    expect(bootstrapEnded(`${RECORD}## Choices\n\n\`ended 2026-10-02\`\n`)).toBeNull();
    expect(bootstrapEnded(`${RECORD}## Bootstrap\n\n\`\`\`\n\`ended 2026-10-02\`\n\`\`\`\n`)).toBeNull();
    expect(bootstrapEnded(`${RECORD}## Bootstrap\n\n\`ended soon\`\n`)).toBeNull();
    expect(bootstrapEnded('')).toBeNull();
  });
});

// Kanon's own callers are named apart from their lanes (ADR 0011), so the review caller on the
// default branch is found by what it calls, not by its file name.
describe('kanon doctor finds the review caller on the default branch by what it calls', () => {
  it('reports bootstrap can end with the caller under another name', async () => {
    const g = github(0, false);
    g.st.defaultWorkflows!['review.yml'] = callerFile('agent-review', REQ.lanes['agent-review']!, { release: PINNED, ciName: 'CI', defaultBranch: 'main' });
    const r = await run(checkout(healthyFiles()), g, ['--json']);
    expect(ids(r)).toEqual(['ruleset.bootstrap-can-end main']);
  });
});
