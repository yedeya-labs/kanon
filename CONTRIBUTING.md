# Contributing to Kanon

Kanon is opinionated on purpose. Its rules are fixed, not configurable ([ADR 0002](docs/decisions/0002-standardise-dont-parameterise.md)). A contribution that changes a rule has to change it for every adopter, and must say why in the rule's own **Why** paragraph.

## Sign off every commit (DCO)

Kanon uses the [Developer Certificate of Origin](https://developercertificate.org/) instead of a contributor licence agreement ([ADR 0010](docs/decisions/0010-licence.md)). By adding a sign-off line to a commit, you certify that you wrote the change, or otherwise have the right to submit it, under the project's licence (Apache-2.0). You keep the copyright in your contribution.

```text
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it for you, using your git `user.name` and `user.email`. A pull request whose commits aren't all signed off can't be merged. To fix one that isn't, run `git commit --amend -s`, or `git rebase --signoff main` for several commits, and force-push.

## How changes land

- **Titles.** Every pull request title is a conventional commit with one of Kanon's fixed types, and never ends in `(#n)` ([`K-SHIP-4`](rulebook/06-shipping.md)). CI checks it.
- **Merging.** Pull requests are squash-merged, with the title as the commit subject and the body as its message.
- **Tests.** Kanon's own tests must pass. A change to a check comes with a test that fails without it.
- **Security.** Don't open a public issue for a security problem. See [SECURITY.md](SECURITY.md).
