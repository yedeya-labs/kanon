import { describe, expect, it } from 'vitest';
import { lanePersona, lanePersonaCli } from '../../scripts/lane-persona.mjs';

/**
 * Issue #1401 (`K-AGENT-1`): a fixed step in a job that checks out nothing (the Overseer's and the
 * telemetry Explorer's `file` jobs) can't read the App register from its working directory, so
 * `appPersona` there always answers null and every post drops the persona. The lane's gate job
 * reads the role's persona from the register on the default branch instead, as it reads the
 * scrub's names (`upstream-names.mjs`), and hands it on as its output.
 */

const REGISTER = [
  '# App register', '',
  '| Role | App slug | Persona |', '|---|---|---|',
  '| Implementer | `acme-kanon-author` | |',
  '| Explorer | `acme-kanon-author` | Grace |',
  '| Overseer | `acme-kanon-author` | Ada |', '',
].join('\n');

/** A `gh` that answers the default branch and the register, or fails each as told. */
const fakeRun = (register: string | null | 'throws' = REGISTER) => {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args[1] === 'repos/acme/widget-shop') return 'main\n';
    if (String(args[1]).startsWith('repos/acme/widget-shop/contents/docs/qa/agent-identities.md')) {
      if (register === 'throws') throw Object.assign(new Error('boom'), { stderr: 'HTTP 500' });
      if (register === null) throw Object.assign(new Error('nope'), { stderr: 'HTTP 404: Not Found' });
      return register;
    }
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  return { run, calls };
};

describe('lanePersona: the role\'s persona, from the register on the default branch', () => {
  it('reads the register at the default branch, never the working directory', () => {
    const { run, calls } = fakeRun();
    expect(lanePersona({ repo: 'acme/widget-shop', role: 'Overseer', run })).toEqual({ persona: 'Ada', notes: [] });
    expect(calls.at(-1)![1]).toBe('repos/acme/widget-shop/contents/docs/qa/agent-identities.md?ref=main');
  });

  it('answers each role\'s own persona', () => {
    expect(lanePersona({ repo: 'acme/widget-shop', role: 'Explorer', run: fakeRun().run }).persona).toBe('Grace');
  });

  it('answers null, quietly, for a role with none and for a register with no Persona column or none at all', () => {
    expect(lanePersona({ repo: 'acme/widget-shop', role: 'Implementer', run: fakeRun().run })).toEqual({ persona: null, notes: [] });
    const bare = REGISTER.replace('| Persona |', '|').replace('|---|---|---|', '|---|---|').replace(/ [A-Za-z]* \|$/gm, '');
    expect(lanePersona({ repo: 'acme/widget-shop', role: 'Overseer', run: fakeRun(bare).run })).toEqual({ persona: null, notes: [] });
    expect(lanePersona({ repo: 'acme/widget-shop', role: 'Overseer', run: fakeRun(null).run })).toEqual({ persona: null, notes: [] });
  });

  it('answers null, saying why, when the register can\'t be read or its Persona column is malformed', () => {
    const malformed = REGISTER.replace('| Ada |', '| Ada <b> |');
    for (const reg of ['throws', malformed] as const) {
      const { persona, notes } = lanePersona({ repo: 'acme/widget-shop', role: 'Overseer', run: fakeRun(reg).run });
      expect(persona, reg).toBeNull();
      expect(notes.join(' ')).toMatch(/App register/);
    }
  });
});

describe('lanePersonaCli: what the gate job writes to its output', () => {
  it('prints the persona', () => {
    expect(lanePersonaCli({ repo: 'acme/widget-shop', role: 'Overseer', run: fakeRun().run })).toEqual({ code: 0, out: 'Ada', notes: [] });
  });

  it('prints nothing for the role\'s own name', () => {
    expect(lanePersonaCli({ repo: 'acme/widget-shop', role: 'Implementer', run: fakeRun().run })).toEqual({ code: 0, out: '', notes: [] });
  });

  it('prints nothing, and stays green, when the register can\'t be read: the posts fall back to the role\'s header', () => {
    const r = lanePersonaCli({ repo: 'acme/widget-shop', role: 'Overseer', run: fakeRun('throws').run });
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
    expect(r.notes.join(' ')).toMatch(/::warning/);
  });

  it('exits 2 without the repository, or with an argument that is not one of Kanon\'s roles', () => {
    expect(lanePersonaCli({ repo: '', role: 'Overseer' }).code).toBe(2);
    for (const role of ['', 'Reviewr', 'overseer']) expect(lanePersonaCli({ repo: 'acme/widget-shop', role, run: fakeRun().run }).code, role).toBe(2);
  });
});
