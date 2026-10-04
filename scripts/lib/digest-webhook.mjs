// The chat webhook the two digests post to (plan 0004, decision 7).
//
// The digest lanes map the caller's `DIGEST_WEBHOOK` secret to the variable of the same name,
// and the message stays a `{"text": …}` body. That is the only name read: the transitional
// `SLACK_RELEASE_WEBHOOK` fallback, kept while the reference adopter's callers still passed the
// old name, was removed once they mapped `DIGEST_WEBHOOK`.

/**
 * The webhook URL, or '' when `DIGEST_WEBHOOK` is unset (the digest then posts nothing).
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export const digestWebhook = (env) => env.DIGEST_WEBHOOK || '';
