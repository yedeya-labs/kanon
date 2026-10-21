// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
/**
 * Pure text helpers for turning release-please release bodies into chat text. Shared:
 * `parseSections`, `scopeOf`, `INTERNAL_SCOPES` and `bulletProse`. Kanon text, for
 * the deploy announcement's `deploy` message (plan 0011 step N9) and the release announcement's
 * `release` message (kanon#1190): `kanonBullet`, `kanonList`, `kanonMaint`. Nothing here writes a chat system's markup: the weekly digest's `weekly-digest`
 * message (step N8) is Kanon text too, and each hook renders it for its own system.
 *
 * Extracted from announce-deploy.mjs so the weekly digest (RA-502) can reuse them
 * instead of growing a second, drifting copy — the two posts parse the same release
 * bodies and must read each commit's scope identically, which is why `parseSections`,
 * `scopeOf` and `INTERNAL_SCOPES` live here. Only the two announcements categorise,
 * with `classify`; the digest groups by its own `INTERNAL_AREAS`, a superset kept apart
 * so widening it never changes what an announcement calls a Feature.
 *
 * PURE ONLY, deliberately: no fetch, no env, no process. That is what makes this
 * unit-testable (tests/library/release-notes.test.ts, announce-deploy.test.ts).
 *
 * Imports nothing but Kanon's contract library (itself import-free), for `literal`:
 * a release note's line is text nobody controls, and never enters Kanon text bare
 * (plan 0011 §3.1).
 */

import { literal } from './notify-contract.mjs';

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

/**
 * A raw bullet's parts: its scope (`**scope:**`), its prose, and the refs release-please appends
 * (`([label](url))`), each removed from the prose.
 * @param {string} raw
 */
function partsOf(raw) {
  const refs = [];
  let s = raw
    .replace(/\s*\(\[([^\]]+)\]\(([^)]+)\)\)/g, (_, label, url) => {
      refs.push({ label, url });
      return '';
    })
    .trim();
  const scope = s.match(/^\*\*(.+?):\*\*\s*/);
  if (scope) s = s.slice(scope[0].length);
  return { scope: scope ? scope[1] : null, prose: s, refs };
}

/**
 * A raw bullet's prose alone, as plain text: no scope, no refs. The weekly digest groups by
 * scope and links no pull request, so this is all it shows of a bullet; it is a commit's
 * subject, text nobody controls, so the digest puts it into Kanon text through `literal`.
 * @param {string} raw
 */
export const bulletProse = (raw) => partsOf(raw).prose;

/**
 * Maintenance as its parts, each plain text: dependency bumps rolled into a count, other
 * scopes listed. `kanonMaint` joins them into Kanon text.
 */
export function maintParts(bullets) {
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
  return parts;
}

// ------------------------------------------------------------ Kanon text (plan 0011)

/** An `https://` URL a Kanon text link can hold: no whitespace, no parenthesis, no `<>`. */
const LINKABLE = /^https:\/\/[^\s()<>]+$/;

/**
 * A raw bullet as one line of Kanon text, `scope: prose ([#pr](url))`, read by `partsOf`: the
 * scope prefix and noise refs dropped, the last `#N` ref kept as a link. The prose is a commit's subject, so it goes through `literal`; the link is
 * kept only when its URL is `https://`.
 */
export function kanonBullet(raw) {
  const { scope, prose, refs } = partsOf(raw);
  const pr = [...refs].reverse().find((r) => /^#\d+$/.test(r.label) && LINKABLE.test(r.url));
  const link = pr ? ` ([${pr.label}](${pr.url}))` : '';
  return `${scope ? `${literal(scope)}: ` : ''}${literal(prose)}${link}`;
}

/**
 * Raw bullets as a Kanon text body: deduped `- ` lines, capped at `max`, with a last
 * `…and N more` line. Empty when there are none.
 */
export function kanonList(bullets, max = 8) {
  const cleaned = [...new Set(bullets.map(kanonBullet))].filter((b) => b.trim() !== '');
  const shown = cleaned.slice(0, max);
  const extra = cleaned.length - shown.length;
  return [...shown.map((b) => `- ${b}`), ...(extra > 0 ? [`…and ${extra} more`] : [])].join('\n');
}

/** Maintenance as one line of Kanon text, or empty: `maintParts`, each `literal`, joined. */
export const kanonMaint = (bullets) => maintParts(bullets).map(literal).join(' · ');
