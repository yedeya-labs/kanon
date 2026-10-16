import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { callerFile } from '../../cli/callers.mjs';
import { DEPLOY_CALLER_PATH, deployCallerFile } from '../../cli/init.mjs';
import { EXIT, FINDINGS, NOTIFY_HOOK, NOTIFY_LINE, PACKAGE_INSTALL, pinnedUses, runPaths } from '../../cli/doctor.mjs';
import { checkout, clone, fakeGitHub, healthyFiles, ids, LANES, no, NEXT, ok, PINNED, REPO, REQ, ROOT, run, type Req, type Result } from './helpers/doctor.js';
import { SPAWNS } from './helpers/spawns.js';

/**
 * `kanon doctor` on chat notifications (plan 0011 §9, step N10): the hook at
 * `.github/actions/notify/action.yml`, each message kind's secret, the secret they replace, and
 * the last post, for the callers of the lanes that notify at the checked release.
 *
 * The checked release here is NEXT, a copy of this tree's requirements in which the project digest
 * notifies, as N7 made it: its lane takes `KANON_CHAT_PROJECT_DIGEST` and no longer
 * `DIGEST_WEBHOOK`. This tree is past N7 too, so NEXT is this tree's requirements as they are; a
 * release before N7 is `beforeN7`. The fixtures are helpers/doctor.ts's.
 */
vi.setConfig({ testTimeout: SPAWNS.timeout });

const LANE = 'agent-project-digest';
const CALLER = `.github/workflows/${LANE}.yml`;
const SECRET = 'KANON_CHAT_PROJECT_DIGEST';
const LEGACY = 'DIGEST_WEBHOOK';
type Notify = { hook: { path: string; inputs: string[] }; versions: number[]; kinds: Record<string, { secret: string; lanes: string[] }>; legacySecret: string; prebuilt: Record<string, { action: string; hook: string }> };
const notifyOf = (r: Req) => (r as unknown as { notify: Notify }).notify;

/** NEXT's requirements: the project digest notifies, as plan 0011's N7 makes it. */
const nextReq = (tweak: (n: Notify) => void = () => {}) => {
  const next = clone(REQ);
  const lane = next.lanes[LANE]!;
  lane.secrets = [...new Set([...lane.secrets.filter((n) => n !== LEGACY), SECRET])].sort();
  notifyOf(next).kinds['project-digest']!.lanes = [LANE];
  tweak(notifyOf(next));
  return next;
};

/** A release before plan 0011's N7: the notify entry, and no lane in it; the project digest takes `DIGEST_WEBHOOK`. */
const beforeN7 = () => {
  const old = clone(REQ);
  const lane = old.lanes[LANE]!;
  lane.secrets = [...new Set([...lane.secrets.filter((n) => n !== SECRET), LEGACY])].sort();
  for (const k of Object.values(notifyOf(old).kinds)) k.lanes = [];
  return old;
};

/** Kanon's prebuilt hook, as `kanon init` writes it, at `ref`. */
const prebuilt = (name: 'slack' | 'webhook', ref = PINNED) =>
  readFileSync(join(ROOT, `actions/notify/hooks/${name}.yml`), 'utf8').replace(/@v\d+\.\d+\.\d+/, `@${ref}`);

/** An adopter's own hook, with these steps. */
const ownHook = (steps: string[], o: { using?: string; inputs?: string[] } = {}) => [
  'name: notify',
  'inputs:',
  ...(o.inputs ?? ['message-v1', 'text', 'kind', 'secret']).map((k) => `  ${k}:\n    required: true`),
  'runs:',
  `  using: ${o.using ?? 'composite'}`,
  '  steps:',
  ...steps,
  '',
].join('\n');

/** The installation: the healthy one, the project digest's caller mapping `mapped`, and the hook. */
const files = (o: { hook?: string | null; mapped?: string[]; extra?: Record<string, string> } = {}) => {
  const f = healthyFiles();
  const lane = { ...REQ.lanes[LANE]!, secrets: o.mapped ?? ['CLAUDE_CODE_OAUTH_TOKEN', SECRET] };
  f[CALLER] = callerFile(LANE, lane, { release: PINNED, ciName: 'CI', defaultBranch: 'main' });
  if (o.hook !== null) f[NOTIFY_HOOK] = o.hook ?? prebuilt('slack');
  return { ...f, ...o.extra };
};

type RunOf = { id: number; branch?: string; status?: string; from?: string; job?: string; conclusion?: string; line?: string | null };
/** A run of the deploy caller: a `release` run at v1.0.0, on a commit of main, unless it says otherwise; each job's log has its line. */
type DeployRunOf = { id: number; event?: string; branch?: string; from?: string; onDefault?: boolean; jobs: Array<{ name: string; conclusion?: string; line?: string | null }> };
/**
 * A fake GitHub with the repository's secrets, the caller's completed runs (newest first), each
 * with its notify job's log, and the organisation secrets shared with the repository (null: the
 * token can't list them). Its run listing ignores the filters, as a server that did would, so
 * doctor's own check of each run is what refuses one from another branch or repository. The
 * deploy caller's runs are `deployRuns`, with the repository's releases' tags `tags`.
 */
