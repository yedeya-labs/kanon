import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * kanon#1387, the docs half of project #1373 (`docs/projects/1373.md`, Issue F). Once every Author
 * lane commits through a push job, `docs/lanes.md` says how, with the upgrade steps an adopter
 * follows for the release that brings it, and `SECURITY.md` drops the gap #1358 accepted until
 * then: GitHub's verification, not an author email, now decides what carries the status.
 *
 * Mutations that turn it red: delete the "How an Author lane commits" section, or its upgrade
 * subsection, or one of the upgrade steps; restore SECURITY.md's "after a mid-run re-fetch"
 * subsection, or a link to its anchor from either file; or say again that the revise and rebase
 * agents' token pushes, or holds workflows write.
 */

const ROOT = process.cwd();
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

/** The body of the section headed `heading` exactly, up to the next heading of its level or above. */
const section = (text: string, heading: string): string => {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === heading);
  if (start < 0) throw new Error(`no "${heading}" heading`);
  const level = heading.indexOf(' ');
  const end = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}} `).test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
};

const LANES = read('docs/lanes.md');
const SECURITY = read('SECURITY.md');
const COMMITS = '## How an Author lane commits';
const UPGRADE = '### Upgrading to the release that brings verified commits';
const GAP_ANCHOR = '#the-implementer-status-after-a-mid-run-re-fetch';

describe('[LANE-21] docs/lanes.md says how an Author lane commits, with the upgrade steps', () => {
  it('[LANE-21] the agent commits locally, and a push job re-creates each commit through the API', () => {
    const body = section(LANES, COMMITS);
    expect(body).toMatch(/agent commits on its runner/);
    expect(body).toMatch(/`push` job/);
    expect(body).toMatch(/re-creates each commit GitHub lacks through GitHub's Git Data API/);
    expect(body).toMatch(/verified as your App's/);
    expect(body).toMatch(/runs no agent and none of your code/);
    // Every lane that commits this way is named.
    for (const lane of ['implement', 'triage', 'implement-revise', 'Lead', 'Lead revise', 'rebase', 'split']) {
      expect(body).toContain(lane);
    }
  });

  it('[LANE-21] gives the adopter\'s upgrade steps for the release that brings it', () => {
    const steps = section(LANES, UPGRADE);
    // An agent no longer pushes: an adopter's playbook that tells it to must change.
    expect(steps).toMatch(/`git push`/);
    expect(steps).toMatch(/`gh pr create`/);
    expect(steps).toContain('docs/.kanon-pull-request.json');
    // The App's bot account authors the commit, not the persona.
    expect(steps).toMatch(/`<slug>\[bot\]`/);
    expect(steps).toMatch(/persona/);
    // A person's commit under the App's email now ends the carry.
    expect(steps).toMatch(/under the App's email/);
    expect(steps).toMatch(/ends the implementer status/);
    // The push job's token, and a ruleset as an option, never a requirement.
    expect(steps).toMatch(/Workflows write/);
    expect(steps).toMatch(/signed commits/);
  });

  it('[LANE-21] the revise and rebase lanes link to the section, not to the gap', () => {
    for (const title of ['## The revise lane', '## The rebase lane']) {
      const body = section(LANES, title);
      expect(body).toContain('](#how-an-author-lane-commits)');
      expect(body).not.toContain(GAP_ANCHOR);
    }
  });
});

describe('[LANE-21] SECURITY.md no longer lists the mid-run re-fetch gap as an accepted exposure', () => {
  it('[LANE-21] has no subsection on it, and nothing links to one', () => {
    expect(SECURITY).not.toMatch(/^#+ The Implementer status after a mid-run re-fetch$/m);
    expect(SECURITY).not.toContain(GAP_ANCHOR);
    expect(LANES).not.toContain(GAP_ANCHOR);
    expect(SECURITY).not.toMatch(/#1358/);
  });

  it('[LANE-21] says the revise and rebase agents\' token writes no code and no workflow, and the push job does', () => {
    const body = section(SECURITY, '## Accepted exposures');
    const token = section(body, '### Which lanes, and what runs').split('\n').find((l) => /Author App's installation token/.test(l));
    expect(token).toBeDefined();
    expect(token).not.toMatch(/push/);
    const bounds = section(body, '### What bounds it');
    expect(bounds).not.toMatch(/contents, issues, pull requests and workflows write/);
    expect(bounds).toMatch(/contents read/);
    expect(bounds).toMatch(/`push` job/);
  });
});
