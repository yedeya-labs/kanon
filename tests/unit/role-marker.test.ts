import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const { asRole, headerLine, markedRole, personaHeader, roleMarker, setMarkerPhase, signed, withPersona } = await import('../../scripts/lib/role-marker.mjs');
const { personaEnv, resolveRole } = await import('../../actions/agent-setup/persona.mjs');

/**
 * Plan 0005 §3.3, step L3: the persona header, the role marker, and the persona as the agent's
 * commit author. The readers of §3.3's table are in `tests/library/role-marker-readers.test.ts`;
 * the writers' guard is below.
 */

afterEach(() => { setMarkerPhase('additive'); });

describe('the header and the marker', () => {
  it('writes the role alone without a persona, and the persona with its role beside it', () => {
    expect(personaHeader('Reviewer')).toBe('**Reviewer**');
    expect(personaHeader('reviewer', 'Reviewer')).toBe('**Reviewer**');
    expect(personaHeader('Reviewer', 'Thea')).toBe('**Thea (Reviewer)**');
    expect(roleMarker('Merger')).toBe('<!-- kanon:role=merger -->');
    expect(headerLine('Lead')).toBe('**Lead** <!-- kanon:role=lead -->');
  });

  it('refuses a role that is not an agent\'s', () => {
    expect(() => roleMarker('Releaser')).toThrow(/not an agent role/);
    expect(() => headerLine('Nobody')).toThrow(/not an agent role/);
  });

  it('reads the FIRST marker, so a quoted one further down is not the post\'s', () => {
    expect(markedRole(`${headerLine('Merger')}\n\n> ${headerLine('Reviewer')}`)).toBe('Merger');
    expect(markedRole('<!--kanon:role=reviewer-->')).toBe('Reviewer');
    expect(markedRole('no marker')).toBeNull();
    expect(markedRole('<!-- kanon:role=releaser -->')).toBeNull();
    expect(markedRole(undefined)).toBeNull();
  });

  it('signs a body once: the header line, a blank line, then the body', () => {
    const once = signed('Hello', 'Implementer');
    expect(once).toBe('**Implementer** <!-- kanon:role=implementer -->\n\nHello');
    expect(signed(once, 'Implementer')).toBe(once);
    // A body the agent already opened with a marker is left alone, whichever role it names.
    expect(signed(`${headerLine('Lead')}\n\nx`, 'Implementer')).toBe(`${headerLine('Lead')}\n\nx`);
    // A marker further down is not an opening one.
    expect(signed(`x\n${roleMarker('Lead')}`, 'Implementer').startsWith(headerLine('Implementer'))).toBe(true);
  });
});

describe('asRole: the login decides at L3, and the login and the marker at L4', () => {
  const who = (body: string, login = 'acme-implementer[bot]') => ({ login, expected: 'acme-implementer', body });

  it('additive: only the login', () => {
    expect(asRole('Implementer', who('x'))).toBe(true);
    expect(asRole('Implementer', who(signed('x', 'Lead')))).toBe(true);
    expect(asRole('Implementer', who(signed('x', 'Implementer'), 'app/someone-else'))).toBe(false);
  });

  it('required: the login and the role\'s own marker', () => {
    setMarkerPhase('required');
    expect(asRole('Implementer', who(signed('x', 'Implementer')))).toBe(true);
    expect(asRole('Implementer', who(signed('x', 'Lead')))).toBe(false);
    expect(asRole('Implementer', who('x'))).toBe(false);
    // A marker never stands in for the login.
    expect(asRole('Implementer', who(signed('x', 'Implementer'), 'a-person'))).toBe(false);
  });

  it('ships additive, so this release changes no reader', () => {
    expect(setMarkerPhase('additive')).toBe('additive');
    expect(() => setMarkerPhase('strict' as never)).toThrow(/unknown marker phase/);
  });
});

