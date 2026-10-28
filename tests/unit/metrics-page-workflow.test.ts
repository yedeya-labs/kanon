import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = parse(readFileSync('.github/workflows/metrics-page.yml', 'utf8'));

describe('the metrics page workflow', () => {
  it("grants the page job exactly the reads Kanon's health needs, the closing pull request included (#696)", () => {
    expect(workflow.jobs.page.permissions).toEqual({ contents: 'read', issues: 'read', 'pull-requests': 'read' });
  });
});

describe('the metrics page commits through the verified-commit helper (kanon#1385)', () => {
  type Step = { id?: string; name?: string; if?: string; run?: string; env?: Record<string, string> };
  const steps = workflow.jobs.page.steps as Step[];
  const propose = steps.find((s) => s.name === 'Propose the page')!;

  it("[LANE-18] the metrics page's fixed step creates its commit with the helper instead of git push --force", () => {
    expect(JSON.stringify(workflow)).not.toMatch(/git push/);
    const run = String(propose.run);
    // The helper from the checked-out tree, replacing the refresh branch over the commit this run
    // checked out, with the Author App's token, after the local commit and before the pull request.
    expect(run).toMatch(/node scripts\/lib\/verified-commits\.mjs --git-dir \.git --tip HEAD --branch "\$branch" --replace --head "\$GITHUB_SHA" --app-login "\$APP_SLUG\[bot\]"/);
    expect(run.indexOf('git commit')).toBeLessThan(run.indexOf('verified-commits.mjs'));
    expect(run.indexOf('verified-commits.mjs')).toBeLessThan(run.indexOf('gh pr'));
    expect(run).toMatch(/^\s*branch=kanon\/metrics-page$/m);
    expect(propose.env).toMatchObject({
      GH_TOKEN: '${{ steps.app-token.outputs.token }}',
      REPO: '${{ github.repository }}',
      APP_SLUG: '${{ steps.app-token.outputs.app-slug }}',
    });
    // The delegate's sign-off is still added to the local commit, whose message the helper keeps.
    const at = (s: Step | undefined) => steps.indexOf(s!);
    expect(at(steps.find((s) => /agent-commits\.sh/.test(String(s.run))))).toBeLessThan(at(propose));
  });
});
