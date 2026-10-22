import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `K-PRIN-2`: a rule has exactly one home. Anything else that needs it cites the rule by id, so a
 * sentence of a rule's **Rule** paragraph copied word for word into a lane prompt, a playbook, a
 * skill, an agent instruction file or a doc is a second home that drifts (kanon#1249).
 *
 * WHAT IT CATCHES. Each rule's **Rule** paragraph is split into sentences, and every sentence of at
 * least `MIN_WORDS` words is searched for in each surface below, both read the same way: links
 * reduced to their text, backticks and bold markers dropped, whitespace collapsed (a YAML prompt is
 * folded across indented lines), and case ignored (a prompt shouts its NEVERs). A shorter sentence
 * ("Never merge.") is too common to be a copy. A paraphrase is not caught; that half stays with
 * the Reviewer, whose playbook cites `K-PRIN-2`.
 *
 * WHERE IT LOOKS. Every workflow under `.github/workflows/` (the lane prompts are its `prompt:`
 * inputs; the whole file is read, so a comment that copies a rule is caught too), the baseline
 * playbooks and templates under `rulebook/templates/`, `skills/`, `docs/`, each action's README,
 * and the top-level documents, `AGENTS.md` and `CLAUDE.md` when present.
 *
 * WHAT IT LEAVES OUT, and why:
 *   - the rulebook's chapters, which are the home;
 *   - `docs/plans/` and `docs/decisions/`: a plan or an ADR is the dated record of a decision that
 *     a rule then states. The rule links back to it as where it came from (rulebook/README.md), so
 *     the record holds the decision's words by design, and rewriting it to cite the rule would
 *     rewrite history. On Kanon, ADR 0004 holds three rule sentences and plan 0010 one, all of them
 *     the decision the rule was written from;
 *   - `CHANGELOG.md`, release notes generated from commit titles, also a record.
 *
 * `ALLOWED` holds a copy that is intentional: each entry names the file, the rule and why. It is
 * empty: on 2026-10-22 the detector found no copy outside the records above.
 */

const MIN_WORDS = 12;

const ROOT = process.cwd();

/** Text as the detector compares it: link text kept, markup dropped, whitespace collapsed, lower case. */
const normalise = (text: string): string =>
  text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** The sentences of a paragraph, each normalised and without its closing punctuation. */
const sentencesOf = (paragraph: string): string[] =>
  normalise(paragraph)
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/[.!?]+$/, '').trim())
    .filter((s) => s.split(' ').length >= MIN_WORDS);

type Sentence = { id: string; sentence: string };