const github = (o: { secrets?: Set<string> | null; runs?: RunOf[]; org?: Set<string> | null; owner?: 'User' | 'Organization'; runsRefused?: boolean; deployRuns?: DeployRunOf[]; tags?: string[] } = {}) => {
  const g = fakeGitHub({ secrets: o.secrets === undefined ? new Set([...LANES.flatMap((l) => REQ.lanes[l]!.secrets), 'CLAUDE_CODE_OAUTH_TOKEN', SECRET]) : o.secrets, releases: { [NEXT]: nextReq() } });
  g.st.ownerType = o.owner ?? 'User';
  const runs = o.runs ?? [{ id: 501, line: `${NOTIFY_LINE} {"hook":"slack","kind":"project-digest","outcome":"posted"}` }];
  for (const r of runs) {
    g.st.runJobs[r.id] = [{ id: r.id * 10, name: 'digest / gate', conclusion: 'success' }, { id: r.id * 10 + 1, name: r.job ?? `digest / notify`, conclusion: r.conclusion ?? 'success' }];
    g.st.appsCheck.logs[r.id * 10 + 1] = r.line === null ? '2026-10-14T07:00:01Z posting\n' : `2026-10-14T07:00:01Z posting\n2026-10-14T07:00:02Z ${r.line ?? ''}\n`;
  }
  const deployRuns = o.deployRuns ?? [];
  for (const r of deployRuns) {
    g.st.runJobs[r.id] = r.jobs.map((j, i) => ({ id: r.id * 10 + i, name: j.name, conclusion: j.conclusion ?? 'success' }));
    r.jobs.forEach((j, i) => { g.st.appsCheck.logs[r.id * 10 + i] = j.line === null ? '2026-10-15T07:00:01Z posting\n' : `2026-10-15T07:00:01Z posting\n2026-10-15T07:00:02Z ${j.line ?? ''}\n`; });
  }
  const tags = new Set(o.tags ?? ['v1.0.0']);
  const inner = g.gh;
  const calls: string[] = [];
  g.gh = async (args: string[], input?: string) => {
    const path = args.find((x) => x.startsWith('repos/')) ?? '';
    calls.push(path);
    if (path.startsWith(`repos/${REPO}/actions/workflows/${LANE}.yml/runs?`)) {
      if (o.runsRefused) return no('gh: Resource not accessible by personal access token (HTTP 403)');
      return ok({ workflow_runs: runs.map((r) => ({ id: r.id, status: r.status ?? 'completed', head_branch: r.branch ?? 'main', head_repository: { full_name: r.from ?? REPO }, html_url: `https://github.com/${REPO}/actions/runs/${r.id}`, created_at: '2026-10-14T07:00:00Z' })) });
    }
    if (path.startsWith(`repos/${REPO}/actions/workflows/deploy.yml/runs?`)) {
      return ok({ workflow_runs: deployRuns.map((r) => ({ id: r.id, status: 'completed', event: r.event ?? 'release', head_branch: r.branch ?? 'v1.0.0', head_sha: `sha${r.id}`, head_repository: { full_name: r.from ?? REPO }, html_url: `https://github.com/${REPO}/actions/runs/${r.id}`, created_at: '2026-10-15T07:00:00Z' })) });
    }
    const tag = new RegExp(`^repos/${REPO}/releases/tags/(.+)$`).exec(path);
    if (tag) return tags.has(decodeURIComponent(tag[1]!)) ? ok({ tag_name: decodeURIComponent(tag[1]!) }) : no('gh: Not Found (HTTP 404)');
    const compare = new RegExp(`^repos/${REPO}/compare/sha(\\d+)\\.\\.\\.main$`).exec(path);
    if (compare) return ok({ status: 'ahead', ahead_by: 1, behind_by: deployRuns.find((r) => r.id === Number(compare[1]))?.onDefault === false ? 3 : 0 });
    if (path === `repos/${REPO}/actions/organization-secrets?per_page=100`) return o.org ? ok({ total_count: o.org.size, secrets: [...o.org].map((name) => ({ name })) }) : no('gh: Resource not accessible by personal access token (HTTP 403)');
    return inner(args, input);
  };
  return Object.assign(g, { paths: calls });
};

const check = async (f: Record<string, string>, g = github(), req = nextReq()) => {
  g.st.releases[NEXT] = req;
  return run(checkout(f), g, ['--to', NEXT, '--json']);
};
const notifyIds = (r: Result) => ids(r).filter((x: string) => x.startsWith('notify.'));
const finding = (r: Result, id: string) => r.json.findings.find((f: { id: string }) => f.id === id);
const notifyUnchecked = (r: Result) => r.json.unchecked.filter((u: { check: string }) => u.check.startsWith('notify-'));