describe('the agent is asked to open every post with its header (agent-run)', () => {
  it('appends the instruction with the exact header line, and nothing else changes', () => {
    const out = withPersona('Do the work.\n', 'Reviewer', headerLine('Reviewer'));
    expect(out.startsWith('Do the work.\n\nWHO YOU SPEAK AS')).toBe(true);
    expect(out.split('\n')).toContain(headerLine('Reviewer'));
    expect(withPersona('Do the work.', '', '')).toBe('Do the work.');
  });

  it('writes the prompt to $GITHUB_OUTPUT under a delimiter, unchanged with no role', () => {
    const dir = mkdtempSync(join(tmpdir(), 'persona-prompt-'));
    try {
      const out = join(dir, 'out');
      const runIt = (env: Record<string, string>) => {
        writeFileSync(out, '');
        const r = spawnSync(process.execPath, ['actions/agent-run/persona-prompt.mjs'], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: out, ...env } });
        expect(r.status, r.stderr).toBe(0);
        const m = /^text<<(KANON_PROMPT_[0-9a-f]{32})\n([\s\S]*)\n\1\n$/.exec(readFileSync(out, 'utf8'));
        expect(m).not.toBeNull();
        return m![2];
      };
      expect(runIt({ PROMPT: 'line one\nline two', KANON_ROLE: 'Implementer', KANON_POST_HEADER: headerLine('Implementer') }))
        .toBe(withPersona('line one\nline two', 'Implementer', headerLine('Implementer')));
      expect(runIt({ PROMPT: 'line one', KANON_ROLE: '', KANON_POST_HEADER: '' })).toBe('line one');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('agent-run falls back to the lane\'s prompt, and the prompt step can never stop the agent', () => {
    const run = parse(readFileSync('actions/agent-run/action.yml', 'utf8')) as { runs: { steps: { id?: string; uses?: string; 'continue-on-error'?: boolean; with?: Record<string, string> }[] } };
    const prompt = run.runs.steps.find((s) => s.id === 'prompt');
    expect(prompt?.['continue-on-error']).toBe(true);
    const agent = run.runs.steps.find((s) => String(s.uses).startsWith('anthropics/claude-code-action@'));
    expect(agent?.with?.prompt).toBe('${{ steps.prompt.outputs.text || inputs.prompt }}');
  });
});

describe('the role the agent speaks as (agent-setup)', () => {
  const REGISTER = '| Role | App slug |\n|---|---|\n| Implementer | `acme-implementer` |\n| Reviewer | `acme-reviewer` |\n';

  it('takes the lane\'s role, or the default branch register\'s row for the minted slug', () => {
    expect(resolveRole({ role: 'reviewer' })).toEqual({ role: 'Reviewer' });
    expect(resolveRole({ slug: 'acme-implementer', register: () => REGISTER })).toEqual({ role: 'Implementer' });
  });

  it('names what it could not resolve, and never guesses', () => {
    expect(resolveRole({ role: 'Releaser' })).toMatchObject({ problem: expect.stringMatching(/not an agent role/) });
    expect(resolveRole({})).toMatchObject({ problem: expect.stringMatching(/no role and no App slug/) });
    expect(resolveRole({ slug: 'acme-other', register: () => REGISTER })).toMatchObject({ problem: expect.stringMatching(/no agent role/) });
    expect(resolveRole({ slug: 'acme-implementer', register: () => 'no table' })).toMatchObject({ problem: expect.stringMatching(/no App register table/) });
    expect(resolveRole({ slug: 'acme-implementer', register: () => { throw new Error('HTTP 404'); } })).toMatchObject({ problem: 'HTTP 404' });
  });

  it('exports the role, the persona (the role, while none is declared) and the header line', () => {
    expect(personaEnv('Implementer')).toEqual([
      'KANON_ROLE=Implementer', 'KANON_PERSONA=Implementer', 'KANON_POST_HEADER=**Implementer** <!-- kanon:role=implementer -->',
    ]);
  });

  it('runs before the commit identity, in every call of the block', () => {
    const setup = parse(readFileSync('actions/agent-setup/action.yml', 'utf8')) as { runs: { steps: { name?: string; run?: string; if?: string; env?: Record<string, string> }[] } };
    const names = setup.runs.steps.map((s) => s.name);
    expect(names.indexOf('Say who the agent speaks as')).toBe(0);
    expect(names.indexOf('Commit as the App, signed off by the delegate')).toBeGreaterThan(0);
    const step = setup.runs.steps[0]!;
    expect(step.if).toBeUndefined();
    expect(step.run).toBe('node "$GITHUB_ACTION_PATH/persona.mjs"');
    expect(step.env).toEqual({ ROLE: '${{ inputs.role }}', APP_SLUG: '${{ inputs.app-slug }}', GH_TOKEN: '${{ inputs.github-token }}' });
  });
});

/**
 * THE WRITERS (plan 0005 §3.3). Every fixed step that posts as an App opens the post with that
 * App's header line. A script posting as an App does it with `signed(…, '<Role>')` in the call;
 * a script posting only as `github-actions` (the default token) is not an agent and signs
 * nothing, and is listed with that reason. A new posting script fails here until it is in one
 * list or the other.
 */
const SIGNED: Record<string, string> = {
  'scripts/merge-gate.mjs': 'Merger',
  'scripts/dispatch-sweep.mjs': 'Lead',
  'scripts/lead-reconcile.mjs': 'Lead',
  'scripts/overseer-file.mjs': 'Overseer',
};
const UNSIGNED: Record<string, string> = {
  'scripts/implement-crash.mjs': 'posts as github-actions, deliberately not as the Implementer (its header says why)',
  'scripts/split-lineage.mjs': 'its gate posts on the default token, before the Lead\'s is minted',
  'scripts/workflow-health.mjs': 'the project digest runs it on the default token',
};
/** Where a gh argv opens a comment, an issue or a pull request. */
const POST = /'(issue|pr)',\s*'(comment|create)'/g;

/** The whole call expression around index `at`: back to its `(`, forward to the matching `)`. */
function callAround(src: string, at: number): string {
  const start = src.lastIndexOf('(', at);
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    if (src[i] === ')') depth -= 1;
    if (depth === 0) return src.slice(start, i + 1);
  }
  return '';
}

