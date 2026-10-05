#!/usr/bin/env node
// The `kanon` command: `kanon apps` (cli/apps.mjs) and `kanon milestones` (cli/milestones.mjs).
// Both call GitHub through the caller's own `gh`, and say first which token it uses and whose
// it is (cli/gh-token.mjs).
import { apps } from './apps.mjs';
import { milestones } from './milestones.mjs';

const HELP = `Usage: kanon <command> [options]

Commands:
  apps         create the repository's agent GitHub Apps from manifests, for a personal
               account or an organisation; run it from the repository's checkout
               (kanon apps --help)
  milestones   create the two bucket milestones when missing (kanon milestones --help)`;

const [command, ...rest] = process.argv.slice(2);
if (command === 'apps') process.exitCode = await apps(rest);
else if (command === 'milestones') process.exitCode = await milestones(rest);
else if (command === undefined || command === '-h' || command === '--help') console.log(HELP);
else {
  console.error(`kanon: unknown command "${command}"\n\n${HELP}`);
  process.exitCode = 2;
}
