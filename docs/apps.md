# Creating Kanon's Apps: `kanon apps`

Step 12 of the adoption checklist (`K-ADOPT-1`) gives an owner **two GitHub Apps, three with releases, reused across its repositories** ([ADR 0013](decisions/0013-personal-accounts-and-two-apps.md), plan 0005 §3):

| App | Roles | Secrets |
|---|---|---|
| **Author** | Implementer, Lead, Explorer, Overseer | `AUTHOR_APP_ID`, `AUTHOR_APP_PRIVATE_KEY` |
| **Judge** | Reviewer, Merger | `JUDGE_APP_ID`, `JUDGE_APP_PRIVATE_KEY` |
| **Releaser**, optional | the release workflow alone | `RELEASER_APP_ID`, `RELEASER_APP_PRIVATE_KEY` |

Each App holds exactly the union of its roles' permissions (`K-ADOPT-8`), plus the Author's one broadened permission, Commit statuses write, for the implementer status (`K-AGENT-3`). Each lane still narrows its token to what it uses (`K-AGENT-46`), and each agent still speaks as its role, through a persona header and a role marker. Each App's id and key are stored as Actions secrets (`K-AGENT-6`), and each of its roles gets a row in the App register, the rows sharing the App's slug (`K-LAYOUT-6`). Done by hand, each App means a name, the permissions one by one, turning the webhook off, a key, an installation, two secrets per repository and a row per role. `kanon apps` does all of that from a [GitHub App manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest), and leaves the Owner two clicks per App: **Create** and **Install**. The command never creates an App or a key itself; the Owner does, in GitHub's own pages (`K-AGENT-6`).

## What you need

- **Node 24 or later.** The command uses Node's built-ins only, so nothing is installed.
- **An owner: a personal account or an organisation.** `--owner <login>` names the account that will own the Apps, and the repository's owner. The command asks GitHub which kind of account it is (`GET /users/<login>`, its `type`) and uses that account's pages: `https://github.com/settings/apps/new` for a personal account, `https://github.com/organizations/<org>/settings/apps/new` for an organisation, and the matching App settings and installation pages in every message it prints. `--org <org>` is the old spelling: it still works for one release, with a warning, and then goes.
- **`gh`, signed in as the Owner**: an admin of each repository, who can set its Actions secrets. The command stores the secrets with your own `gh`.
- **A token that can write secrets.** Whatever token `gh` uses needs **Secrets: read and write** on each repository; for a fine-grained token that is the repository permission *Secrets*, set to *Read and write*. Reading is not enough. **A `GH_TOKEN` in the environment takes precedence over the login `gh` has stored** (then `GITHUB_TOKEN`, then the stored login), so a stale or narrower `GH_TOKEN` is the token that counts, whoever `gh auth status` says you are. So the command says first which one it uses and whose it is, for example `Using the token in GH_TOKEN, which belongs to octocat.`, never the token itself. If GitHub refuses that token outright (401), it stops there; if a stale `GH_TOKEN` is the cause, `unset GH_TOKEN` to fall back to the stored login, or export a fresh one. Before it opens any page, the command sets a throwaway secret, `KANON_APPS_PREFLIGHT`, and deletes it again. If either step fails, it stops with `gh`'s own error and creates nothing, and it deletes the throwaway secret even when setting it failed; when GitHub refused the token (401 or 403), the refusal repeats the fix for the token it used. **To check the token first,** without creating anything, add `--preflight` (with or without `--apps`): the command runs these checks alone, the checkout, the token, the owner and the throwaway secret on each repository, and exits 0 when the real run would get past them, or 1 with the same refusal ([#420](https://github.com/yedeya-labs/kanon/issues/420)). It opens no page and writes no file. GitHub has no read-only way to tell whether a fine-grained token can write a secret, which is why it writes the throwaway one.
- **A browser on the same machine.** GitHub sends you back to a listener on `127.0.0.1` once the App is created.
- **A checkout of one of the repositories**, where the command writes the App register. **Run it from there, or pass `--dir`.** Before it uses the token for anything, the command checks that the directory is a git checkout with a remote that points at one of `<owner>/<repo>` (any remote, and any host spelling, an SSH host alias included), and refuses otherwise, naming the directory and the repository. Run from a subdirectory, it writes the register at the top of the checkout. To write the register somewhere else on purpose, pass `--register <path>`; no checkout is needed then.

## Run it

Kanon isn't on npm. Run the command straight from a tagged Kanon release, from the adopter's checkout. It needs Node on the machine that runs it, which is Kanon's runtime, and nothing in the repository: an adopter written in any language runs it the same way, with no `package.json`. `npx` fetches the tag from GitHub, and the `--package` flag is needed: without it, `npx` reads `kanon` as an argument rather than the command.

