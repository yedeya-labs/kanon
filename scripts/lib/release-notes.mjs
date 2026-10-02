// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
/**
 * Pure text helpers for turning release-please release bodies into Slack mrkdwn.
 *
 * Extracted verbatim from announce-deploy.mjs so the weekly digest (RA-502) can
 * reuse them instead of growing a second, drifting copy — the two posts read the
 * same release bodies and must categorise them identically, or the same commit
 * gets called a Feature in one and Maintenance in the other.
 *
 * PURE ONLY, deliberately: no fetch, no env, no process. That is what makes this
 * unit-testable (tests/library/release-notes.test.ts) and what kept the extraction
 * from touching announce-deploy's I/O path, which has no test coverage of its own.
 *
 * Dependency-free (Node 20+), matching its callers.
 */

/** Inline markdown → Slack mrkdwn (bold + links) for a single bullet's prose. */
export const slackInline = (s) =>
  s
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/\[(.+?)\]\((https?:[^\s)]+)\)/g, '<$2|$1>');

/**
 * Parse a release-please body into { sectionName: [rawBulletLine, ...] }.
 * Sections are `### Heading`, bullets are `* ...` / `- ...` (any indent).
 */
export function parseSections(md) {
  const sections = {};
  let current = null;
  for (const line of md.replace(/\r\n/g, '\n').split('\n')) {
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      current = h[1].trim();
      sections[current] ??= [];
      continue;
    }
    const b = line.match(/^\s*[-*]\s+(.*)$/);
    if (b && current) sections[current].push(b[1].trim());
  }
  return sections;
}

/** Scopes we always fold into Maintenance, even under a Features/Fixes heading. */
export const INTERNAL_SCOPES = new Set([
  'ci', 'cd', 'qa', 'deps', 'deps-dev', 'build', 'chore', 'chores',
  'test', 'tests', 'docs', 'doc', 'style', 'styles', 'refactor', 'release',
]);

/** Conventional-commit scope of a bullet (`**scope:** …`), or null. */
export const scopeOf = (raw) => raw.match(/^\*\*(.+?):\*\*/)?.[1]?.toLowerCase() ?? null;

/** feature | fix | maint — heading decides, but internal scopes force maint. */
export function classify(heading, scope) {
  if (scope && INTERNAL_SCOPES.has(scope)) return 'maint';
  const h = heading.toLowerCase();
  if (h.includes('feature')) return 'feature';
  if (h.includes('fix') || h.includes('performance') || h.includes('revert')) return 'fix';
  return 'maint';
}

/** Render a raw bullet as `scope: prose (<url|#pr>)`, dropping noise refs. */
export function cleanBullet(raw) {
  const refs = [];
  let s = raw
    .replace(/\s*\(\[([^\]]+)\]\(([^)]+)\)\)/g, (_, label, url) => {
      refs.push({ label, url });
      return '';
    })
    .trim();
  const scope = s.match(/^\*\*(.+?):\*\*\s*/);
  if (scope) s = s.slice(scope[0].length);
  const pr = [...refs].reverse().find((r) => /^#\d+/.test(r.label));
  const link = pr ? ` (<${pr.url}|${pr.label}>)` : '';
  return `${scope ? `${scope[1]}: ` : ''}${slackInline(s)}${link}`;
}

/** Strip the scope prefix from a cleaned bullet — the digest groups BY scope, so repeating it in every line is noise. */
export const dropScopePrefix = (cleaned) => cleaned.replace(/^[a-z0-9._/-]+:\s*/i, '');

/** Headline section: deduped bullets, capped, with a "+N more" tail. */
export function renderList(title, bullets, max = 8) {
  if (bullets.length === 0) return '';
  const cleaned = [...new Set(bullets.map(cleanBullet))];
  const shown = cleaned.slice(0, max);
  const extra = cleaned.length - shown.length;
  return (
    `\n*${title}*\n` +
    shown.map((b) => `• ${b}`).join('\n') +
    (extra > 0 ? `\n  …+${extra} more` : '') +
    '\n'
  );
}

/** Maintenance: roll dependency bumps into a count, list other scopes. */
export function renderMaint(bullets) {
  let deps = 0;
  let approx = false;
  const scopes = new Set();
  for (const raw of bullets) {
    const scope = scopeOf(raw);
    if (scope === 'deps' || scope === 'deps-dev' || /\bbump\b/i.test(raw)) {
      const batch = raw.match(/with (\d+) updates?/i);
      if (batch) {
        deps += Number(batch[1]);
        approx = true;
      } else deps += 1;
    } else if (scope) scopes.add(scope);
  }
  const parts = [];
  if (deps) parts.push(`${approx ? '~' : ''}${deps} dependency update${deps === 1 ? '' : 's'}`);
  if (scopes.size) parts.push(`${[...scopes].sort().join(', ')} updates`);
  return parts.length ? `\n*Maintenance* — ${parts.join(' · ')}\n` : '';
}
