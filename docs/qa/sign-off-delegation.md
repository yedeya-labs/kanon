# Sign-off delegation

Kanon's own agents commit under the Apps in the [App register](agent-identities.md), and an App can't certify the [Developer Certificate of Origin](https://developercertificate.org/). The Owner delegates the sign-off on those commits to one person, who takes responsibility for every commit an agent App of this repository authors (`K-AGENT-44`, `K-LAYOUT-14`). Contributors' commits are unaffected: each person signs off their own ([CONTRIBUTING.md](../../CONTRIBUTING.md)).

| Delegate | Email | Delegated on |
|---|---|---|
| Geoffry Nagy | yedeya@gmail.com | 2026-10-04 |

The `dco` check reads this record from the default branch only, so it applies to the pull requests opened after it merges. Kanon's project-setup hook adds this sign-off to the Implementer's commits ([`agent-commits.sh`](../../.github/actions/project-setup/agent-commits.sh)); the check judges them by this record either way.
