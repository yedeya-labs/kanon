// Kanon's Slack hook (plan 0011 §7.2): one Kanon notification, posted to one Slack incoming webhook
// as Block Kit with a `text` fallback.
//
// WHERE IT RUNS. In the `notify` job only (plan 0011 §5), through the hook an adopter keeps at
// `.github/actions/notify/action.yml`, which `kanon init --chat slack` writes from
// `actions/notify/hooks/slack.yml`: that file's one step is this action, at a Kanon release. It
// reads the hook interface's four inputs (§6.1) and nothing else, through the environment:
// `MESSAGE_FILE` (`message-v1`), `TEXT_FILE` (`text`, unused: Slack gets its own rendering),
// `KIND` and `SECRET`.
//
// ONE WEBHOOK, THE ONE IT IS GIVEN (decision 4). `secret` is one Slack incoming-webhook URL, and the
// hook posts there and nowhere else. There is no routing map: a kind reaches its own channel
// because its own secret holds that channel's webhook. Anything that isn't
// `https://hooks.slack.com/services/…` is refused by name and never echoed: a non-Slack URL means
// a non-Slack system, which is the generic webhook hook's job or the adopter's own hook's.
//
// THE MESSAGE IS NOT RE-VALIDATED HERE. The `notify` block validated it before calling the hook, and
// a hook must ignore a field it doesn't know and post a kind it doesn't know (§3.4): a hook pinned
// at an older release may be handed a message with an additive field, which `validate` at this
// hook's release would refuse. So the rendering reads each field defensively, and holds Slack's
// limits itself.
//
// ESCAPING (decision 7: all escaping for a chat system lives in its hook). Every `&`, `<` and `>`
// becomes `&amp;`, `&lt;`, `&gt;` (Slack's three control characters), so no text can form
// `<!channel>`, `<!here>` or a mention; the only `<…>` the payload holds are the links this file
// writes. Slack's `mrkdwn` documents no escape for its formatting characters, so a literal `*`, `_`,
// `` ` `` or `~` gets a zero-width space on each side, which keeps Slack from pairing it (N12
// checks the rendering live). The header is `plain_text`, which Slack never parses, so it is not
// escaped.
//
// Needs Node 20 or later (for `fetch`), and no dependencies but Kanon's contract library.

import { readFileSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import { isCliEntry } from '../../../scripts/lib/cli-entry.mjs';
import { linesOf, parseInline } from '../../../scripts/lib/notify-contract.mjs';

/** One Slack incoming webhook (§7.2). Nothing else is posted to. */
export const SLACK_WEBHOOK = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/-]+$/;

/** Slack's limits (plan 0011 §13). */
export const SLACK = Object.freeze({
  blocks: 50,
  header: 150,
  sectionText: 3000,
  fieldText: 2000,
  fields: 10,
  contextElements: 10,
  /** Slack's recommended ceiling for the top-level `text`. */
  text: 4000,
});

/** The contract's links a context block has room for: the tenth element is the run's own. */
export const LINK_SLOTS = SLACK.contextElements - 1;

/** The header's lead, by severity; an unknown severity reads as `info`. The longest is 19 characters. */
export const EMOJI = Object.freeze({ info: ':large_blue_circle:', warning: ':warning:', critical: ':rotating_light:' });
/** The `text` fallback's lead, by severity: words, which a push notification and a screen reader read as words. */
const LEAD = Object.freeze({ info: '', warning: 'Warning: ', critical: 'Critical: ' });

/** Most a 429's `Retry-After` may ask for, in seconds, and still be retried (§5.4). */
export const RETRY_AFTER_MAX = 60;

const ZWSP = '​';
const CUT = '…';

/** Characters, as Unicode code points, as the contract counts them. */
const len = (/** @type {string} */ s) => [...s].length;
const str = (/** @type {unknown} */ v) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

// ------------------------------------------------------------------ Kanon text to mrkdwn

