# The App register

What the App register (`docs/qa/agent-identities.md`, `K-AGENT-3`, `K-LAYOUT-6`) admits, and what its readers do with a row, where a project has needed a clause to cite. This area holds only the clauses projects have seeded so far; it is not a complete description of the register, whose rules are `K-AGENT-3` and `K-LAYOUT-6`. Every clause is `[seed]` until a human promotes it (`K-SPEC-8`).

**Id prefix:** `REG`

## Apps that are not agents

- `[REG-1]` `[seed]` The App register accepts rows for GitHub Apps that are not agents, under the rulebook's non-agent App role, and more than one such row, each naming its own App slug; `parseAppRegister`, `lane-check`, `kanon doctor` and `apps-check` read a register holding such rows without an error or a finding, and read every agent role's row from it as before.
- `[REG-2]` `[seed]` A non-agent row whose App slug is also the slug of an agent role's row is refused: `parseAppRegister` throws naming both rows, and `lane-check` and `kanon doctor` report it by name.
- `[REG-3]` `[seed]` The lanes' membership gate (`scripts/lane-gate.mjs`, `K-AGENT-45`) does not admit an App whose only rows in the App register are non-agent rows: it reports that App as not a member, as it reports an App the register doesn't name.
- `[REG-4]` `[seed]` The `dco` check (`actions/dco/dco.mjs`, `K-AGENT-44`) applies the sign-off delegation to no App whose only rows in the App register are non-agent rows, the non-agent App role's or the Intake role's: it checks such an App's commit as it checks any other commit, so the delegate's `Signed-off-by:` does not pass it.
