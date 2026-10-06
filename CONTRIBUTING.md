# Contributing to Kanon

Kanon is opinionated on purpose. Its rules are fixed, not configurable ([ADR 0002](docs/decisions/0002-standardise-dont-parameterise.md)). A contribution that changes a rule has to change it for every adopter, and must say why in the rule's own **Why** paragraph.

## Sign off every commit (DCO)

Kanon uses the [Developer Certificate of Origin](https://developercertificate.org/) instead of a contributor licence agreement ([ADR 0010](docs/decisions/0010-licence.md)). By adding a sign-off line to a commit, you certify that you wrote the change, or otherwise have the right to submit it, under the project's licence (Apache-2.0). You keep the copyright in your contribution.

```text
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it for you, using your git `user.name` and `user.email`. A pull request whose commits aren't all signed off can't be merged: the [DCO check](actions/dco/README.md) fails it, and lists each commit whose sign-off is missing or isn't its author's. To fix one that isn't, run `git commit --amend -s`, or `git rebase --signoff main` for several commits, and force-push.

### AI-assisted changes

AI-assisted changes are welcome. The **human** who submits them signs off, and so certifies the DCO and takes responsibility for the change. The AI may be credited with a `Co-Authored-By:` trailer, but never signs off: the DCO check fails a commit whose only sign-off is an AI or bot identity.

### The repository's own agents

The one exception is a commit authored by one of the repository's **own** agent Apps, the ones listed in its App register (`docs/qa/agent-identities.md`). When the Owner records a standing delegation in `docs/qa/sign-off-delegation.md`, such a commit carries the sign-off of the person it names, who takes responsibility for it ([`K-AGENT-44`](rulebook/03-agents.md)). The DCO check reads both files from the base branch, so a pull request can't add itself to either. Without a record, an agent's commit fails the check like any other. Contributors' commits, AI-assisted or not, are unaffected: you sign off your own.

## How changes land

- **Titles.** Every pull request title is a conventional commit with one of Kanon's fixed types, and never ends in `(#n)` ([`K-SHIP-4`](rulebook/06-shipping.md)). CI checks it.
- **Merging.** Pull requests are squash-merged, with the title as the commit subject and the body as its message.
- **Tests.** Kanon's own tests must pass. A change to a check comes with a test that fails without it.
- **The Reviewer's grant.** A change to the Reviewer's flags (`.github/workflows/review-agent-job.yml`), or a bump of the claude-code-action pin in `actions/agent-run`, is red until the grant is re-probed against the CLI that ships ([#284](https://github.com/yedeya-labs/kanon/issues/284)). Run `node .github/scripts/reviewer-grant-probe.mjs --version-only` for the CLI version, install it, run the script again with `--cli <binary>` and a Claude token in the environment, and commit the `.github/scripts/reviewer-grant-record.json` it writes. It writes nothing unless every probe passes. A probe that fails is a widening of what a pull request can talk the Reviewer into, so raise it with the Owner instead.
- **Changes to the checks that judge a PR.** Kanon's required DCO and PR-title checks run Kanon's last release, not the copy in your pull request, so a pull request can't weaken the check that passes it ([#47](https://github.com/yedeya-labs/kanon/issues/47), [ADR 0011](docs/decisions/0011-kanon-runs-its-own-lanes.md)). A change to `actions/dco` or `actions/pr-title` is therefore judged by the released version, and takes effect one release later, when Dependabot bumps the pin. Your copy still runs on your pull request, in the "Judging actions smoke" check, so a broken change still fails CI.
- **Security.** Don't open a public issue for a security problem. See [SECURITY.md](SECURITY.md).