<!-- x-release-please-start-version -->

```sh
npx --yes --package github:yedeya-labs/kanon#v0.38.0 kanon apps --owner <owner> --repo <repo>[,<repo>...] --apps author,judge
```

<!-- x-release-please-end -->

Or, from a Kanon checkout: `node cli/kanon.mjs apps --owner <owner> --repo <repo> --apps author,judge --dir <path to the adopter's checkout>`.

`--apps` takes `author`, `judge` and `releaser`, comma-separated. The **Judge** is the App that ends bootstrap, because its Reviewer's approval is the required review (`K-ADOPT-6`), on a plan with rulesets (`K-ADOPT-3`); the Author opens the pull requests it approves. Add `releaser` only if you make releases (see [`docs/release.md`](release.md#with-the-releaser)). Run it from the branch that adds your lane callers ([`docs/lanes.md`](lanes.md#your-first-lane-the-reviewer)), because `lane-check` fails a caller whose role has no register row. Each App is named `<owner>-<app>` unless you pass `--name <app>=<name>`. App names are unique across all of GitHub, so if the name is taken, change it on GitHub's page before you click **Create**; the command reads back the slug GitHub gives it.

`--repo` takes every repository of the owner that adopts Kanon, comma-separated. GitHub hands over an App's private key once, at creation, so each repository named gets the App's secrets in the same run. `--roles`, the per-role Apps before plan 0005, is gone, and the command says so.

### A repository added later: `--reuse`

GitHub has no API that makes a new private key for an existing App. To add a repository to Apps you created earlier, generate a key on each App's settings page (**Credentials → Key pairs → New key**, [GitHub's steps](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps); a key pair, not a client secret), add the repository to the App's installation, then run:

```sh
kanon apps --owner <owner> --repo <new repo> --reuse author:<author slug>=<key file> --reuse judge:<judge slug>=<key file>
```

For each App it checks the key is a key of the slug (GitHub accepts a token it signs only if it is), checks the slug's App holds exactly the permissions of the App you named (`rulebook/agent-permissions.json`, as `apps-check` checks them), checks the installation covers the repository, stores the two secrets, **deletes the key file**, and writes the register rows. A key that isn't the slug's, a slug whose App holds other permissions (the Author's slug given as the Judge's, say: it names which App's they are), or an installation that misses the repository, stops it with nothing stored and the file kept. An organisation may instead hold the secrets once, as organisation secrets, where its plan offers them to its repositories.

## What happens, and what you click

For each App, in turn:

