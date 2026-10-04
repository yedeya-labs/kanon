import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeStub } from './stub-bin.js';
import { runWorkflowStep, type RunStepResult, type WorkflowStep } from './workflow-step.js';

/** Kanon's root, whichever tier's working directory a test runs in. */
const KANON = fileURLToPath(new URL('../../../', import.meta.url));

/** The App register's fixed path (`K-LAYOUT-6`). */
export const APP_REGISTER = 'docs/qa/agent-identities.md';

/** The fixture adopter's register, which names every role, as the default branch would serve it. */
export const ownRegister = (): string => readFileSync(join(KANON, 'tests/fixtures/adopter', APP_REGISTER), 'utf8');

/**
 * Execute a lane step that reads logins from the App register over the API (plan 0004 P5): the
 * Merger's `logins` job's read and the reconciler's `lead` step.
 *
 * `gh` is a stub that serves `register` for the contents call and records its argv, so a test
 * can hold the step to the DEFAULT branch (no `ref`) as well as to the answer. `null` serves a
 * 404, the shape of a register that is not on the default branch at all. `KANON` is this tree,
 * so the step runs the parser the runner would: `actions/lane-check/app-register.awk`.
 */
export const runRegisterStep = (step: WorkflowStep, register: string | null): RunStepResult & { ghArgs: string[] } => {
  const dir = mkdtempSync(join(tmpdir(), 'register-step-'));
  const served = join(dir, 'served.md');
  const argsFile = join(dir, 'gh-args');
  writeFileSync(argsFile, '');
  if (register !== null) writeFileSync(served, register);
  writeStub(join(dir, 'gh'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(argsFile)}
${register === null
    ? 'echo "gh: Not Found (HTTP 404)" >&2; exit 1'
    : `case "$*" in *"contents/${APP_REGISTER}"*) cat ${JSON.stringify(served)};; *) echo "unexpected gh call: $*" >&2; exit 1;; esac`}
`);
  const r = runWorkflowStep(step, {
    dir,
    env: { PATH: `${dir}:${process.env.PATH}`, GH_TOKEN: 'test-token', REPO: 'owner/repo', KANON },
  });
  return { ...r, ghArgs: readFileSync(argsFile, 'utf8').split('\n').filter(Boolean) };
};

/** `register` with one role's slug replaced — the "renamed App" fixture. */
export const withSlug = (register: string, role: string, slug: string): string => {
  const row = new RegExp(`^(\\|\\s*(?:\\*\\*)?${role}(?:\\*\\*)?\\s*\\|\\s*(?:\\*\\*)?)\`[^\`]+\``, 'm');
  if (!row.test(register)) throw new Error(`withSlug: no ${role} row in the register`);
  return register.replace(row, `$1\`${slug}\``);
};

/** `register` with one role's row deleted — the "missing row" fixture. */
export const withoutRole = (register: string, role: string): string => {
  const row = new RegExp(`^\\|\\s*(?:\\*\\*)?${role}(?:\\*\\*)?\\s*\\|.*\\n`, 'm');
  if (!row.test(register)) throw new Error(`withoutRole: no ${role} row in the register`);
  return register.replace(row, '');
};
