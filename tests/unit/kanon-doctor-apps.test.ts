import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { appSecrets, appsCheckFile } from '../../cli/callers.mjs';
import { EXIT } from '../../cli/doctor.mjs';
import { appsCheckRun, checkout, clone, fakeGitHub, healthyFiles, identitiesOf, ids, LANES, NEW_DOC, NEXT, nextRelease, permissionsOf, PINNED, put, registerText, releaseBy, releaserFiles, releaserOn, REPO, REQ, ROOT, run, type Result } from './helpers/doctor.js';
import { SPAWNS } from './helpers/spawns.js';

/**
 * `kanon doctor` on the Apps in use: the Releaser's ruleset bypass (#49, #441), Apps no lane uses any
 * more, Kanon's own workflows (#437, #440), and private Apps read through apps-check (#417).
 *
 * Split out of kanon-doctor.test.ts, which holds the plan's falsifiable checks and the JSON contract,
 * so the doctor's cases run in parallel (#436). The fixtures are in helpers/doctor.ts.
 */
// Every case runs doctor against a real git checkout (helpers/doctor.ts).
vi.setConfig({ testTimeout: SPAWNS.timeout });

// #49, K-MERGE-8: where the release caller maps the Releaser, it is the ruleset's only bypass
// actor, through pull requests only.
describe('kanon doctor and the Releaser\'s ruleset bypass (#49)', () => {
  const RELEASER_ID = 4242;
  const ADMIN = { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'pull_request' };
  const RELEASER = { actor_id: RELEASER_ID, actor_type: 'Integration', bypass_mode: 'pull_request' };
  const releaseCaller = [
    'name: Release', 'on:', '  push:', '    branches: [main]', 'permissions: {}', 'jobs:', '  release:',
    '    permissions:', '      contents: write', '      pull-requests: write',
    `    uses: yedeya-labs/kanon/.github/workflows/release.yml@${PINNED}`,
    '    secrets:', ...appSecrets('releaser').map((n) => `      ${n}: \${{ secrets.${n} }}`), '',
  ].join('\n');
  const withReleaser = (bypass: unknown[] | undefined, release = REQ) => {
    const files = healthyFiles();
    files['.github/workflows/release.yml'] = releaseCaller;
    files['docs/qa/agent-identities.md'] = registerText([...identitiesOf(LANES), 'releaser']);
    files['.github/workflows/apps-check.yml'] = appsCheckFile([...identitiesOf(LANES), 'releaser'], PINNED);
    const github = fakeGitHub({ secrets: new Set([...LANES.flatMap((l) => REQ.lanes[l]!.secrets), ...appSecrets('releaser')]), releases: { [NEXT]: release } });
    github.st.apps['widgets-releaser'] = { id: RELEASER_ID, owner: { login: 'acme', type: 'User' }, permissions: permissionsOf(REQ, 'releaser') };
    github.st.rulesets = [{ ...github.st.rulesets[0]!, source_type: 'Repository', ...(bypass ? { bypass_actors: bypass } : {}) }];
    return { dir: checkout(files), github };
  };

  it('is healthy with the Releaser as the one bypass actor', async () => {
    const { dir, github } = withReleaser([RELEASER]);
    const r = await run(dir, github, ['--json']);
    expect(r.json.apps.map((a: { identity: string }) => a.identity)).toContain('releaser');
    expect(ids(r)).toEqual([]);
    expect(r.status).toBe(EXIT.healthy);
  });

  it('names a ruleset that lacks the Releaser, with the command that adds it beside the others', async () => {
    const { dir, github } = withReleaser([ADMIN]);
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual(['ruleset.releaser-bypass-missing main', 'ruleset.bypass-extra main']);
    const [missing, extra] = r.json.findings;
    expect(missing).toMatchObject({ category: 'ruleset', blocking: true, fix: { url: `https://github.com/${REPO}/settings/rules/7` } });
    expect(missing.message).toContain('`widgets-releaser`');
    expect(JSON.parse(missing.fix.commands[1])).toEqual({ bypass_actors: [ADMIN, RELEASER] });
    expect(extra.message).toContain('the admin role (pull requests only)');
    expect(JSON.parse(extra.fix.commands[1])).toEqual({ bypass_actors: [RELEASER] });
    expect(r.status).toBe(EXIT.findings);
  });

  it('asks the admin bypass off only against a release whose dco passes the Releaser\'s release PR (#337)', async () => {
    // A release without the exemption, or one from before the field existed: keep the bypass.
    const without = clone(REQ);
    without.release = { dcoExemptsReleaser: false };
    const older = clone(REQ);
    delete older.release;
    for (const target of [without, older]) {
      const { dir, github } = withReleaser([ADMIN, RELEASER], target);
      const r = await run(dir, github, ['--json', '--to', NEXT]);
      expect(ids(r)).toEqual([]);
      expect(r.json.notes.join('\n')).toMatch(/lets the admin role \(pull requests only\) bypass it beside the Releaser\. Keep that while you pin v1\.1\.0/);
      expect(r.status).toBe(EXIT.healthy);
    }
    // This release has it: the admin's bypass goes.
    const { dir, github } = withReleaser([ADMIN, RELEASER]);
    expect(ids(await run(dir, github, ['--json']))).toEqual(['ruleset.bypass-extra main']);
  });

  it('tells the Releaser from another App by its id', async () => {
    const other = { actor_id: 99, actor_type: 'Integration', bypass_mode: 'pull_request' };
    const { dir, github } = withReleaser([other]);
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual(['ruleset.releaser-bypass-missing main', 'ruleset.bypass-extra main']);
    expect(r.json.findings[1].message).toContain('the App 99 (pull requests only)');
  });

  it('is incomplete, not healthy, when the token can\'t see the bypass list', async () => {
    const { dir, github } = withReleaser(undefined);
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual([]);
    expect(r.json.unchecked).toEqual([expect.objectContaining({ check: 'ruleset-bypass', subject: 'main' })]);
    expect(r.status).toBe(EXIT.incomplete);
  });

  // #417: apps-check reads a private Releaser's permissions, but its id is the RELEASER_APP_ID
  // secret's value, which the run's log masks; the owner's installations name it.
  const privateReleaser = (bypass: unknown[]) => {
    const { dir, github } = withReleaser(bypass);
    github.st.private = new Set(Object.keys(github.st.apps));
    appsCheckRun(github, Object.fromEntries([...identitiesOf(LANES), 'releaser'].map((id) => [id, permissionsOf(REQ, id)])), { appIds: { releaser: RELEASER_ID } });
    return { dir, github };
  };

  it('reads a private Releaser\'s id from the owner\'s installations, never from the masked log, to find it in the bypass list (#417)', async () => {
    const { dir, github } = privateReleaser([RELEASER]);
    github.st.installations = [{ id: 34, app_slug: 'widgets-releaser', app_id: RELEASER_ID, account: { login: 'acme' } }];
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual([]);
    expect(r.json.unchecked).toEqual([]);
    expect(r.status).toBe(EXIT.healthy);
    const missing = privateReleaser([ADMIN]);
    missing.github.st.installations = github.st.installations;
    expect(ids(await run(missing.dir, missing.github, ['--json']))).toContain('ruleset.releaser-bypass-missing main');
  });

  it('leaves a private Releaser\'s bypass unchecked, and says why, when the token can\'t list the installations or they list no Releaser (#417)', async () => {
    const { dir, github } = privateReleaser([RELEASER]);
    const r = await run(dir, github, ['--json']);
    expect(r.json.unchecked).toEqual([expect.objectContaining({ check: 'ruleset-bypass', subject: 'main', reason: expect.stringContaining('a secret the run\'s log masks') })]);
    expect(r.json.unchecked[0].reason).toContain('only a GitHub App\'s user token can list them');
    expect(r.status).toBe(EXIT.incomplete);
    github.st.ownerType = 'Organization';
    const org = await run(dir, github, ['--json']);
    expect(org.json.unchecked[0].reason).toContain('Administration permission (read)');
    github.st.installations = [{ id: 31, app_slug: 'widgets-reviewer', app_id: 77, account: { login: 'acme' } }];
    const none = await run(dir, github, ['--json']);
    expect(none.json.unchecked).toEqual([expect.objectContaining({ check: 'ruleset-bypass', reason: expect.stringContaining('list no installation of it') })]);
  });

  it('asks nothing of the bypass where the release caller doesn\'t map the Releaser', async () => {
    const dir = checkout(healthyFiles());
    const github = fakeGitHub();
    github.st.rulesets = [{ ...github.st.rulesets[0]!, bypass_actors: [ADMIN] }];
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual([]);
    expect(r.status).toBe(EXIT.healthy);
  });
});

