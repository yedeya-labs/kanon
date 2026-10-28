// A decision asked of a person, recorded on GitHub before it is asked anywhere else (`K-WORK-24`).
//
// THE RECORD IS THE ASK. An agent that needs a person's decision posts one comment, in the form
// below, on the issue or pull request the decision concerns, and labels that thread
// `decision:needed`. Only then does it ask in chat. When the person answers, there or on GitHub,
// the agent records the answer on the same thread, in the answer form, and takes the label off.
// So "what waits on me?" is read from the repository (`kanon inbox`), never from a session's
// memory, which forgets: a session's context is compacted, and a subagent's hand-back drops what
// it doesn't carry.
//
// THE FORM IS FIXED, AND READ ONLY FOR ITS SHAPE. The marker says what a comment is; the three
// bold parts are what a person needs to decide without the session that asked. The status core
// reads a comment only to find the marker and the parts (decision 4 of the status project: a
// comment's text never leaves the process), and answers with the comment's link.
//
// AN APP-RUN AGENT'S ASK OPENS WITH ITS HEADER. `K-AGENT-1` makes every post an App-run agent
// writes open with its persona header and role marker, so the marker may stand on the line after
// that header rather than on the first line. One header line is skipped, and only a line that
// carries a role marker: anything else before the marker makes the comment neither an ask nor an
// answer, so a marker quoted further down still isn't one.

import { markedRole } from './role-marker.mjs';

/** The label that marks a thread waiting on a person's decision (`K-WORK-12`, `K-WORK-24`). */
export const DECISION_LABEL = 'decision:needed';

/** The first line of an ask. */
export const ASK_MARKER = '<!-- kanon:decision-needed -->';

/** The first line of the answer that settles the thread's latest ask. */
export const ANSWER_MARKER = '<!-- kanon:decision-answered -->';

/** The parts every ask carries, in order, each opening a line. */
export const ASK_PARTS = /** @type {const} */ (['**Question.**', '**Options.**', '**Recommendation.**']);

/** The parts every answer carries, each opening a line. */
export const ANSWER_PARTS = /** @type {const} */ (['**Decision.**', '**Decided by.**']);

/** `lines`, opened with an App-run agent's header line and a blank line when one is given (`K-AGENT-1`). @param {string | undefined} header @param {string[]} lines */
const headed = (header, lines) => (header ? [header, '', ...lines] : lines).join('\n');

/**
 * An ask's body, in the form the rule fixes; for an App-run agent, after its header line.
 * @param {{ question: string, options: string[], recommendation: string, header?: string }} ask
 */
export function askBody({ question, options, recommendation, header }) {
  return headed(header, [
    ASK_MARKER,
    '',
    `${ASK_PARTS[0]} ${question}`,
    '',
    ASK_PARTS[1],
    ...options.map((o, i) => `${i + 1}. ${o}`),
    '',
    `${ASK_PARTS[2]} ${recommendation}`,
  ]);
}

/**
 * An answer's body, in the form the rule fixes; for an App-run agent, after its header line.
 * @param {{ decision: string, by: string, header?: string }} answer the decision, and who made it and where
 */
export function answerBody({ decision, by, header }) {
  return headed(header, [ANSWER_MARKER, '', `${ANSWER_PARTS[0]} ${decision}`, '', `${ANSWER_PARTS[1]} ${by}`]);
}

/** Does a line of the body open with `part`? @param {string} body @param {string} part */
const opens = (body, part) => body.split('\n').some((l) => l.trimStart().startsWith(part));

/**
 * What a comment is: an ask, an answer, or neither, by the marker on its first non-blank line,
 * or on the next one when the first is an App-run agent's header line, the one line carrying a
 * role marker (`K-AGENT-1`). A marker quoted further down is neither.
 * @param {string} body
 * @returns {'ask' | 'answer' | null}
 */
export function kindOf(body) {
  const lines = String(body ?? '').split('\n').map((l) => l.trim()).filter((l) => l !== '');
  const first = lines[0] !== undefined && markedRole(lines[0]) !== null ? lines[1] : lines[0];
  if (first === ASK_MARKER) return 'ask';
  if (first === ANSWER_MARKER) return 'answer';
  return null;
}

/** Does an ask carry every part of the form? @param {string} body */
export const isWholeAsk = (body) => kindOf(body) === 'ask' && ASK_PARTS.every((p) => opens(body, p));

/**
 * Where a labelled thread stands, from its comments, oldest first:
 *   - `ask`: the link of its latest ask, or null when it has none;
 *   - `form`: `ok` when that ask carries every part, `incomplete` when it doesn't, `missing` when
 *     the thread has the label and no ask;
 *   - `answered`: an answer was recorded after the latest ask, and the label was left on.
 * @param {Array<{ body: string, url: string }>} comments
 */
export function askState(comments) {
  let ask = /** @type {{ body: string, url: string } | null} */ (null);
  let answered = false;
  for (const c of comments) {
    const kind = kindOf(c.body);
    if (kind === 'ask') {
      ask = c;
      answered = false;
    } else if (kind === 'answer' && ask) answered = true;
  }
  return {
    ask: ask ? ask.url : null,
    form: /** @type {'ok' | 'incomplete' | 'missing'} */ (!ask ? 'missing' : isWholeAsk(ask.body) ? 'ok' : 'incomplete'),
    answered,
  };
}
