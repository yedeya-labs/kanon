# Creating the agent Apps: `kanon apps`

Step 12 of the adoption checklist (`K-ADOPT-1`) gives every agent role its own GitHub App, holding exactly that role's permissions (`K-ADOPT-8`), with its id and key stored as Actions secrets (`K-AGENT-6`) and a row in the App register (`K-LAYOUT-6`). Done by hand, each App means a name, the permissions one by one, turning the webhook off, a key, an installation, two secrets and a register row. `kanon apps` does all of that from a [GitHub App manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest), and leaves the Owner two clicks per App: **Create** and **Install**. The command never creates an App or a key itself; the Owner does, in GitHub's own pages (`K-AGENT-6`).

## What you need

- **Node 24 or later.** The command uses Node's built-ins only, so nothing is installed.
- **`gh`, signed in as the Owner**: an admin of the repository, who can set its Actions secrets. The command stores the secrets with your own `gh`, and checks it can before it opens any page.
- **A browser on the same machine.** GitHub sends you back to a listener on `127.0.0.1` once the App is created.
- **A checkout of the repository**, where the command writes the App register. Run it from there, or pass `--dir`.

## Run it

The npm package isn't published yet, so run the command from a tagged Kanon release, from the adopter's checkout:

<!-- x-release-please-start-version -->

```sh
npx --yes --package github:yedeya-labs/kanon#v0.6.1 kanon apps --org <org> --repo <repo> --roles reviewer
```

<!-- x-release-please-end -->

Or, from a Kanon checkout: `node cli/kanon.mjs apps --org <org> --repo <repo> --roles reviewer --dir <path to the adopter's checkout>`.

`--roles` takes one role or several, comma-separated: `explorer`, `implementer`, `reviewer`, `merger`, `lead`, `overseer`. Create the **Reviewer first**: it is the App that ends bootstrap (`K-ADOPT-6`). Each App is named `<repo>-<role>` unless you pass `--name <role>=<name>`. App names are unique across all of GitHub, so if the name is taken, change it on GitHub's page before you click **Create**; the command reads back the slug GitHub gives it.

## What happens, and what you click

For each role, in turn:

1. **The manifest.** The command builds it from [`rulebook/agent-permissions.json`](../rulebook/agent-permissions.json), the machine-readable twin of [chapter 03's roles table](../rulebook/03-agents.md): exactly the role's permissions plus Metadata: read, a private App, and no webhook. A test fails if the file and the table disagree.
2. **You click "Create GitHub App".** Your browser opens a local page that sends the manifest to your organisation's "create App" page. GitHub shows the name and the permissions; check them and click **Create GitHub App for &lt;org&gt;**.
3. **The key.** GitHub redirects back to the local listener with a one-time code. The command refuses a redirect whose `state` doesn't match the one it sent, then exchanges the code for the App's id and private key.
4. **The secrets.** It sets `<ROLE>_APP_ID` and `<ROLE>_APP_PRIVATE_KEY` (for example `REVIEWER_APP_ID`) on the repository with `gh secret set`. The key goes to `gh` on standard input, and is never written to disk, printed, or passed as an argument.
5. **You click "Install".** Your browser opens the App's install page. Choose the organisation, then **Only select repositories**, pick the repository alone, and click **Install**. The command waits until the installation exists, then checks it covers this repository. It fails if the repository is missing, and warns if the installation covers all repositories or any other one (`K-ADOPT-8`: one App per role per repository).
6. **The register.** It writes the role's row in `docs/qa/agent-identities.md`, creating the file if it doesn't exist, and prints the diff. **Commit it**: the command doesn't.

## Limits

- **Key rotation stays manual.** GitHub has no API that makes a new private key for an existing App, so the command can't rotate one. It prints the steps at the end of every run: generate a key on the App's settings page, `gh secret set <ROLE>_APP_PRIVATE_KEY -R <org>/<repo> < key.pem`, delete the file, then delete the old key.
- **A lost key can't be recovered.** If `gh secret set` fails after the App is created, the key existed only in memory. The command says so and prints how to generate a new one by hand.
- **It creates new Apps only.** It doesn't change an existing App's permissions, rename a secret, or move an App to another repository. Sharing one App across repositories is the adopter's deliberate choice, recorded in the register (`K-AGENT-3`).
- **Agent roles only.** Intake and the Releaser aren't agents. Kanon's release workflow runs under the workflow's own token, and an Intake App's credentials belong to the running application, not to Actions secrets.
