// The chat webhook the two digests post to (plan 0004, decision 7).
//
// The digest lanes map the caller's `DIGEST_WEBHOOK` secret to the variable of the same name,
// and the message stays a `{"text": …}` body. The reference adopter's own digest workflows
// passed `SLACK_RELEASE_WEBHOOK` to these scripts before they called the lanes, so that name
// is still read second: a Kanon pin bump that lands before the adopter's callers switch then
// keeps posting rather than going quiet with a green run.

/**
 * The webhook URL, or '' when neither variable is set (the digest then posts nothing).
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export const digestWebhook = (env) => env.DIGEST_WEBHOOK || env.SLACK_RELEASE_WEBHOOK || '';
