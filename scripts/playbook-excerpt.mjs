#!/usr/bin/env node
// @ts-nocheck -- moved from the reference adopter's pipeline library, which doesn't type-check its scripts (plan 0001 §3; ADR 0009)
// RA-2488 option 2 — the merge-reconcile arm reads only the part of the reviewer playbook
// it uses.
//
// WHY. `agent-merge-reconcile.yml` told the Reviewer to "read docs/qa/reviewer-playbook.md,
// especially Capturing follow-ups". The whole file is ~44 KB (~11k tokens); the reconcile
// job only files fallback follow-ups, so everything about reviewing a LIVE PR — modes,
// the red-test check, verdicts, the base-pin, output — is context it writes to cache and
// re-reads on every later turn for nothing. Asking the model to "read only section X" is
// a request it can ignore; this cuts the file before the model starts, with no model.
//
// WHAT IS KEPT. `## Capturing follow-ups` (the filing rules: bar, dedup, labels,
// severity, milestone, one-call create, body shape) and `## Beware your own suggested
// fix`, because the first links to the second for how to write — or omit — a remedy in
// a filed body. `tests/unit/playbook-excerpt.test.ts` asserts every in-page link in
// the excerpt resolves inside it, so a new cross-reference cannot silently dangle.
//
// FAILS SAFE, AND LOUDLY. If a heading is not found (renamed, reworded), the output is
// the WHOLE playbook plus a `::warning` in the run log — today's behaviour, never less
// context. The unit test keys on the same `SECTIONS`, so a rename reds CI rather than
// quietly reverting the saving. The script always exits 0 and the workflow step is
// `continue-on-error`; if no file is written at all, the prompt says to read the full
// playbook instead.
//
// TRUST. The section list is a constant in this file, not an argument, and the workflow
// runs this script and reads the playbook from its default-branch checkout — so the
// merged PR's content does not choose what is extracted. That is the whole claim: the
// `run:` line and the prompt live in whichever workflow copy executes, and a copy on
// another ref (a `workflow_dispatch --ref`) can change either. Same boundary as the
// playbook read it replaces.
//
// LINKS. The playbook's relative links (`./explorer-playbook.md`) are written for
// docs/qa/; the excerpt lives elsewhere, so they are rewritten to repo-root paths
// (`docs/qa/explorer-playbook.md`), which is also the agent's working directory.
//
// `node:` builtins only, like every script under scripts/.
//
// Usage: playbook-excerpt.mjs [--out <path>]   (default out: EXCERPT_PATH, which the workflow uses)

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, posix } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PLAYBOOK = 'docs/qa/reviewer-playbook.md';

/** Gitignored, and `.agent/` is in runner-artifact-guard's DIRS, so it cannot be committed. */
export const EXCERPT_PATH = '.agent/reviewer-playbook-excerpt.md';

/** Level-2 headings kept, matched as a PREFIX of the heading text, in output order. */
export const SECTIONS = ['Capturing follow-ups', 'Beware your own suggested fix'];

/**
 * Each wanted `## ` section — its heading line up to (not including) the next `## `
 * heading or end of file. `###` and deeper stay inside their section. Fenced code is
 * skipped when looking for headings, so a `## ` inside a fence cannot split a section.
 *
 * @param {string} text
 * @param {string[]} prefixes
 * @returns {{ sections: string[], missing: string[] }}
 */
export function extractSections(text, prefixes) {
  const lines = String(text ?? '').split('\n');
  const starts = []; // { at, title }
  // CommonMark: a fence closes only on the same character, at least as long as it opened.
  let fence = null;
  lines.forEach((line, at) => {
    const f = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (f && !fence) fence = f;
    else if (f && fence && f[0] === fence[0] && f.length >= fence.length && /^\s*[`~]+\s*$/.test(line)) fence = null;
    const m = !fence && !f && /^## (.+)$/.exec(line);
    if (m) starts.push({ at, title: m[1].trim() });
  });
  const sections = [];
  const missing = [];
  for (const prefix of prefixes) {
    const i = starts.findIndex((s) => s.title.startsWith(prefix));
    if (i < 0) { missing.push(prefix); continue; }
    const end = i + 1 < starts.length ? starts[i + 1].at : lines.length;
    sections.push(lines.slice(starts[i].at, end).join('\n').trimEnd());
  }
  return { sections, missing };
}

const DOC_DIR = dirname(PLAYBOOK);

/** Re-root the playbook's `./x.md` / `../x.md` links so they still resolve from the excerpt. */
export const rebaseLinks = (text) =>
  text.replace(/\]\((\.{1,2}\/[^)\s]*)\)/g, (_, rel) => `](${posix.normalize(posix.join(DOC_DIR, rel))})`);

/**
 * The file the agent reads. On any missing section, the whole playbook — never a partial
 * excerpt, which would drop rules without saying which.
 *
 * @param {string} playbook  the playbook text
 * @returns {{ text: string, fallback: boolean, missing: string[] }}
 */
export function buildExcerpt(playbook) {
  const { sections, missing } = extractSections(playbook, SECTIONS);
  if (missing.length) {
    return {
      fallback: true,
      missing,
      text:
        `<!-- ${PLAYBOOK}, IN FULL: the excerpt step could not find ${missing.map((m) => `"## ${m}"`).join(', ')} (RA-2488). -->\n\n` +
        rebaseLinks(playbook),
    };
  }
  const header = [
    `# Reviewer playbook — the sections merge-reconciliation uses`,
    '',
    `Cut from \`${PLAYBOOK}\` on the default branch by \`scripts/playbook-excerpt.mjs\` before this run started (no model; RA-2488).`,
    'The rest of that playbook is about reviewing a PR that is still open — modes, the red-test check, verdicts, output — and does not apply to an already-merged PR, so it is deliberately left out.',
    '',
  ].join('\n');
  return { fallback: false, missing: [], text: `${header}\n${rebaseLinks(sections.join('\n\n'))}\n` };
}

function main() {
  const i = process.argv.indexOf('--out');
  const out = i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : EXCERPT_PATH;
  try {
    const playbook = readFileSync(PLAYBOOK, 'utf8');
    const { text, fallback, missing } = buildExcerpt(playbook);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
    if (fallback) {
      console.log(`::warning title=playbook-excerpt::heading(s) not found in ${PLAYBOOK}: ${missing.join('; ')} — wrote the WHOLE playbook to ${out} (RA-2488)`);
    } else {
      console.log(`playbook excerpt: ${out} (${Buffer.byteLength(text)} of ${Buffer.byteLength(playbook)} bytes)`);
    }
  } catch (err) {
    console.log(`::warning title=playbook-excerpt::could not write ${out}: ${err instanceof Error ? err.message : String(err)} — the prompt falls back to ${PLAYBOOK}`);
  }
}

const IS_CLI = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href;
  } catch {
    return false;
  }
})();
if (IS_CLI) main();
