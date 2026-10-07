import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { checkCommit, parseDelegation, parseRegister } from '../../actions/dco/dco.mjs';
import { writeStub } from './helpers/stub-bin.js';
import { SPAWNS } from './helpers/spawns.js';

/**
 * An agent's commits pass the adopter's own `dco` check (K-AGENT-44, kanon#234).
 *
 * The `agent-setup` block runs `agent-commits.sh` on every lane. These tests run that script
 * in a scratch repository with a stub `gh`, then commit the way an agent does, under the git
 * config claude-code-action leaves (`claude[bot]`), and judge each commit with the `dco`
 * action's own `checkCommit`. So "an agent's commits pass the check" is asserted end to end,
 * short of a runner; the blocks smoke runs the block itself on one.
 */
const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'actions/agent-setup/agent-commits.sh');
const DCO_MJS = join(ROOT, 'actions/dco/dco.mjs');
const RECORD = 'docs/qa/sign-off-delegation.md';
const REPO = 'acme/widgets';
const SLUG = 'acme-implementer';
const BOT_ID = '987654321';
const DELEGATION = '| Delegate | Email | Delegated on |\n|---|---|---|\n| Ada Lovelace | ada@example.com | 2026-10-04 |\n';
const TRUST = { slugs: [SLUG], delegate: { name: 'Ada Lovelace', email: 'ada@example.com', date: '2026-10-04' } };

type Run = { status: number | null; out: string; dir: string; env: Record<string, string> };
type Opts = {
  slug?: string;
  /** The default branch's record: its text, `null` for none (404), or `'error'` for a failed read. */
  record?: string | null | 'error';
  users?: 'ok' | 'fail';
  /** Prepare the repository before the script runs, as a project-setup hook would. */
  prepare?: (dir: string) => void;
  env?: Record<string, string>;
};

