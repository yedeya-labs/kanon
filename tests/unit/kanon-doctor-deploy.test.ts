import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { appSecrets, ciFile } from '../../cli/callers.mjs';
import { deployCallerProblems, EXIT, FINDINGS, NOTIFY_HOOK, probeAnswer, readWaivers, restrictsTags, runsOnPush, UNWAIVABLE, UNWAIVABLE_UNDER, WAIVER_LABEL } from '../../cli/doctor.mjs';
import { DEPLOY_CALLER_PATH, deployCallerFile, deployEnvironmentSecrets, deployHookStub, deploySection } from '../../cli/init.mjs';
import { parseYaml } from '../../cli/workflow-yaml.mjs';
import { PROBE_LINE } from '../../scripts/deploy-gate.mjs';
import { checkout, fakeGitHub, HEALTHY_DEPLOY, healthyFiles, ids, LANES, no, ok, PINNED, releaseBy, releaserFiles, releaserOn, REPO, REQ, ROOT, run, type Result } from './helpers/doctor.js';
import { SPAWNS } from './helpers/spawns.js';

/**
 * `kanon doctor`'s deploy checks (plan 0010 §12, step D7): the `## Deploy` declaration, the caller
 * `kanon init` writes from it, the three hooks, the Releaser, CI on push, the environments, the
 * OIDC subject, the trust probe's line, the artifact's retention and the release tags' ruleset,
 * with the two fallback markers of §13. The fixtures are helpers/doctor.ts's, with a fake GitHub
 * that answers the deploy lane's reads.
 *
 * Each case holds its check in both directions (`K-PRIN-11`): the healthy installation, written by
 * `kanon init`'s own builders, is the baseline every mutation below departs from, and gives no
 * `deploy.*` finding.
 */
vi.setConfig({ testTimeout: SPAWNS.timeout });

type Lane = { workflows: { release: string; environment: string }; hooks: Array<{ path: string; inputs: string[] }> };
const LANE = (REQ as unknown as { deploy: Lane }).deploy;
const TWO = ['staging', 'production'];
const RELEASE_CALLER = '.github/workflows/release-please.yml';
const RECORD = 'docs/qa/adoption.md';
const REFUSED = (envs: string[]) => `${PROBE_LINE} ${JSON.stringify(Object.fromEntries(envs.map((e) => [e, 'refused'])))}`;

