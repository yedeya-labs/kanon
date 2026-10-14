import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Every Kanon action's file under `actions/`, nested ones too, relative to `root` and sorted:
 * `actions/<dir>/action.yml` and plan 0011's `actions/notify/slack/action.yml` alike, in either
 * spelling. The hook files `kanon init` writes (`actions/notify/hooks/*.yml`) are not actions.
 *
 * The guards that hold every action to a rule read this one list, so a guard can't go back to
 * reading the top level only and skip a nested action without a word (kanon#927).
 */
export const actionFiles = (root: string = process.cwd()): string[] =>
  readdirSync(join(root, 'actions'), { recursive: true, encoding: 'utf8' })
    .filter((f) => /^action\.ya?ml$/.test(basename(f)))
    .map((f) => join('actions', f))
    .sort();
