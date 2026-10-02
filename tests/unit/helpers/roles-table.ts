import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Reads chapter 03's roles table, the rule `rulebook/agent-permissions.json` is the twin of
 * (`K-PRIN-2`), and turns each agent row's "GitHub permissions" prose into GitHub manifest
 * permissions. It is strict on purpose: a phrase it can't read throws, rather than being
 * skipped, so prose that drifts into a new shape fails the parity test instead of silently
 * granting nothing.
 */
export const CHAPTER = join(process.cwd(), 'rulebook/03-agents.md');

/** The prose names of GitHub App permissions, as the roles table spells them. */
const KEYS: Record<string, string> = {
  contents: 'contents',
  issues: 'issues',
  'pull requests': 'pull_requests',
  workflows: 'workflows',
  actions: 'actions',
  checks: 'checks',
  'commit statuses': 'statuses',
};

export type Row = { role: string; kind: string; prose: string };
export type Parsed = { grants: Record<string, 'read' | 'write'>; denies: Record<string, 'write' | 'access'> };

/** Every row of the roles table, in order. Throws when the table can't be found. */
export const rolesTable = (text: string = readFileSync(CHAPTER, 'utf8')): Row[] => {
  const lines = text.split('\n');
  const head = lines.findIndex((l) => /^\| Role \| Kind \| May \| May not \| GitHub permissions \|$/.test(l));
  if (head < 0) throw new Error('rulebook/03-agents.md: the roles table header was not found');
  const rows: Row[] = [];
  for (let i = head + 2; i < lines.length && lines[i]?.startsWith('|'); i++) {
    const c = (lines[i] ?? '').split('|').slice(1, -1).map((s) => s.trim());
    if (c.length !== 5) throw new Error(`rulebook/03-agents.md:${i + 1}: a roles-table row needs 5 cells, has ${c.length}`);
    rows.push({ role: (c[0] ?? '').replace(/\*\*/g, ''), kind: c[1] ?? '', prose: c[4] ?? '' });
  }
  return rows;
};

/** The rows that are agents, and so get an App from `kanon apps`. */
export const agentRows = (rows: Row[] = rolesTable()): Row[] => rows.filter((r) => r.kind === 'agent');

const key = (name: string): string => {
  const k = KEYS[name.trim().toLowerCase()];
  if (!k) throw new Error(`"${name.trim()}" is not a GitHub permission the parser knows`);
  return k;
};

/** Turns one row's permissions prose into grants and explicit denials. */
export const parsePermissions = (prose: string): Parsed => {
  const parsed: Parsed = { grants: {}, denies: {} };
  const text = prose.replace(/\*\*/g, '').replace(/\([^)]*\)/g, '').replace(/\.\s*$/, '');
  for (const raw of text.split(';')) {
    const group = raw.trim();
    if (!group) continue;
    if (/^no /i.test(group)) {
      for (const item of group.split(',')) {
        const m = /^\s*no (.+?) (write|access)\s*$/i.exec(item);
        if (!m) throw new Error(`can't read the denial "${item.trim()}"`);
        parsed.denies[key(m[1] ?? '')] = (m[2] ?? '').toLowerCase() as 'write' | 'access';
      }
      continue;
    }
    const pending: string[] = [];
    for (const item of group.split(/,| and /)) {
      const m = /^\s*(.+?)(?: (read|write)(?: only)?)?\s*$/i.exec(item);
      if (!m) throw new Error(`can't read "${item.trim()}"`);
      pending.push(key(m[1] ?? ''));
      if (m[2]) {
        for (const k of pending.splice(0)) {
          if (parsed.grants[k]) throw new Error(`"${prose}" grants ${k} twice`);
          parsed.grants[k] = m[2].toLowerCase() as 'read' | 'write';
        }
      }
    }
    if (pending.length) throw new Error(`"${group}" names ${pending.join(', ')} with no read or write`);
  }
  return parsed;
};

/** What K-ADOPT-8 gives a role's App: its row, plus Metadata: read on every App. */
export const expectedManifestPermissions = (row: Row): Record<string, string> => ({
  ...parsePermissions(row.prose).grants,
  metadata: 'read',
});
