// Writes one role's row into an App register (docs/qa/agent-identities.md, K-LAYOUT-6).
//
// The register is read the way actions/lane-check/app-register.awk reads it: exactly one
// table outside a fenced block whose header starts `| Role | App slug |`, one row per role,
// the role matched with or without bold. This module only writes; the awk program stays the
// one reader the lanes use, and the tests hold what this writes to what it parses.

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

/** The columns a new register gets: the five K-LAYOUT-6 names, then one for anything else. */
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
 * @param {{ role: string, slug: string, permissions: Record<string, string> }} app
 * @returns {{ text: string, diff: string[] }}
 */
export const writeRegisterRow = (text, { role, slug, permissions }) => {
  const known = new Map(/** @type {Array<[string, string]>} */ (PERMISSION_COLUMNS.map(([k, n]) => [n, k])));
  const nameOf = new Map(/** @type {Array<[string, string]>} */ (PERMISSION_COLUMNS.map(([k, n]) => [k, n])));
  for (const key of Object.keys(permissions)) {
    if (!nameOf.has(key)) throw new Error(`no register column is known for the permission "${key}"`);
  }

  /** @param {string[]} header @param {string[] | undefined} old */
  const build = (header, old) => {
    const inColumns = new Set(header.map((h) => known.get(h)).filter(Boolean));
    const other = Object.entries(permissions)
      .filter(([k]) => k !== 'metadata' && !inColumns.has(k))
      .map(([k, v]) => `${nameOf.get(k)}: ${label(v)}`);
    return header.map((h, i) => {
      if (h === 'Role') return role;
      if (h === 'App slug') return `\`${slug}\``;
      const key = known.get(h);
      if (key) return label(permissions[key]);
      if (h === 'Other') return other.length ? other.join(', ') : 'None';
      return old?.[i] ?? '';
    });
  };

  if (text === null || !findTable(text.split('\n'))) {
    const table = [row(NEW_HEADER), row(NEW_HEADER.map(() => '---')), row(build(NEW_HEADER, undefined))];
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
  const needsOther = Object.keys(permissions).some((k) => k !== 'metadata' && !header.includes(nameOf.get(k) ?? ''));
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
