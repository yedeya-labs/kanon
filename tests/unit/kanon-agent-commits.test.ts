import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { checkCommit, parseDelegation, parseRegister } from '../../actions/dco/dco.mjs';
import { writeStub } from './helpers/stub-bin.js';

/**
 * Kanon's own Implementer passes Kanon's own `dco` check (ADR 0011 stage 2, K-AGENT-44).
 *
 * The released lane writes claude-code-action's default bot into git config and adds no
 * sign-off, so Kanon's project-setup hook runs `agent-commits.sh` for the Implementer's two
 * lanes. These tests run that script in a scratch repository, make the commits an agent
 * makes, and judge each with the `dco` action's own `checkCommit`, against Kanon's real App
 * register and real delegation record. So "the Implementer's commits pass DCO" is asserted
 * end to end, short of a runner.
 */
const ROOT = process.cwd();
const SCRIPT = join(ROOT, '.github/actions/project-setup/agent-commits.sh');
const RECORD = 'docs/qa/sign-off-delegation.md';
const SLUG = 'kanon-implementer';
const BOT_ID = '987654321';

type Run = { status: number | null; out: string; dir: string; env: Record<string, string> };

/** Run the script in a fresh repository, with a `gh` that answers the bot's id (or fails). */
const run = (opts: { lane?: string; slug?: string; record?: string | null; gh?: 'ok' | 'fail' } = {}): Run => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-commits-'));
  const bin = join(dir, '.bin');
  mkdirSync(bin);
  writeStub(join(bin, 'gh'), opts.gh === 'fail'
    ? '#!/usr/bin/env bash\necho "HTTP 404: Not Found" >&2\nexit 1\n'
    : `#!/usr/bin/env bash\n[ "$1 $2" = "api users/${SLUG}%5Bbot%5D" ] || { echo "unexpected: $*" >&2; exit 2; }\necho ${BOT_ID}\n`);
  git(dir, 'init', '-q');
  mkdirSync(join(dir, 'actions/dco'), { recursive: true });
  cpSync(join(ROOT, 'actions/dco/dco.mjs'), join(dir, 'actions/dco/dco.mjs'));
  const record = opts.record === undefined ? readFileSync(join(ROOT, RECORD), 'utf8') : opts.record;
  if (record !== null) {
    mkdirSync(join(dir, 'docs/qa'), { recursive: true });
    writeFileSync(join(dir, RECORD), record);
  }
  const envFile = join(dir, '.github-env');
  writeFileSync(envFile, '');
  const r = spawnSync('bash', [SCRIPT], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, LANE: opts.lane ?? 'implementer', APP_SLUG: opts.slug ?? SLUG, GH_TOKEN: 't', GITHUB_ENV: envFile },
  });
  const env = Object.fromEntries(readFileSync(envFile, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { status: r.status, out: `${r.stdout}${r.stderr}`, dir, env };
};

/** git with a person's identity in config, as claude-code-action leaves one; `env` outranks it. */
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

const kanonTrust = () => {
  const reg = parseRegister(readFileSync(join(ROOT, 'docs/qa/agent-identities.md'), 'utf8'));
  const del = parseDelegation(readFileSync(join(ROOT, RECORD), 'utf8'));
  if (!('slugs' in reg) || !('delegate' in del)) throw new Error('Kanon\'s register or delegation record does not parse');
  return { slugs: reg.slugs, delegate: del.delegate };
};

const AGENT_MESSAGE = 'feat(lanes): build the thing\n\nWhat and why.\n\nCo-Authored-By: Claude <noreply@anthropic.com>';

describe("Kanon's own records (K-LAYOUT-14, K-LAYOUT-6)", () => {
  it('delegate a person, and register the Implementer by the slug the lanes commit as', () => {
    const trust = kanonTrust();
    expect(trust.slugs).toContain(SLUG);
    expect(trust.delegate.name).not.toMatch(/bot|claude/i);
  });

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

describe("the Implementer's commits pass Kanon's dco check (agent-commits.sh)", () => {
  it.each(['implementer', 'implementer-revise'])('on the %s lane: authored as the App, signed off by the delegate', (lane) => {
    const r = run({ lane });
    try {
      expect(r.status, r.out).toBe(0);
      expect(r.env).toEqual({
        GIT_AUTHOR_NAME: `${SLUG}[bot]`,
        GIT_AUTHOR_EMAIL: `${BOT_ID}+${SLUG}[bot]@users.noreply.github.com`,
        GIT_COMMITTER_NAME: `${SLUG}[bot]`,
        GIT_COMMITTER_EMAIL: `${BOT_ID}+${SLUG}[bot]@users.noreply.github.com`,
      });
      const c = commitAs(r, AGENT_MESSAGE);
      expect(c.commit.author.name).toBe(`${SLUG}[bot]`);
      expect(checkCommit(c, kanonTrust())).toEqual({ ok: true, delegated: SLUG });
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('adds the sign-off once, through an amend and beside a `-s` of the bot\'s own', () => {
    const r = run();
    try {
      const { name, email } = kanonTrust().delegate;
      const line = `Signed-off-by: ${name} <${email}>`;
      commitAs(r, AGENT_MESSAGE, '-s');
      gitEnv(r.dir, r.env, 'commit', '-q', '--amend', '--no-edit');
      const c = head(r);
      expect(c.commit.message.split('\n').filter((l) => l === line)).toHaveLength(1);
      expect(checkCommit(c, kanonTrust())).toEqual({ ok: true, delegated: SLUG });
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('keeps a delegate\'s name with spaces and quotes intact', () => {
    const r = run({ record: '| Delegate | Email | Delegated on |\n|---|---|---|\n| Ada O\'Neil "Lovelace" | ada@example.com | 2026-10-04 |\n' });
    try {
      expect(r.status, r.out).toBe(0);
      expect(commitAs(r, AGENT_MESSAGE).commit.message).toContain('Signed-off-by: Ada O\'Neil "Lovelace" <ada@example.com>');
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('without the script\'s identity the same commit fails, so the identity is what passes it', () => {
    const r = run();
    try {
      const c = commitAs({ ...r, env: {} }, AGENT_MESSAGE);
      expect(c.commit.author.name).toBe('claude[bot]');
      expect(checkCommit(c, kanonTrust()).ok).toBe(false);
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it.each([['the reviewer', 'reviewer'], ['a lane with no name', '']])('does nothing on %s', (_, lane) => {
    const r = run({ lane });
    try {
      expect(r.status, r.out).toBe(0);
      expect(r.env).toEqual({});
      expect(existsSync(join(r.dir, '.git/hooks/commit-msg'))).toBe(false);
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('fails by name when the bot account can\'t be read, or no slug was passed', () => {
    for (const r of [run({ gh: 'fail' }), run({ slug: '' })]) {
      try {
        expect(r.status).toBe(1);
        expect(r.out).toMatch(/::error title=project-setup::/);
        expect(r.env).toEqual({});
      } finally {
        rmSync(r.dir, { recursive: true, force: true });
      }
    }
  });

  it.each([['no record', null], ['a malformed record', '| Delegate | Email | Delegated on |\n|---|---|---|\n| claude[bot] | noreply@anthropic.com | 2026-10-04 |\n']])(
    'with %s, adds no sign-off and warns, so the check fails the commit as the rule says', (_, record) => {
      const r = run({ record });
      try {
        expect(r.status, r.out).toBe(0);
        expect(r.out).toMatch(/::warning title=project-setup::.*will fail the dco check/);
        expect(existsSync(join(r.dir, '.git/hooks/commit-msg'))).toBe(false);
        expect(checkCommit(commitAs(r, AGENT_MESSAGE), kanonTrust()).ok).toBe(false);
      } finally {
        rmSync(r.dir, { recursive: true, force: true });
      }
    },
  );

  it('is run by Kanon\'s hook after Node, with the slug and token from the lane and nothing interpolated into the script', () => {
    const hook = parse(readFileSync(join(ROOT, '.github/actions/project-setup/action.yml'), 'utf8')) as {
      runs: { steps: { uses?: string; run?: string; env?: Record<string, string> }[] };
    };
    const steps = hook.runs.steps;
    const at = steps.findIndex((s) => s.run?.includes('agent-commits.sh'));
    expect(at).toBeGreaterThan(steps.findIndex((s) => s.uses?.startsWith('actions/setup-node@')));
    expect(steps[at]?.run).toBe('bash "$GITHUB_ACTION_PATH/agent-commits.sh"');
    expect(steps[at]?.env).toEqual({ LANE: '${{ inputs.lane }}', APP_SLUG: '${{ inputs.app-slug }}', GH_TOKEN: '${{ inputs.github-token }}' });
  });
});