/** Each rule's **Rule** paragraph, from its label to the next blank line, as long sentences. */
const ruleSentences = (chapter: string): Sentence[] => {
  const out: Sentence[] = [];
  let id: string | undefined;
  const lines = chapter.split('\n');
  lines.forEach((line, i) => {
    const heading = /^### `(K-[A-Z]+-\d+)`/.exec(line);
    if (heading) id = heading[1];
    else if (/^#/.test(line)) id = undefined;
    if (!id || !line.startsWith('**Rule.**')) return;
    let end = i;
    while (end + 1 < lines.length && lines[end + 1]!.trim() !== '') end++;
    const paragraph = lines.slice(i, end + 1).join(' ').slice('**Rule.**'.length);
    for (const sentence of sentencesOf(paragraph)) out.push({ id, sentence });
  });
  return out;
};

/** A rule sentence found outside the rulebook: where, which rule, and the sentence. */
type Copy = { file: string; id: string; sentence: string };

const copiesIn = (file: string, text: string, sentences: Sentence[]): Copy[] => {
  const flat = normalise(text);
  return sentences.filter((s) => flat.includes(s.sentence)).map((s) => ({ file, ...s }));
};

const EXCLUDED = [/^docs\/plans\//, /^docs\/decisions\//];

/** An intentional copy: the file, the rule, and why it stays. None today. */
const ALLOWED: { file: string; id: string; why: string }[] = [];

const walk = (dir: string): string[] =>
  !existsSync(join(ROOT, dir))
    ? []
    : readdirSync(join(ROOT, dir)).flatMap((e) => {
        const path = `${dir}/${e}`;
        return statSync(join(ROOT, path)).isDirectory() ? walk(path) : /\.(md|ya?ml)$/.test(e) ? [path] : [];
      });

const SURFACES = (): string[] =>
  [
    ...walk('.github/workflows'),
    ...walk('rulebook/templates'),
    ...walk('skills'),
    ...walk('docs'),
    ...readdirSync(join(ROOT, 'actions')).map((a) => `actions/${a}/README.md`),
    ...['AGENTS.md', 'CLAUDE.md', 'README.md', 'ROADMAP.md', 'CONTRIBUTING.md', 'SECURITY.md'],
  ].filter((f) => existsSync(join(ROOT, f)) && !EXCLUDED.some((re) => re.test(f)));

const CHAPTERS = readdirSync(join(ROOT, 'rulebook')).filter((f) => /^\d\d-.*\.md$/.test(f));
const SENTENCES = CHAPTERS.flatMap((f) => ruleSentences(readFileSync(join(ROOT, 'rulebook', f), 'utf8')));

describe('K-PRIN-2 no rule sentence is copied verbatim outside the rulebook', () => {
  it('reads the rules: every chapter yields sentences long enough to search for', () => {
    // A split that silently found nothing would pass every file below.
    expect(SENTENCES.length).toBeGreaterThan(300);
    for (const f of CHAPTERS) expect(ruleSentences(readFileSync(join(ROOT, 'rulebook', f), 'utf8')).length, f).toBeGreaterThan(0);
  });

  it('reads the surfaces: the lane prompts, the playbooks and the skills are among them', () => {
    const surfaces = SURFACES();
    expect(surfaces).toContain('.github/workflows/agent-implement.yml');
    expect(surfaces).toContain('docs/qa/reviewer-playbook.md');
    expect(surfaces).toContain('rulebook/templates/playbooks/reviewer-playbook.md');
    expect(surfaces).toContain('skills/file-issue/SKILL.md');
    expect(surfaces.some((f) => f.startsWith('docs/plans/') || f.startsWith('docs/decisions/'))).toBe(false);
  });

  it('finds no copy outside the allow-list', () => {
    const copies = SURFACES()
      .flatMap((file) => copiesIn(file, readFileSync(join(ROOT, file), 'utf8'), SENTENCES))
      .filter((c) => !ALLOWED.some((a) => a.file === c.file && a.id === c.id));
    expect(copies.map((c) => `${c.file} copies ${c.id}: "${c.sentence}"; cite the rule by its id instead`)).toEqual([]);
  });

  it('each allow-list entry still matches a copy, so a removed copy takes its entry with it', () => {
    for (const a of ALLOWED) {
      const found = copiesIn(a.file, readFileSync(join(ROOT, a.file), 'utf8'), SENTENCES).some((c) => c.id === a.id);
      expect(found, `${a.file} / ${a.id}`).toBe(true);
    }
  });
});

describe('K-PRIN-2 the detector on fixtures', () => {
  const chapter = [
    '### `K-TEST-1` A fixture rule',
    '',
    '**Rule.** Every merge to the `main` branch is made by a human, or by a merger agent inside a green zone.',
    'Never merge.',
    '',
    '**Why.** Because.',
  ].join('\n');
  const sentences = ruleSentences(chapter);

  it('splits the Rule paragraph, keeping only sentences of at least twelve words', () => {
    expect(sentences).toEqual([
      { id: 'K-TEST-1', sentence: 'every merge to the main branch is made by a human, or by a merger agent inside a green zone' },
    ]);
  });

  it('catches a copy folded across a YAML prompt, in other case and without backticks', () => {
    const prompt = 'prompt: |\n  EVERY MERGE to the main branch is made\n    by a human, or by a **merger agent** inside a green zone.\n';
    expect(copiesIn('lane.yml', prompt, sentences)).toHaveLength(1);
  });

  it('catches a copy that keeps a link, by its text', () => {
    const doc = 'Every merge to the [main branch](x.md) is made by a human, or by a merger agent inside a green zone.';
    expect(copiesIn('doc.md', doc, sentences)).toHaveLength(1);
  });

  it('passes a citation by id and a paraphrase', () => {
    expect(copiesIn('doc.md', 'Merges follow `K-TEST-1`.', sentences)).toEqual([]);
    expect(copiesIn('doc.md', 'A human, or a merger agent in a green zone, makes every merge to main.', sentences)).toEqual([]);
  });
});
