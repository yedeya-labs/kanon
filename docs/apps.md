# Creating the agent Apps: `kanon apps`

Step 12 of the adoption checklist (`K-ADOPT-1`) gives every agent role its own GitHub App, holding exactly that role's permissions (`K-ADOPT-8`), with its id and key stored as Actions secrets (`K-AGENT-6`) and a row in the App register (`K-LAYOUT-6`). Done by hand, each App means a name, the permissions one by one, turning the webhook off, a key, an installation, two secrets and a register row. `kanon apps` does all of that from a [GitHub App manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest), and leaves the Owner two clicks per App: **Create** and **Install**. The command never creates an App or a key itself; the Owner does, in GitHub's own pages (`K-AGENT-6`).

## What you need

- **Node 24 or later.** The command uses Node's built-ins only, so nothing is installed.
- **`gh`, signed in as the Owner**: an admin of the repository, who can set its Actions secrets. The command stores the secrets with your own `gh`.
- **A token that can write secrets.** Whatever token `gh` uses needs **Secrets: read and write** on the repository; for a fine-grained token that is the repository permission *Secrets*, set to *Read and write*. Reading is not enough. **A `GH_TOKEN` in the environment takes precedence over the login `gh` has stored**, so a stale or narrower `GH_TOKEN` is the token that counts, whoever `gh auth status` says you are. Before it opens any page, the command sets a throwaway secret, `KANON_APPS_PREFLIGHT`, and deletes it again. If either step fails, it stops with `gh`'s own error and creates nothing, and it deletes the throwaway secret even when setting it failed.
- **A browser on the same machine.** GitHub sends you back to a listener on `127.0.0.1` once the App is created.
- **A checkout of the repository**, where the command writes the App register. Run it from there, or pass `--dir`.

## Run it

Kanon isn't on npm. Run the command straight from a tagged Kanon release, from the adopter's checkout. It needs Node on the machine that runs it, which is Kanon's runtime, and nothing in the repository: an adopter written in any language runs it the same way, with no `package.json`. `npx` fetches the tag from GitHub, and the `--package` flag is needed: without it, `npx` reads `kanon` as an argument rather than the command.

<!-- x-release-please-start-version -->

```sh
npx --yes --package github:yedeya-labs/kanon#v0.23.0 kanon apps --org <org> --repo <repo> --roles reviewer
```

<!-- x-release-please-end -->

Or, from a Kanon checkout: `node cli/kanon.mjs apps --org <org> --repo <repo> --roles reviewer --dir <path to the adopter's checkout>`.

`--roles` takes one role or several, comma-separated: `explorer`, `implementer`, `reviewer`, `merger`, `lead`, `overseer`. Create the **Reviewer first**: it is the App that ends bootstrap (`K-ADOPT-6`), on a plan with rulesets (`K-ADOPT-3`). Run it from the branch that adds the role's lane caller ([`docs/lanes.md`](lanes.md#your-first-lane-the-reviewer)), because `lane-check` fails a caller whose role has no register row. Each App is named `<repo>-<role>` unless you pass `--name <role>=<name>`. App names are unique across all of GitHub, so if the name is taken, change it on GitHub's page before you click **Create**; the command reads back the slug GitHub gives it.

## What happens, and what you click

For each role, in turn:

1. **The manifest.** The command builds it from [`rulebook/agent-permissions.json`](../rulebook/agent-permissions.json), the machine-readable twin of [chapter 03's roles table](../rulebook/03-agents.md): exactly the role's permissions plus Metadata: read, a private App, and no webhook. A test fails if the file and the table disagree.
2. **You click "Create GitHub App".** Your browser opens a local page that sends the manifest to your organisation's "create App" page. GitHub shows the name and the permissions; check them and click **Create GitHub App for &lt;org&gt;**.
3. **The key.** GitHub redirects back to the local listener with a one-time code. The command refuses a redirect whose `state` doesn't match the one it sent, then exchanges the code for the App's id and private key.
4. **The secrets.** It sets `<ROLE>_APP_ID` and `<ROLE>_APP_PRIVATE_KEY` (for example `REVIEWER_APP_ID`) on the repository with `gh secret set`. The key goes to `gh` on standard input, and is never written to disk, printed, or passed as an argument.
5. **You click "Install".** Your browser opens the App's install page. Choose the organisation, then **Only select repositories**, pick the repository alone, and click **Install**. The command waits until the installation exists, then checks it covers this repository. It fails if the repository is missing, and warns if the installation covers all repositories or any other one (`K-ADOPT-8`: one App per role per repository).
6. **The register.** It writes the role's row in `docs/qa/agent-identities.md`, creating the file if it doesn't exist, and prints the diff. A row the register already has for the role is rewritten in place, with the slug GitHub gave the App, so a placeholder row is replaced rather than doubled. A line that says only "none installed" is removed when the first row is added. **Commit it**: the command doesn't.

## Checking the installations later

A person's token often can't list an organisation's App installations, but each App can read its own. Kanon's `apps-check` workflow ([`.github/workflows/apps-check.yml`](../.github/workflows/apps-check.yml)) does that for every agent role the register lists: it mints the role's token from `<ROLE>_APP_ID` and `<ROLE>_APP_PRIVATE_KEY`, then, with [`cli/apps-check.mjs`](../cli/apps-check.mjs), fails if the minted slug isn't the register's, if the installation doesn't cover the repository, or if its permissions differ from the role's in `rulebook/agent-permissions.json`, and warns if it covers other repositories or all of them. Each role's job writes a summary table. It runs by hand and is not a required check.

It is a reusable workflow. Add a thin caller, `.github/workflows/apps-check.yml`, pinned to the same **exact version** as your lanes (`K-ADOPT-11`), and map the two secrets of each role your register lists:

<!-- x-release-please-start-version -->

```yaml
name: apps-check

on:
  workflow_dispatch:

permissions: {}

jobs:
  apps:
    permissions:
      contents: read
    uses: yedeya-labs/kanon/.github/workflows/apps-check.yml@v0.23.0
    secrets:
      REVIEWER_APP_ID: ${{ secrets.REVIEWER_APP_ID }}
      REVIEWER_APP_PRIVATE_KEY: ${{ secrets.REVIEWER_APP_PRIVATE_KEY }}
```

<!-- x-release-please-end -->

Then run it:

```sh
gh workflow run apps-check.yml -R <org>/<repo>
```

- **Map secrets by name, never `secrets: inherit`.** The workflow takes each role's two secrets by their fixed names (`EXPLORER_`, `IMPLEMENTER_`, `REVIEWER_`, `MERGER_`, `LEAD_`, `OVERSEER_`), all optional, and each role's job reads only its own two. A role the register lists whose secrets you didn't map fails at the mint, by name.
- **`contents: read` is the ceiling.** Only the job that reads your register uses it; the check jobs run on the App tokens alone.
- **The check is the pinned version's.** It runs Kanon's script and compares against Kanon's role permissions at the tag you pinned, and reads only your register from your checkout. `lane-check` reads this caller as no lane caller, and holds it to the one pin and to mapping its secrets by name.

## Limits

- **Key rotation stays manual.** GitHub has no API that makes a new private key for an existing App, so the command can't rotate one. It prints the steps at the end of every run: generate a key on the App's settings page, `gh secret set <ROLE>_APP_PRIVATE_KEY -R <org>/<repo> < key.pem`, delete the file, then delete the old key.
- **A lost key can't be recovered.** The pre-check makes this unlikely, but if `gh secret set` still fails after the App is created, the key existed only in memory. The command says so and prints how to generate a new one by hand.
- **It creates new Apps only.** It doesn't change an existing App's permissions, rename a secret, or move an App to another repository. Sharing one App across repositories is the adopter's deliberate choice, recorded in the register (`K-AGENT-3`).
- **Agent roles only.** Intake and the Releaser aren't agents. Kanon's release workflow runs under the workflow's own token, and an Intake App's credentials belong to the running application, not to Actions secrets.
