import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The App register a revise lane reads its role's login from (plan 0001 §5, `K-LAYOUT-6`),
 * for the `gh` stubs: the fixture adopter's, so the lanes and `lane-check` are tested against
 * one register.
 */
export const REGISTER_FIXTURE = readFileSync(
  join(process.cwd(), 'tests/fixtures/lane-check/adopter/docs/qa/agent-identities.md'),
  'utf8',
);
export const IMPLEMENTER_LOGIN = 'example-implementer';
export const LEAD_LOGIN = 'example-lead';

/**
 * The stub's arm for `gh api repos/O/R/contents/docs/qa/agent-identities.md`: the register in
 * `STUB_REGISTER`, or a 404 when it is unset. It must come BEFORE `GH_COMPARE_ARM`, which
 * answers every other `gh api` call. Escaped for the template literal that carries it.
 */
export const GH_REGISTER_ARM = `if [ "\${1:-}" = "api" ] && [[ "\${2:-}" == */contents/docs/qa/agent-identities.md ]]; then
  [ -n "\${STUB_REGISTER:-}" ] || { echo "HTTP 404: Not Found (docs/qa/agent-identities.md)" >&2; exit 1; }
  printf '%s\\n' "$STUB_REGISTER"
  exit 0
fi`;

/** What a filter step needs to read its login: its own `ROLE` and parser, and the register. */
export const registerEnv = (step: { env?: Record<string, string> }, register: string = REGISTER_FIXTURE) => ({
  ROLE: step.env?.ROLE ?? '',
  REGISTER_AWK: step.env?.REGISTER_AWK ?? '',
  STUB_REGISTER: register,
});
