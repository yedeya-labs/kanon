import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './helpers/adopter.js';
import { parse } from 'yaml';
import { jobPrompt } from '../unit/helpers/spine.js';
const { parseProposed, report } = await import('../../scripts/lead-reconcile.mjs');

/**
 * RA-967 — the decomposition contract has more than one copy, and nothing checked
 * that they are the same contract.
 *
 * A brief's `## Decomposition` section is the ONE machine-readable thing the
 * pipeline requires of a brief (RA-949 keeps everything else free). That contract is
 * stated in three places, and they have already disagreed twice, both times within
 * hours, both times caught by eye in review rather than by a check:
 *
 *   1. `.github/workflows/agent-lead.yml` — the prompt example, which is what the
 *      brief author writes to.
 *   2. `scripts/project-closure.mjs` (was `lead-reconcile.mjs`) — `ISSUE_RE` / `MILESTONE_RE` / `DEPENDS_RE`
 *      and the narrative example above them, which is what reads it back.
 *   3. `report()`'s `brief-unparseable` text, which is what tells whoever has to
 *      FIX a brief what shape to write.
 *
 * The two live disagreements, both from PR RA-956's own history: the original
 * contract (`- [ ] **Title** — summary — milestone: X`) was written from
 * imagination and the first real brief parsed ZERO items against it; and the prompt
 * told the author to name a brief file with a slug while `readWorld` keys the whole
 * project off a numeric tracking issue. Neither was a check away from being caught —
 * there was no check.
 *
 * ── WHAT THIS LOCKS, AND WHAT IT DELIBERATELY DOES NOT ──────────────────────
 *
 * EACH COPY IS CHECKED AGAINST THE PARSER, NOT AGAINST THE OTHER COPIES. That is the
 * whole mechanism, and the distinction decides what this can and cannot catch. RA-949's
 * position is that the shape stays derived from real briefs rather than imposed, so
 * this takes whatever example a copy writes, feeds it to the real `parseProposed`, and
 * requires that every field the example DECLARES is a field the parser READ.
 *
 * So: drift ONE copy to a shape the parser reads differently and THAT copy reds, which
 * is the drift that costs something — a prompt teaching a brief the tick will refuse,
 * or a `brief-unparseable` report quoting a shape that does not parse. Change what an
 * example SAYS while keeping the shape — a different title, milestone, adoption or
 * dependency count, in one copy or all of them — and this stays green, because the
 * copies are never compared to each other. Measured, not assumed: rewording only
 * `agent-lead.yml`'s example title leaves all 28 tests passing (RA-1659 review, and this
 * PR's own mutation table says the same).
 *
 * FOUR FIXED POINTS, AND THEY ARE NOT FREE. An earlier draft of this paragraph claimed
 * the assertions "never name `###`, `—` or `**Milestone:**`", and that is not what the
 * code does: the extractor anchors on the `### Issue` heading, and three assertions key
 * on the literal `**Milestone`, `**Closes ` and `**Depends on:` markers. A synchronised
 * rename of any of those four REDS here — which fails safe, since the alternative is
 * passing vacuously on a format nothing parses — but it is a real bound on RA-949's
 * freedom and belongs stated rather than discovered.
 *
 * `**Labels:` IS A FIFTH LITERAL AND THE ONLY ONE THAT FAILS OPEN, because labels are
 * optional: the assertion returns early when the marker is absent, so a synchronised
 * rename turns it into a silent SKIP rather than a red. Named here because "four fixed
 * points, everything else is the author's" would otherwise read as though nothing else
 * were keyed on a literal. Everything beyond these five is still the author's.
 *
 * The readings here are deliberately dumber than the parser's — "every `#N` inside
 * the `**Closes …**` span", not the parser's leading-run anchor. That asymmetry is
 * the point: a guard that re-implements the thing it guards shares its bugs, and
 * an example the parser reads only partially is a misleading example whichever
 * side is at fault.
 *
 * AGENTS.md already names this class for its own routing table — "a documented rule
 * that has drifted from the copies enforcing it is worse than either alone" (RA-636,
 * RA-691, RA-719). This is that rule applied to a regex instead of a table.
 */