// The Owner, 2026-10-06: per-role Apps left installed after the two-App move are listed, not blocking.
describe('kanon doctor and Apps no lane uses any more', () => {
  /** A checkout whose register once named the per-role App `widgets-reviewer`, then moved on. */
  const migrated = () => {
    const files = healthyFiles();
    const now = files['docs/qa/agent-identities.md']!;
    files['docs/qa/agent-identities.md'] = `${now.trimEnd()}\n| Reviewer | \`widgets-reviewer\` | Read & write | Read & write | Read & write | No access | No access | None |\n`;
    const dir = checkout(files);
    put(dir, { 'docs/qa/agent-identities.md': now });
    execFileSync('git', ['-C', dir, 'commit', '-q', '-am', 'move to two Apps']);
    return dir;
  };

  it('names an App the register once named that is still installed, without blocking, with the delete steps', async () => {
    const github = fakeGitHub();
    github.st.installations = [{ id: 31, app_slug: 'widgets-reviewer', account: { login: 'acme' } }, { id: 32, app_slug: 'some-other-app', account: { login: 'acme' } }];
    const r = await run(migrated(), github, ['--json']);
    expect(ids(r)).toEqual(['app.unused widgets-reviewer']);
    expect(r.json.findings[0]).toMatchObject({ category: 'app', blocking: false, fix: { url: 'https://github.com/settings/installations/31' } });
    expect(r.json.findings[0].fix.text).toContain('https://github.com/settings/apps/widgets-reviewer/advanced');
    expect(r.status).toBe(EXIT.healthy);
  });

  it('says nothing of one already uninstalled, or one the register still names', async () => {
    const github = fakeGitHub();
    github.st.installations = [{ id: 33, app_slug: `widgets-${identitiesOf(LANES)[0]}`, account: { login: 'acme' } }];
    const r = await run(migrated(), github, ['--json']);
    expect(ids(r)).toEqual([]);
  });

  it('in an organisation, lists its installations, and names the token that can when this one can\'t (#417)', async () => {
    const github = fakeGitHub();
    github.st.ownerType = 'Organization';
    const blind = await run(migrated(), github, ['--json']);
    expect(blind.json.unchecked).toEqual([expect.objectContaining({ check: 'unused-apps', subject: 'acme' })]);
    expect(blind.json.unchecked[0].reason).toMatch(/an owner of acme.*Administration permission \(read\)/);
    expect(blind.json.unchecked[0].reason).toContain('docs/doctor.md');
    expect(blind.status).toBe(EXIT.incomplete);
    github.st.installations = [{ id: 31, app_slug: 'widgets-reviewer', account: { login: 'acme' } }];
    const r = await run(migrated(), github, ['--json']);
    expect(github.calls.some((c) => c[1] === 'orgs/acme/installations?per_page=100')).toBe(true);
    expect(ids(r)).toEqual(['app.unused widgets-reviewer']);
    expect(r.json.findings[0].fix.url).toBe('https://github.com/organizations/acme/settings/installations/31');
    expect(r.status).toBe(EXIT.healthy);
  });

  it('is incomplete when the installations can\'t be listed, and asks nothing without a former App', async () => {
    const r = await run(migrated(), fakeGitHub(), ['--json']);
    expect(r.json.unchecked).toEqual([expect.objectContaining({ check: 'unused-apps', subject: 'acme' })]);
    expect(r.status).toBe(EXIT.incomplete);
    const github = fakeGitHub();
    const plain = await run(checkout(healthyFiles()), github, ['--json']);
    expect(plain.status).toBe(EXIT.healthy);
    expect(github.calls.some((c) => String(c[1]).includes('installations'))).toBe(false);
  });

  it('lists the per-role Apps as app.unused and their secrets as secret.stale, beside a release caller by `$/` (G4)', async () => {
    const dir = migrated();
    put(dir, releaserFiles({ '.github/workflows/release-please.yml': releaseBy('$/.github/workflows/release.yml') }));
    execFileSync('git', ['-C', dir, 'add', '-A']);
    execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'release caller']);
    const github = releaserOn(fakeGitHub({ secrets: new Set([...LANES.flatMap((l) => REQ.lanes[l]!.secrets), ...appSecrets('releaser'), ...appSecrets('reviewer')]) }));
    github.st.installations = [{ id: 31, app_slug: 'widgets-reviewer', account: { login: 'acme' } }];
    const r = await run(dir, github, ['--json']);
    expect(ids(r)).toEqual(['app.unused widgets-reviewer', 'secret.stale acme/widgets']);
    expect(r.json.findings[1].fix.commands).toEqual(appSecrets('reviewer').sort().map((n) => `gh secret delete ${n} -R ${REPO}`));
  });
});

