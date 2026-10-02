import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentRows, expectedManifestPermissions, parsePermissions, rolesTable } from './helpers/roles-table.js';

/**
 * `rulebook/agent-permissions.json` is the roles table's permissions column in a form code
 * can read (`kanon apps` builds every App manifest from it). The table is the rule and the
 * file its twin, so this test is the parity check `K-PRIN-2` asks for where a restatement
 * can't be avoided: each agent row's prose, plus what `K-ADOPT-8` adds, must equal the file.
 */
const data = JSON.parse(readFileSync(join(process.cwd(), 'rulebook/agent-permissions.json'), 'utf8')) as {
  roles: Record<string, { role: string; permissions: Record<string, string> }>;
};

describe('the roles table and rulebook/agent-permissions.json agree (K-PRIN-2, K-ADOPT-8)', () => {
  const rows = agentRows();

  it('finds the six agent rows, so the checks below are not vacuous', () => {
    expect(rows.map((r) => r.role)).toEqual(['Explorer', 'Implementer', 'Reviewer', 'Merger', 'Lead', 'Overseer']);
  });

  it('the file has exactly one entry per agent row, keyed by the role in lowercase', () => {
    expect(Object.keys(data.roles).sort()).toEqual(rows.map((r) => r.role.toLowerCase()).sort());
    for (const [k, v] of Object.entries(data.roles)) expect(v.role.toLowerCase()).toBe(k);
  });

  for (const row of agentRows()) {
    it(`${row.role}: the file holds exactly the row's permissions plus Metadata: read`, () => {
      expect(data.roles[row.role.toLowerCase()]?.permissions).toEqual(expectedManifestPermissions(row));
    });

    it(`${row.role}: the file grants nothing the row explicitly denies`, () => {
      const held = data.roles[row.role.toLowerCase()]?.permissions ?? {};
      for (const [k, denied] of Object.entries(parsePermissions(row.prose).denies)) {
        if (denied === 'access') expect(held[k], `${row.role} ${k}`).toBeUndefined();
        else expect(held[k], `${row.role} ${k}`).not.toBe('write');
      }
    });
  }

  it("K-ADOPT-8 still adds Metadata: read to every App and the Merger's two check scopes", () => {
    const chapter = readFileSync(join(process.cwd(), 'rulebook/10-adoption.md'), 'utf8');
    const start = chapter.indexOf('### `K-ADOPT-8`');
    const end = chapter.indexOf('**Why.**', start);
    if (start < 0 || end < 0) throw new Error('rulebook/10-adoption.md: K-ADOPT-8 or its Why line moved');
    const rule = chapter.slice(start, end);
    expect(rule).toContain('plus **Metadata: read** on every App');
    expect(rule).toContain('The Merger also holds **Checks: read** and **Commit statuses: read**');
    expect(data.roles.merger?.permissions).toMatchObject({ checks: 'read', statuses: 'read' });
  });
});

describe('the roles-table reader', () => {
  it('reads every row of the real table, agent or not, without throwing', () => {
    const rows = rolesTable();
    expect(rows.length).toBeGreaterThanOrEqual(12);
    for (const r of rows.filter((x) => x.kind === 'agent')) expect(() => parsePermissions(r.prose)).not.toThrow();
  });

  it('reads the shapes the table uses', () => {
    expect(parsePermissions('Contents, Issues and Pull requests write; Actions read; **no Actions write, no Workflows access**.')).toEqual({
      grants: { contents: 'write', issues: 'write', pull_requests: 'write', actions: 'read' },
      denies: { actions: 'write', workflows: 'access' },
    });
    expect(parsePermissions('Contents write (so its approval satisfies the ruleset), Issues and Pull requests write.').grants).toEqual({
      contents: 'write',
      issues: 'write',
      pull_requests: 'write',
    });
  });

  it('throws on a phrase it cannot read, rather than skipping it', () => {
    expect(() => parsePermissions('Contents read, Administration write.')).toThrow(/Administration/);
    expect(() => parsePermissions('Contents and Issues.')).toThrow(/no read or write/);
    expect(() => parsePermissions('Contents read; no Workflows.')).toThrow(/denial/);
  });
});
