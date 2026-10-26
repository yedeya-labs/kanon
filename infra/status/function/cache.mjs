// The hosted status server's per-person cache (project #1327, decision 5, `[MCP-9]`): the REST
// answers one person's reads got, in the warm container's memory, so the next read of the same
// URL can ask GitHub conditionally and a 304 serves the body GitHub confirmed is current.
//
// PER PERSON, NEVER SHARED. Each person's entries are filed under a SHA-256 of their own GitHub
// token, and a reader is handed only its person's (`for`), so one person's answer can't reach
// another. The cache holds the hash, never the token.
//
// AT MOST `CACHE_TTL_MS`. An entry is dropped that long after GitHub answered it with a body, even
// if GitHub has confirmed it since: a body read to find a marker is held no longer than that. It
// is never served without asking GitHub (the reader always revalidates), so an answer is always
// live. GraphQL is never cached: GitHub has no conditional GraphQL.

import { createHash } from 'node:crypto';

/** How long an entry lives, as docs/status.md states it. */
export const CACHE_TTL_MS = 60_000;

/** @typedef {{ etag: string, text: string, link: string | null }} Entry one GET's answer: its ETag, its body's text and its `Link` header */
/** @typedef {{ get: (url: string) => Entry | null, put: (url: string, entry: Entry) => void }} PersonCache */

/**
 * The container's cache.
 * @param {{ now?: () => number, maxPeople?: number, maxEntries?: number }} [opts]
 */
export function readCache({ now = () => Date.now(), maxPeople = 200, maxEntries = 500 } = {}) {
  /** @type {Map<string, Map<string, Entry & { at: number }>>} */
  const people = new Map();

  const sweep = () => {
    const t = now();
    for (const [who, entries] of people) {
      for (const [url, e] of entries) if (t - e.at >= CACHE_TTL_MS) entries.delete(url);
      if (!entries.size) people.delete(who);
    }
  };

  return {
    /**
     * One person's cache, by their GitHub token.
     * @param {string} token
     * @returns {PersonCache}
     */
    for(token) {
      const who = createHash('sha256').update(token, 'utf8').digest('hex');
      return {
        get: (url) => {
          sweep();
          const e = people.get(who)?.get(url);
          return e ? { etag: e.etag, text: e.text, link: e.link } : null;
        },
        put: (url, { etag, text, link }) => {
          sweep();
          let entries = people.get(who);
          if (!entries) {
            if (people.size >= maxPeople) people.delete(/** @type {string} */ (people.keys().next().value));
            entries = new Map();
            people.set(who, entries);
          }
          entries.delete(url);
          if (entries.size >= maxEntries) entries.delete(/** @type {string} */ (entries.keys().next().value));
          entries.set(url, { etag, text, link, at: now() });
        },
      };
    },
    /** Whose entries it holds, as their tokens' hashes, after dropping what has lived its time. */
    keys: () => {
      sweep();
      return [...people.keys()];
    },
  };
}
