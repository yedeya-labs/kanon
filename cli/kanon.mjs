#!/usr/bin/env node
// The `kanon` command. One subcommand so far: `kanon apps` (cli/apps.mjs).
import { apps } from './apps.mjs';

const HELP = `Usage: kanon <command> [options]

Commands:
  apps    create the repository's agent GitHub Apps from manifests (kanon apps --help)`;

const [command, ...rest] = process.argv.slice(2);
if (command === 'apps') process.exitCode = await apps(rest);
else if (command === undefined || command === '-h' || command === '--help') console.log(HELP);
else {
  console.error(`kanon: unknown command "${command}"\n\n${HELP}`);
  process.exitCode = 2;
}
