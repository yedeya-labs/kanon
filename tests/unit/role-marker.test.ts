import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { SPAWNS } from './helpers/spawns.js';
import { writeStub } from './helpers/stub-bin.js';

const { asRole, headerLine, markedRole, personaHeader, roleMarker, setMarkerPhase, signed, signedAs, withPersona } = await import('../../scripts/lib/role-marker.mjs');
const { personaEnv, resolvePersona, resolveRole, speaksAsNoRole } = await import('../../actions/agent-setup/persona.mjs');
const { appPersona, parsePersonas } = await import('../../scripts/app-register.mjs');
const { withBaselines } = await import('../../actions/agent-run/persona-prompt.mjs');

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

// Its cases run a step in `bash`, so the block takes the spawn budget (#436).
describe("signedAs: a fixed step makes a post read as the role it knows it is (kanon#336)", SPAWNS, () => {
  it("opens a body unless its first marker is already the role's, whatever another role's says", () => {
    expect(signedAs('Approve.', 'Reviewer')).toBe(`${headerLine('Reviewer')}\n\nApprove.`);
    expect(signedAs('Approve.', 'Reviewer', 'Thea')).toBe(`${headerLine('Reviewer', 'Thea')}\n\nApprove.`);
    const mine = `${headerLine('Reviewer')}\n\nApprove.`;
    expect(signedAs(mine, 'Reviewer')).toBe(mine);
    // Where `signed` leaves another role's opening marker alone, `signedAs` opens the body, so
    // the result always reads as the role.
    const other = `${headerLine('Merger')}\n\nApprove.`;
    expect(signedAs(other, 'Reviewer')).toBe(`${headerLine('Reviewer')}\n\n${other}`);
    for (const b of ['', 'x', mine, other, `x\n${roleMarker('Lead')}`]) expect(markedRole(signedAs(b, 'Reviewer'))).toBe('Reviewer');
  });

  it('the CLI signs standard input, and refuses a role that is not an agent\'s', () => {
    const cli = (args: string[], input: string) => spawnSync('node', ['scripts/lib/role-marker.mjs', ...args], { input, encoding: 'utf8' });
    const r = cli(['sign', 'Reviewer'], 'Approve.\n');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${headerLine('Reviewer')}\n\nApprove.\n`);
    expect(cli(['sign', 'Reviewer', 'Thea'], 'x').stdout.startsWith(headerLine('Reviewer', 'Thea'))).toBe(true);
    expect(cli(['sign', 'Reviewer', ''], 'x').stdout.startsWith(`${headerLine('Reviewer')}\n`)).toBe(true);
    expect(cli(['sign', 'Releaser'], 'x').status).toBe(1);
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

// Its cases run a step in `bash`, so the block takes the spawn budget (#436).
describe('the agent is asked to open every post with its header (agent-run)', SPAWNS, () => {
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
      expect(runIt({ PROMPT: 'line one', KANON_ROLE: 'Implementer', KANON_POST_HEADER: headerLine('Implementer'), KANON_BASELINE_PLAYBOOKS: 'docs/qa/lead-playbook.md' }))
        .toBe(withBaselines(withPersona('line one', 'Implementer', headerLine('Implementer')), 'docs/qa/lead-playbook.md'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names the baseline playbooks agent-setup copied, with the remedy, and nothing when there are none (kanon#329)', () => {
    const out = withBaselines('Do the work.\n', 'docs/qa/reviewer-playbook.md docs/qa/lead-playbook.md');
    expect(out.startsWith('Do the work.\n\nKANON\'S BASELINE PLAYBOOKS')).toBe(true);
    expect(out).toContain('`docs/qa/reviewer-playbook.md`, `docs/qa/lead-playbook.md` are not this');
    expect(out).toContain('`git add -f <path>`');
    expect(withBaselines('Do the work.', '')).toBe('Do the work.');
    expect(withBaselines('Do the work.', ' ')).toBe('Do the work.');
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
  'scripts/telemetry-file.mjs': 'Explorer',
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
    // With the register's persona for the role (plan 0005 §3.3), read where the script runs.
    for (const call of calls) expect(call, `${file}: ${call.slice(0, 120)}`).toMatch(new RegExp(`signed\\([\\s\\S]*'${role}', appPersona\\('${role}'\\)\\)`));
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
    // The first line is the filter's persona header (`header`, read from the default branch's
    // register), falling back to the role's own header line.
    expect(body).toMatch(/printf '%s\\n' \\\n\s+"([^"]+)" \\\n\s+"" \\/);
    expect(/printf '%s\\n' \\\n\s+"([^"]+)"/.exec(body)![1]).toBe(`\${HEADER:-${headerLine(role)}}`);
    const step = wf.jobs[job]!.steps.find((s) => /gh pr comment/.test(s.run ?? '')) as { env?: Record<string, string> };
    expect(step.env?.HEADER).toBe('${{ needs.filter.outputs.header }}');
  });
});

/** The register's optional `Persona` column (plan 0005 §3.3; decided by the Owner, 2026-10-05). */
// Its cases run steps in `bash`, so the block takes the spawn budget (#436).
describe('personas live in the App register\'s optional Persona column', SPAWNS, () => {
  const reg = (rows: string, header = '| Role | App slug | Persona |', sep = '|---|---|---|') => `# Agent identities\n\n${header}\n${sep}\n${rows}`;
  const ROWS = '| Implementer | `acme-implementer` | The Builder |\n| Reviewer | `acme-reviewer` |  |\n| Lead | `acme-lead` | Lead |\n';

  it('reads a declared persona, and a blank cell, the role\'s own name or no column as none', () => {
    const p = parsePersonas(reg(ROWS));
    expect([...p]).toEqual([['Implementer', 'The Builder']]);
    expect(parsePersonas(reg('| Implementer | `acme-implementer` |\n', '| Role | App slug |', '|---|---|')).size).toBe(0);
    // The column may sit anywhere after the slug, and the cell may be bold.
    expect(parsePersonas(reg('| Implementer | `a-i` | Read | **Ada** |\n', '| Role | App slug | Contents | Persona |', '|---|---|---|---|')).get('Implementer')).toBe('Ada');
    // A table in a fenced block is an example, and isn't read.
    expect(parsePersonas(`\`\`\`\n${reg('| Implementer | `x` | <bad> |\n')}\`\`\`\n${reg(ROWS)}`).get('Implementer')).toBe('The Builder');
  });

  it.each([
    ['two Persona columns', reg('| Implementer | `a` | A | B |\n', '| Role | App slug | Persona | Persona |', '|---|---|---|---|'), /2 `Persona` columns/],
    ['markup', reg('| Implementer | `a` | <b>A</b> |\n'), /:5: the Implementer row's persona `<b>A<\/b>` is malformed/],
    ['a leading digit', reg('| Implementer | `a` | 9 Lives |\n'), /is malformed/],
    ['more than 40 characters', reg(`| Implementer | \`a\` | ${'A'.repeat(41)} |\n`), /is malformed/],
    ['a bot suffix', reg('| Implementer | `a` | builder[bot] |\n'), /is malformed/],
    ['another role\'s name', reg('| Implementer | `a` | Merger |\n'), /is another role's name/],
    ['a persona on a role that is not an agent', reg('| Releaser | `a` | Shipper |\n'), /only an agent role has one/],
  ])('fails by line and row on %s', (_, text, message) => {
    expect(() => parsePersonas(text)).toThrow(message);
  });

  it('a fixed step reads it where it runs, and falls back to the role on any problem', () => {
    const dir = mkdtempSync(join(tmpdir(), 'personas-'));
    try {
      writeFileSync(join(dir, 'good.md'), reg(ROWS));
      writeFileSync(join(dir, 'bad.md'), reg('| Implementer | `a` | <x> |\n'));
      expect(appPersona('Implementer', join(dir, 'good.md'))).toBe('The Builder');
      expect(appPersona('Reviewer', join(dir, 'good.md'))).toBeNull();
      expect(appPersona('Implementer', join(dir, 'bad.md'))).toBeNull();
      expect(appPersona('Implementer', join(dir, 'missing.md'))).toBeNull();
      expect(signed('x', 'Implementer', appPersona('Implementer', join(dir, 'good.md')))).toBe('**The Builder (Implementer)** <!-- kanon:role=implementer -->\n\nx');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the agent-setup block exports it as the persona, and a malformed one as the role with a reason', () => {
    expect(resolvePersona('Implementer', () => reg(ROWS))).toEqual({ persona: 'The Builder' });
    expect(resolvePersona('Reviewer', () => reg(ROWS))).toEqual({ persona: null });
    expect(resolvePersona('Implementer', () => reg('| Implementer | `a` | <x> |\n'))).toMatchObject({ persona: null, problem: expect.stringMatching(/is malformed/) });
    expect(resolvePersona('Implementer', () => { throw new Error('HTTP 404'); })).toEqual({ persona: null, problem: 'HTTP 404' });
    expect(personaEnv('Implementer', 'The Builder')).toEqual([
      'KANON_ROLE=Implementer', 'KANON_PERSONA=The Builder', 'KANON_POST_HEADER=**The Builder (Implementer)** <!-- kanon:role=implementer -->',
    ]);
  });

  it('the persona step runs end to end against a stubbed default-branch register', () => {
    const dir = mkdtempSync(join(tmpdir(), 'persona-step-'));
    try {
      writeFileSync(join(dir, 'register'), reg(ROWS));
      writeStub(join(dir, 'gh'), `#!/usr/bin/env bash\ncat "${dir}/register"\n`);
      const envFile = join(dir, 'env');
      writeFileSync(envFile, '');
      const r = spawnSync(process.execPath, ['actions/agent-setup/persona.mjs'], { encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_ENV: envFile, GITHUB_REPOSITORY: 'acme/widgets', ROLE: '', APP_SLUG: 'acme-implementer' } });
      expect(r.status, r.stderr).toBe(0);
      expect(readFileSync(envFile, 'utf8')).toBe(`${personaEnv('Implementer', 'The Builder').join('\n')}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Owner decision, 2026-10-06 (kanon#336): an unresolved role fails the step, by name.
  it('the persona step FAILS by name when it cannot resolve the role, and passes a run that asks for none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'persona-fail-'));
    try {
      writeFileSync(join(dir, 'register'), reg(ROWS));
      writeStub(join(dir, 'gh'), `#!/usr/bin/env bash\ncat "${dir}/register"\n`);
      const envFile = join(dir, 'env');
      const step = (ROLE: string, APP_SLUG: string) => {
        writeFileSync(envFile, '');
        const r = spawnSync(process.execPath, ['actions/agent-setup/persona.mjs'], { encoding: 'utf8',
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_ENV: envFile, GITHUB_REPOSITORY: 'acme/widgets', ROLE, APP_SLUG } });
        return { status: r.status, out: r.stdout + r.stderr, env: readFileSync(envFile, 'utf8') };
      };
      for (const [role, slug] of [['Releaser', ''], ['', 'acme-unregistered']] as const) {
        const r = step(role, slug);
        expect(r.status, `${role}/${slug}: ${r.out}`).toBe(1);
        expect(r.out).toMatch(/::error title=agent-setup::cannot tell which role this agent speaks as: /);
        expect(r.env, 'and exports nothing').toBe('');
      }
      for (const [role, slug] of [['', ''], ['', 'github-actions']] as const) {
        const r = step(role, slug);
        expect(r.status, `${role}/${slug}: ${r.out}`).toBe(0);
        expect(r.out).toMatch(/speaks as no persona/);
      }
      expect(step('Reviewer', '').status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(speaksAsNoRole({})).toBe(true);
    expect(speaksAsNoRole({ slug: 'github-actions' })).toBe(true);
    expect(speaksAsNoRole({ slug: 'acme-implementer' })).toBe(false);
    expect(speaksAsNoRole({ role: 'Reviewer', slug: 'github-actions' })).toBe(false);
  });

  it('the shell writers read it from a register on standard input, and never fail', () => {
    const run = (input: string) => spawnSync(process.execPath, ['scripts/lib/role-marker.mjs', 'header-from-register', 'Implementer'], { input, encoding: 'utf8' });
    expect(run(reg(ROWS)).stdout).toBe('**The Builder (Implementer)** <!-- kanon:role=implementer -->\n');
    const bad = run(reg('| Implementer | `a` | <x> |\n'));
    expect(bad.status).toBe(0);
    expect(bad.stdout).toBe(`${headerLine('Implementer')}\n`);
  });

  it('Kanon\'s own register declares no persona: its headers are the roles\'', () => {
    expect(parsePersonas(readFileSync('docs/qa/agent-identities.md', 'utf8')).size).toBe(0);
  });
});

/**
 * EVERY AGENT IS ASKED TO WRITE ITS HEADER (#310's review). The persona step resolves the role
 * from `role`, or else from the App register's row for `app-slug`. Since plan 0005's L4 a slug
 * is the Author's or the Judge's, which several roles share, so it resolves nothing: every
 * `agent-setup` call passes its role, or is listed here with why its agent posts as no App.
 */
const NO_PERSONA: Record<string, string> = {
  'agent-project-digest.yml': 'its agent writes a digest the workflow posts to a webhook, as no App',
  'agent-weekly-digest.yml': 'its agent writes a digest the workflow posts to a webhook, as no App',
  'agent-blocks-smoke.yml': 'a smoke run of the blocks, as `github-actions`, which posts nothing and runs no agent',
  'overseer-agent-job.yml': 'its agent files nothing; `overseer-file.mjs` files on a token of its own, signed as the Overseer',
};
describe('every agent-setup call names the agent\'s role, or says why its agent posts as no App', () => {
  type SetupStep = { uses?: string; with?: Record<string, string> };
  const calls = spawnSync('git', ['ls-files', '.github/workflows/*.yml'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
    .flatMap((f) => Object.values((parse(readFileSync(f, 'utf8')) as { jobs?: Record<string, { steps?: SetupStep[] }> }).jobs ?? {})
      .flatMap((j) => j.steps ?? []).filter((s) => s.uses === '$/actions/agent-setup').map((s) => ({ file: f.split('/').pop()!, with: s.with ?? {} })));

  it('finds the calls, so the rule below is not vacuous', () => {
    expect(calls.length).toBeGreaterThanOrEqual(10);
  });

  it('each passes its role, or is listed: since L4 an App slug names two or four roles (plan 0005 §3.3)', () => {
    const silent = calls.filter((c) => !c.with.role).map((c) => c.file);
    expect(silent.sort()).toEqual(Object.keys(NO_PERSONA).sort());
  });

  it.each([
    ['review-agent-job.yml', 'Reviewer'],
    ['explore-agent-job.yml', 'Explorer'],
    ['verify-acs-agent-job.yml', 'Explorer'],
    ['code-audit-agent-job.yml', 'Explorer'],
    ['rebase-agent-job.yml', 'Implementer'],
    ['merge-reconcile-agent-job.yml', 'Reviewer'],
    ['lead-split-agent-job.yml', 'Lead'],
    ['lane-agent-job.yml', '${{ inputs.role }}'],
  ])('%s names the %s, whose App its agent posts as', (file, role) => {
    expect(calls.filter((c) => c.file === file).map((c) => c.with.role)).toEqual([role]);
  });
});