// The Owner, 2026-10-07 (#440, #437): apps-check names each App's secrets literally, so on Kanon's
// own tree doctor lists the per-role Apps' secrets as stale, and never the three Apps'.
describe("kanon doctor on Kanon's own workflows (#440, #437)", () => {
  const kanonTree = () => {
    const files: Record<string, string> = { 'docs/qa/agent-identities.md': readFileSync(join(ROOT, 'docs/qa/agent-identities.md'), 'utf8') };
    for (const f of readdirSync(join(ROOT, '.github/workflows')).filter((x) => /\.ya?ml$/.test(x))) files[`.github/workflows/${f}`] = readFileSync(join(ROOT, '.github/workflows', f), 'utf8');
    return files;
  };
  const PER_ROLE = ['implementer', 'explorer', 'reviewer'].flatMap(appSecrets);
  const APP_SECRETS = ['author', 'judge', 'releaser'].flatMap(appSecrets);
  const stale = async (files: Record<string, string>) => {
    // Kanon's tree pins its judging actions to its last release; check against this tree's own.
    const r = await run(checkout(files), fakeGitHub({ secrets: new Set(['CLAUDE_CODE_OAUTH_TOKEN', ...PER_ROLE, ...APP_SECRETS]) }), ['--json', '--to', PINNED]);
    return { r, deletes: r.json.findings.filter((f: { id: string }) => f.id === 'secret.stale').flatMap((f: { fix: { commands: string[] } }) => f.fix.commands) };
  };

  it('lists exactly the per-role pairs as stale, and none of the Author\'s, Judge\'s or Releaser\'s', async () => {
    const { deletes } = await stale(kanonTree());
    expect(deletes).toEqual([...PER_ROLE].sort().map((n) => `gh secret delete ${n} -R ${REPO}`));
  });

  it('lists none while apps-check reads them by a computed name, and says why (mutation)', async () => {
    const files = kanonTree();
    const computed = (suffix: string) => `\${{ secrets[format('{0}_${suffix}', matrix.app.secret)] }}`;
    files['.github/workflows/apps-check.yml'] = files['.github/workflows/apps-check.yml']!
      .replace(/\$\{\{ matrix\.app\.key == 'author' && secrets\.AUTHOR_APP_ID [^}]*\}\}/g, computed('APP_ID'))
      .replace(/\$\{\{ matrix\.app\.key == 'author' && secrets\.AUTHOR_APP_PRIVATE_KEY [^}]*\}\}/g, computed('APP_PRIVATE_KEY'));
    const { r, deletes } = await stale(files);
    expect(deletes).toEqual([]);
    expect(r.json.notes.join('\n')).toContain('.github/workflows/apps-check.yml reads secrets by a computed name');
  });
});