describe('every fixed step that posts as an App opens the post with its header (the writers)', () => {
  const scripts = [...new Set(spawnSync('git', ['ls-files', 'scripts/*.mjs', 'scripts/**/*.mjs'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean))];
  const posting = scripts.filter((f) => [...readFileSync(f, 'utf8').matchAll(POST)].length > 0);

  it('knows every script that posts, and why it signs or doesn\'t', () => {
    expect(posting.sort()).toEqual([...Object.keys(SIGNED), ...Object.keys(UNSIGNED)].sort());
  });

  it.each(Object.entries(SIGNED))('%s signs every post as the %s', (file, role) => {
    const src = readFileSync(file, 'utf8');
    const calls = [...src.matchAll(POST)].map((m) => callAround(src, m.index!));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call, `${file}: ${call.slice(0, 120)}`).toMatch(new RegExp(`signed\\([\\s\\S]*'${role}'\\)`));
  });

  it('the rebase lane\'s attempt comment, posted on the Implementer\'s token, is signed by its script', async () => {
    const { attemptComment } = await import('../../scripts/rebase-lane.mjs');
    expect(attemptComment('a'.repeat(40), '123').startsWith(`${headerLine('Implementer')}\n\n`)).toBe(true);
  });

  it.each([
    ['.github/workflows/agent-implement-revise.yml', 'record-round', 'Implementer'],
    ['.github/workflows/agent-lead-revise.yml', 'record-round', 'Lead'],
  ])('%s: the %s job\'s comment, on the App\'s token, opens with the %s header', (file, job, role) => {
    const wf = parse(readFileSync(file, 'utf8')) as { jobs: Record<string, { steps: { run?: string }[] }> };
    const posts = wf.jobs[job]!.steps.filter((s) => /gh pr comment/.test(s.run ?? ''));
    expect(posts).toHaveLength(1);
    const body = posts[0]!.run!.slice(posts[0]!.run!.indexOf('gh pr comment'));
    expect(body).toMatch(/printf '%s\\n' \\\n\s+"([^"]+)" \\\n\s+"" \\/);
    expect(/printf '%s\\n' \\\n\s+"([^"]+)"/.exec(body)![1]).toBe(headerLine(role));
  });
});
