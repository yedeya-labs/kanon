# `kanon init`

`kanon init` installs Kanon in the repository whose checkout you run it from ([plan 0005](plans/0005-lean-installation.md) §5.4). It inspects the repository and its owner, asks what it can't infer, writes the declarations and the lane callers pinned to the release it runs from, creates the labels, the bucket milestones and, where the plan has rulesets, the default branch's ruleset, and runs [`kanon apps`](apps.md) for the Apps the lanes run as. It commits nothing, prints as exact steps whatever its token or plan can't do, and changes nothing on a second run. `kanon init --help` lists every option.

It is **scriptable** ([ADR 0014](decisions/0014-adopter-audiences.md), decision 2): every question has a flag that answers it. The agent skills of plan 0005's L11 drive it that way, and so can any program.

## Answering without a terminal

Each question `init` asks has a flag. A flag answers its question; `--yes` takes the default of every question no flag answers; without `--yes`, the questions no flag answers are asked. On a standard input that isn't a terminal, `init` refuses to start without `--yes`, and changes nothing.

| Question | Flag | Default |
|---|---|---|
| Who is the Owner? | `--owner <who>` | the token's login |
| Who is the Maintainer? | `--maintainer <who>` | the Owner |
| Who is the Stakeholder? | `--stakeholder <who>` | the Owner |
| Which lanes to install? | `--lanes <list>` | the lanes the repository already calls, or `review` |
| The stack's gates | `--gates <list>`, or `--gates none` | suggested from `package.json`, a `Makefile`, Cargo or Go |
| Does a lane need a test database? | `--test-database none\|hook` | `none` |
| Record a sign-off delegation? | `--delegation`, `--no-delegation` | no |
| The delegate's name | `--delegate-name <name>` (implies `--delegation`) | `git config user.name` |
| The delegate's email | `--delegate-email <email>` (implies `--delegation`) | `git config user.email` |
| Delete GitHub's default labels outside the taxonomy? | `--delete-default-labels`, `--keep-default-labels` | keep |
| Create the optional Releaser App? (asked only of a repository that calls Kanon's release workflow) | `--releaser`, `--no-releaser` | no |
| Create the Apps now? | `--create-apps`, `--no-apps` | yes |

**What fails, by name, before anything changes:** a flag `init` doesn't know; a value flag given twice; a value `init` doesn't take (`--test-database` other than `none` or `hook`, a lane Kanon doesn't ship); two flags that contradict each other (`--delegation` and `--no-delegation`, `--delegate-name` or `--delegate-email` with `--no-delegation`, `--delete-default-labels` and `--keep-default-labels`, `--releaser` and `--no-releaser`, `--create-apps` and `--no-apps`); and `--releaser` for a repository that doesn't call Kanon's release workflow. Each exits 2.

`kanon apps` opens a browser for each App it creates, and waits for you to click Create and Install there. A program that wants to run that step on its own, for instance to explain it first, passes `--no-apps`: the command it would have run is then a step left to a person.