/** Slack's three control characters, escaped. */
export const escapeControl = (/** @type {string} */ s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * One literal character as Slack shows it literally: a control character escaped, a formatting
 * character fenced with zero-width spaces, anything else itself.
 * @param {string} c
 */
const literalChar = (c) => ('*_`~'.includes(c) ? `${ZWSP}${c}${ZWSP}` : escapeControl(c));

/**
 * Text that is never markup (a title, a heading, a field, a link's label, or a Kanon text node),
 * as atoms: one per character, so a cut never splits an escape.
 * @param {string} s
 * @returns {string[]}
 */
const plainAtoms = (s) => [...s].map(literalChar);

/**
 * Nodes of one parsed line, as mrkdwn atoms. A link is one atom, so a cut never splits it.
 * @param {import('../../../scripts/lib/notify-contract.mjs').Node[]} nodes
 * @returns {string[]}
 */
function nodeAtoms(nodes) {
  return nodes.flatMap((n) => {
    switch (n.t) {
      case 'text': return plainAtoms(n.v);
      case 'code': return ['`', ...[...n.v].map(escapeControl), '`'];
      case 'strong': return ['*', ...nodeAtoms(n.c), '*'];
      case 'em': return ['_', ...nodeAtoms(n.c), '_'];
      case 'link': return [`<${linkUrl(n.url)}|${nodeAtoms(n.c).join('')}>`];
      default: return [];
    }
  });
}

/** A URL inside `<url|label>`: control characters escaped, and a `|` encoded so it can't end the URL. */
const linkUrl = (/** @type {string} */ u) => escapeControl(u).replace(/\|/g, '%7C');

/**
 * Kanon text as mrkdwn atoms, line by line, with `'\n'` atoms between lines: `**strong**` →
 * `*strong*`, `_emphasis_` and `` `code` `` stay, `[label](url)` → `<url|label>`, `- ` → `• `.
 * @param {string} text
 * @returns {string[]}
 */
export function kanonAtoms(text) {
  return linesOf(text).flatMap((line, i) => {
    const bullet = line.startsWith('- ');
    const atoms = bullet ? ['•', ' ', ...nodeAtoms(parseInline(line.slice(2)))] : nodeAtoms(parseInline(line));
    return i === 0 ? atoms : ['\n', ...atoms];
  });
}

/** Kanon text as one mrkdwn string. */
export const toMrkdwn = (/** @type {string} */ text) => kanonAtoms(text).join('');

/**
 * Atoms joined into chunks of at most `max` characters, cut at line boundaries where a line fits,
 * and inside a line, between atoms, where it doesn't. The line break a cut falls on is dropped.
 * @param {string[]} atoms
 * @param {number} max
 * @returns {string[]}
 */
export function chunk(atoms, max) {
  /** @type {string[][]} */
  const lines = [[]];
  for (const a of atoms) {
    if (a === '\n') lines.push([]);
    else /** @type {string[]} */ (lines.at(-1)).push(a);
  }
  /** @type {string[]} */
  const out = [];
  let cur = '';
  let curLen = 0;
  let started = false;
  const flush = () => { if (started) out.push(cur); cur = ''; curLen = 0; started = false; };
  for (const line of lines) {
    const text = line.join('');
    const n = len(text);
    if (started && curLen + 1 + n <= max) { cur += `\n${text}`; curLen += 1 + n; continue; }
    if (n <= max) { flush(); cur = text; curLen = n; started = true; continue; }
    // A line longer than a chunk: it starts on the current chunk's next line, if there is room,
    // and fills chunk after chunk between atoms.
    if (started && curLen + 1 < max) { cur += '\n'; curLen += 1; } else flush();
    for (const a of line) {
      const an = len(a);
      if (started && curLen + an > max) flush();
      const piece = an > max ? [...a].slice(0, max).join('') : a;
      cur += piece; curLen += len(piece); started = true;
    }
  }
  flush();
  return out.filter((c) => c.length > 0);
}

/** Atoms cut to at most `max` characters, ending with `…` when anything was left out. */
function cutAtoms(/** @type {string[]} */ atoms, /** @type {number} */ max) {
  const whole = atoms.join('');
  if (len(whole) <= max) return whole;
  let out = '';
  let n = 0;
  for (const a of atoms) {
    const an = len(a);
    if (n + an > max - 1) break;
    out += a; n += an;
  }
  return `${out}${CUT}`;
}

/** A plain-text line cut to `max` code points with `…`, for the header. */
const cutPlain = (/** @type {string} */ s, /** @type {number} */ max) => (len(s) <= max ? s : `${[...s].slice(0, max - 1).join('')}${CUT}`);

// ------------------------------------------------------------------ the payload

/** @typedef {Record<string, any>} Block */

/**
 * The message (`message-v1`, validated by the `notify` block) as Slack's payload: `text` and at
 * most 50 `blocks` (§7.2).
 * @param {Record<string, any>} message
 * @returns {{ text: string, blocks: Block[] }}
 */
export function payload(message) {
  const severity = Object.hasOwn(EMOJI, str(message.severity)) ? str(message.severity) : 'info';
  const title = str(message.title);
  const summary = str(message.summary);
  const sections = Array.isArray(message.sections) ? message.sections : [];
  const runUrl = str(message.source?.run_url);
  const links = (Array.isArray(message.links) ? message.links : [])
    .filter((/** @type {any} */ l) => str(l?.url) && str(l.url) !== runUrl)
    .slice(0, LINK_SLOTS);
  const runLink = runUrl ? `<${linkUrl(runUrl)}|The run>` : '';

  /** @type {Block[]} */
  const blocks = [];
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: cutPlain(`${EMOJI[/** @type {keyof typeof EMOJI} */ (severity)]} ${title}`, SLACK.header), emoji: true },
  });
  for (const text of chunk(kanonAtoms(summary), SLACK.sectionText)) blocks.push(mrkdwnSection(text));

  for (const s of sections) {
    blocks.push({ type: 'divider' });
    const heading = str(s?.heading);
    const atoms = [...(heading ? ['*', ...plainAtoms(heading), '*', '\n'] : []), ...kanonAtoms(str(s?.body))];
    const fields = (Array.isArray(s?.fields) ? s.fields : []).slice(0, SLACK.fields).map((/** @type {any} */ f) => ({
      type: 'mrkdwn',
      text: cutAtoms(['*', ...plainAtoms(str(f?.label)), '*', '\n', ...plainAtoms(str(f?.value))], SLACK.fieldText),
    }));
    const texts = chunk(atoms, SLACK.sectionText);
    if (texts.length === 0) texts.push(ZWSP);
    texts.forEach((text, i) => {
      const block = mrkdwnSection(text);
      if (i === 0 && fields.length > 0) block.fields = fields;
      blocks.push(block);
    });
  }

  const elements = [
    ...links.map((/** @type {any} */ l) => ({ type: 'mrkdwn', text: `<${linkUrl(str(l.url))}|${plainAtoms(str(l.label) || str(l.url)).join('')}>` })),
    ...(runLink ? [{ type: 'mrkdwn', text: runLink }] : []),
  ];
  if (elements.length > 0) blocks.push({ type: 'context', elements });

  const fitted = blocks.length <= SLACK.blocks ? blocks : [
    ...blocks.slice(0, SLACK.blocks - 1),
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `This message was too long for Slack, and was cut.${runLink ? ` The whole message is in ${runLink}.` : ''}` }],
    },
  ];
  return { text: fallbackText({ severity, title, summary, sections, links, runLink }), blocks: fitted };
}