/** The adoption record: the healthy one, its `## Deploy` the section `kanon init` writes for `envs`. */
const record = (envs: string[], o: { fallback?: string; extra?: string; section?: string } = {}) => {
  const section = o.section ?? (envs.length ? `${deploySection(envs).join('\n')}${o.fallback ? `- **Fallback:** \`${o.fallback}\`\n` : ''}` : HEALTHY_DEPLOY);
  return healthyFiles()[RECORD]!.replace(HEALTHY_DEPLOY, section) + (o.extra ?? '');
};

/** The installation: the healthy one with the Releaser, and, for a chain, init's caller and hook stubs. */
const files = (envs: string[] = TWO, o: { fallback?: string; extra?: string; caller?: string | null } = {}) => {
  const f: Record<string, string> = releaserFiles(healthyFiles());
  f[RELEASE_CALLER] = releaseBy(`yedeya-labs/kanon/.github/workflows/release.yml@${PINNED}`);
  f[RECORD] = record(envs, o);
  if (envs.length) for (const h of LANE.hooks) f[h.path] = deployHookStub(h);
  const caller = o.caller === undefined ? (envs.length ? deployCallerFile(envs, REQ, PINNED) : null) : o.caller;
  if (caller !== null) f[DEPLOY_CALLER_PATH] = caller;
  return f;
};

type Env = { reviewers?: boolean; selfReview?: boolean; adminBypass?: boolean; policy?: 'none' | 'protected' | Array<{ name: string; type?: string }> };
type DeployRun = { id: number; event?: string; branch?: string; from?: string; onDefault?: boolean; line?: string | null; probe?: string };
const healthyEnv = (name: string, envs: string[]): Env => ({ reviewers: name === envs[envs.length - 1], selfReview: true, adminBypass: false, policy: [{ name: 'v*', type: 'tag' }] });

/**
 * A fake GitHub holding the deploy lane's state: the environments (null: the token can't read
 * them), the OIDC subject template, the artifact retention, the tag rulesets' rules, the deploy
 * caller's runs (newest first), each with its probe job's log, the release tags, the owner's kind
 * and the organisation secrets shared with the repository (null: the token can't list them). Its run
 * listing ignores the filters, as a server that did would, so doctor's own check of each run is
 * what refuses one.
 */
const github = (o: {
  envs?: Record<string, Env> | null; chain?: string[]; sub?: unknown | null; retention?: number | null;
  tagRules?: string[][]; runs?: DeployRun[] | null; tags?: string[]; owner?: 'User' | 'Organization'; org?: Set<string> | null;
} = {}) => {
  const chain = o.chain ?? TWO;
  const g = releaserOn(fakeGitHub({ secrets: new Set([...LANES.flatMap((l) => REQ.lanes[l]!.secrets), ...appSecrets('releaser')]) }));
  g.st.ownerType = o.owner ?? 'User';
  (o.tagRules ?? [['creation', 'update', 'deletion']]).forEach((rules, i) => {
    (g.st.rulesets as unknown[]).push({ id: 80 + i, name: `Release tags ${i}`, target: 'tag', enforcement: 'active', conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } }, rules: rules.map((type) => ({ type })), bypass_actors: [] });
  });
  const envs = o.envs === undefined ? Object.fromEntries(chain.map((e) => [e, healthyEnv(e, chain)])) : o.envs;
  const runs = o.runs === undefined ? [{ id: 700, line: REFUSED(chain) }] : o.runs;
  for (const r of runs ?? []) {
    g.st.runJobs[r.id] = [{ id: r.id * 10, name: 'release / gate', conclusion: 'success' }, { id: r.id * 10 + 1, name: 'release / probe', conclusion: r.probe ?? 'success' }];
    g.st.appsCheck.logs[r.id * 10 + 1] = r.line === null ? '2026-10-15T07:00:01Z probing\n' : `2026-10-15T07:00:01Z probing\n2026-10-15T07:00:02Z ${r.line ?? REFUSED(chain)}\n`;
  }
  const tags = new Set(o.tags ?? ['v1.0.0']);
  const inner = g.gh;
  const paths: string[] = [];
  g.gh = async (args: string[], input?: string) => {
    const path = args.find((x) => x.startsWith('repos/')) ?? '';
    paths.push(path);
    const denied = no('gh: Resource not accessible by personal access token (HTTP 403)');
    if (path === `repos/${REPO}/environments?per_page=100`) {
      if (!envs) return denied;
      return ok({ total_count: Object.keys(envs).length, environments: Object.entries(envs).map(([name, e]) => ({
        name,
        can_admins_bypass: e.adminBypass ?? false,
        protection_rules: e.reviewers ? [{ id: 1, type: 'required_reviewers', prevent_self_review: e.selfReview ?? true, reviewers: [{ type: 'User', reviewer: { login: 'octo' } }] }] : [],
        deployment_branch_policy: e.policy === 'none' ? null : e.policy === 'protected' ? { protected_branches: true, custom_branch_policies: false } : { protected_branches: false, custom_branch_policies: true },
      })) });
    }
    const policies = new RegExp(`^repos/${REPO}/environments/([^/]+)/deployment-branch-policies\\?per_page=100$`).exec(path);
    if (policies && envs) {
      const e = envs[decodeURIComponent(policies[1]!)];
      return ok({ total_count: 0, branch_policies: Array.isArray(e?.policy) ? e.policy.map((p, i) => ({ id: i + 1, ...p })) : [] });
    }
    if (path === `repos/${REPO}/actions/oidc/customization/sub`) return o.sub === null ? denied : ok(o.sub ?? { use_default: true });
    if (path === `repos/${REPO}/actions/organization-secrets?per_page=100`) return o.org ? ok({ total_count: o.org.size, secrets: [...o.org].map((name) => ({ name })) }) : denied;
    if (path === `repos/${REPO}/actions/permissions/artifact-and-log-retention`) return o.retention === null ? denied : ok({ days: o.retention ?? 90, maximum_allowed_days: 90 });
    if (path.startsWith(`repos/${REPO}/actions/workflows/deploy.yml/runs?`)) {
      if (runs === null) return denied;
      return ok({ workflow_runs: runs.map((r) => ({ id: r.id, status: 'completed', event: r.event ?? 'release', head_branch: r.branch ?? 'v1.0.0', head_sha: `sha${r.id}`, head_repository: { full_name: r.from ?? REPO }, html_url: `https://github.com/${REPO}/actions/runs/${r.id}`, created_at: '2026-10-15T07:00:00Z' })) });
    }
    const tag = new RegExp(`^repos/${REPO}/releases/tags/(.+)$`).exec(path);
    if (tag) return tags.has(decodeURIComponent(tag[1]!)) ? ok({ tag_name: decodeURIComponent(tag[1]!) }) : no('gh: Not Found (HTTP 404)');
    const compare = new RegExp(`^repos/${REPO}/compare/sha(\\d+)\\.\\.\\.main$`).exec(path);
    if (compare) return ok({ status: 'ahead', ahead_by: 1, behind_by: (runs ?? []).find((r) => r.id === Number(compare[1]))?.onDefault === false ? 3 : 0 });
    return inner(args, input);
  };
  return Object.assign(g, { paths });
};

const check = (f: Record<string, string>, g = github()) => run(checkout(f), g, ['--json']);
const deployIds = (r: Result) => ids(r).filter((x: string) => x.startsWith('deploy.'));
const finding = (r: Result, id: string, subject?: string) => r.json.findings.find((f: { id: string; subject: string }) => f.id === id && (subject === undefined || f.subject === subject));
const deployUnchecked = (r: Result) => r.json.unchecked.filter((u: { check: string }) => u.check.startsWith('deploy-'));
const DEPLOY_PATHS = /environments|oidc|artifact-and-log-retention|deploy\.yml\/runs/;

