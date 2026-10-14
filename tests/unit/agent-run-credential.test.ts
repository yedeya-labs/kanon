import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { actionFiles } from './helpers/actions.js';
import { SPAWNS } from './helpers/spawns.js';

const { CREDENTIALS, checkCredential } = await import('../../actions/agent-run/credential-check.mjs');

/**
 * Plan 0009 §10, step A1 — `agent-run` takes the Claude subscription token or an Anthropic API
 * key, exactly one, and hands it to the agent through `env:` only.
 *
 * The caller maps one of `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY`; the lane hands each
 * down as its own input. A check before the agent fails on both, on neither, and on a value that
 * carries the other credential's prefix, naming the secret and never what it holds, and writes
 * `auth`. The agent step reads both from its `env:` and passes neither as an input of
 * `claude-code-action`, which copies its inputs into `ALL_INPUTS` and its inline-comment step.
 *
 * The seeded values are fakes in the documented forms. The prefixes themselves are NOT RUN against
 * a real token or key: plan 0009 step A0 measures them.
 */
const TOKEN = 'sk-ant-oat01-TESTSECRET-token';
const KEY = 'sk-ant-api03-TESTSECRET-key';
/** Neither prefix: an older or unknown form, which the check lets through (prefixes not run). */
const OTHER = 'TESTSECRET-no-known-prefix';
/** Anything a message could leak: the seeded values' distinctive part, and either prefix. */
const LEAKS = [/TESTSECRET/, /sk-ant/, /oat01/, /api03/];

const noLeak = (text: string) => {
  for (const re of LEAKS) expect(text, `printed ${re}`).not.toMatch(re);
};

describe('the credential check decides which credential runs, or why none can', () => {
  it('a token only: the subscription', () => {
    const r = checkCredential({ token: TOKEN });
    expect(r).toMatchObject({ ok: true, auth: 'subscription' });
    noLeak(r.message);
  });

  it('a key only: the API key', () => {
    const r = checkCredential({ apiKey: KEY });
    expect(r).toMatchObject({ ok: true, auth: 'api-key' });
    noLeak(r.message);
  });

  it('both set: fails, naming both secrets', () => {
    const r = checkCredential({ token: TOKEN, apiKey: KEY });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^::error title=claude-credential::/);
    expect(r.message).toMatch(/maps both CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY; map one/);
    noLeak(r.message);
  });

  it('neither set: fails, naming both secrets', () => {
    const r = checkCredential({});
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/No Claude credential: the caller maps neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY, or maps an empty secret/);
    expect(checkCredential({ token: '', apiKey: '' }).ok).toBe(false);
  });

  it('an API key stored as the token: fails, naming the secret and where it belongs', () => {
    const r = checkCredential({ token: KEY });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/CLAUDE_CODE_OAUTH_TOKEN holds what looks like an Anthropic API key\. Store it as ANTHROPIC_API_KEY/);
    noLeak(r.message);
  });

  it('a token stored as the API key: fails, naming the secret and where it belongs', () => {
    const r = checkCredential({ apiKey: TOKEN });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/ANTHROPIC_API_KEY holds what looks like a Claude subscription token\. Store it as CLAUDE_CODE_OAUTH_TOKEN/);
    noLeak(r.message);
  });

  it('a value with neither prefix passes under its own name, so an unmeasured prefix stops no caller that works today', () => {
    expect(checkCredential({ token: OTHER })).toMatchObject({ ok: true, auth: 'subscription' });
    expect(checkCredential({ apiKey: OTHER })).toMatchObject({ ok: true, auth: 'api-key' });
  });

  it('names the two secrets, the two inputs and the two `auth` values the plan names', () => {
    expect(CREDENTIALS.map((c: { secret: string; input: string; auth: string }) => `${c.secret} ${c.input} ${c.auth}`)).toEqual([
      'CLAUDE_CODE_OAUTH_TOKEN claude-token subscription',
      'ANTHROPIC_API_KEY anthropic-api-key api-key',
    ]);
  });
});

// Its cases run the script in `node`, so the block takes the spawn budget (#436).
describe('the credential check, run as the block runs it', SPAWNS, () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  const runScript = (env: { CLAUDE_CODE_OAUTH_TOKEN?: string; ANTHROPIC_API_KEY?: string }) => {
    const dir = mkdtempSync(join(tmpdir(), 'credential-check-'));
    dirs.push(dir);
    const output = join(dir, 'output');
    writeFileSync(output, '');
    const r = spawnSync(process.execPath, ['actions/agent-run/credential-check.mjs'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, ...env },
    });
    return { status: r.status, out: r.stdout + r.stderr, output: readFileSync(output, 'utf8') };
  };

  it.each([
    ['a token only', { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, ANTHROPIC_API_KEY: '' }, 0, 'auth=subscription\n'],
    ['a key only', { CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: KEY }, 0, 'auth=api-key\n'],
    ['both', { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, ANTHROPIC_API_KEY: KEY }, 1, ''],
    ['neither, as the block sets an unmapped input', { CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: '' }, 1, ''],
    ['neither, unset', {}, 1, ''],
    ['a key as the token', { CLAUDE_CODE_OAUTH_TOKEN: KEY, ANTHROPIC_API_KEY: '' }, 1, ''],
    ['a token as the key', { CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: TOKEN }, 1, ''],
  ])('%s: exits %s, writes %j, and prints no value', (_name, env, status, output) => {
    const r = runScript(env);
    expect(r.status, r.out).toBe(status);
    expect(r.output).toBe(output);
    noLeak(r.out);
    noLeak(r.output);
  });
});

