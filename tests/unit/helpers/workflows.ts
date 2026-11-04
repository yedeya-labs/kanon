import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every workflow file under `.github/workflows`, relative to `root` and sorted, in either spelling:
 * GitHub runs `x.yaml` as it runs `x.yml`, and a subdirectory's files not at all.
 *
 * The guards that hold a rule on Kanon's own workflows read this one list, so a `.yaml` workflow
 * can't pass them unread (kanon#1598).
 */
export const workflowFiles = (root: string = process.cwd()): string[] =>
  readdirSync(join(root, '.github/workflows'))
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => join('.github/workflows', f))
    .sort();
