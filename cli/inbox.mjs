// `kanon inbox`: what waits on a person, read live from GitHub when they ask, and nothing else
// (`K-WORK-24`, `K-WORK-25`, docs/status.md "The inbox").
//
// TWO LISTS, BOTH COMPUTED. The pull requests ready for a person's merge, and the decisions asked
// of a person (`decision:needed`). Neither is kept anywhere: a session that tracks them in its own
// context loses them when the context is compacted or a subagent hands back, so the answer to
// "what's waiting on me?" is always this command's, run then.
//
// PULL-ONLY. It prints when run and sends nothing: no notification, no comment, no schedule.
//
// A SURFACE OF `kanon status`. It is `kanon status --inbox` under its own name: the same status
// core, the same reader with the person's own credential, the same `kanon-status/v1` document
// with `--json`, the same exit codes. This file only parses its few flags.
import { EXIT, SCHEMA, realDeps, status } from './status.mjs';

export const USAGE = `Usage: kanon inbox [--repo <owner>/<repo>] [--json]

What waits on you, read live from GitHub, with a link for each: the pull requests ready for a
person's merge, and the decisions asked of a person, each an issue or pull request labelled
decision:needed with the decision asked in a comment. Writes nothing and sends nothing; it is
\`kanon status --inbox\` (docs/status.md).

Options:
  --repo <owner>/<repo>  the repository (default: this checkout's origin remote)
  --json                 print one kanon-status/v1 document instead of prose
  -h, --help             this text

Exit codes: 0 answered; 2 usage error; 3 could not run; 4 a read didn't complete, so there is no
answer (docs/status.md).

Needs \`gh\` and a token that can read the repository. A token GitHub won't show check runs to,
such as a fine-grained personal access token, is answered from the head's workflow runs instead.`;

/**
 * `kanon inbox`. Returns the exit code.
 * @param {string[]} argv @param {Partial<import('./status.mjs').Deps>} [overrides]
 */
export const inbox = async (argv, overrides = {}) => {
  const as = { name: 'kanon inbox', usage: USAGE };
  /** @type {string[]} */
  const forwarded = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const flag = arg.startsWith('--') && arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (flag === '--repo') {
      forwarded.push(arg);
      if (!arg.includes('=') && i + 1 < argv.length) forwarded.push(argv[++i] ?? '');
    } else if (flag === '--json' || flag === '-h' || flag === '--help') forwarded.push(arg);
    else {
      // Every other flag is `kanon status`'s, and naming a view here would print a second one.
      const deps = { ...realDeps, ...overrides };
      const error = `unknown argument "${arg}"`;
      if (argv.includes('--json')) deps.out(JSON.stringify({ schema: SCHEMA, kanon: deps.release(), status: 'error', exitCode: EXIT.usage, error }, null, 2));
      else {
        deps.err(`${as.name}: ${error}`);
        deps.err(USAGE);
      }
      return EXIT.usage;
    }
  }
  return status([...forwarded, '--inbox'], overrides, as);
};