type Step = { id?: string; name?: string; uses?: string; run?: string; shell?: string; env?: Record<string, unknown>; with?: Record<string, unknown>; 'continue-on-error'?: unknown };
type Action = { inputs: Record<string, { required?: boolean; default?: string }>; outputs: Record<string, { value: string }>; runs: { steps: Step[] } };
const action = parse(readFileSync('actions/agent-run/action.yml', 'utf8')) as Action;
const steps = action.runs.steps;
const isAgent = (s: Step) => String(s.uses ?? '').startsWith('anthropics/claude-code-action@');
const agent = steps.find(isAgent)!;
const check = steps.find((s) => s.id === 'credential')!;
/** Any reference to either credential: its input, its secret or its variable. */
const CREDENTIAL_REF = /claude-token|anthropic-api-key|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY/i;

describe('agent-run hands the credential to the agent through env only', () => {
  it('takes both credentials as optional inputs, so a caller passing only the token works unchanged', () => {
    expect(action.inputs['claude-token']).toMatchObject({ required: false, default: '' });
    expect(action.inputs['anthropic-api-key']).toMatchObject({ required: false, default: '' });
  });

  it("the agent step's env sets exactly the two variables, each from its own input", () => {
    const creds = Object.entries(agent.env ?? {}).filter(([k, v]) => CREDENTIAL_REF.test(k) || CREDENTIAL_REF.test(String(v)));
    expect(Object.fromEntries(creds)).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: '${{ inputs.claude-token }}',
      ANTHROPIC_API_KEY: '${{ inputs.anthropic-api-key }}',
    });
  });

  it("no `with:` of the action, or of any step, names either credential", () => {
    expect(Object.keys(agent.with ?? {}).length).toBeGreaterThan(0);
    for (const s of steps) {
      for (const [k, v] of Object.entries(s.with ?? {})) {
        expect(`${k}: ${String(v)}`, `${s.name ?? s.uses}`).not.toMatch(CREDENTIAL_REF);
        // The action's own inputs for a credential, under any value.
        expect(k, `${s.name ?? s.uses}`).not.toMatch(/api_key|oauth_token/);
      }
    }
  });

  it('no `run:` line reads a credential input: the check gets the values through its env', () => {
    for (const s of steps) expect(String(s.run ?? ''), s.name).not.toMatch(/inputs\.(claude-token|anthropic-api-key)/);
    expect(check.env).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: '${{ inputs.claude-token }}',
      ANTHROPIC_API_KEY: '${{ inputs.anthropic-api-key }}',
    });
  });

  it('only the check and the agent step hold either credential', () => {
    const holders = steps.filter((s) => CREDENTIAL_REF.test(JSON.stringify({ env: s.env ?? {}, with: s.with ?? {}, run: s.run ?? '' })));
    expect(holders.map((s) => s.id)).toEqual(['credential', 'agent']);
  });

  it('runs the check before the agent, never past a failure, and writes `auth` from it', () => {
    expect(steps.indexOf(check)).toBeGreaterThanOrEqual(0);
    expect(steps.indexOf(check)).toBeLessThan(steps.indexOf(agent));
    expect(check['continue-on-error']).toBeUndefined();
    expect(check.run).toBe('node "$GITHUB_ACTION_PATH/credential-check.mjs"');
    expect(action.outputs.auth?.value).toBe('${{ steps.credential.outputs.auth }}');
  });
});

/**
 * kanon#747 — a comment that tells a reader how to run a lane on the API key names the input
 * `agent-run` declares. A composite action only warns about an input it doesn't declare, so a key
 * passed as `anthropic_api_key` never reaches the agent and the check fails the run with "No Claude
 * credential". And since step A2 every lane hands both credentials down, so no comment may still
 * send a reader to a note on "graduating" to API-key billing: the caller maps one, as
 * `actions/agent-run/README.md` says.
 */
describe('no workflow or action comment points at a credential input agent-run does not take', () => {
  const files = [
    ...readdirSync('.github/workflows').filter((f) => /\.ya?ml$/.test(f)).map((f) => join('.github/workflows', f)),
    // Every action, nested ones too (kanon#927).
    ...actionFiles(),
  ];
  const comments = files.flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .map((line, i) => ({ where: `${file}:${i + 1}`, text: line.replace(/^.*?(?:^|\s)#/, '#') }))
      .filter(({ text }) => text.trimStart().startsWith('#')),
  );

  it('reads every workflow and action comment, so the checks below are not vacuous', () => {
    expect(files).toContain('.github/workflows/review-agent-job.yml');
    expect(files).toContain('actions/agent-run/action.yml');
    // Nested actions too (kanon#927): plan 0011's hook actions sit one level down.
    expect(files).toContain('actions/notify/slack/action.yml');
    expect(comments.some(({ where }) => where.startsWith('.github/workflows/review-agent-job.yml'))).toBe(true);
  });

  it('names the API-key input `anthropic-api-key`, never `anthropic_api_key`', () => {
    for (const { where, text } of comments) expect(text, where).not.toContain('anthropic_api_key');
  });

  it('sends no reader to a "graduate to API-key billing" note: the caller maps either credential', () => {
    for (const { where, text } of comments) expect(text, where).not.toMatch(/graduate/i);
  });
});
