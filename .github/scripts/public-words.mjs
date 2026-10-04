// The reference adopter's names, kept out of Kanon's public history without spelling them
// out: a guard that listed them would publish them. Kanon was extracted from a private
// reference adopter, and the list of names is kept in the private extraction repository.
// Each entry is the SHA-256 of one forbidden word, in lowercase.
//
// Two guards read this list. tests/unit/public-tree.test.ts hashes every word of every
// tracked file. This script, run by .github/workflows/public-text.yml, hashes every word
// of a pull request's title and body (#239). The repository squash-merges with the PR's
// title and body as the commit message, so a name in either would reach main's history
// through the commit even when no tracked file holds it, and only a force-push could take
// it out.
//
// The script never prints the word it found, only where it found it: a public run's log
// would publish it just as the file would.
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const FORBIDDEN_WORD_HASHES = new Set([
  'eb6d4cb1d4d4fd087a92bd52a7c778fbcc46dc621ba6344f6fd93e047acdcc33',
  '158385f3d76e7655f02bd15674a48626946ece7464201dbc4400e73209880c7e',
  '898bf036643470de81f5b53327142a6aa333296219b9af8c09b652bc12011c88',
]);

/** @param {string} word */
export const sha256 = (word) => createHash('sha256').update(word).digest('hex');

/**
 * Whether the text holds a forbidden word: each lowercased run of `[a-z0-9]` is hashed and
 * looked up, so a name inside punctuation, a URL or a path is still one word.
 * @param {string} text
 * @param {Set<string>} [hashes]
 */
export const namesForbiddenWord = (text, hashes = FORBIDDEN_WORD_HASHES) =>
  (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).some((w) => hashes.has(sha256(w)));

/**
 * The parts of a pull request's text that hold a forbidden word, by name.
 * @param {{ title?: string, body?: string }} pr
 * @param {Set<string>} [hashes]
 * @returns {string[]}
 */
export const forbiddenParts = ({ title = '', body = '' }, hashes = FORBIDDEN_WORD_HASHES) =>
  [['the title', title], ['the body', body]].filter(([, text]) => namesForbiddenWord(text ?? '', hashes)).map(([part]) => part ?? '');

/** @param {string[]} parts */
export const advice = (parts) => [
  `The pull request's ${parts.join(' and ')} name${parts.length === 1 ? 's' : ''} the reference adopter.`,
  'This repository squash-merges with the title and body as the commit message, so the name would enter main\'s history.',
  'Edit it out, which re-runs this check. GitHub keeps every earlier revision of a description in its edit history,',
  'readable by anyone: open the "edited" menu on the description and delete each revision that holds the name.',
].join('\n');

/**
 * The check itself: the exit code and what to print, for a PR's title and body as the
 * workflow passes them in the environment.
 * @param {Record<string, string | undefined>} env
 * @param {Set<string>} [hashes]
 * @returns {{ code: number, message: string }}
 */
export const check = (env, hashes = FORBIDDEN_WORD_HASHES) => {
  const parts = forbiddenParts({ title: env.PR_TITLE ?? '', body: env.PR_BODY ?? '' }, hashes);
  return parts.length
    ? { code: 1, message: `::error title=The reference adopter is named::${advice(parts).replaceAll('\n', '%0A')}` }
    : { code: 0, message: 'Neither the title nor the body names the reference adopter.' };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { code, message } = check(process.env);
  console.log(message);
  process.exit(code);
}