/** @returns {Block} */
const mrkdwnSection = (/** @type {string} */ text) => ({ type: 'section', text: { type: 'mrkdwn', text } });

/**
 * The top-level `text` (decision 6): the whole message in mrkdwn when it fits Slack's 4,000
 * characters, otherwise the title, the summary and the run's link.
 * @param {{ severity: string, title: string, summary: string, sections: any[], links: any[], runLink: string }} m
 */
export function fallbackText({ severity, title, summary, sections, links, runLink }) {
  const head = `${LEAD[/** @type {keyof typeof LEAD} */ (severity)]}*${plainAtoms(title).join('')}*`;
  const summaryAtoms = kanonAtoms(summary);
  const parts = [head, summaryAtoms.join('')];
  for (const s of sections) {
    const lines = [];
    if (str(s?.heading)) lines.push(`*${plainAtoms(str(s.heading)).join('')}*`);
    lines.push(toMrkdwn(str(s?.body)));
    for (const f of Array.isArray(s?.fields) ? s.fields : []) lines.push(`*${plainAtoms(str(f?.label)).join('')}:* ${plainAtoms(str(f?.value)).join('')}`);
    parts.push(lines.join('\n'));
  }
  const linkLine = [
    ...links.map((/** @type {any} */ l) => `<${linkUrl(str(l.url))}|${plainAtoms(str(l.label) || str(l.url)).join('')}>`),
    ...(runLink ? [runLink] : []),
  ].join(' · ');
  if (linkLine) parts.push(linkLine);
  const whole = parts.join('\n\n');
  if (len(whole) <= SLACK.text) return whole;

  const tail = runLink ? `\n\n${runLink}` : '';
  const room = SLACK.text - len(head) - 2 - len(tail);
  return `${head}\n\n${cutAtoms(summaryAtoms, Math.max(room, 1))}${tail}`;
}

// ------------------------------------------------------------------ the request

/** A failure the hook reports as it is: its message never holds the URL, the body or the message's text. */
export class HookError extends Error {}

/**
 * The webhook in `secret`, or the refusal. The refusal names the input, never its value.
 * @param {unknown} secret
 * @returns {{ ok: true, url: string } | { ok: false, reason: string }}
 */
