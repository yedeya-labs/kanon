// The lane's prompt, with the instruction to open every post with the agent's persona header
// and role marker appended (plan 0005 §3.3, step L3). `agent-setup` resolved the role and
// exported its header line; with no role resolved, that instruction is left out.
//
// AND WHICH PLAYBOOKS ARE KANON'S BASELINE (kanon#329). `agent-setup` copies the baseline into
// the place of each playbook the project lacks and has git ignore it there, so an agent asked
// to write the project's own playbook would edit the copy and find it can't commit it. It
// exported the copies as `KANON_BASELINE_PLAYBOOKS`; this names them, with the remedy. None, and
// nothing is added.
//
// AND THAT THE SESSION ENDS WHEN THE AGENT STOPS (kanon#621). Every lane's agent runs headless,
// so a command still running when it ends its turn is lost with whatever it meant to do next.
// `action.yml` takes background tasks and `Monitor` away and raises the foreground cap; this
// says why, so the agent waits for a long command rather than looking for another way round.
// Appended to every lane's prompt, last, with the precondition rule after it (kanon#1564).
//
// Written to `$GITHUB_OUTPUT` as `text`, under a delimiter the prompt can't contain, or to stdout
// outside a job.
//
// Inputs, by environment only: PROMPT, KANON_ROLE, KANON_POST_HEADER, KANON_BASELINE_PLAYBOOKS,
// GITHUB_OUTPUT.

import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';

import { isCliEntry } from '../../scripts/lib/cli-entry.mjs';
import { withPersona } from '../../scripts/lib/role-marker.mjs';

/**
 * The prompt, with a note naming the baseline playbooks in the checkout appended. With none,
 * the prompt is returned unchanged.
 * @param {string} prompt
 * @param {string} copies `KANON_BASELINE_PLAYBOOKS`: the copies' paths, space-separated
 */
export function withBaselines(prompt, copies) {
  const paths = copies.split(/\s+/).filter(Boolean);
  if (!paths.length) return prompt;
  return [
    prompt.trimEnd(),
    '',
    `KANON'S BASELINE PLAYBOOKS (K-LAYOUT-17). ${paths.map((p) => `\`${p}\``).join(', ')} ${paths.length === 1 ? 'is' : 'are'} not this`,
    "project's own. The project has no playbook there, so Kanon's baseline for the role was copied",
    'there for you to read, at a path git ignores. Never commit one as it is. When your task is to',
    "write the project's own playbook, edit the copy and stage it with `git add -f <path>`: a plain",
    '`git add` refuses an ignored path, and `git add -A` skips it without a word.',
  ].join('\n');
}

/** What `withHeadless` appends. Exported so its sentences are asserted, not assumed. */
export const HEADLESS_RULE = [
  'THIS IS A HEADLESS RUN (kanon#621). Your session ends when you stop, and nothing resumes it: a',
  'command still running when you end your turn is lost, and so is everything you meant to do',
  'after it. Run every command in the foreground and wait for it, giving a long one (a test tier,',
  'a gate) an explicit `timeout` up to the Bash tool\'s maximum. Never end your turn to wait for',
  'something to finish or report back.',
].join('\n');

/**
 * What `withHeadless` appends after the headless rule (kanon#1564): how an agent says it stopped
 * on a precondition it found mid-run, so the run is neither green and silent nor counted `ok`.
 * Narrow on purpose: a stop the lane's instructions make part of the work (a question, a plan, a
 * verdict, a refusal it posts) is the work, and stays a clean run.
 */
export const STOP_RULE = [
  'A PRECONDITION THAT DOESN\'T HOLD (kanon#1564). If you stop without doing this run\'s work because',
  'something it needs before it can start isn\'t so, such as the issue, pull request or tracking issue',
  'it is for not existing, or not being what your instructions say it must be, end your final',
  'message with one line of its own: `KANON-STOP: <what didn\'t hold, in one sentence>`. Never write',
  'it for a stop your instructions make part of the work, such as asking a question, posting a plan,',
  'a verdict or a finding. Kanon then records the run as not done and warns on it.',
].join('\n');

/**
 * The prompt, with the headless rule and the precondition rule appended.
 * @param {string} prompt
 */
export function withHeadless(prompt) {
  return `${prompt.trimEnd()}\n\n${HEADLESS_RULE}\n\n${STOP_RULE}`;
}

if (isCliEntry(import.meta.url)) {
  const env = process.env;
  const text = withHeadless(withBaselines(withPersona(env.PROMPT ?? '', env.KANON_ROLE ?? '', env.KANON_POST_HEADER ?? ''), env.KANON_BASELINE_PLAYBOOKS ?? ''));
  const eof = `KANON_PROMPT_${randomBytes(16).toString('hex')}`;
  const out = `text<<${eof}\n${text}\n${eof}\n`;
  // Outside a job, to stdout: the prompt is what a run by hand wants to see.
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, out);
  else process.stdout.write(out);
}
