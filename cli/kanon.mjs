#!/usr/bin/env node
// The `kanon` command: `kanon init` (cli/init.mjs), `kanon doctor` (cli/doctor.mjs), `kanon apps`
// (cli/apps.mjs) and `kanon milestones` (cli/milestones.mjs). Each calls GitHub through the
// caller's own `gh`, and says first which token it uses and whose it is (cli/gh-token.mjs).
import { apps } from './apps.mjs';
import { doctor } from './doctor.mjs';
import { init } from './init.mjs';
import { milestones } from './milestones.mjs';

const HELP = `Usage: kanon <command> [options]

Commands:
  init         install Kanon in the repository whose checkout you run it from: inspect it,
               ask what it can't infer, write the declarations and lane callers, create the
               labels, milestones and ruleset, and run \`kanon apps\` (kanon init --help)
  doctor       compare the installation with the requirements of the release its callers
               pin, or of the one you move to (--to), and list what is missing or stale,
               with the fix for each; writes nothing; --json for scripts (kanon doctor --help)
  apps         create the repository's agent GitHub Apps from manifests, for a personal
               account or an organisation; run it from the repository's checkout
               (kanon apps --help)
  milestones   create the two bucket milestones when missing (kanon milestones --help)`;

const [command, ...rest] = process.argv.slice(2);
if (command === 'init') process.exitCode = await init(rest);
else if (command === 'doctor') process.exitCode = await doctor(rest);
else if (command === 'apps') process.exitCode = await apps(rest);
else if (command === 'milestones') process.exitCode = await milestones(rest);
else if (command === undefined || command === '-h' || command === '--help') console.log(HELP);
else {
  console.error(`kanon: unknown command "${command}"\n\n${HELP}`);
  process.exitCode = 2;
}
