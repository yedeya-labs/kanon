# Sign-off delegation

Kanon's own agents commit under the Apps in the [App register](agent-identities.md), and an App can't certify the [Developer Certificate of Origin](https://developercertificate.org/). The Owner delegates the sign-off on those commits to one person, who takes responsibility for every commit an agent App of this repository authors (`K-AGENT-44`, `K-LAYOUT-14`). Contributors' commits are unaffected: each person signs off their own ([CONTRIBUTING.md](../../CONTRIBUTING.md)).

| Delegate | Email | Delegated on |
|---|---|---|
| Geoffry Nagy | yedeya@gmail.com | 2026-10-04 |

The `dco` check reads this record from the default branch only, so it applies to the pull requests opened after it merges. The lanes' `agent-setup` block adds this sign-off to every agent commit, as for any adopter ([`agent-setup`](../../actions/agent-setup/README.md)); the check judges them by this record either way. Kanon's lanes run the release their callers pin, so the block does this for Kanon from the first release that includes [#234](https://github.com/yedeya-labs/kanon/issues/234) onwards.