// #441: a release caller is recognised by what it calls, Kanon's pin, `$/` or a local path, never by
// the repository's name, so the Releaser it maps is an App in use on Kanon's own repository too.
describe('kanon doctor and a release caller by any path (#441)', () => {
  const ADMIN = { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'pull_request' };
  const using = (uses: string, bypass?: unknown[]) => {
    const dir = checkout(releaserFiles({ ...healthyFiles(), '.github/workflows/release-please.yml': releaseBy(uses) }));
    return run(dir, releaserOn(fakeGitHub({ secrets: new Set([...LANES.flatMap((l) => REQ.lanes[l]!.secrets), ...appSecrets('releaser')]) }), bypass), ['--json']);
  };
  const apps = (r: Result) => r.json.apps.map((a: { identity: string }) => a.identity);

  for (const uses of [`yedeya-labs/kanon/.github/workflows/release.yml@${PINNED}`, '$/.github/workflows/release.yml', '$/.github/workflows/release.yaml', './.github/workflows/release.yml']) {
    it(`checks the Releaser a caller reaching \`${uses}\` maps as an App in use, its ruleset bypass included`, async () => {
      const r = await using(uses);
      expect(apps(r)).toContain('releaser');
      expect(ids(r)).toEqual([]);
      expect(r.status).toBe(EXIT.healthy);
      expect(ids(await using(uses, [ADMIN]))).toEqual(['ruleset.releaser-bypass-missing main', 'ruleset.bypass-extra main']);
    });
  }

  it('leaves the Releaser out for a caller of another workflow, or one that maps none of its secrets (mutations)', async () => {
    for (const uses of ['$/.github/workflows/release-notes.yml', './.github/workflows/releases/release.yml', '$/actions/release.yml', 'octo/kanon/.github/workflows/release.yml@v1.0.0', 'acme/tools/$/.github/workflows/release.yml', './.github/workflows/release.yml.bak']) {
      const r = await using(uses, [ADMIN]);
      expect(apps(r)).not.toContain('releaser');
      expect(ids(r)).not.toContain('ruleset.releaser-bypass-missing main');
    }
    const bare = releaseBy('$/.github/workflows/release.yml').replace(/ {4}secrets:\n( {6}.*\n)+/, '');
    const dir = checkout(releaserFiles({ ...healthyFiles(), '.github/workflows/release-please.yml': bare }));
    const r = await run(dir, releaserOn(fakeGitHub({ secrets: new Set([...LANES.flatMap((l) => REQ.lanes[l]!.secrets), ...appSecrets('releaser')]) }), [ADMIN]), ['--json']);
    expect(apps(r)).not.toContain('releaser');
  });
});

