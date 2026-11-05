// Writes one role's row into an App register (docs/qa/agent-identities.md, K-LAYOUT-6).
//
// The register is read the way actions/lane-check/app-register.awk reads it: exactly one
// table outside a fenced block whose header starts `| Role | App slug |`, one row per role,
// the role matched with or without bold. This module only writes; the awk program stays the
// one reader the lanes use, and the tests hold what this writes to what it parses.
//
// Each row also records its App's ID, in an `App ID` column (kanon#1607): an App ID isn't secret,
// and GitHub tells a person's token nothing about a private App (#623), so the register is where
// the next repository's `kanon apps --reuse`, and doctor's Releaser bypass check, find it. Every
// reader keys on a column's header, the lanes' on the first two, so the column changes nothing
// for them; a register without it still reads, and gains it when a row with an ID is written.
// `registerAppIds` is the one reader of the column.

/** GitHub's manifest permission keys, in the register's column order, with their column names. */
export const PERMISSION_COLUMNS = /** @type {const} */ ([
  ['contents', 'Contents'],
  ['issues', 'Issues'],
  ['pull_requests', 'Pull requests'],
  ['workflows', 'Workflows'],
  ['actions', 'Actions'],
  ['checks', 'Checks'],
  ['statuses', 'Commit statuses'],
  ['metadata', 'Metadata'],
]);

/**
 * A permission's name in the register: its column's name, or, for a permission with no column
 * (one a repository declares as an extra, `K-AGENT-3`), its key in words, `deployments` →
 * `Deployments`, `repository_hooks` → `Repository hooks`. Such a permission goes in `Other`.
 * @param {string} key
 */
export const permissionName = (key) => {
  const column = PERMISSION_COLUMNS.find(([k]) => k === key);
  if (column) return column[1];
  const words = key.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The column that records each row's App ID (kanon#1607). */
export const APP_ID_COLUMN = 'App ID';

/** The columns a new register gets: the five K-LAYOUT-6 names, then one for anything else, and the App's ID when a row has one. */
const NEW_HEADER = ['Role', 'App slug', 'Contents', 'Issues', 'Pull requests', 'Workflows', 'Actions', 'Other'];

/** @param {string | undefined} level */
const label = (level) => (level === 'write' ? 'Read & write' : level === 'read' ? 'Read' : 'No access');

/** @param {string} s */
const unbold = (s) => {
  let t = s.trim();
  if (/^\*\*.*\*\*$/.test(t) || /^__.*__$/.test(t)) t = t.slice(2, -2).trim();
  return t;
};

/** @param {string} line */
const cells = (line) => line.split('|').slice(1, -1).map((c) => c.trim());

/** @param {string[]} c */
const row = (c) => `| ${c.join(' | ')} |`;

/**
 * Locates the register's table. Returns null when there is none, and throws when there is
 * more than one, because the lanes' reader refuses that register too.
 * @param {string[]} lines
 */
const findTable = (lines) => {
  /** @type {{ header: number, end: number } | null} */
  let found = null;
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^[ \t]*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !/^[ \t]*\|/.test(line)) continue;
    const c = cells(line);
    if (c[0] === 'Role' && c[1] === 'App slug') {
      if (found) throw new Error('docs/qa/agent-identities.md has more than one table headed | Role | App slug |; fix it by hand first');
      let end = i + 1;
      while (end < lines.length && /^[ \t]*\|/.test(lines[end] ?? '')) end++;
      found = { header: i, end };
    }
  }
  return found;
};

/**
 * Returns the register with `role`'s row written, and a diff of what changed.
 * @param {string | null} text the register's current content, or null when the file doesn't exist
 * @param {{ role: string, slug: string, permissions: Record<string, string>, appId?: number | null }} app
 *   `appId`: the App's ID, recorded in the `App ID` column; without it, the row keeps the one it has
 * @returns {{ text: string, diff: string[] }}
 */
