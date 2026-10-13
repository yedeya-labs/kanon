// Whether a text holds a registered adopter key: the one rule every key-in-text check reads (#737),
// at intake (`infra/telemetry/function/rows.mjs`), in the #41 job's output (`kanon-findings.mjs`)
// and in Jev's request (`jev.mjs`). A key need not have the shape the scrub's `key` rule refuses,
// so each of them searches the text for every registered key.
//
// Imports nothing, so the ingest function may link it into its package, as it links `band.mjs`.

/** A letter or a digit, the only characters that can continue a key. */
const ALNUM = /[a-z0-9]/;

/**
 * Whether `text` holds `key` in any case, joined to its neighbours by anything but a letter or a
 * digit: a space, `_`, `-`, a dot. A key may itself hold `-`, so `text` is searched for the key
 * whole, not split into words. A key inside a longer run of letters and digits is not found, so a
 * short key doesn't match every word it is a part of.
 * @param {string} text
 * @param {string} key a registered key, lowercase
 */
export function holdsKey(text, key) {
  if (!key) return false;
  const t = text.toLowerCase();
  for (let i = t.indexOf(key); i !== -1; i = t.indexOf(key, i + 1)) {
    if (!ALNUM.test(t[i - 1] ?? '') && !ALNUM.test(t[i + key.length] ?? '')) return true;
  }
  return false;
}