/** Every decomposition example in a piece of text, dedented and unprefixed.
 *
 *  ONE EXTRACTOR FOR ALL THREE COPIES, because they are written three different
 *  ways: indented prose inside a YAML block scalar, an indented block inside a `//`
 *  comment run, and a fenced block inside a rendered report. The prefix is whatever
 *  precedes the issue heading on its own line — spaces, `// `, ` * ` — and the block
 *  is the run of following lines carrying that same prefix, ending at a closing
 *  fence or at the first line that dedents back out to prose.
 *
 *  A "blank" line inside a comment run is the bare marker (`//`), not an empty
 *  string, so a line equal to the TRIMMED prefix counts as blank rather than
 *  terminating the block. Getting that wrong would truncate every comment example at
 *  its first paragraph break and still look like it worked. */
export function decompositionExamples(text: string): string[] {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(.*?)###\s+Issue\s/.exec(lines[i]);
    // Only a comment/indent/quote prefix. Anything else is prose ABOUT an example
    // ("write `### Issue B — …`"), not an example, and dedenting it yields nonsense.
    if (!m || !/^[\s/*>|-]*$/.test(m[1])) continue;
    const prefix = m[1];
    const block: string[] = [];
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (block.length && /^\s*```/.test(line)) break;
      if (line.trim() === prefix.trim()) { block.push(''); continue; }
      if (!line.startsWith(prefix)) break;
      block.push(line.slice(prefix.length));
    }
    while (block.length && block.at(-1) === '') block.pop();
    out.push(block.join('\n'));
  }
  return out;
}

const workflow = parse(readFileSync(join(ROOT, '.github/workflows/agent-lead.yml'), 'utf8'));
// Since RA-2609 the lane hands its prompt to the spine as an input (`jobPrompt` reads either shape).
const prompt: string = jobPrompt(workflow.jobs.brief);

// The parser and the example above it moved to `project-closure.mjs` (cleanup round 5).
const reconcileSource = readFileSync(join(ROOT, 'scripts/project-closure.mjs'), 'utf8');

/** The `brief-unparseable` report as a human actually receives it.
 *
 *  RENDERED, NOT GREPPED OUT OF THE SOURCE. That text is a template literal on one
 *  physical line with `\n` escapes, so a line-based scan of the file cannot see it at
 *  all — and a guard that silently found nothing there would be the third copy going
 *  unguarded while the test reported green. */
const unparseableReport: string = report(
  {
    project: '952',
    briefMerged: true,
    briefPath: 'docs/projects/952.md',
    proposed: parseProposed('# Brief with no decomposition\n'),
    filed: [], open: [], blocked: [], all: [], unmilestoned: [], searchHits: 0,
  },
  { phase: 'brief-unparseable', actions: [], stopped: null },
);

/** The three copies, each named by what it is FOR — the author, the parser, the
 *  person fixing a brief the parser rejected. */
const COPIES: Array<[string, string]> = [
  ['agent-lead.yml — the example the brief author writes to', prompt],
  ['project-closure.mjs — the example above the parser that reads it', reconcileSource],
  ['report() — the shape quoted back when a brief does not parse', unparseableReport],
];

describe('the decomposition contract is stated the same way everywhere (RA-967)', () => {
  // THE GUARD OF THE GUARD. Every assertion below is `it.each` over the examples
  // found — so deleting an example, or reformatting one until the extractor no
  // longer recognises it, would leave the suite green with nothing tested. This is
  // what makes that a red instead.
  it.each(COPIES)('%s states the contract by example', (_name, text) => {
    expect(decompositionExamples(text).length).toBeGreaterThan(0);
  });

  const cases = COPIES.flatMap(([name, text]) =>
    decompositionExamples(text).map((example, i) => ({ name, i, example })));

  it('finds one example per copy, so nothing below runs vacuously', () => {
    expect(cases.length).toBeGreaterThanOrEqual(COPIES.length);
  });

  describe.each(cases)('$name (example $i)', ({ example }) => {
    // Prefixed with the heading the parser anchors on, because an example shows the
    // ITEM, not the section around it. Anchoring is `parseProposed`'s own business
    // and has its own tests; this is about the item's shape.
    const parsed = parseProposed(`## Decomposition\n\n${example}`) as unknown as
      { residue?: string[] } & Array<{
        key: string; title: string; body: string; milestone: string | null;
        labels: string[]; closes: number[]; dependsOnKeys: string[];
        droppedLabels: string[]; droppedCloses: number[]; droppedDeps: string[];
        droppedLines: string[];
      }>;
    const headings = example.split('\n').filter((l) => /^###\s+Issue\s/.test(l));
    const item = parsed[0];

    it('parses to exactly the items it shows, with nothing left over', () => {
      // A copy that shows two items and parses one is the RA-956 failure with a
      // smaller blast radius: the tick files a prefix and reports progress.
      expect(parsed.length).toBe(headings.length);
      expect(parsed.residue ?? []).toEqual([]);
    });

    it('reads the key and the title the heading declares', () => {
      const [, key, title] = /###\s+Issue\s+(\S+)\s*[—–-]\s*(.+?)\s*$/.exec(headings[0]) ?? [];
      expect(item?.key).toBe(key);
      expect(item?.title).toBe(title);
    });

    it('reads the milestone the example declares', () => {
      const line = example.split('\n').find((l) => /\*\*Milestone:?\*?\*?:?/.test(l));
      // The milestone is not optional — `nextActions` refuses to file without one —
      // so an example that omits it teaches a brief the tick will not act on.
      expect(line, 'every copy must show the milestone; the tick refuses to file without one').toBeTruthy();
      expect(item?.milestone).toBeTruthy();
      expect(line).toContain(item.milestone);
    });

    it('reads every label the example declares, and invents none', () => {
      if (!/\*\*Labels:/.test(example)) return;
      expect(item.labels.length).toBeGreaterThan(0);
      expect(item.droppedLabels).toEqual([]);
      for (const label of item.labels) expect(example).toContain(label);
    });

    it('adopts every issue the example writes into its `Closes` span', () => {
      const span = /\*\*Closes\s[^*]*/.exec(example)?.[0];
      if (!span) { expect(item.closes).toEqual([]); return; }
      // A span that names no `#N` adopts nothing, so the loop below would pass on it.
      expect(span).toMatch(/#\d+/);
      // Deliberately wider than the parser's leading-run read: every reference the
      // span shows must be one the parser took. An example whose span holds a number
      // the parser drops is teaching an adoption that will not happen.
      for (const [, n] of span.matchAll(/#(\d+)/g)) expect(item.closes).toContain(Number(n));
      expect(item.droppedCloses).toEqual([]);
    });

    it('holds on every dependency the example names', () => {
      const line = example.split('\n').find((l) => /\*\*Depends on:/.test(l));
      if (!line) { expect(item.dependsOnKeys).toEqual([]); return; }
      // Parentheticals are per-dependency rationale (RA-1300/RA-1310) and may name
      // anything; the references are what is left when they are removed.
      const named = [...line.replace(/\([^)]*\)/g, ' ').matchAll(/Issue\s+([A-Z0-9]+)/g)].map((m) => m[1]);
      expect(named.length).toBeGreaterThan(0);
      for (const key of named) expect(item.dependsOnKeys).toContain(key);
      expect(item.droppedDeps).toEqual([]);
    });

    it('keeps the body, and discards nothing from the item', () => {
      // The body is filed VERBATIM as the issue's acceptance criteria, and the file
      // phase refuses an empty one. An example whose body the parser eats is an
      // example of a brief that cannot be filed.
      const hasBody = example.split('\n').slice(headings.length).some((l) => l.trim() && !/^\*\*[A-Z]/.test(l.trim()));
      if (hasBody) expect(item.body).not.toBe('');
      expect(item.droppedLines).toEqual([]);
    });
  });

  // RA-995's deletion, made permanent. The superseded one-liner
  // (`- [ ] **Title** — summary — milestone: X`) was written from imagination and
  // parses to nothing; it survived above `parseProposed` as a JSDoc block for months
  // after the code stopped implementing it, which is what an editor showed on hover
  // and what the next agent read first. The examples above cannot catch it, because
  // the extractor only recognises examples in the CURRENT shape — a copy stating the
  // old one is invisible to them rather than red.
  //
  // INLINE CODE SPANS ARE EXEMPT, and the exemption is load-bearing rather than a
  // convenience: `project-closure.mjs` explains the deletion by quoting the format it
  // replaced, and a rule that forbade naming the old shape would forbid recording why
  // it went. A backticked mention is a mention; an unquoted one is a copy.
  it.each(COPIES)('%s does not still document the superseded one-liner (RA-995)', (_name, text) => {
    expect(text.replace(/`[^`\n]*`/g, '')).not.toMatch(/-\s*\[[ xX]\]\s*\*\*[^*\n]+\*\*\s*[—–-][^\n]*milestone:/i);
  });
});