export function webhookOf(secret) {
  const url = str(secret).trim();
  if (url === '') return { ok: false, reason: 'The secret input is empty: there is no Slack webhook to post to.' };
  if (!SLACK_WEBHOOK.test(url)) {
    return {
      ok: false,
      reason: "The secret input is not a Slack incoming-webhook URL (https://hooks.slack.com/services/…), so Kanon's Slack hook won't post to it. "
        + "It posts to the one Slack webhook it is given: for another system, use Kanon's generic webhook hook or your own hook (docs/notifications.md).",
    };
  }
  return { ok: true, url };
}

/**
 * Seconds to wait before retrying a 429, or null for no retry: at most 60 (§5.4), and one second
 * when Slack sends no `Retry-After` (its incoming webhooks' rate is one a second).
 * @param {string | null} header
 */
export function retryAfter(header) {
  if (header === null || header.trim() === '') return 1;
  if (!/^\d+$/.test(header.trim())) return null;
  const s = Number(header.trim());
  return s <= RETRY_AFTER_MAX ? s : null;
}

/** Slack's error string from a response body (`invalid_payload`, `no_text`, …), or null for anything else, which is never printed. */
export const slackError = (/** @type {string} */ body) => (/^[a-z][a-z0-9_]{0,63}$/.test(body.trim()) ? body.trim() : null);

/**
 * @typedef {{
 *   fetch: (url: string, init: { method: string, headers: Record<string, string>, body: string, redirect: 'manual' }) => Promise<{ status: number, headers: { get(name: string): string | null }, text(): Promise<string> }>,
 *   sleep: (ms: number) => Promise<void>,
 * }} Io
 */

/**
 * POST the payload to the webhook. Retries once on a 429 whose `Retry-After` is at most 60
 * seconds; a redirect is not followed, so the URL is never re-sent to a host it doesn't name.
 * Throws a `HookError` naming the status and Slack's error string, never the URL.
 * @param {string} url
 * @param {{ text: string, blocks: Block[] }} body
 * @param {Io} io
 */
export async function post(url, body, io) {
  const init = /** @type {const} */ ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual' });
  for (let attempt = 1; ; attempt += 1) {
    let res;
    try {
      res = await io.fetch(url, init);
    } catch (e) {
      const code = /** @type {any} */ (e)?.cause?.code;
      throw new HookError(`The request to Slack failed${typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : ''}.`);
    }
    if (res.status >= 200 && res.status < 300) return { attempts: attempt };
    if (res.status === 429 && attempt === 1) {
      const wait = retryAfter(res.headers.get('retry-after'));
      if (wait !== null) { await io.sleep(wait * 1000); continue; }
    }
    const reason = slackError(await res.text().catch(() => ''));
    throw new HookError(`Slack refused the message: HTTP ${res.status}${reason ? ` ${reason}` : ''}.`);
  }
}

// ------------------------------------------------------------------ the action

/**
 * The action: read the inputs, refuse a secret that isn't a Slack webhook, post. Returns the exit code.
 * @param {{ env: Record<string, string | undefined>, io: Io, readFile?: (path: string) => string, out?: { log: (s: string) => void, error: (s: string) => void } }} args
 */
export async function main({ env, io, readFile = (p) => readFileSync(p, 'utf8'), out = console }) {
  const fail = (/** @type {string} */ why) => { out.error(`::error title=Kanon's Slack hook::${why}`); return 1; };
  const hook = webhookOf(env.SECRET);
  if (!hook.ok) return fail(hook.reason);
  if (!env.MESSAGE_FILE) return fail('The message-v1 input is empty: there is no message to post.');
  /** @type {unknown} */
  let message;
  try {
    message = JSON.parse(readFile(env.MESSAGE_FILE));
  } catch {
    return fail('The message-v1 input is not a readable JSON file.');
  }
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return fail('The message-v1 input is not a JSON object.');
  const body = payload(/** @type {Record<string, any>} */ (message));
  try {
    const { attempts } = await post(hook.url, body, io);
    out.log(`Posted the ${str(env.KIND) || 'Kanon'} message to Slack: ${body.blocks.length} blocks${attempts > 1 ? ', after one retry' : ''}.`);
    return 0;
  } catch (e) {
    if (e instanceof HookError) return fail(e.message);
    return fail('The post to Slack failed.');
  }
}

if (isCliEntry(import.meta.url)) {
  const io = /** @type {Io} */ ({ fetch: globalThis.fetch, sleep: (ms) => wait(ms).then(() => undefined) });
  process.exitCode = await main({ env: process.env, io });
}
