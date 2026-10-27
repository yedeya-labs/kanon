# Kanon

[![CI](https://github.com/yedeya-labs/kanon/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/yedeya-labs/kanon/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/yedeya-labs/kanon?sort=semver)](https://github.com/yedeya-labs/kanon/releases)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Let Claude review your pull requests, then merge the safe ones and implement your issues, with CI and GitHub, not prompts, deciding what it may do on its own.**

Kanon is a set of GitHub workflows and two GitHub Apps for teams that let Claude Code agents work on a real repository. Start with the Reviewer on every pull request, and hand over more when you trust it.

- **About a dollar a reviewed pull request.** $1.13 at the median at API list price ($2.74 at the 90th percentile), over 360 pull requests on Kanon's own repository, on your own API key or Claude subscription. [What each lane costs](docs/lanes.md#what-a-model-run-costs).
- **Rules that fail the build, not prompts.** Agents seldom read a repository's rules file, and in [RepoComplianceBench](https://arxiv.org/abs/2607.26819) none followed a "stop and hand off to a person" rule unaided. Most of Kanon's rules are CI checks, tests and GitHub settings, and [the count below](#what-is-enforced-honestly) says which aren't yet.
- **An agent never approves its own work.** Writing and approving run under two separate GitHub Apps. A pull request can't change the rules it is judged by, and the Reviewer never runs its code.
- **You decide how far it goes.** Review only, then low-risk pull requests merging on their own, then agents implementing issues. Anything on a path you mark always goes to a person.

Kanon builds itself this way: [its own pull requests](https://github.com/yedeya-labs/kanon/pulls?q=is%3Apr+is%3Amerged) are reviewed by its own Reviewer, and nearly all are written by Claude Code agents.

> **κανών** (*kanōn*): a measuring rod; the rule that work is checked against.

## Who it's for

A team or a solo developer on GitHub who wants agents to do real work on a real repository, with a test suite the agents can run, and who would rather adopt one set of rules than design their own. Kanon has **no configuration**: when a rule doesn't fit, the rule changes for everyone, or the project is outside what Kanon is for ([ADR 0002](docs/decisions/0002-standardise-dont-parameterise.md)).

## How it works

- **Two GitHub Apps** act for the agents: the **Author** writes (the Lead, Implementer, Explorer and Overseer) and the **Judge** judges (the Reviewer and Merger).
- **Lanes** are reusable workflows that run one agent each, started by a label, a review or a schedule.
- **The Reviewer** reviews a pull request labelled `review:please` until it approves. A person merges, or the Merger merges inside a narrow green zone you define. Anything on an escalation path always goes to a person.

[docs/architecture.md](docs/architecture.md) shows the whole picture on one page.

## Quickstart

You need Node 24, Claude Code, `gh` signed in as a repository admin, and a CI workflow. In Claude Code, from your repository:

<!-- x-release-please-start-version -->

```sh
claude plugin marketplace add yedeya-labs/kanon#v0.42.0
claude plugin install kanon@kanon
```

<!-- x-release-please-end -->

Type `/kanon:adopt` next; asking the agent to install Kanon won't start it. It asks three questions, which environments your releases deploy to, if any, and, where a lane you choose posts to chat (the full pipeline's digests, or the release announcement for each published release), which hook posts it (Slack, a JSON webhook, your own or none), shows one summary to confirm, writes the files on a branch, walks you through the steps only you can take (creating the two Apps, adding a secret), and opens the pull request. Start with **Review**: the Reviewer on your pull requests, nothing else. [docs/install.md](docs/install.md) has every other way to install.

## What is enforced, honestly

The [rulebook](rulebook/) has 226 rules, each with its reason. 171 name what enforces them, in whole or in part: a CI check, a test, a GitHub setting or the Reviewer's checklist. **55 are prose only**: their "Enforced by" line says so, and they are Kanon's own backlog. Kanon is pre-1.0 and runs its own lanes on itself ([ADR 0011](docs/decisions/0011-kanon-runs-its-own-lanes.md)).

## Read on

- [Architecture](docs/architecture.md): Apps, lanes, gates and data, on one page.
- [Installing](docs/install.md), [lanes](docs/lanes.md), [`kanon doctor`](docs/doctor.md), [`kanon status`](docs/status.md), [what sharing sends](docs/sharing.md).
- [Rulebook](rulebook/) and [decisions](docs/decisions/), the [roadmap](ROADMAP.md).

## Contributing

Contributions are welcome, and every commit must be signed off by its human author. AI-assisted changes are fine, but a person certifies them. See [CONTRIBUTING.md](CONTRIBUTING.md), and please follow the [code of conduct](CODE_OF_CONDUCT.md). Report security problems privately, as described in [SECURITY.md](SECURITY.md).

## License

Kanon is licensed under the [Apache License 2.0](LICENSE). The name "Kanon" is not covered by the licence; see [TRADEMARK.md](TRADEMARK.md).
