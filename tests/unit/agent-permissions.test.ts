import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentRows, appsTable, expectedManifestPermissions, grantsOf, parsePermissions, rolesTable, unionOf } from './helpers/roles-table.js';

/**
 * `rulebook/agent-permissions.json` is the roles table's permissions column in a form code
 * can read (`kanon apps` builds every App manifest from it). The table is the rule and the
 * file its twin, so this test is the parity check `K-PRIN-2` asks for where a restatement
 * can't be avoided: each agent row's prose, plus what `K-ADOPT-8` adds, must equal the file.
 */
const data = JSON.parse(readFileSync(join(process.cwd(), 'rulebook/agent-permissions.json'), 'utf8')) as {
  roles: Record<string, { role: string; permissions: Record<string, string> }>;
  apps: Record<string, { app: string; roles: string[]; permissions: Record<string, string>; broadened?: Record<string, string> }>;
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

/**
 * ADR 0013: the agent roles, and the Releaser, run under three Apps. Each App's permissions
 * are the union of its roles' rows of the roles table, plus Metadata: read (K-ADOPT-8), plus
 * a broadening recorded with its reason (K-AGENT-3). The one broadening is the Author's
 * Commit statuses write, for the implementer status (plan 0005, question 6); any other is a
 * decision this test makes a reviewer see.
 */
const BROADENED: Record<string, Record<string, string>> = { author: { statuses: 'write' } };

describe("the three Apps hold the union of their roles' rows (ADR 0013, K-ADOPT-8)", () => {
  const table = appsTable();
  const byRole = new Map(rolesTable().map((r) => [r.role.toLowerCase(), r]));
  const broadenedOf = (key: string) => Object.fromEntries(Object.entries(data.apps[key]?.broadened ?? {}).filter(([k]) => !k.startsWith('$')));

  it('finds the three Apps in the table and the file, so the checks below are not vacuous', () => {
    expect(table.map((a) => a.app)).toEqual(['Author', 'Judge', 'Releaser']);
    expect(Object.keys(data.apps).sort()).toEqual(['author', 'judge', 'releaser']);
    for (const [k, v] of Object.entries(data.apps)) expect(v.app.toLowerCase()).toBe(k);
  });

  it("the table and the file give each App the same roles", () => {
    for (const row of table) expect(data.apps[row.app.toLowerCase()]?.roles, row.app).toEqual(row.roles.map((r) => r.toLowerCase()));
  });

  it('every agent role, and the Releaser, belongs to exactly one App, and every App role is a row of the roles table', () => {
    const owners = new Map<string, string[]>();
    for (const [app, v] of Object.entries(data.apps)) for (const r of v.roles) owners.set(r, [...(owners.get(r) ?? []), app]);
    for (const r of [...agentRows().map((x) => x.role.toLowerCase()), 'releaser']) expect(owners.get(r) ?? [], r).toHaveLength(1);
    for (const r of owners.keys()) expect(byRole.has(r), `${r} is not a row of the roles table`).toBe(true);
  });

  for (const key of ['author', 'judge', 'releaser']) {
    it(`${key}: its permissions are the union of its roles' rows, plus Metadata: read, plus its recorded broadening`, () => {
      const app = data.apps[key];
      if (!app) throw new Error(`agent-permissions.json has no App "${key}"`);
      const union = unionOf(app.roles.map((r) => grantsOf(byRole.get(r)?.prose ?? '')));
      expect(app.permissions).toEqual({ ...union, ...broadenedOf(key), metadata: 'read' });
    });

    it(`${key}: its broadening is exactly the recorded one, and each entry is broader than its roles' rows`, () => {
      const app = data.apps[key];
      const union = unionOf((app?.roles ?? []).map((r) => grantsOf(byRole.get(r)?.prose ?? '')));
      const broadened = broadenedOf(key);
      expect(broadened).toEqual(BROADENED[key] ?? {});
      for (const [k, v] of Object.entries(broadened)) expect(union[k] === v || (union[k] === 'write' && v === 'read'), `${key} ${k}`).toBe(false);
      if (Object.keys(broadened).length) expect(typeof app?.broadened?.['$why'], `${key}'s broadening has no reason`).toBe('string');
    });
  }

  it("the Apps table's permissions prose equals the file, less Metadata: read", () => {
    for (const row of table) {
      const { metadata, ...held } = data.apps[row.app.toLowerCase()]?.permissions ?? {};
      expect(metadata, row.app).toBe('read');
      expect(grantsOf(row.prose), row.app).toEqual(held);
    }
  });

  it('only the Author holds Workflows, and the Judge never does (K-AGENT-7)', () => {
    expect(Object.entries(data.apps).filter(([, v]) => v.permissions.workflows).map(([k]) => k)).toEqual(['author']);
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