export const writeRegisterRow = (text, { role, slug, permissions, appId = null }) => {
  const known = new Map(/** @type {Array<[string, string]>} */ (PERMISSION_COLUMNS.map(([k, n]) => [n, k])));

  /** @param {string[]} header @param {string[] | undefined} old */
  const build = (header, old) => {
    const inColumns = new Set(header.map((h) => known.get(h)).filter(Boolean));
    const other = Object.entries(permissions)
      .filter(([k]) => k !== 'metadata' && !inColumns.has(k))
      .map(([k, v]) => `${permissionName(k)}: ${label(v)}`);
    return header.map((h, i) => {
      if (h === 'Role') return role;
      if (h === 'App slug') return `\`${slug}\``;
      const key = known.get(h);
      if (key) return label(permissions[key]);
      if (h === 'Other') return other.length ? other.join(', ') : 'None';
      if (h === APP_ID_COLUMN && appId !== null) return String(appId);
      return old?.[i] ?? '';
    });
  };

  if (text === null || !findTable(text.split('\n'))) {
    const fresh = appId === null ? NEW_HEADER : [...NEW_HEADER, APP_ID_COLUMN];
    const table = [row(fresh), row(fresh.map(() => '---')), row(build(fresh, undefined))];
    const note = 'Every App also holds Metadata: Read (`K-ADOPT-8`).';
    if (text === null) {
      const created = ['# Agent identities', '', ...table, '', note, ''];
      return { text: created.join('\n'), diff: created.map((l) => `+${l}`) };
    }
    // An empty register says "none installed" (K-LAYOUT-6); the table replaces that line.
    const kept = text.split('\n').filter((l) => !/^\s*[_*]*none installed\.?[_*]*\s*$/i.test(l));
    const removed = text.split('\n').filter((l) => /^\s*[_*]*none installed\.?[_*]*\s*$/i.test(l));
    while (kept.length && kept[kept.length - 1] === '') kept.pop();
    const added = ['', ...table, '', note];
    return { text: [...kept, ...added, ''].join('\n'), diff: [...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)] };
  }

  const lines = text.split('\n');
  const table = /** @type {{ header: number, end: number }} */ (findTable(lines));
  /** @type {string[]} */
  const diff = [];
  let header = cells(lines[table.header] ?? '');

  // A permission the role holds with no column of its own goes in `Other`. A register
  // without that column gains one, and the rows already there say `not recorded` rather
  // than claim the App holds nothing else.
  const inHeader = new Set(header.map((h) => known.get(h)).filter(Boolean));
  const needsOther = Object.keys(permissions).some((k) => k !== 'metadata' && !inHeader.has(k));
  if (needsOther && !header.includes('Other')) {
    for (let i = table.header; i < table.end; i++) {
      const before = lines[i] ?? '';
      const isSep = i === table.header + 1;
      const extra = i === table.header ? 'Other' : isSep ? '---' : 'not recorded';
      lines[i] = `${before.trimEnd()} ${extra} |`;
      diff.push(`-${before}`, `+${lines[i]}`);
    }
    header = [...header, 'Other'];
  }
  // A register from before the App ID column gains it once a row with an ID is written; the rows
  // already there get an empty cell, an ID not recorded, never a guess.
  if (appId !== null && !header.includes(APP_ID_COLUMN)) {
    for (let i = table.header; i < table.end; i++) {
      const before = lines[i] ?? '';
      const extra = i === table.header ? APP_ID_COLUMN : i === table.header + 1 ? '---' : '';
      lines[i] = `${before.trimEnd()} ${extra} |`;
      const prior = diff.indexOf(`+${before}`);
      if (prior >= 0) diff[prior] = `+${lines[i]}`;
      else diff.push(`-${before}`, `+${lines[i]}`);
    }
    header = [...header, APP_ID_COLUMN];
  }

  const matches = [];
  for (let i = table.header + 2; i < table.end; i++) {
    if (unbold(cells(lines[i] ?? '')[0] ?? '') === role) matches.push(i);
  }
  if (matches.length > 1) throw new Error(`docs/qa/agent-identities.md lists the role ${role} ${matches.length} times; fix it by hand first`);
  const at = matches[0];
  if (at === undefined) {
    const added = row(build(header, undefined));
    lines.splice(table.end, 0, added);
    diff.push(`+${added}`);
  } else {
    const before = lines[at] ?? '';
    const after = row(build(header, cells(before)));
    if (after !== before) {
      lines[at] = after;
      // Drop a diff pair the Other column already recorded for this line.
      const prior = diff.indexOf(`+${before}`);
      if (prior >= 0) diff[prior] = `+${after}`;
      else diff.push(`-${before}`, `+${after}`);
    }
  }
  return { text: lines.join('\n'), diff };
};

/**
 * The App ID each role's row records, read from the `App ID` column (kanon#1607): role → ID, for
 * the rows whose cell holds a positive whole number. Empty for a register without the column, or
 * without a table; it throws on nothing, so a reader falls back to its other sources.
 * @param {string | null} text
 * @returns {Map<string, number>}
 */
export const registerAppIds = (text) => {
  /** @type {Map<string, number>} */
  const ids = new Map();
  if (text === null) return ids;
  const lines = text.split('\n');
  /** @type {{ header: number, end: number } | null} */
  let table;
  try {
    table = findTable(lines);
  } catch {
    return ids;
  }
  if (!table) return ids;
  const col = cells(lines[table.header] ?? '').indexOf(APP_ID_COLUMN);
  if (col < 0) return ids;
  for (let i = table.header + 2; i < table.end; i++) {
    const c = cells(lines[i] ?? '');
    const id = /^\d+$/.test(c[col] ?? '') ? Number(c[col]) : 0;
    if (id > 0) ids.set(unbold(c[0] ?? ''), id);
  }
  return ids;
};