describe('kanon doctor on chat notifications (plan 0011 §9)', () => {
  it('finds nothing on a healthy installation: Kanon\'s Slack hook at the callers\' pin, the kind\'s secret held, the last post posted (the mutations\' baseline)', async () => {
    const r = await check(files());
    expect(ids(r)).toEqual([]);
    expect(notifyUnchecked(r)).toEqual([]);
    expect(r.status).toBe(EXIT.healthy);
  });

  it('asks nothing where the checked release has no lane that notifies, as a release before N7', async () => {
    // This tree notifies since N7 and N8, from both digests; a release before them has the entry, and no lane in it.
    expect(Object.values(notifyOf(REQ).kinds).flatMap((k) => k.lanes)).toEqual([LANE, 'agent-weekly-digest', 'deploy']);
    const f = files({ hook: null, mapped: ['CLAUDE_CODE_OAUTH_TOKEN', LEGACY] });
    const r = await check(f, github({ secrets: new Set([...LANES.flatMap((l) => REQ.lanes[l]!.secrets), LEGACY]) }), beforeN7());
    expect(notifyIds(r)).toEqual([]);
    // A release without the entry at all, as every release before N10.
    const old = nextReq();
    delete (old as unknown as { notify?: Notify }).notify;
    expect(notifyIds(await check(files({ hook: null }), github(), old))).toEqual([]);
  });

  describe('notify.none', () => {
    it('is a note, never blocking, naming what is skipped, what still runs, and how to write each prebuilt hook', async () => {
      const r = await check(files({ hook: null }));
      expect(notifyIds(r)).toEqual([`notify.none ${NOTIFY_HOOK}`]);
      const f = finding(r, 'notify.none');
      expect(f.blocking).toBe(false);
      expect(FINDINGS['notify.none']).toEqual({ category: 'declaration', blocking: false });
      expect(r.status).toBe(EXIT.healthy);
      expect(f.message).toContain(`${CALLER} calls ${LANE}`);
      expect(f.message).toContain('health job');
      expect(f.fix.commands).toEqual([
        'mkdir -p .github/actions/notify',
        `gh api -H 'Accept: application/vnd.github.raw+json' 'repos/yedeya-labs/kanon/contents/actions/notify/hooks/slack.yml?ref=${NEXT}' > ${NOTIFY_HOOK}`,
        `gh api -H 'Accept: application/vnd.github.raw+json' 'repos/yedeya-labs/kanon/contents/actions/notify/hooks/webhook.yml?ref=${NEXT}' > ${NOTIFY_HOOK}`,
      ]);
      expect(f.fix.text).toMatch(/your own composite action/);
    });

    it('is not joined by notify.kind-unset: with no hook nothing posts whatever the secrets', async () => {
      const r = await check(files({ hook: null }), github({ secrets: new Set(LANES.flatMap((l) => REQ.lanes[l]!.secrets)) }));
      expect(notifyIds(r)).toEqual([`notify.none ${NOTIFY_HOOK}`]);
    });
  });

  describe('notify.kind-unset', () => {
    const without = () => new Set([...LANES.flatMap((l) => REQ.lanes[l]!.secrets), 'CLAUDE_CODE_OAUTH_TOKEN']);

    it('is a note naming the kind and its gh secret set line, never secret.missing', async () => {
      const r = await check(files(), github({ secrets: without() }));
      expect(ids(r)).toEqual([`notify.kind-unset ${CALLER}`]);
      const f = finding(r, 'notify.kind-unset');
      expect(f.blocking).toBe(false);
      expect(f.message).toContain('project-digest');
      expect(f.message).toContain(SECRET);
      expect(f.fix.commands).toEqual([`gh secret set ${SECRET} -R ${REPO}`]);
      expect(r.status).toBe(EXIT.healthy);
    });

    it('counts an organisation secret shared with the repository, and is unchecked, not a finding, where the token can\'t list those', async () => {
      expect(notifyIds(await check(files(), github({ secrets: without(), owner: 'Organization', org: new Set([SECRET]) })))).toEqual([]);
      expect(notifyIds(await check(files(), github({ secrets: without(), owner: 'Organization', org: new Set(['OTHER']) })))).toEqual([`notify.kind-unset ${CALLER}`]);
      const blind = await check(files(), github({ secrets: without(), owner: 'Organization', org: null }));
      expect(notifyIds(blind)).toEqual([]);
      expect(notifyUnchecked(blind)).toEqual([{ check: 'notify-secrets', subject: CALLER, reason: expect.stringContaining('an organisation secret of acme shared with it could') }]);
      expect(blind.status).toBe(EXIT.incomplete);
      // A personal account has no organisation secrets: doctor doesn't ask for them.
      const user = github({ secrets: without(), org: null });
      await check(files(), user);
      expect(user.paths.filter((p) => p.includes('organization-secrets'))).toEqual([]);
    });

    it('is unchecked where the token can\'t list the repository\'s secrets', async () => {
      const r = await check(files(), github({ secrets: null }));
      expect(notifyIds(r)).toEqual([]);
      expect(notifyUnchecked(r)).toEqual([expect.objectContaining({ check: 'notify-secrets', subject: CALLER })]);
    });
  });

  it('never reports a chat secret a workflow maps and the repository lacks as secret.missing, a kind\'s or DIGEST_WEBHOOK', async () => {
    const other = ['name: Post', 'on: push', 'permissions: {}', 'jobs:', '  post:', '    runs-on: ubuntu-latest', '    env:',
      `      A: \${{ secrets.${LEGACY} }}`, '      B: ${{ secrets.KANON_CHAT_WEEKLY_DIGEST }}', `      C: \${{ secrets.${SECRET} }}`, '    steps:', '      - run: "true"', ''].join('\n');
    const secrets = new Set([...LANES.flatMap((l) => REQ.lanes[l]!.secrets), 'CLAUDE_CODE_OAUTH_TOKEN']);
    const r = await check(files({ extra: { '.github/workflows/post.yml': other } }), github({ secrets }));
    expect(ids(r).filter((x: string) => x.startsWith('secret.'))).toEqual([]);
    // Against this tree's release too, whose digest lanes still take DIGEST_WEBHOOK.
    const legacy = files({ mapped: ['CLAUDE_CODE_OAUTH_TOKEN', LEGACY], extra: { '.github/workflows/post.yml': other } });
    const now = await run(checkout(legacy), github({ secrets }), ['--json']);
    expect(ids(now).filter((x: string) => x.startsWith('secret.'))).toEqual([]);
  });

  describe('notify.legacy-secret', () => {
    it('blocks on a notifying caller that still maps DIGEST_WEBHOOK, in place of caller.secret-stale for it, with the notify fix', async () => {
      const r = await check(files({ mapped: ['CLAUDE_CODE_OAUTH_TOKEN', LEGACY] }));
      expect(ids(r)).toEqual([`notify.legacy-secret ${CALLER}`, `caller.secret-missing ${CALLER}`]);
      const f = finding(r, 'notify.legacy-secret');
      expect(f.blocking).toBe(true);
      expect(r.status).toBe(EXIT.findings);
      expect(f.message).toContain(LEGACY);
      expect(f.message).toMatch(/doesn't start at all until the line goes, health job included/);
      expect(f.fix.commands).toEqual([`      ${LEGACY}: \${{ secrets.${LEGACY} }}`, `      ${SECRET}: \${{ secrets.${SECRET} }}`, `gh secret set ${SECRET} -R ${REPO}`]);
      expect(f.fix.text).toMatch(/add a hook/);
    });

    it('leaves another stale secret of the same caller to caller.secret-stale, and a caller of a lane that doesn\'t notify to it alone', async () => {
      const both = await check(files({ mapped: ['CLAUDE_CODE_OAUTH_TOKEN', SECRET, LEGACY, 'OTHER_SECRET'] }));
      expect(ids(both)).toEqual([`notify.legacy-secret ${CALLER}`, `caller.secret-stale ${CALLER}`]);
      expect(finding(both, 'caller.secret-stale').fix.commands).toEqual(['      OTHER_SECRET: ${{ secrets.OTHER_SECRET }}']);
      // The review lane notifies nothing: DIGEST_WEBHOOK there is an ordinary stale line.
      const f = files();
      f['.github/workflows/agent-review.yml'] = f['.github/workflows/agent-review.yml']!.replace(/^( {4}secrets:\n)/m, `$1      ${LEGACY}: \${{ secrets.${LEGACY} }}\n`);
      const review = await check(f);
      expect(ids(review)).toEqual(['caller.secret-stale .github/workflows/agent-review.yml']);
    });

    it('is not reported while the lane still declares DIGEST_WEBHOOK', async () => {
      const r = await check(files({ mapped: ['CLAUDE_CODE_OAUTH_TOKEN', SECRET, LEGACY] }), github(), nextReq());
      expect(notifyIds(r)).toContain(`notify.legacy-secret ${CALLER}`);
      const keeps = nextReq();
      keeps.lanes[LANE]!.secrets = [...keeps.lanes[LANE]!.secrets, LEGACY].sort();
      expect(notifyIds(await check(files({ mapped: ['CLAUDE_CODE_OAUTH_TOKEN', SECRET, LEGACY] }), github(), keeps))).toEqual([]);
    });
  });

  describe('notify.hook-malformed and notify.hook-version-old', () => {
    const post = ['    - shell: bash', '      run: echo posted'];
    for (const [what, hook] of [
      ['not a composite action', ownHook(post, { using: 'node20' })],
      ['declares no version the release writes', ownHook(post, { inputs: ['message-v9', 'text', 'kind', 'secret'] })],
      ['declares no secret', ownHook(post, { inputs: ['message-v1', 'text', 'kind'] })],
      ['can\'t be read as YAML', 'runs: [\n'],
    ] as const) {
      it(`blocks on a hook that ${what}`, async () => {
        const r = await check(files({ hook }));
        expect(notifyIds(r)).toEqual([`notify.hook-malformed ${NOTIFY_HOOK}`]);
        expect(finding(r, 'notify.hook-malformed').blocking).toBe(true);
        expect(r.status).toBe(EXIT.findings);
      });
    }

    it('accepts an own hook that declares the inputs (the baseline)', async () => {
      expect(notifyIds(await check(files({ hook: ownHook(post) })))).toEqual([]);
    });

    it('notes a hook on a version the release writes, but not its newest, and is quiet once it declares the newest', async () => {
      const two = nextReq((n) => { n.versions = [1, 2]; });
      const r = await check(files({ hook: ownHook(post) }), github(), two);
      expect(notifyIds(r)).toEqual([`notify.hook-version-old ${NOTIFY_HOOK}`]);
      expect(finding(r, 'notify.hook-version-old').blocking).toBe(false);
      expect(finding(r, 'notify.hook-version-old').fix.commands).toEqual(['  message-v2:', '    required: true']);
      expect(notifyIds(await check(files({ hook: ownHook(post, { inputs: ['message-v1', 'message-v2', 'text', 'kind', 'secret'] }) }), github(), two))).toEqual([]);
    });
  });

  describe('notify.hook-unpinned (K-ADOPT-12)', () => {
    const SHA = 'a'.repeat(40);
    const DIGEST = `sha256:${'b'.repeat(64)}`;
    for (const uses of ['acme/teams-notify@main', 'acme/teams-notify', 'docker://ghcr.io/acme/notifier:latest', 'docker://ghcr.io/acme/notifier']) {
      it(`blocks on \`${uses}\``, async () => {
        const r = await check(files({ hook: ownHook([`    - uses: ${uses}`]) }));
        expect(notifyIds(r)).toEqual([`notify.hook-unpinned ${NOTIFY_HOOK}`]);
        expect(finding(r, 'notify.hook-unpinned').message).toContain(`\`${uses}\``);
        expect(finding(r, 'notify.hook-unpinned').blocking).toBe(true);
      });
    }
    it('accepts a version tag, a full commit SHA and an image by digest', async () => {
      const r = await check(files({ hook: ownHook([`    - uses: acme/teams-notify@v2.1.0`, `    - uses: acme/teams-notify@${SHA}`, `    - uses: docker://ghcr.io/acme/notifier@${DIGEST}`, '    - uses: acme/teams-notify@v4']) }));
      expect(notifyIds(r)).toEqual([]);
    });
    it('reads a ref as K-ADOPT-12 does', () => {
      expect(['a/b@v1', 'a/b@v1.2.3', 'a/b@1.2', `a/b/c@${SHA}`, `docker://x/y@${DIGEST}`, `docker://x/y:1@${DIGEST}`, './.github/actions/notify/post', 'yedeya-labs/kanon/actions/notify/slack@candidate-v0.40.0'].map(pinnedUses)).toEqual(Array(8).fill(true));
      expect(pinnedUses('a/b@candidate-main')).toBe(false);
      expect(['a/b@main', 'a/b@release/v1', 'a/b', `a/b@${SHA.slice(1)}`, 'docker://x/y:1', 'docker://x/y@sha256:abc'].map(pinnedUses)).toEqual(Array(6).fill(false));
    });
  });

  describe('notify.hook-unreviewed (K-MERGE-4)', () => {
    const SCRIPT = 'scripts/post.mjs';
    const pipeline = (entry: string) => `# Escalation\n\n## Pipeline code\n\n- \`${entry}\` — the notify hook's script\n`;

    it('blocks on a run: of a repository script neither under .github/ nor declared pipeline code, and names the bullet to declare it', async () => {
      const r = await check(files({ hook: ownHook(['    - shell: bash', `      run: node ${SCRIPT} "$TEXT"`]), extra: { [SCRIPT]: 'console.log(1)\n' } }));
      expect(notifyIds(r)).toEqual([`notify.hook-unreviewed ${NOTIFY_HOOK}`]);
      const f = finding(r, 'notify.hook-unreviewed');
      expect(f.blocking).toBe(true);
      expect(f.message).toContain(`\`${SCRIPT}\``);
      expect(f.fix.commands).toEqual([`- \`${SCRIPT}\` — the notify hook runs it`]);
    });

    it('accepts it once declared under ## Pipeline code, as a file or under a directory', async () => {
      const hook = ownHook(['    - shell: bash', `      run: node ./${SCRIPT}`]);
      for (const entry of [SCRIPT, 'scripts/']) {
        expect(notifyIds(await check(files({ hook, extra: { [SCRIPT]: 'x\n', 'docs/qa/escalation-paths.md': pipeline(entry) } })))).toEqual([]);
      }
      // A neighbour of the declared file is not it (#728).
      expect(notifyIds(await check(files({ hook, extra: { [SCRIPT]: 'x\n', 'docs/qa/escalation-paths.md': pipeline('scripts/post.mjs.bak') } })))).toEqual([`notify.hook-unreviewed ${NOTIFY_HOOK}`]);
    });

    it('accepts a script under .github/, by its path or the hook\'s own directory, and a word that names no file', async () => {
      const r = await check(files({
        hook: ownHook(['    - shell: bash', '      run: |', '        node .github/actions/notify/post.mjs', '        node "$GITHUB_ACTION_PATH/post.mjs"', "        curl -H 'Content-Type: application/json' --data @body.json \"$URL\""]),
        extra: { '.github/actions/notify/post.mjs': 'x\n' },
      }));
      expect(notifyIds(r)).toEqual([]);
    });

    it('blocks on a local action outside .github/', async () => {
      const r = await check(files({ hook: ownHook(['    - uses: ./tools/notify']), extra: { 'tools/notify/action.yml': 'name: x\nruns:\n  using: composite\n  steps: []\n' } }));
      expect(notifyIds(r)).toEqual([`notify.hook-unreviewed ${NOTIFY_HOOK}`]);
      expect(finding(r, 'notify.hook-unreviewed').fix.commands).toEqual(['- `tools/notify/` — the notify hook runs it']);
    });

    for (const install of ['npm ci', 'npm install', 'pip install -r requirements.txt', 'go mod download', 'yarn', 'pnpm install']) {
      it(`blocks on a run: that installs packages, \`${install}\``, async () => {
        const r = await check(files({ hook: ownHook(['    - shell: bash', `      run: ${install}`]) }));
        expect(notifyIds(r)).toEqual([`notify.hook-unreviewed ${NOTIFY_HOOK}`]);
        expect(finding(r, 'notify.hook-unreviewed').message).toMatch(/installs packages/);
      });
    }

    it('reads installs and paths as the plan says, and no more', () => {
      expect(['npm run post', 'yarn run post', 'echo npm ci is not run here'.replace('npm ci', 'npm-ci'), 'node post.mjs'].map((r) => PACKAGE_INSTALL.test(r))).toEqual([false, false, false, false]);
      expect(['npm i', 'cd x && npm ci', 'python -m pip install x', 'cargo install y'].map((r) => PACKAGE_INSTALL.test(r))).toEqual([true, true, true, true]);
      const exists = (p: string) => ['scripts/post.mjs', 'scripts', 'body.json'].includes(p);
      expect(runPaths('node ./scripts/post.mjs --x=scripts/ ; cat /etc/passwd https://x/y $HOME/z application/json body.json', exists)).toEqual(['scripts/post.mjs', 'scripts', 'body.json']);
      expect(runPaths('node ${{ github.workspace }}/scripts/post.mjs', exists)).toEqual(['scripts/post.mjs']);
    });
  });

  describe('notify.hook-pin-behind (decision 18)', () => {
    it('notes a prebuilt hook pinned below the callers, without blocking and without pin.mixed', async () => {
      const r = await check(files({ hook: prebuilt('webhook', 'v0.9.0') }));
      expect(ids(r)).toEqual([`notify.hook-pin-behind ${NOTIFY_HOOK}`]);
      const f = finding(r, 'notify.hook-pin-behind');
      expect(f.blocking).toBe(false);
      expect(f.message).toContain('at v0.9.0');
      expect(f.message).toContain(`the callers pin ${PINNED}: it is behind them`);
      expect(f.fix.commands).toEqual([`    - uses: yedeya-labs/kanon/actions/notify/webhook@${PINNED}`]);
      expect(r.status).toBe(EXIT.healthy);
      expect(r.json.releases.pins).toEqual([PINNED]);
    });

    it('accepts its own fix at a candidate pin: a hook at the callers\' candidate-vX.Y.Z is neither behind nor unpinned (K-ADOPT-12)', async () => {
      const CANDIDATE = 'candidate-v1.0.0';
      const f = files({ hook: prebuilt('slack', CANDIDATE) });
      for (const p of Object.keys(f).filter((x) => x.startsWith('.github/workflows/'))) f[p] = f[p]!.replaceAll(`@${PINNED}`, `@${CANDIDATE}`);
      const g = github();
      g.st.releases[CANDIDATE] = REQ;
      g.st.releases[NEXT] = nextReq();
      const r = await run(checkout(f), g, ['--to', NEXT, '--json']);
      expect(r.json.releases.pinned).toBe(CANDIDATE);
      expect(notifyIds(r)).toEqual([]);
      // Behind the candidate, the fix names it, and following the fix leaves nothing.
      const behind = { ...f, [NOTIFY_HOOK]: prebuilt('slack', 'v0.9.0') };
      const before = await run(checkout(behind), g, ['--to', NEXT, '--json']);
      expect(notifyIds(before)).toEqual([`notify.hook-pin-behind ${NOTIFY_HOOK}`]);
      expect(finding(before, 'notify.hook-pin-behind').fix.commands).toEqual([`    - uses: yedeya-labs/kanon/actions/notify/slack@${CANDIDATE}`]);
    });

    it('blocks on a prebuilt hook pinned ahead of the callers, as lane-check fails it (#958), with the callers\' pin as its fix', async () => {
      const r = await check(files({ hook: prebuilt('slack', 'v1.2.4') }));
      expect(notifyIds(r)).toEqual([`notify.hook-pin-ahead ${NOTIFY_HOOK}`]);
      const f = finding(r, 'notify.hook-pin-ahead');
      expect(f.blocking).toBe(true);
      expect(r.status).toBe(EXIT.findings);
      expect(f.message).toContain(`at v1.2.4, ahead of the callers' ${PINNED}`);
      expect(f.message).toMatch(/lane-check fails it/);
      expect(f.fix.commands).toEqual([`    - uses: yedeya-labs/kanon/actions/notify/slack@${PINNED}`]);
      // A candidate of a later release is ahead too; one of the callers' own release is level.
      expect(notifyIds(await check(files({ hook: prebuilt('slack', 'candidate-v1.0.1') })))).toEqual([`notify.hook-pin-ahead ${NOTIFY_HOOK}`]);
      expect(notifyIds(await check(files({ hook: prebuilt('slack', 'candidate-v1.0.0') })))).toEqual([`notify.hook-pin-behind ${NOTIFY_HOOK}`]);
    });

    it('says nothing of a hook at the callers\' pin, or of an own hook', async () => {
      expect(notifyIds(await check(files({ hook: prebuilt('webhook') })))).toEqual([]);
      expect(notifyIds(await check(files({ hook: ownHook(['    - uses: acme/teams-notify@v0.9.0']) })))).toEqual([]);
    });

    it('still counts any other Kanon reference in the hook toward pin.mixed', async () => {
      const r = await check(files({ hook: ownHook(['    - uses: yedeya-labs/kanon/actions/lane-check@v0.9.0']) }));
      expect(ids(r)).toContain('pin.mixed .github');
    });
  });

  describe('notify.failing', () => {
    const line = (outcome: string) => `${NOTIFY_LINE} {"hook":"slack","kind":"project-digest","outcome":"${outcome}"}`;

    it('notes a latest notify job that printed outcome failed, with the run to read and re-run', async () => {
      const r = await check(files(), github({ runs: [{ id: 601, line: line('failed'), conclusion: 'failure' }] }));
      expect(ids(r)).toEqual([`notify.failing ${CALLER}`]);
      const f = finding(r, 'notify.failing');
      expect(f.blocking).toBe(false);
      expect(f.message).toContain('/actions/runs/601');
      expect(f.message).toContain('project-digest was failed, through the slack hook');
      expect(f.fix.commands).toEqual([`gh run view 601 -R ${REPO} --log-failed`, `gh run rerun 601 -R ${REPO} --failed`]);
      expect(r.status).toBe(EXIT.healthy);
    });

    it('is quiet on posted and on skipped', async () => {
      for (const outcome of ['posted', 'skipped']) expect(notifyIds(await check(files(), github({ runs: [{ id: 602, line: line(outcome) }] })))).toEqual([]);
    });

    it('reads the line only from a completed run on the default branch of the repository itself, whatever the server returned', async () => {
      const runs: RunOf[] = [
        { id: 701, branch: 'topic', line: line('failed'), conclusion: 'failure' },
        { id: 702, from: 'mallory/widgets', line: line('failed'), conclusion: 'failure' },
        { id: 703, status: 'in_progress', line: line('failed'), conclusion: 'failure' },
        // A run whose notify job didn't run (no hook, or a dry run) says nothing: the next one does.
        { id: 704, line: null, conclusion: 'skipped' },
        { id: 705, line: line('posted') },
        { id: 706, line: line('failed'), conclusion: 'failure' },
      ];
      expect(notifyIds(await check(files(), github({ runs })))).toEqual([]);
      // Mutation's twin: the same failed run, on the default branch, first.
      expect(notifyIds(await check(files(), github({ runs: [{ id: 706, line: line('failed'), conclusion: 'failure' }, { id: 705, line: line('posted') }] })))).toEqual([`notify.failing ${CALLER}`]);
    });

    it('is unchecked where the token can\'t list the runs, or the job printed no line', async () => {
      const refused = await check(files(), github({ runsRefused: true }));
      expect(notifyUnchecked(refused)).toEqual([expect.objectContaining({ check: 'notify-runs', subject: CALLER, reason: expect.stringContaining('Actions: read') })]);
      const silent = await check(files(), github({ runs: [{ id: 801, line: null }] }));
      expect(notifyUnchecked(silent)).toEqual([expect.objectContaining({ check: 'notify-runs', reason: expect.stringContaining(`printed no ${NOTIFY_LINE} line`) })]);
      expect(notifyIds(silent)).toEqual([]);
    });

    it('says nothing while the caller has no run whose notify job ran', async () => {
      expect(notifyIds(await check(files(), github({ runs: [] })))).toEqual([]);
    });
  });

  // Plan 0011 N9's installer half: the deploy lane's `deploy.yml` notifies too, so its caller is a
  // notifying caller. Its kind's secret is optional there, so a job that doesn't map it is part of
  // `notify.kind-unset`, never `caller.secret-missing`.
  describe("the deploy lane's caller (plan 0011 N9)", () => {
    const DEPLOY_SECRET = 'KANON_CHAT_DEPLOY';
    const TWO = ['staging', 'production'];
    const deployFiles = (caller = deployCallerFile(TWO, REQ, PINNED)) => files({ extra: { [DEPLOY_CALLER_PATH]: caller } });
    const held = (...extra: string[]) => new Set([...LANES.flatMap((l) => REQ.lanes[l]!.secrets), 'CLAUDE_CODE_OAUTH_TOKEN', SECRET, ...extra]);

    it('reports notify.kind-unset, a note, where the repository lacks KANON_CHAT_DEPLOY and a hook exists, and nothing once it holds it', async () => {
      const r = await check(deployFiles(), github({ secrets: held() }));
      expect(notifyIds(r)).toEqual([`notify.kind-unset ${DEPLOY_CALLER_PATH}`]);
      const f = finding(r, 'notify.kind-unset');
      expect(f.blocking).toBe(false);
      expect(f.message).toContain(`whose deploy messages are posted only with ${DEPLOY_SECRET}, which ${REPO} doesn't hold`);
      expect(f.message).not.toContain('model run');
      expect(f.fix.commands).toEqual([`gh secret set ${DEPLOY_SECRET} -R ${REPO}`]);
      // Never secret.missing, nor caller.secret-missing: a kind not posted is a choice.
      expect(ids(r).filter((x: string) => /secret-missing|^secret\.missing/.test(x))).toEqual([]);
      expect(notifyIds(await check(deployFiles(), github({ secrets: held(DEPLOY_SECRET) })))).toEqual([]);
      // With no hook, nothing posts: notify.none names the deploy caller, and kind-unset stays quiet.
      const none = await check(files({ hook: null, extra: { [DEPLOY_CALLER_PATH]: deployCallerFile(TWO, REQ, PINNED) } }), github({ secrets: held() }));
      expect(notifyIds(none)).toEqual([`notify.none ${NOTIFY_HOOK}`]);
      expect(finding(none, 'notify.none').message).toContain(`${DEPLOY_CALLER_PATH} call agent-project-digest, deploy,`);
    });

    it("names each deploy job that doesn't map KANON_CHAT_DEPLOY, with the line to add, even where the repository holds it", async () => {
      const unmapped = deployCallerFile(TWO, REQ, PINNED).replace(/^ {4}secrets:\n {6}KANON_CHAT_DEPLOY: .*\n(?= {2}deploy-2:)/m, '');
      expect(unmapped).not.toBe(deployCallerFile(TWO, REQ, PINNED));
      const r = await check(deployFiles(unmapped), github({ secrets: held(DEPLOY_SECRET) }));
      expect(notifyIds(r)).toEqual([`notify.kind-unset ${DEPLOY_CALLER_PATH}`]);
      const f = finding(r, 'notify.kind-unset');
      expect(f.message).toMatch(/its job deploy-1 maps none: so deploy is not posted/);
      expect(f.fix.commands).toEqual([`      ${DEPLOY_SECRET}: \${{ secrets.${DEPLOY_SECRET} }}`]);
    });

    it('decides an unmapped deploy job before the organisation lookup, and adds the gh secret set line only where a listing shows the secret missing', async () => {
      const unmapped = deployCallerFile(TWO, REQ, PINNED).replace(/^ {4}secrets:\n {6}KANON_CHAT_DEPLOY: .*\n(?= {2}deploy-2:)/m, '');
      const line = `      ${DEPLOY_SECRET}: \${{ secrets.${DEPLOY_SECRET} }}`;
      const set = `gh secret set ${DEPLOY_SECRET} -R ${REPO}`;
      const org = (shared: Set<string> | null) => check(deployFiles(unmapped), github({ secrets: held(), owner: 'Organization', org: shared }));
      // Shared through the organisation: the job is still the finding, with its line alone.
      const shared = await org(new Set([DEPLOY_SECRET]));
      expect(notifyIds(shared)).toEqual([`notify.kind-unset ${DEPLOY_CALLER_PATH}`]);
      expect(finding(shared, 'notify.kind-unset').fix.commands).toEqual([line]);
      const secretsUnchecked = (r: Result) => notifyUnchecked(r).filter((u: { check: string }) => u.check === 'notify-secrets');
      expect(secretsUnchecked(shared)).toEqual([]);
      // Missing from both listings: both lines.
      const missing = await org(new Set(['OTHER']));
      expect(finding(missing, 'notify.kind-unset').fix.commands).toEqual([set, line]);
      expect(finding(missing, 'notify.kind-unset').message).toContain(`nor does ${REPO} hold it`);
      // The organisation's listing unreadable: the job's line, and the secret unchecked.
      const blind = await org(null);
      expect(finding(blind, 'notify.kind-unset').fix.commands).toEqual([line]);
      expect(secretsUnchecked(blind)).toEqual([expect.objectContaining({ check: 'notify-secrets', subject: DEPLOY_CALLER_PATH })]);
      // A mapped caller whose secret the organisation shares: nothing.
      expect(notifyIds(await check(deployFiles(), github({ secrets: held(), owner: 'Organization', org: new Set([DEPLOY_SECRET]) })))).toEqual([]);
    });

    describe('notify.failing', () => {
      const line = (outcome: string) => `${NOTIFY_LINE} {"hook":"slack","kind":"deploy","outcome":"${outcome}"}`;
      /** A deploy run whose staging announcement posted and whose production announcement said `production`. */
      const deployRun = (id: number, production: string, o: Partial<DeployRunOf> = {}): DeployRunOf => ({
        id,
        jobs: [
          { name: 'release / gate', line: null },
          { name: 'staging / deploy', line: null },
          { name: 'staging / notify', line: line('posted') },
          { name: 'production / deploy', line: null },
          { name: 'production / notify', line: line(production), conclusion: production === 'failed' ? 'failure' : 'success' },
        ],
        ...o,
      });
      const deployOnly = (r: Result) => notifyIds(r).filter((x: string) => x.endsWith(DEPLOY_CALLER_PATH));

      it('notes a failing announcement in the latest release run, read at its tag, with the run to read and re-run (#1046)', async () => {
        const g = github({ secrets: held(DEPLOY_SECRET), deployRuns: [deployRun(901, 'failed')] });
        const r = await check(deployFiles(), g);
        expect(notifyIds(r)).toEqual([`notify.failing ${DEPLOY_CALLER_PATH}`]);
        const f = finding(r, 'notify.failing');
        expect(f.blocking).toBe(false);
        expect(f.message).toContain('/actions/runs/901');
        expect(f.message).toContain('production / notify');
        expect(f.message).toContain('a release at v1.0.0');
        expect(f.message).toContain('deploy was failed, through the slack hook');
        expect(f.fix.commands).toEqual([`gh run view 901 -R ${REPO} --log-failed`, `gh run rerun 901 -R ${REPO} --failed`]);
        // A deploy run's failed jobs can include a deploy job: the fix says what the re-run takes with it.
        expect(f.fix.text).toMatch(/a failed deploy job of the run too/);
        // The deploy caller's runs are listed at every ref, not the default branch's alone; the digest's still are.
        expect(g.paths.filter((p) => p.includes('/deploy.yml/runs?'))).toEqual([`repos/${REPO}/actions/workflows/deploy.yml/runs?status=completed&per_page=10`]);
        expect(g.paths.filter((p) => p.includes(`/${LANE}.yml/runs?`))).toEqual([`repos/${REPO}/actions/workflows/${LANE}.yml/runs?branch=main&status=completed&per_page=10`]);
      });

      it('counts a dispatch at a release\'s tag as a release run, and is quiet when every announcement posted or was skipped', async () => {
        const dispatched = await check(deployFiles(), github({ secrets: held(DEPLOY_SECRET), deployRuns: [deployRun(902, 'failed', { event: 'workflow_dispatch' })] }));
        expect(deployOnly(dispatched)).toEqual([`notify.failing ${DEPLOY_CALLER_PATH}`]);
        expect(finding(dispatched, 'notify.failing').message).toContain('a dispatch at v1.0.0');
        for (const outcome of ['posted', 'skipped']) {
          expect(notifyIds(await check(deployFiles(), github({ secrets: held(DEPLOY_SECRET), deployRuns: [deployRun(903, outcome)] })))).toEqual([]);
        }
      });

      it('reads only a run that counts, as deploy.trust-unproven does: this repository\'s, a release or a dispatch, at a release\'s tag, on a commit of the default branch', async () => {
        const runs: DeployRunOf[] = [
          deployRun(911, 'failed', { from: 'mallory/widgets' }),
          deployRun(912, 'failed', { branch: 'v9.9.9' }),
          deployRun(913, 'failed', { onDefault: false }),
          deployRun(914, 'failed', { event: 'push', branch: 'main' }),
          deployRun(915, 'failed', { event: 'workflow_dispatch', branch: 'main' }),
          // A run whose announcements didn't run says nothing: the next one does.
          { id: 916, jobs: [{ name: 'release / gate', line: null, conclusion: 'failure' }, { name: 'staging / notify', line: null, conclusion: 'skipped' }] },
          deployRun(917, 'posted'),
          deployRun(918, 'failed'),
        ];
        expect(deployOnly(await check(deployFiles(), github({ secrets: held(DEPLOY_SECRET), deployRuns: runs })))).toEqual([]);
        // Mutation's twin: the same failed run, one that counts, first.
        expect(deployOnly(await check(deployFiles(), github({ secrets: held(DEPLOY_SECRET), deployRuns: [deployRun(918, 'failed'), deployRun(917, 'posted')] })))).toEqual([`notify.failing ${DEPLOY_CALLER_PATH}`]);
      });

      it('is unchecked where an announcement of the latest run printed no line, and nothing failed', async () => {
        const silent = deployRun(921, 'posted');
        silent.jobs[4]!.line = null;
        const r = await check(deployFiles(), github({ secrets: held(DEPLOY_SECRET), deployRuns: [silent] }));
        expect(notifyIds(r)).toEqual([]);
        expect(notifyUnchecked(r)).toEqual([expect.objectContaining({ check: 'notify-runs', subject: DEPLOY_CALLER_PATH, reason: expect.stringContaining(`printed no ${NOTIFY_LINE} line`) })]);
      });
    });

    it("says nothing of the deploy caller against a release whose deploy.yml posts nothing", async () => {
      const r = await check(deployFiles(), github({ secrets: held() }), nextReq((n) => { n.kinds.deploy!.lanes = []; }));
      expect(notifyIds(r)).toEqual([]);
    });
  });

  it('says nothing of the branch exposure (decision 22): no finding id names it', () => {
    expect(Object.keys(FINDINGS).filter((id) => id.startsWith('notify.')).sort()).toEqual([
      'notify.failing', 'notify.hook-malformed', 'notify.hook-pin-ahead', 'notify.hook-pin-behind', 'notify.hook-unpinned', 'notify.hook-unreviewed', 'notify.hook-version-old', 'notify.kind-unset', 'notify.legacy-secret', 'notify.none',
    ]);
    expect(Object.entries(FINDINGS).filter(([id]) => id.startsWith('notify.')).map(([id, f]) => [id, f.blocking])).toEqual([
      ['notify.hook-pin-behind', false], ['notify.hook-pin-ahead', true], ['notify.kind-unset', false], ['notify.none', false], ['notify.hook-malformed', true], ['notify.hook-version-old', false], ['notify.hook-unpinned', true], ['notify.hook-unreviewed', true], ['notify.legacy-secret', true], ['notify.failing', false],
    ]);
  });
});