1. **The manifest.** The command builds it from the `apps` block of [`rulebook/agent-permissions.json`](../rulebook/agent-permissions.json), the machine-readable twin of [chapter 03's Apps table](../rulebook/03-agents.md): exactly the App's permissions, a private App, and no webhook. A test fails if the file and the table disagree.
2. **You click "Create GitHub App".** Your browser opens a local page that sends the manifest to the owner's "create App" page: your personal account's or your organisation's. GitHub shows the name and the permissions; check them and click **Create GitHub App for &lt;owner&gt;**.
3. **The key.** GitHub redirects back to the local listener with a one-time code. The command refuses a redirect whose `state` doesn't match the one it sent, then exchanges the code for the App's id and private key.
4. **The secrets.** It sets `<APP>_APP_ID` and `<APP>_APP_PRIVATE_KEY` (for example `JUDGE_APP_ID`) on every repository named, with `gh secret set`. The key goes to `gh` on standard input, and is never written to disk, printed, or passed as an argument.
5. **You click "Install".** Your browser opens the App's install page. Choose the owner's account, then **Only select repositories**, pick the repositories you named, and click **Install**. The command waits until the installation exists, then checks it covers each of them. It fails if one is missing, and warns if the installation covers all of the owner's repositories (`K-ADOPT-8`). One App covering several repositories is the point (plan 0005 §3.2), so that is no warning.
6. **The register.** It writes one row per role of the App in `docs/qa/agent-identities.md` (the Judge's Reviewer and Merger rows, say, both naming its slug), creating the file if it doesn't exist, and prints the diff. A row the register already has for the role is rewritten in place, with the slug GitHub gave the App, so a placeholder or an old per-role row is replaced rather than doubled. A line that says only "none installed" is removed when the first row is added. For the other repositories named, it prints the rows to copy into each one's register. **Commit them**: the command doesn't.
7. **The Releaser's bypass.** For the Releaser only, it adds the App to the bypass list of each ruleset on each repository's default branch, for pull requests only (`K-MERGE-8`, [#49](https://github.com/yedeya-labs/kanon/issues/49)), because a manifest can't. That needs a token that can edit the ruleset; otherwise it prints the step, and the command. It removes no other bypass actor, such as the admin role: it prints that step, for once your `dco` caller pins a release whose check passes the Releaser's release PR ([`docs/release.md`](release.md#with-the-releaser)).

`lane-check` fails a register in which one App's roles name two slugs, or in which any two of the Author, the Judge and the Releaser share one: Author and Judge sharing an App would let it approve what it authored, and the Releaser sharing one would make its release bypass another role's (plan 0005 §3.4).

## Checking the installations later

A person's token often can't list an account's App installations, but each App can read its own. Kanon's `apps-check` workflow ([`.github/workflows/apps-check.yml`](../.github/workflows/apps-check.yml)) does that for each of the Author, the Judge and the Releaser the register lists: it mints the App's token from `<APP>_APP_ID` and `<APP>_APP_PRIVATE_KEY`, then, with [`cli/apps-check.mjs`](../cli/apps-check.mjs), fails if the App's roles name more than one slug, if the minted slug isn't the register's, if the installation doesn't cover the repository, or if its permissions differ from the App's in `rulebook/agent-permissions.json`, and warns if it covers all of the owner's repositories. Each App's job writes a summary table. It runs by hand and is not a required check.

It is a reusable workflow. Add a thin caller, `.github/workflows/apps-check.yml`, pinned to the same **exact version** as your lanes (`K-ADOPT-11`), and map the two secrets of each App your register lists:

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
    uses: yedeya-labs/kanon/.github/workflows/apps-check.yml@v0.38.0
    secrets:
      AUTHOR_APP_ID: ${{ secrets.AUTHOR_APP_ID }}
      AUTHOR_APP_PRIVATE_KEY: ${{ secrets.AUTHOR_APP_PRIVATE_KEY }}
      JUDGE_APP_ID: ${{ secrets.JUDGE_APP_ID }}
      JUDGE_APP_PRIVATE_KEY: ${{ secrets.JUDGE_APP_PRIVATE_KEY }}
```

<!-- x-release-please-end -->

Then run it:

```sh
gh workflow run apps-check.yml -R <owner>/<repo>
```

- **Map secrets by name, never `secrets: inherit`.** The workflow takes each App's two secrets by their fixed names (`AUTHOR_`, `JUDGE_`, `RELEASER_`), all optional, and each App's job reads only its own two. An App the register lists whose secrets you didn't map fails at the mint, by name.
- **`contents: read` is the ceiling.** Only the job that reads your register uses it; the check jobs run on the App tokens alone.
- **`kanon doctor` reads what it found.** GitHub shows a private App only to the App itself, so each App's job also prints one line, `kanon-apps-check/v1` and the App's slug and installation permissions, which doctor reads from the latest dispatched run on your default branch. Not the App's id: it is the `<APP>_APP_ID` secret's value, which the runner masks in the log ([`docs/doctor.md`](doctor.md#the-token-it-needs), [#417](https://github.com/yedeya-labs/kanon/issues/417)). Run it again after you change an App.
- **The check is the pinned version's.** It runs Kanon's script and compares against Kanon's App permissions at the tag you pinned, and reads only your register from your checkout. `lane-check` reads this caller as no lane caller, and holds it to the one pin and to mapping its secrets by name.

## Limits

- **Key rotation stays manual.** GitHub has no API that makes a new private key for an existing App, so the command can't rotate one. It prints the steps at the end of every run: generate a key on the App's settings page (**Credentials → Key pairs → New key**, [GitHub's steps](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps); not a client secret), `gh secret set <APP>_APP_PRIVATE_KEY -R <owner>/<repo> < key.pem` for each repository the App covers, delete the file, then delete the old key.
- **A lost key can't be recovered.** The pre-check makes this unlikely, but if `gh secret set` still fails after the App is created, the key existed only in memory. The command says so, and how to generate a new one and store it with `--reuse`.
- **It creates and reuses Apps; it doesn't change them.** It doesn't change an existing App's permissions or rename a secret. Moving from the per-role Apps of earlier releases is the migration in the release notes of plan 0005's L4: create the Author and the Judge, rename the secrets, rewrite the register, then uninstall the old Apps.
- **Blast radius.** Any key of an App mints tokens for every repository its installation covers, with that App's grant. That is the cost of one App per owner (plan 0005 §3.2), and why no agent's job holds a key (`K-AGENT-49`).
- **Kanon's three Apps only.** Intake isn't one. Kanon's release workflow runs under the workflow's own token unless its caller maps the optional Releaser App's `RELEASER_APP_ID` and `RELEASER_APP_PRIVATE_KEY` ([`docs/release.md`](release.md#with-the-releaser)), and an Intake App's credentials belong to the running application, not to Actions secrets.
