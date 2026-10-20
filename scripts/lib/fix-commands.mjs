// The checks whose failure has a known fix command (kanon#1173), which the revise lane runs on a
// hand-back before any model run.
//
// THE COMMAND IS KANON'S, NEVER THE CHECK'S. A failed check's log is the pull request's own code
// talking, and #1100's case printed its own `--fix` in it. Running what a log says would let any
// text a test prints choose a command the Implementer's token runs. So the Merger, which can read
// the log, only RECOGNISES the failure and names its key here; the revise lane, which can't,
// looks the key up here and runs this file's command. A key that isn't here runs nothing, and the
// model mandate runs instead.
//
// ONE FAILED STEP. A check is recognised only when its job failed on one step, and that step's log
// carries the entry's own failure line. A job with two failed steps is a mixed failure, and the
// model gets it whole.

/**
 * @typedef {{kanon: string, base: string, workflows: string[]}} FixContext
 *   `kanon`, the Kanon tree the lane runs (`$KANON`); `base`, the commit the pull request's diff
 *   is taken against; `workflows`, the text of the project's workflow files, where its CI says
 *   how it runs the check.
 * @typedef {{key: string, recognises: (log: string) => boolean,
 *            commands: (ctx: FixContext) => {fix: string[], verify: string[]}}} FixCommand
 *   `fix` rewrites the working tree; `verify` is the check itself, which must then pass.
 */

/** The line `citation-shift.mjs` prints when coordinates this diff moved were left behind. */
const CITATION_SHIFT_MOVED = /citation-shift: \d+ coordinate\(s\) point at lines this diff MOVED/;

/**
 * The `--path` globs the project's CI passes `citation-shift.mjs`, from its workflow files, as the
 * implement lanes' prompts tell their agent to pass them. Read from the workflows, which say what
 * the check read, not from its log. Each is an argument to Kanon's script, never a shell word.
 *
 * @param {string[]} workflows
 * @returns {string[]}
 */
export function citationShiftPaths(workflows) {
  const paths = new Set();
  for (const text of workflows) {
    for (const line of String(text).replace(/\\\r?\n/g, ' ').split('\n')) {
      if (!line.includes('citation-shift.mjs')) continue;
      for (const m of line.matchAll(/--path\s+(?:'([^']*)'|"([^"]*)"|([^\s'";|&]+))/g)) {
        const glob = m[1] ?? m[2] ?? m[3];
        if (glob) paths.add(glob);
      }
    }
  }
  return [...paths];
}

/** @type {readonly FixCommand[]} */
export const FIX_COMMANDS = Object.freeze([
  {
    key: 'citation-shift',
    recognises: (log) => CITATION_SHIFT_MOVED.test(log),
    commands: ({ kanon, base, workflows }) => {
      const args = [`${kanon}/scripts/citation-shift.mjs`, '--base', base, ...citationShiftPaths(workflows).flatMap((p) => ['--path', p])];
      return { fix: ['node', ...args, '--fix'], verify: ['node', ...args] };
    },
  },
]);

/**
 * The key of the one allow-listed failure a failed check's log shows, or `null`. The log is
 * `gh run view --job <id> --log-failed`'s: one line per log line of each failed step, as
 * `<job>\t<step>\t<line>`. More than one failed step, or a log that matches no entry or more
 * than one, is `null`.
 *
 * @param {string} log
 * @returns {string|null}
 */
export function recognise(log) {
  const text = String(log ?? '');
  const steps = new Set(text.split('\n').map((l) => l.split('\t')).filter((f) => f.length >= 3).map((f) => f[1]));
  if (steps.size > 1) return null;
  const hits = FIX_COMMANDS.filter((f) => f.recognises(text));
  return hits.length === 1 ? (hits[0]?.key ?? null) : null;
}

/**
 * The commands for these keys, in order, or `{ unknown }` naming the first key that isn't on the
 * list.
 *
 * @param {string[]} keys
 * @param {FixContext} ctx
 * @returns {{commands: {key: string, fix: string[], verify: string[]}[]}|{unknown: string}}
 */
export function commandsFor(keys, ctx) {
  const commands = [];
  for (const key of keys) {
    const entry = FIX_COMMANDS.find((f) => f.key === key);
    if (!entry) return { unknown: key };
    commands.push({ key, ...entry.commands(ctx) });
  }
  return { commands };
}