/** Run the script in a fresh repository, with a `gh` that answers the bot's id and the record. */
const run = (opts: Opts = {}): Run => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-commits-'));
  const bin = join(dir, '.bin');
  const temp = join(dir, '.runner-temp');
  mkdirSync(bin);
  mkdirSync(temp);
  const record = opts.record === undefined ? DELEGATION : opts.record;
  if (typeof record === 'string' && record !== 'error') writeFileSync(join(bin, 'record'), record);
  const contents = record === null
    ? 'echo "gh: Not Found (HTTP 404)" >&2; exit 1'
    : record === 'error' ? 'echo "gh: Server Error (HTTP 502)" >&2; exit 1' : `cat "${bin}/record"`;
  writeStub(join(bin, 'gh'), `#!/usr/bin/env bash
case "$1 $2" in
  "api users/${opts.slug || SLUG}%5Bbot%5D") ${opts.users === 'fail' ? 'echo "HTTP 404: Not Found" >&2; exit 1' : `echo ${BOT_ID}`} ;;
  "api repos/${REPO}/contents/${RECORD}") [ "$3 $4" = "-H Accept: application/vnd.github.raw" ] || { echo "no raw accept: $*" >&2; exit 2; }; ${contents} ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
`);
  git(dir, 'init', '-q');
  opts.prepare?.(dir);
  const envFile = join(dir, '.github-env');
  writeFileSync(envFile, '');
  const r = spawnSync('bash', [SCRIPT], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`, HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null',
      APP_SLUG: opts.slug ?? SLUG, GH_TOKEN: 't', GITHUB_REPOSITORY: REPO, GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_ENV: envFile, RUNNER_TEMP: temp, DCO_MJS, ...opts.env,
    },
  });
  const env = Object.fromEntries(readFileSync(envFile, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { status: r.status, out: `${r.stdout}${r.stderr}`, dir, env };
};

/** git with claude-code-action's identity in config; the job's environment outranks it. */
const git = (dir: string, ...args: string[]) => gitEnv(dir, {}, ...args);
const gitEnv = (dir: string, env: Record<string, string>, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=claude[bot]', '-c', 'user.email=41898282+claude[bot]@users.noreply.github.com', ...args], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', ...env },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

/** Commit as the agent does, then shape HEAD as the REST API's commit object the check reads. */
const commitAs = (r: Run, message: string, ...flags: string[]) => {
  writeFileSync(join(r.dir, 'f.txt'), `${Math.random()}\n`);
  gitEnv(r.dir, r.env, 'add', 'f.txt');
  gitEnv(r.dir, r.env, 'commit', '-q', '-m', message, ...flags);
  return head(r);
};
const head = (r: Run) => {
  const [name = '', email = '', ...body] = git(r.dir, 'log', '-1', '--format=%an%x00%ae%x00%B').split('\0');
  return { sha: 'x', parents: ['p'], author: null, committer: null, commit: { message: body.join('\0'), author: { name, email } } };
};

const within = (r: Run, fn: (r: Run) => void) => {
  try {
    fn(r);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
};

const AGENT_MESSAGE = 'feat(lanes): build the thing\n\nWhat and why.\n\nCo-Authored-By: Claude <noreply@anthropic.com>';
const IDENTITY = {
  GIT_AUTHOR_NAME: `${SLUG}[bot]`,
  GIT_AUTHOR_EMAIL: `${BOT_ID}+${SLUG}[bot]@users.noreply.github.com`,
  GIT_COMMITTER_NAME: `${SLUG}[bot]`,
  GIT_COMMITTER_EMAIL: `${BOT_ID}+${SLUG}[bot]@users.noreply.github.com`,
};

// Each case runs agent-commits.sh and then git init and commits through its hooks: a dozen spawns,
// about a second alone. Under a loaded full `npm test` the husky case took 5.1s and failed on the
// 5s default (kanon#381), so the block gets 15s.
describe("an agent's commits pass the adopter's dco check (agent-commits.sh, K-AGENT-44)", { timeout: 15_000 }, () => {
  it('authors each commit as the App and signs it off as the delegate, under claude-code-action\'s git config', () =>
    within(run(), (r) => {
      expect(r.status, r.out).toBe(0);
      expect(r.env).toMatchObject(IDENTITY);
      const c = commitAs(r, AGENT_MESSAGE);
      expect(c.commit.author.name).toBe(`${SLUG}[bot]`);
      expect(c.commit.message).toContain('Signed-off-by: Ada Lovelace <ada@example.com>');
      expect(checkCommit(c, TRUST)).toEqual({ ok: true, delegated: SLUG });
    }));

  // PLAN 0005 §3.3 (step L3): the persona is the author's NAME, and the App's noreply address
  // stays the email, which is what GitHub attributes the commit by and what `checkCommit` reads.
  it('authors a persona-named commit with the App\'s noreply email, which passes with the delegate\'s sign-off', () =>
    within(run({ env: { KANON_PERSONA: 'Implementer' } }), (r) => {
      expect(r.status, r.out).toBe(0);
      expect(r.env).toMatchObject({ ...IDENTITY, GIT_AUTHOR_NAME: 'Implementer' });
      const c = commitAs(r, AGENT_MESSAGE);
      expect(c.commit.author).toEqual({ name: 'Implementer', email: IDENTITY.GIT_AUTHOR_EMAIL });
      expect(git(r.dir, 'log', '-1', '--format=%cn')).toBe(`${SLUG}[bot]\n`);
      expect(checkCommit(c, TRUST)).toEqual({ ok: true, delegated: SLUG });
      // A declared persona's display name, spaces and all, is only ever the name.
      const named = { ...c, commit: { ...c.commit, author: { ...c.commit.author, name: 'The Builder' } } };
      expect(checkCommit(named, TRUST)).toEqual({ ok: true, delegated: SLUG });
    }));

  it('a persona-named commit without the delegate\'s sign-off still fails', () =>
    within(run({ env: { KANON_PERSONA: 'Implementer' }, record: null }), (r) => {
      expect(r.status, r.out).toBe(0);
      const c = commitAs(r, AGENT_MESSAGE);
      expect(c.commit.author.name).toBe('Implementer');
      expect(checkCommit(c, TRUST).ok).toBe(false);
    }));

  it('without the identity and the hook the same commit fails, so they are what passes it', () =>
    within(run(), (r) => {
      const c = commitAs({ ...r, env: {} }, AGENT_MESSAGE);
      expect(c.commit.author.name).toBe('claude[bot]');
      expect(checkCommit(c, TRUST).ok).toBe(false);
    }));

  it('adds the sign-off once, through an amend and beside a `-s` of the bot\'s own', () =>
    within(run(), (r) => {
      const line = 'Signed-off-by: Ada Lovelace <ada@example.com>';
      commitAs(r, AGENT_MESSAGE, '-s');
      gitEnv(r.dir, r.env, 'commit', '-q', '--amend', '--no-edit');
      const c = head(r);
      expect(c.commit.message.split('\n').filter((l) => l === line)).toHaveLength(1);
      expect(checkCommit(c, TRUST)).toEqual({ ok: true, delegated: SLUG });
    }));

  it('keeps a delegate\'s name with spaces and quotes intact', () =>
    within(run({ record: '| Delegate | Email | Delegated on |\n|---|---|---|\n| Ada O\'Neil "Lovelace" | ada@example.com | 2026-10-04 |\n' }), (r) => {
      expect(r.status, r.out).toBe(0);
      expect(commitAs(r, AGENT_MESSAGE).commit.message).toContain('Signed-off-by: Ada O\'Neil "Lovelace" <ada@example.com>');
    }));

  it('uses the noreply domain of the server the job runs on', () =>
    within(run({ env: { GITHUB_SERVER_URL: 'https://ghe.example.com' } }), (r) => {
      expect(r.env.GIT_AUTHOR_EMAIL).toBe(`${BOT_ID}+${SLUG}[bot]@users.noreply.ghe.example.com`);
    }));

  it('changes no file in the workspace: the hooks live outside it', () =>
    within(run(), (r) => {
      expect(r.env.GIT_CONFIG_KEY_0).toBe('core.hooksPath');
      expect(r.env.GIT_CONFIG_VALUE_0?.startsWith(join(r.dir, '.runner-temp'))).toBe(true);
      expect(r.env.GIT_CONFIG_COUNT).toBe('1');
      expect(existsSync(join(r.dir, '.git/hooks/commit-msg'))).toBe(false);
    }));

  it('keeps the project\'s own hooks running, husky-style, and its commit-msg sees the sign-off', () =>
    within(run({
      // A husky-like setup: `core.hooksPath` in the repository's config, hooks that source a
      // helper next to themselves, a pre-commit, and a commit-msg linter that needs the trailer.
      prepare: (dir) => {
        const h = join(dir, '.husky/_');
        mkdirSync(h, { recursive: true });
        writeFileSync(join(h, 'h'), 'touch "$(dirname "$0")/../ran-$(basename "$0")"\n[ "$(basename "$0")" != commit-msg ] || grep -q "^Signed-off-by: Ada Lovelace" "$1"\n');
        for (const name of ['pre-commit', 'commit-msg']) {
          writeFileSync(join(h, name), '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n');
          chmodSync(join(h, name), 0o755);
        }
        git(dir, 'config', 'core.hooksPath', '.husky/_');
      },
    }), (r) => {
      expect(r.status, r.out).toBe(0);
      const c = commitAs(r, AGENT_MESSAGE);
      expect(existsSync(join(r.dir, '.husky/ran-pre-commit'))).toBe(true);
      expect(existsSync(join(r.dir, '.husky/ran-commit-msg'))).toBe(true);
      expect(checkCommit(c, TRUST)).toEqual({ ok: true, delegated: SLUG });
    }));

  it('fails a commit the project\'s own commit-msg hook rejects', () =>
    within(run({
      prepare: (dir) => {
        writeFileSync(join(dir, '.git/hooks/commit-msg'), '#!/usr/bin/env bash\nexit 1\n');
        chmodSync(join(dir, '.git/hooks/commit-msg'), 0o755);
      },
    }), (r) => {
      expect(() => commitAs(r, AGENT_MESSAGE)).toThrow(/git commit/);
    }));

  it('adds its hooks path after any git config the job already set through the environment', () =>
    within(run({ env: { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: '1', GIT_CONFIG_KEY_1: 'c.d', GIT_CONFIG_VALUE_1: '2' } }), (r) => {
      expect(r.env.GIT_CONFIG_KEY_2).toBe('core.hooksPath');
      expect(r.env.GIT_CONFIG_COUNT).toBe('3');
      expect(r.env.GIT_CONFIG_KEY_0).toBeUndefined();
    }));

  it('fails by name when the bot account can\'t be read, or no slug was passed', () => {
    for (const r of [run({ users: 'fail' }), run({ slug: '' })]) {
      within(r, () => {
        expect(r.status).toBe(1);
        expect(r.out).toMatch(/::error title=agent-setup::/);
        expect(r.env).toEqual({});
      });
    }
  });

  it.each([
    ['no record on the default branch', null, 'notice'],
    ['a malformed record', '| Delegate | Email | Delegated on |\n|---|---|---|\n| claude[bot] | noreply@anthropic.com | 2026-10-04 |\n', 'warning'],
    ['a record that could not be read', 'error', 'warning'],
  ] as const)('with %s, still commits as the App, adds no sign-off, and says so', (_, record, level) =>
    within(run({ record }), (r) => {
      expect(r.status, r.out).toBe(0);
      expect(r.out).toMatch(new RegExp(`::${level} title=agent-setup::.*will fail a dco check`));
      expect(r.env).toEqual(IDENTITY);
      const c = commitAs(r, AGENT_MESSAGE);
      expect(c.commit.author.name).toBe(`${SLUG}[bot]`);
      expect(checkCommit(c, TRUST).ok).toBe(false);
    }));
});

describe('the agent-setup block runs it, and the lanes give it the App token', () => {
  const setup = parse(readFileSync(join(ROOT, 'actions/agent-setup/action.yml'), 'utf8')) as {
    inputs: Record<string, { default?: string; required?: boolean }>;
    runs: { steps: { name?: string; run?: string; env?: Record<string, string>; if?: string }[] };
  };

  it('on every call that has an App, with nothing interpolated into the script', () => {
    const step = setup.runs.steps.find((s) => s.run?.includes('agent-commits.sh'));
    // Only the review lane passes no slug: it calls the block before its token is minted.
    expect(step?.if).toBe("inputs.app-slug != ''");
    expect(step?.run).toBe('DCO_MJS="$GITHUB_ACTION_PATH/../dco/dco.mjs" bash "$GITHUB_ACTION_PATH/agent-commits.sh"');
    expect(step?.env).toEqual({ APP_SLUG: '${{ inputs.app-slug }}', GH_TOKEN: '${{ inputs.github-token }}' });
    expect(setup.inputs['github-token']).toMatchObject({ required: false, default: '${{ github.token }}' });
  });

  it('reads the parser of the `dco` action that ships beside it', () => {
    expect(existsSync(join(ROOT, 'actions/agent-setup/../dco/dco.mjs'))).toBe(true);
  });

  it('the shared lane passes the minted App token', () => {
    // The spine's agent job (kanon#274), where its steps live; `steps.app-token` there is the token it receives.
    const lane = parse(readFileSync(join(ROOT, '.github/workflows/lane-agent-job.yml'), 'utf8')) as {
      jobs: { run: { steps: { uses?: string; with?: Record<string, string> }[] } };
    };
    const call = lane.jobs.run.steps.find((s) => s.uses === '$/actions/agent-setup');
    expect(call?.with?.['github-token']).toBe('${{ steps.app-token.outputs.token }}');
  });

  it("Kanon's own project-setup hook no longer does it too: one owner (kanon#234)", () => {
    expect(existsSync(join(ROOT, '.github/actions/project-setup/agent-commits.sh'))).toBe(false);
    expect(readFileSync(join(ROOT, '.github/actions/project-setup/action.yml'), 'utf8')).not.toMatch(/agent-commits|GIT_AUTHOR|commit-msg/);
  });
});

// Its cases run `git` over Kanon's history, so the block takes the spawn budget (#436).
describe("Kanon's own records (K-LAYOUT-14, K-LAYOUT-6, K-LAYOUT-16)", SPAWNS, () => {
  const kanonTrust = () => {
    const reg = parseRegister(readFileSync(join(ROOT, 'docs/qa/agent-identities.md'), 'utf8'));
    const del = parseDelegation(readFileSync(join(ROOT, RECORD), 'utf8'));
    if (!('slugs' in reg) || !('delegate' in del)) throw new Error('Kanon\'s register or delegation record does not parse');
    return { slugs: reg.slugs, delegate: del.delegate };
  };

  it('delegate a person, and register the Implementer by the slug the lanes commit as', () => {
    const trust = kanonTrust();
    expect(trust.slugs).toContain('yedeya-labs-author');
    expect(trust.delegate.name).not.toMatch(/bot|claude/i);
  });

  it("pass Kanon's Implementer commit, made by the block, against Kanon's real register and record", () =>
    within(run({ record: readFileSync(join(ROOT, RECORD), 'utf8'), slug: 'yedeya-labs-author' }), (r) => {
      expect(r.status, r.out).toBe(0);
      expect(checkCommit(commitAs(r, AGENT_MESSAGE), kanonTrust())).toEqual({ ok: true, delegated: 'yedeya-labs-author' });
    }));

  it('declare no test database, which the lanes read as none (K-LAYOUT-16)', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'tdb-')), 'out');
    writeFileSync(out, '');
    const r = spawnSync('bash', [join(ROOT, 'actions/test-database/declaration.sh')], {
      cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH!, WANTED: 'true', GITHUB_OUTPUT: out },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('database=false');
    expect(readFileSync(join(ROOT, 'docs/qa/test-database.md'), 'utf8')).toMatch(/^\*\*Test database:\*\* `none`$/m);
  });
});