describe("kanon doctor's deploy checks (plan 0010 §12, D7)", () => {
  describe("on kanon init's own output", () => {
    for (const envs of [['production'], TWO, ['dev', 'staging', 'production']]) {
      it(`finds nothing on a chain of ${envs.length}, its caller, stubs and section as init writes them (the mutations' baseline)`, async () => {
        const r = await check(files(envs), github({ chain: envs }));
        // The deploy caller announces through a notify hook (plan 0011 N9), which this
        // installation lacks: a note, never blocking, and the one finding.
        expect(ids(r)).toEqual(['notify.none .github/actions/notify/action.yml']);
        expect(r.json.unchecked).toEqual([]);
        expect(r.status, r.out).toBe(EXIT.healthy);
        // The caller's jobs at the pinned release are Kanon's id-token holders.
        const holders = r.json.idTokenHolders.filter((h: { workflow: string }) => h.workflow === DEPLOY_CALLER_PATH);
        expect(holders.map((h: { job: string }) => h.job)).toEqual(['release', ...envs.map((_, i) => `deploy-${i + 1}`)]);
        for (const h of holders) expect(h.status).toBe('kanon-lane');
      });
    }

    it("reads init's caller as matching the declaration, in the pure check too", () => {
      for (const envs of [['production'], TWO, ['a', 'b', 'c']]) {
        expect(deployCallerProblems(parseYaml(deployCallerFile(envs, REQ, PINNED)) as Record<string, unknown>, envs, LANE.workflows, deployEnvironmentSecrets(REQ))).toEqual([]);
      }
    });

    it('names each pre-production environment in a note, with whether it has a reviewers rule', async () => {
      const r = await check(files());
      expect(r.json.notes).toContain('The pre-production environment staging has no required reviewers rule; the declaration names none, so either is the project\'s choice (plan 0010 §12).');
    });
  });

  describe('with no chain and no caller: only the three that concern the reference deploy', () => {
    it('reports no deploy.* row, and reads none of the lane\'s platform state, on a reference-only section', async () => {
      const g = github();
      const r = await check(files([]), g);
      expect(deployIds(r)).toEqual([]);
      expect(g.paths.filter((p) => DEPLOY_PATHS.test(p) && !p.endsWith('environments?per_page=100'))).toEqual([]);
    });

    it("passes the adopter fixture's reference-only section", async () => {
      const adopter = readFileSync(join(ROOT, 'tests/fixtures/adopter/docs/qa/adoption.md'), 'utf8');
      const r = await check({ ...files([]), [RECORD]: adopter });
      expect(deployIds(r)).toEqual([]);
    });

    it("notes a record that declares no reference deploy at all, as Kanon's own, without blocking", async () => {
      const r = await check({ ...files([]), [RECORD]: record([], { section: '' }) });
      expect(deployIds(r)).toEqual([`deploy.reference-undeclared ${RECORD}`]);
      expect(finding(r, 'deploy.reference-undeclared').blocking).toBe(false);
      expect(r.status).toBe(EXIT.healthy);
      const kanon = readFileSync(join(ROOT, 'docs/qa/adoption.md'), 'utf8');
      expect(deployIds(await check({ ...files([]), [RECORD]: kanon }))).toEqual([`deploy.reference-undeclared ${RECORD}`]);
    });

    it('blocks on a reference-only section that does not parse, with the parser\'s line', async () => {
      const broken = '## Deploy\n- **Reference environment:** `preview`\n- **Reference deploy workflow:** `deploy-preview.yml`\n';
      const r = await check({ ...files([]), [RECORD]: record([], { section: broken }) });
      expect(deployIds(r)).toEqual([`deploy.declaration ${RECORD}`]);
      const f = finding(r, 'deploy.declaration');
      expect(f.blocking).toBe(true);
      expect(f.message).toContain('without `Reference deploy job`');
      expect(r.status).toBe(EXIT.findings);
    });

    it('reports bullets left under ## Choices as deploy.declaration-moved alone, not as a malformed section too', async () => {
      const left = HEALTHY_DEPLOY.split('\n').slice(1).join('\n');
      const r = await check({ ...files([]), [RECORD]: record([], { section: '', extra: left }) });
      expect(deployIds(r)).toEqual([`deploy.declaration-moved ${RECORD}`]);
    });
  });

  describe('deploy.caller-mismatch', () => {
    const caller = () => deployCallerFile(TWO, REQ, PINNED);
    const mismatch = async (text: string | null, envs = TWO) => {
      const r = await check(files(envs, { caller: text }));
      return { r, f: finding(r, 'deploy.caller-mismatch') };
    };

    it('blocks, can\'t be waived, and its fix is kanon init', async () => {
      const { r, f } = await mismatch(caller().replace(/ {2}deploy-2:[\s\S]*$/, ''));
      expect(deployIds(r)).toEqual([`deploy.caller-mismatch ${DEPLOY_CALLER_PATH}`]);
      expect(f.blocking).toBe(true);
      expect(f.message).toContain('it has no `deploy-2` job, for `production`');
      expect(f.fix.commands).toEqual(['kanon init']);
      expect(UNWAIVABLE['deploy.caller-mismatch']).toBeDefined();
      expect(readWaivers(`## Choices\n\n- **${WAIVER_LABEL}:** \`deploy.caller-mismatch\` on \`${DEPLOY_CALLER_PATH}\` (why)\n`).errors[0]).toContain("can't be waived");
    });

    it('is reported for an extra job', async () => {
      const { f } = await mismatch(`${caller()}  deploy-3:\n    name: extra\n    needs: [release, deploy-2]\n    uses: yedeya-labs/kanon/.github/workflows/deploy.yml@${PINNED}\n    permissions:\n      contents: read\n    with:\n      environment: extra\n      position: 3\n      build: \${{ needs.release.outputs.build }}\n`);
      expect(f.message).toContain('it has a job `deploy-3` that the declaration doesn\'t ask for');
    });

    it('is reported for two jobs swapped, so order counts', async () => {
      const swapped = caller().replace('environment: staging', 'environment: @@').replace('environment: production', 'environment: staging').replace('environment: @@', 'environment: production');
      const { f } = await mismatch(swapped);
      expect(f.message).toContain('`deploy-1` deploys `production`, not `staging`, the declared environment at position 1');
      expect(f.message).toContain('`deploy-2` deploys `staging`, not `production`');
      // And the release job's list in another order.
      const { f: list } = await mismatch(caller().replace("environments: 'staging production'", "environments: 'production staging'"));
      expect(list.message).toContain('passes the environments `production staging`, not the declared `staging production`, in that order');
    });

    it('is reported for a dropped needs:', async () => {
      const { f } = await mismatch(caller().replace('    needs: [release, deploy-1]\n', ''));
      expect(f.message).toContain('`deploy-2` needs nothing, not `deploy-1` and `release`');
    });

    it('is reported for a later job that needs the one before it and not release (#948)', async () => {
      const { f } = await mismatch(caller().replace('needs: [release, deploy-1]', 'needs: deploy-1'));
      expect(f.message).toContain("`deploy-2` needs `deploy-1`, not `deploy-1` and `release`: without `release` it can't read the build it deploys");
    });

    it('is reported for a deploy job with no build input (#948)', async () => {
      const text = caller().split('\n');
      text.splice(text.lastIndexOf('      build: ${{ needs.release.outputs.build }}'), 1);
      const { f } = await mismatch(text.join('\n'));
      expect(f.message).toContain("`deploy-2` doesn't pass `build: ${{ needs.release.outputs.build }}`, which deploy.yml requires");
      const { f: other } = await mismatch(caller().replace('build: ${{ needs.release.outputs.build }}', 'build: ${{ needs.release.outputs.other }}'));
      expect(other.message).toContain("`deploy-1` doesn't pass `build:");
    });

    it('is reported for a deploy job that maps no KANON_DEPLOY_SECRET, or maps it from anything but its own name (kanon#1049)', async () => {
      expect(deployEnvironmentSecrets(REQ)).toEqual(['KANON_DEPLOY_SECRET']);
      const MAP = '      KANON_DEPLOY_SECRET: ${{ secrets.KANON_DEPLOY_SECRET }}';
      const text = caller().split('\n');
      text.splice(text.lastIndexOf(MAP), 1);
      const { r, f } = await mismatch(text.join('\n'));
      expect(deployIds(r)).toEqual([`deploy.caller-mismatch ${DEPLOY_CALLER_PATH}`]);
      expect(f.blocking).toBe(true);
      expect(f.message).toContain("`deploy-2` doesn't map `KANON_DEPLOY_SECRET: ${{ secrets.KANON_DEPLOY_SECRET }}`, so the deploy hook reads it empty, whatever `production` holds");
      expect(f.message).not.toContain('`deploy-1`');
      expect(f.fix.commands).toEqual(['kanon init']);
      // A constant, an empty string or another secret's name: each reaches the hook as that, not the environment's.
      for (const from of ["''", 'environment', '${{ secrets.OTHER }}']) {
        const { f: other } = await mismatch(caller().replace(MAP, `      KANON_DEPLOY_SECRET: ${from}`));
        expect(other.message, from).toContain('`deploy-1` maps `KANON_DEPLOY_SECRET` from `');
        expect(other.message, from).toContain('not `${{ secrets.KANON_DEPLOY_SECRET }}`');
      }
      // Pure: nothing asked of a caller at a release whose deploy.yml declares none.
      const old = parseYaml(text.join('\n').replaceAll(`${MAP}\n`, '')) as Record<string, unknown>;
      expect(deployCallerProblems(old, TWO, LANE.workflows)).toEqual([]);
      expect(deployCallerProblems(old, TWO, LANE.workflows, ['KANON_DEPLOY_SECRET'])).toHaveLength(2);
    });

    it('is reported for a different pinned release between jobs', async () => {
      const text = caller().split('\n');
      const at = text.findLastIndex((l) => l.includes('/deploy.yml@'));
      text[at] = text[at]!.replace(`@${PINNED}`, '@v1.0.1');
      const { r, f } = await mismatch(text.join('\n'));
      expect(f.message).toContain(`its jobs call the lane at different releases, ${PINNED} and v1.0.1`);
      expect(ids(r)).toContain('pin.mixed .github');
    });

    it('is reported for a caller with no declaration, and for a chain with no caller', async () => {
      const r = await check({ ...files([]), [DEPLOY_CALLER_PATH]: caller() });
      expect(deployIds(r)).toEqual([`deploy.caller-mismatch ${DEPLOY_CALLER_PATH}`]);
      expect(finding(r, 'deploy.caller-mismatch').message).toContain('declares no environment under ## Deploy');
      const none = await mismatch(null);
      expect(none.f.message).toContain('is missing');
      expect(none.f.blocking).toBe(true);
    });
  });

  describe('the hooks, the Releaser and CI', () => {
    it('deploy.hook-missing names a missing hook, and one lacking an input', async () => {
      const f = files();
      delete f['.github/actions/smoke/action.yml'];
      f['.github/actions/build/action.yml'] = f['.github/actions/build/action.yml']!.replace(/ {2}sha:\n.*\n.*\n/, '');
      const r = await check(f);
      expect(deployIds(r).sort()).toEqual(['deploy.hook-missing .github/actions/build/action.yml', 'deploy.hook-missing .github/actions/smoke/action.yml']);
      expect(finding(r, 'deploy.hook-missing', '.github/actions/build/action.yml').message).toContain('does not declare sha');
    });

    it('deploy.releaser-missing blocks where the release caller maps no Releaser', async () => {
      const f = files();
      f[RELEASE_CALLER] = f[RELEASE_CALLER]!.replace(/ {4}secrets:\n( {6}.*\n)+/, '');
      const r = await check(f);
      expect(deployIds(r)).toEqual([`deploy.releaser-missing ${RELEASE_CALLER}`]);
      expect(finding(r, 'deploy.releaser-missing').blocking).toBe(true);
    });

    it('deploy.ci-push-missing blocks where ci.yml on the default branch runs on no push to it, and is unchecked where it can\'t be read', async () => {
      const g = github();
      g.st.defaultWorkflows!['ci.yml'] = ciFile(PINNED, 'main').replace('  push:\n    branches: [main]\n', '');
      const r = await check(files(), g);
      expect(deployIds(r)).toEqual(['deploy.ci-push-missing .github/workflows/ci.yml']);
      const blind = github();
      blind.st.defaultWorkflows = null;
      const b = await check(files(), blind);
      expect(deployIds(b)).toEqual([]);
      expect(deployUnchecked(b)).toEqual([expect.objectContaining({ check: 'deploy-ci' })]);
    });

    it('reads a push trigger as GitHub does', () => {
      expect(runsOnPush({ on: 'push' }, 'main')).toBe(true);
      expect(runsOnPush({ on: { push: { branches: ['main'] } } }, 'main')).toBe(true);
      expect(runsOnPush({ on: { push: { branches: ['release/*'] } } }, 'main')).toBe(true);
      expect(runsOnPush({ on: { push: { branches: ['dev'] } } }, 'main')).toBe(false);
      expect(runsOnPush({ on: { push: { 'branches-ignore': ['main'] } } }, 'main')).toBe(false);
      expect(runsOnPush({ on: { push: { tags: ['v*'] } } }, 'main')).toBe(false);
      expect(runsOnPush({ on: { pull_request: null } }, 'main')).toBe(false);
    });
  });

  describe('the environments', () => {
    const envs = (over: Record<string, Env | null>) => {
      const base: Record<string, Env> = Object.fromEntries(TWO.map((e) => [e, healthyEnv(e, TWO)]));
      for (const [k, v] of Object.entries(over)) {
        if (v === null) delete base[k];
        else base[k] = { ...base[k], ...v };
      }
      return base;
    };

    it('deploy.environment-missing names each missing environment and blocks; a note under no-environments; still a block under no-reviewers', async () => {
      const r = await check(files(), github({ envs: envs({ production: null }) }));
      expect(deployIds(r)).toEqual(['deploy.environment-missing production']);
      expect(finding(r, 'deploy.environment-missing').blocking).toBe(true);
      const both = await check(files(), github({ envs: {} }));
      expect(deployIds(both)).toEqual(['deploy.environment-missing staging', 'deploy.environment-missing production']);
      const fallback = await check(files(TWO, { fallback: 'no-environments' }), github({ envs: {} }));
      const missing = fallback.json.findings.filter((f: { id: string }) => f.id === 'deploy.environment-missing');
      expect(missing.map((f: { subject: string }) => f.subject)).toEqual(TWO);
      for (const f of missing) {
        expect(f.blocking).toBe(false);
        expect(f.message).toContain('no-environments');
      }
      const reviewers = await check(files(TWO, { fallback: 'no-reviewers' }), github({ envs: envs({ production: null }) }));
      expect(finding(reviewers, 'deploy.environment-missing').blocking).toBe(true);
    });

    it('deploy.reviewers-missing reads the last environment, blocks, and is a note naming a declared fallback', async () => {
      // The first has reviewers, the last none: read from the first, it would pass.
      const r = await check(files(), github({ envs: envs({ staging: { reviewers: true }, production: { reviewers: false } }) }));
      expect(deployIds(r)).toEqual(['deploy.reviewers-missing production']);
      expect(finding(r, 'deploy.reviewers-missing').blocking).toBe(true);
      expect(FINDINGS['deploy.reviewers-missing']).toEqual({ category: 'deploy', blocking: true });
      for (const fallback of ['no-reviewers', 'no-environments']) {
        const note = await check(files(TWO, { fallback }), github({ envs: envs({ production: { reviewers: false } }) }));
        const f = finding(note, 'deploy.reviewers-missing');
        expect(f.blocking, fallback).toBe(false);
        expect(f.message).toContain(fallback);
      }
    });

    it('deploy.branch-policy blocks on an environment that admits a branch, the default branch included (#939)', async () => {
      for (const policy of ['none', 'protected', [{ name: 'main', type: 'branch' }], [{ name: 'v*', type: 'tag' }, { name: 'main', type: 'branch' }], [{ name: 'main' }]] as Env['policy'][]) {
        const r = await check(files(), github({ envs: envs({ staging: { policy } }) }));
        expect(deployIds(r), JSON.stringify(policy)).toEqual(['deploy.branch-policy staging']);
        expect(finding(r, 'deploy.branch-policy').blocking).toBe(true);
      }
      expect(finding(await check(files(), github({ envs: envs({ production: { policy: [{ name: 'main', type: 'branch' }] } }) })), 'deploy.branch-policy').message).toContain('admits the branch `main`');
    });

    it('deploy.self-review is a note, never a block, saying why prevention may stay off', async () => {
      const r = await check(files(), github({ envs: envs({ production: { selfReview: false } }) }));
      expect(deployIds(r)).toEqual(['deploy.self-review production']);
      const f = finding(r, 'deploy.self-review');
      expect(f.blocking).toBe(false);
      expect(FINDINGS['deploy.self-review']).toEqual({ category: 'deploy', blocking: false });
      expect(f.message).toMatch(/Never a block/);
      expect(r.status).toBe(EXIT.healthy);
    });

    it('deploy.admin-bypass is a note on production', async () => {
      const r = await check(files(), github({ envs: envs({ production: { adminBypass: true }, staging: { adminBypass: true } }) }));
      expect(deployIds(r)).toEqual(['deploy.admin-bypass production']);
      expect(finding(r, 'deploy.admin-bypass').blocking).toBe(false);
    });

    it('is unchecked, with its reason, where the environments can\'t be read', async () => {
      const r = await check(files(), github({ envs: null }));
      expect(deployIds(r)).toEqual([]);
      expect(deployUnchecked(r)).toEqual([{ check: 'deploy-environments', subject: REPO, reason: expect.stringContaining("can't read acme/widgets's environments") }]);
      expect(r.status).toBe(EXIT.incomplete);
    });
  });

  describe('deploy.subject-custom', () => {
    it('blocks on a custom template without context, passes one with it, and is unchecked where it can\'t be read', async () => {
      const r = await check(files(), github({ sub: { use_default: false, include_claim_keys: ['repo'] } }));
      expect(deployIds(r)).toEqual([`deploy.subject-custom ${REPO}`]);
      expect(finding(r, 'deploy.subject-custom').blocking).toBe(true);
      expect(deployIds(await check(files(), github({ sub: { use_default: false, include_claim_keys: ['repo', 'context'] } })))).toEqual([]);
      const blind = await check(files(), github({ sub: null }));
      expect(deployUnchecked(blind)).toEqual([expect.objectContaining({ check: 'deploy-subject', subject: REPO })]);
    });
  });

  describe('deploy.trust-unproven', () => {
    const unproven = (r: Result) => finding(r, 'deploy.trust-unproven');
    const bad = `${PROBE_LINE} {"staging":"refused","production":"obtained"}`;

    it('is a note before any run that counts, and a block once one printed a line that is not every environment refused', async () => {
      const before = await check(files(), github({ runs: [] }));
      expect(deployIds(before)).toEqual([`deploy.trust-unproven ${DEPLOY_CALLER_PATH}`]);
      expect(unproven(before).blocking).toBe(false);
      const after = await check(files(), github({ runs: [{ id: 701, line: bad }] }));
      expect(unproven(after).blocking).toBe(true);
      expect(unproven(after).message).toContain('production was not refused');
      expect(after.status).toBe(EXIT.findings);
    });

    it("reads a routine release run's line, and a dispatch's at a release tag", async () => {
      expect(deployIds(await check(files(), github({ runs: [{ id: 702, event: 'release' }] })))).toEqual([]);
      expect(deployIds(await check(files(), github({ runs: [{ id: 703, event: 'workflow_dispatch', branch: 'v1.0.0' }] })))).toEqual([]);
    });

    it('never counts a run from a fork, a pull_request run, a dispatch at the default branch, or a run whose commit is off it', async () => {
      for (const ignored of [{ from: 'mallory/widgets' }, { event: 'pull_request' }, { event: 'workflow_dispatch', branch: 'main' }, { event: 'workflow_dispatch', branch: 'feature' }, { onDefault: false }] as Array<Partial<DeployRun>>) {
        // The ignored run, newest, printed a perfect line; the run that counts, older, a bad one.
        const r = await check(files(), github({ runs: [{ id: 710, ...ignored }, { id: 711, line: bad }] }));
        expect(unproven(r)?.blocking, JSON.stringify(ignored)).toBe(true);
        expect(unproven(r).message).toContain('/actions/runs/711');
      }
    });

    it('must list exactly the declared environments: one missing, added since that run, or one more, is unproven', async () => {
      const missing = await check(files(), github({ runs: [{ id: 720, line: REFUSED(['staging']) }] }));
      expect(unproven(missing).blocking).toBe(true);
      expect(unproven(missing).message).toContain('production is declared and unproven, added since that run');
      const extra = await check(files(), github({ runs: [{ id: 721, line: REFUSED([...TWO, 'qa']) }] }));
      expect(unproven(extra).message).toContain('it probed qa, which the declaration no longer names');
      const silent = await check(files(), github({ runs: [{ id: 722, line: null }] }));
      expect(unproven(silent).message).toContain(`printed no ${PROBE_LINE} line`);
    });

    it('is always a note naming the fallback under no-environments, where the lane skips the probe', async () => {
      const r = await check(files(TWO, { fallback: 'no-environments' }), github({ envs: {}, runs: [{ id: 730, line: bad }] }));
      const f = unproven(r);
      expect(f.blocking).toBe(false);
      expect(f.message).toContain('no-environments');
    });

    it('is unchecked where the runs can\'t be listed', async () => {
      const r = await check(files(), github({ runs: null }));
      expect(unproven(r)).toBeUndefined();
      expect(deployUnchecked(r)).toEqual([expect.objectContaining({ check: 'deploy-runs', subject: DEPLOY_CALLER_PATH })]);
    });

    it("reads the probe's last line", () => {
      expect(probeAnswer(`x\n2026 ${PROBE_LINE} {"a":"obtained"}\n2026 ${PROBE_LINE} {"a":"refused"}\n`)).toEqual({ a: 'refused' });
      expect(probeAnswer('nothing\n')).toBeNull();
      expect(probeAnswer(`${PROBE_LINE} {not json\n`)).toBeNull();
    });
  });

  describe('deploy.artifact-retention', () => {
    it('is a note below 30 days, and unchecked where it can\'t be read', async () => {
      const r = await check(files(), github({ retention: 10 }));
      expect(deployIds(r)).toEqual([`deploy.artifact-retention ${REPO}`]);
      expect(finding(r, 'deploy.artifact-retention').blocking).toBe(false);
      expect(deployIds(await check(files(), github({ retention: 30 })))).toEqual([]);
      expect(deployUnchecked(await check(files(), github({ retention: null })))).toEqual([expect.objectContaining({ check: 'deploy-retention' })]);
    });
  });

  describe('deploy.secret-repository (kanon#1049)', () => {
    it('is a note when the repository holds KANON_DEPLOY_SECRET, which an environment without one would hand the hook', async () => {
      const g = github();
      (g.st.secrets as Set<string>).add('KANON_DEPLOY_SECRET');
      const r = await check(files(), g);
      expect(deployIds(r)).toEqual(['deploy.secret-repository KANON_DEPLOY_SECRET']);
      const f = finding(r, 'deploy.secret-repository');
      expect(f.blocking).toBe(false);
      expect(f.message).toContain('from the environment first, then the repository');
      expect(f.fix.commands).toEqual([...TWO.map((e) => `gh secret set KANON_DEPLOY_SECRET --env ${e} -R ${REPO}`), `gh secret delete KANON_DEPLOY_SECRET -R ${REPO}`]);
      expect(r.status, r.out).toBe(EXIT.healthy);
      // None without it, and none where the secrets can't be listed (the `secrets` check is unchecked).
      expect(deployIds(await check(files(), github()))).toEqual([]);
      const blind = github();
      blind.st.secrets = null;
      expect(deployIds(await check(files(), blind))).toEqual([]);
    });
  });

  describe('deploy.secret-organization (kanon#1051)', () => {
    const ORG_PATH = 'organization-secrets';
    const orgCalls = (g: ReturnType<typeof github>) => g.paths.filter((p) => p.includes(ORG_PATH));

    it('is a note when an organisation secret named KANON_DEPLOY_SECRET is shared with the repository, which an environment without one would hand the hook', async () => {
      const r = await check(files(), github({ owner: 'Organization', org: new Set(['KANON_DEPLOY_SECRET']) }));
      expect(deployIds(r)).toEqual(['deploy.secret-organization KANON_DEPLOY_SECRET']);
      const f = finding(r, 'deploy.secret-organization');
      expect(f.blocking).toBe(false);
      expect(f.message).toContain('from the environment first, then the repository, then the organisation');
      expect(f.message).toContain('every repository it is shared with');
      expect(f.fix.commands).toEqual(TWO.map((e) => `gh secret set KANON_DEPLOY_SECRET --env ${e} -R ${REPO}`));
      expect(f.fix.text).toContain(`stop sharing acme's KANON_DEPLOY_SECRET with ${REPO}`);
      expect(f.fix.url).toBe('https://github.com/organizations/acme/settings/secrets/actions');
      expect(deployUnchecked(r)).toEqual([]);
      expect(r.status, r.out).toBe(EXIT.healthy);
    });

    it('says nothing where the organisation shares no secret of that name, and never asks on a personal account', async () => {
      expect(deployIds(await check(files(), github({ owner: 'Organization', org: new Set(['OTHER']) })))).toEqual([]);
      const user = github({ org: new Set(['KANON_DEPLOY_SECRET']) });
      expect(deployIds(await check(files(), user))).toEqual([]);
      expect(orgCalls(user)).toEqual([]);
      // Nor without a deploy caller, which maps no deploy hook's secret.
      const none = github({ owner: 'Organization', org: new Set(['KANON_DEPLOY_SECRET']) });
      expect(deployIds(await check(files([], { caller: null }), none)).filter((x: string) => x.startsWith('deploy.secret-'))).toEqual([]);
      expect(orgCalls(none)).toEqual([]);
    });

    it("is unchecked, never a finding, where the token can't list the organisation's secrets", async () => {
      const r = await check(files(), github({ owner: 'Organization', org: null }));
      expect(deployIds(r)).toEqual([]);
      expect(deployUnchecked(r)).toEqual([{ check: 'deploy-secrets', subject: 'KANON_DEPLOY_SECRET', reason: expect.stringContaining('an organisation secret of acme shared with it') }]);
      expect(r.status).toBe(EXIT.incomplete);
    });

    it('stands beside deploy.secret-repository, whose fix deletes the repository secret that hides the organisation one', async () => {
      const g = github({ owner: 'Organization', org: new Set(['KANON_DEPLOY_SECRET']) });
      (g.st.secrets as Set<string>).add('KANON_DEPLOY_SECRET');
      const r = await check(files(), g);
      expect(deployIds(r)).toEqual(['deploy.secret-repository KANON_DEPLOY_SECRET', 'deploy.secret-organization KANON_DEPLOY_SECRET']);
      expect(orgCalls(g)).toHaveLength(1);
    });

    it("lists the organisation's secrets once, for notify.kind-unset and this check alike", async () => {
      // With a notify hook, notify.kind-unset asks for the organisation's secrets too, since the
      // repository lacks KANON_CHAT_DEPLOY: the two checks share the one listing.
      const f = files();
      f[NOTIFY_HOOK] = readFileSync(join(ROOT, 'actions/notify/hooks/slack.yml'), 'utf8').replace(/@(?:candidate-)?v\d+\.\d+\.\d+/, `@${PINNED}`);
      const g = github({ owner: 'Organization', org: new Set(['KANON_DEPLOY_SECRET']) });
      const r = await check(f, g);
      expect(ids(r)).toEqual(expect.arrayContaining([`notify.kind-unset ${DEPLOY_CALLER_PATH}`, 'deploy.secret-organization KANON_DEPLOY_SECRET']));
      expect(orgCalls(g)).toHaveLength(1);
    });
  });

  describe('deploy.tag-ruleset', () => {
    const tagFinding = (r: Result) => finding(r, 'deploy.tag-ruleset');

    it('passes only a ruleset restricting creation, update and deletion, never a creation-only one', async () => {
      expect(restrictsTags({ target: 'tag', enforcement: 'active', rules: [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }] })).toBe(true);
      expect(restrictsTags({ target: 'tag', enforcement: 'active', rules: [{ type: 'creation' }] })).toBe(false);
      expect(restrictsTags({ target: 'tag', enforcement: 'evaluate', rules: [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }] })).toBe(false);
      const creationOnly = await check(files(), github({ tagRules: [['creation']] }));
      expect(deployIds(creationOnly)).toEqual([`deploy.tag-ruleset ${REPO}`]);
      expect(deployIds(await check(files(), github({ tagRules: [] })))).toEqual([`deploy.tag-ruleset ${REPO}`]);
    });

    it('is a note with no marker, blocks under no-reviewers, and is a note naming the open tag path under no-environments', async () => {
      const plain = await check(files(), github({ tagRules: [] }));
      expect(tagFinding(plain).blocking).toBe(false);
      expect(plain.status).toBe(EXIT.healthy);
      const reviewers = await check(files(TWO, { fallback: 'no-reviewers' }), github({ tagRules: [], envs: { staging: healthyEnv('staging', TWO), production: { ...healthyEnv('production', TWO), reviewers: false } } }));
      expect(tagFinding(reviewers).blocking).toBe(true);
      expect(reviewers.status).toBe(EXIT.findings);
      const environments = await check(files(TWO, { fallback: 'no-environments' }), github({ tagRules: [], envs: {} }));
      expect(tagFinding(environments).blocking).toBe(false);
      expect(tagFinding(environments).message).toContain('the tag path stays open');
    });

    it("can't be waived under no-reviewers, and is waived like any note elsewhere", async () => {
      const waiver = `- **${WAIVER_LABEL}:** \`deploy.tag-ruleset\` on \`${REPO}\` (a person creates every tag)\n`;
      const reviewers = await check(files(TWO, { fallback: 'no-reviewers', extra: waiver }), github({ tagRules: [], envs: { staging: healthyEnv('staging', TWO), production: { ...healthyEnv('production', TWO), reviewers: false } } }));
      expect(tagFinding(reviewers).blocking).toBe(true);
      expect(reviewers.json.waived).toEqual([]);
      expect(finding(reviewers, 'declaration.malformed').message).toContain("can't be waived under the `no-reviewers` fallback");
      const plain = await check(files(TWO, { extra: waiver }), github({ tagRules: [] }));
      expect(tagFinding(plain)).toBeUndefined();
      expect(plain.json.waived.map((w: { id: string }) => w.id)).toEqual(['deploy.tag-ruleset']);
      expect(UNWAIVABLE_UNDER['deploy.tag-ruleset']).toMatchObject({ fallback: 'no-reviewers' });
    });
  });

  describe('deploy.reference-undeclared with a chain', () => {
    it("notes a reference that names another job than the caller's, as doctor can't tell deliberate from stale", async () => {
      const f = files();
      f[RECORD] = f[RECORD]!.replace('`staging / deploy`', '`ship`');
      const r = await check(f);
      expect(deployIds(r)).toEqual([`deploy.reference-undeclared ${RECORD}`]);
      expect(finding(r, 'deploy.reference-undeclared').blocking).toBe(false);
      expect(finding(r, 'deploy.reference-undeclared').fix.commands).toContain('- **Reference deploy job:** `staging / deploy`');
    });
  });

  it('holds the ids, their blocking and what no waiver waives to §12', () => {
    expect(Object.entries(FINDINGS).filter(([id]) => id.startsWith('deploy.')).map(([id, f]) => [id, f.blocking]).sort()).toEqual([
      ['deploy.admin-bypass', false], ['deploy.artifact-retention', false], ['deploy.branch-policy', true], ['deploy.caller-mismatch', true],
      ['deploy.ci-push-missing', true], ['deploy.declaration', true], ['deploy.declaration-moved', true], ['deploy.environment-missing', true],
      ['deploy.hook-missing', true], ['deploy.reference-undeclared', false], ['deploy.releaser-missing', true], ['deploy.reviewers-missing', true],
      ['deploy.secret-organization', false], ['deploy.secret-repository', false], ['deploy.self-review', false], ['deploy.subject-custom', true], ['deploy.tag-ruleset', false], ['deploy.trust-unproven', true],
    ]);
    expect(Object.keys(UNWAIVABLE).filter((id) => id.startsWith('deploy.')).sort()).toEqual([
      'deploy.caller-mismatch', 'deploy.declaration', 'deploy.declaration-moved', 'deploy.environment-missing', 'deploy.reviewers-missing', 'deploy.subject-custom',
    ]);
  });
});