// #417: GET /apps/<slug> answers 404 for a private App to a person's token and the workflow's
// alike; only the App itself reads it. apps-check reads each installation with the App's own
// key, and prints what it found; doctor reads that from the latest run on the default branch.
describe('kanon doctor and private Apps, read through apps-check (#417)', () => {
  const apps = identitiesOf(LANES);
  const asReleased = () => Object.fromEntries(apps.map((id) => [id, permissionsOf(REQ, id)]));
  const privately = () => {
    const github = fakeGitHub();
    github.st.private = new Set(apps.map((id) => `widgets-${id}`));
    return github;
  };

  it('is healthy, exit 0, when the Apps are private and the latest apps-check run found what the release grants', async () => {
    const github = privately();
    const url = appsCheckRun(github, asReleased());
    const r = await run(checkout(healthyFiles()), github, ['--json']);
    expect(r.json.unchecked).toEqual([]);
    expect(ids(r)).toEqual([]);
    expect(r.status, r.out).toBe(EXIT.healthy);
    expect(r.json.notes.filter((n: string) => n.includes(url))).toHaveLength(apps.length);
    expect(github.calls.map((c) => c.join(' '))).toContain(`api repos/${REPO}/actions/workflows/apps-check.yml/runs?branch=main&event=workflow_dispatch&status=completed&per_page=1`);
  });

  it('finds a missing and an extra permission in what apps-check found, though apps-check failed the run', async () => {
    const github = privately();
    const [author, judge] = apps as [string, string];
    const holds = asReleased();
    delete holds[judge]!.issues;
    holds[author]!.deployments = 'read';
    appsCheckRun(github, holds, { conclusion: 'failure' });
    const r = await run(checkout(healthyFiles()), github, ['--json']);
    expect(ids(r)).toEqual([`app.permission-extra widgets-${author}`, `app.permission-missing widgets-${judge}`]);
    expect(r.json.findings[1].message).toContain('issues: none');
    expect(r.json.findings[1].fix.url).toBe(`https://github.com/settings/apps/widgets-${judge}/permissions`);
    expect(r.status).toBe(EXIT.findings);
  });

  it('checks --to against what apps-check found', async () => {
    const github = privately();
    const { next, slug } = nextRelease();
    github.st.releases[NEXT] = next;
    appsCheckRun(github, asReleased());
    const r = await run(checkout(healthyFiles()), github, ['--json', '--to', NEXT]);
    expect(ids(r)).toEqual([`app.permission-missing ${slug}`, `declaration.missing ${NEW_DOC}`]);
    expect(r.json.findings[0].message).toContain('deployments: read');
  });

  it('is incomplete, and says to run apps-check, when there is no run on the default branch', async () => {
    const github = privately();
    appsCheckRun(github, asReleased(), { branch: 'feature' });
    const r = await run(checkout(healthyFiles()), github, ['--json']);
    expect(r.json.unchecked.map((u: { check: string; subject: string }) => `${u.check} ${u.subject}`)).toEqual(apps.map((id) => `app-permissions widgets-${id}`));
    for (const u of r.json.unchecked) {
      expect(u.reason).toContain('could not read the App');
      expect(u.reason).toContain(`gh workflow run apps-check.yml -R ${REPO}`);
    }
    expect(r.status).toBe(EXIT.incomplete);
  });

  it('never reads a newer run a fork\'s pull request from its own main started, whose workflow is the fork\'s', async () => {
    const github = privately();
    const [author] = apps as [string];
    const url = appsCheckRun(github, asReleased());
    const forged = asReleased();
    delete forged[author]!.contents;
    appsCheckRun(github, forged, { event: 'pull_request', from: 'mallory/widgets' });
    const r = await run(checkout(healthyFiles()), github, ['--json']);
    expect(r.json.unchecked).toEqual([]);
    expect(ids(r)).toEqual([]);
    expect(r.json.notes.filter((n: string) => n.includes(url))).toHaveLength(apps.length);
  });

  it('is incomplete, and reads nothing from it, when the run it is given came from another repository or another event', async () => {
    for (const o of [{ from: 'mallory/widgets' }, { event: 'pull_request', from: 'mallory/widgets' }, { event: 'push' }]) {
      const github = privately();
      github.st.appsCheck.ignoresEvent = true;
      appsCheckRun(github, asReleased(), o);
      const r = await run(checkout(healthyFiles()), github, ['--json']);
      expect(r.json.unchecked.map((u: { check: string }) => u.check), JSON.stringify(o)).toEqual(apps.map(() => 'app-permissions'));
      expect(r.json.unchecked[0].reason).toContain(`not dispatched in ${REPO}`);
      expect(r.json.unchecked[0].reason).toContain(`gh workflow run apps-check.yml -R ${REPO}`);
      expect(r.status).toBe(EXIT.incomplete);
    }
  });

  it('is incomplete when the run printed no result, as apps-check before #417 did, or checked another App', async () => {
    const github = privately();
    const url = appsCheckRun(github, asReleased(), { line: false });
    const old = await run(checkout(healthyFiles()), github, ['--json']);
    expect(old.json.unchecked).toHaveLength(apps.length);
    expect(old.json.unchecked[0].reason).toContain(url);
    expect(old.json.unchecked[0].reason).toContain('gh workflow run apps-check.yml');
    expect(old.status).toBe(EXIT.incomplete);
    const [author] = apps as [string];
    appsCheckRun(github, asReleased(), { slugs: { [author]: 'acme-old-author' } });
    const other = await run(checkout(healthyFiles()), github, ['--json']);
    expect(other.json.unchecked).toEqual([expect.objectContaining({ check: 'app-permissions', subject: `widgets-${author}`, reason: expect.stringContaining('`acme-old-author`') })]);
    expect(other.status).toBe(EXIT.incomplete);
  });

  it('reads the permissions from a log the runner masked the App id in, and says when a line it can\'t read was masked', async () => {
    const github = privately();
    appsCheckRun(github, asReleased());
    expect([...github.st.appsCheck.secrets]).toHaveLength(apps.length);
    const r = await run(checkout(healthyFiles()), github, ['--json']);
    expect(r.json.unchecked).toEqual([]);
    expect(r.status).toBe(EXIT.healthy);
    for (const n of r.json.notes) for (const v of github.st.appsCheck.secrets) expect(n).not.toContain(v);
    appsCheckRun(github, asReleased(), { line: 'with-id' });
    const old = await run(checkout(healthyFiles()), github, ['--json']);
    expect(old.json.unchecked).toHaveLength(apps.length);
    expect(old.json.unchecked[0].reason).toContain('the runner masked part of');
    expect(old.json.unchecked[0].reason).not.toContain('from before #417');
  });

  it('reads an App it can read from GitHub, and no run', async () => {
    const github = fakeGitHub();
    const r = await run(checkout(healthyFiles()), github, ['--json']);
    expect(r.status).toBe(EXIT.healthy);
    expect(github.calls.some((c) => c.some((x) => x.includes('/actions/')))).toBe(false);
  });
});
