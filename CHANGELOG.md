# Changelog

## [0.6.1](https://github.com/yedeya-labs/kanon/compare/v0.6.0...v0.6.1) (2026-10-02)


### Documentation

* **plans:** add fault attribution to the telemetry schema ([#42](https://github.com/yedeya-labs/kanon/issues/42)) ([60e4edf](https://github.com/yedeya-labs/kanon/commit/60e4edf763299c7da673d3415387c0caf870e842))
* record self-hosting and the base-rules rule, plan `kanon apps`, and keep version references current ([#40](https://github.com/yedeya-labs/kanon/issues/40)) ([d4010df](https://github.com/yedeya-labs/kanon/commit/d4010df17661e52efd382024f8f6d24d1f538fa6))

## [0.6.0](https://github.com/yedeya-labs/kanon/compare/v0.5.1...v0.6.0) (2026-10-02)


### Features

* **lanes:** move the shared lane workflow and three lanes into Kanon, with lane-check ([#35](https://github.com/yedeya-labs/kanon/issues/35)) ([ae47159](https://github.com/yedeya-labs/kanon/commit/ae47159196db84d1d9e02062358f513da3a571f0))


### Documentation

* **plans:** plan the hosted telemetry store ([#33](https://github.com/yedeya-labs/kanon/issues/33)) ([ece3275](https://github.com/yedeya-labs/kanon/commit/ece3275eba9c24a1168f436504fa8f6453f975d2))


### CI

* **release:** call the reusable release workflow through `$/` ([#38](https://github.com/yedeya-labs/kanon/issues/38)) ([41cea9b](https://github.com/yedeya-labs/kanon/commit/41cea9b0e194443a90b355f5d0bce60bf1490055))
* require the agent lanes smoke check ([#37](https://github.com/yedeya-labs/kanon/issues/37)) ([b40e2d5](https://github.com/yedeya-labs/kanon/commit/b40e2d5882ad6cf5196e9588e0ddcb1ee0ad3ebb))

## [0.5.1](https://github.com/yedeya-labs/kanon/compare/v0.5.0...v0.5.1) (2026-10-02)


### CI

* require the agent blocks smoke check ([#30](https://github.com/yedeya-labs/kanon/issues/30)) ([4a063e0](https://github.com/yedeya-labs/kanon/commit/4a063e0a880a0d63c5b3e92f733fc074dcca82ba))

## [0.5.0](https://github.com/yedeya-labs/kanon/compare/v0.4.4...v0.5.0) (2026-10-02)


### Features

* **actions:** move the agent-lane blocks into Kanon ([#26](https://github.com/yedeya-labs/kanon/issues/26)) ([d5a4e5e](https://github.com/yedeya-labs/kanon/commit/d5a4e5e2a36f7bdfd836e42ae6f56d592fcadff4))

## [0.4.4](https://github.com/yedeya-labs/kanon/compare/v0.4.3...v0.4.4) (2026-10-01)


### Documentation

* **plans:** plan the move of the agent lanes into Kanon ([#13](https://github.com/yedeya-labs/kanon/issues/13)) ([81214fb](https://github.com/yedeya-labs/kanon/commit/81214fb23e421d153be18a69e85ed8a443fd1cb1))

## [0.4.3](https://github.com/yedeya-labs/kanon/compare/v0.4.2...v0.4.3) (2026-09-30)


### Documentation

* **release:** confirm release PRs merge through the admin bypass with the queue on ([#11](https://github.com/yedeya-labs/kanon/issues/11)) ([27762cd](https://github.com/yedeya-labs/kanon/commit/27762cd275c1a878f199969e6723e68f5e4f9882))

## [0.4.2](https://github.com/yedeya-labs/kanon/compare/v0.4.1...v0.4.2) (2026-09-30)


### Tests

* fail ordering assertions when the earlier step is missing ([#8](https://github.com/yedeya-labs/kanon/issues/8)) ([05c3aec](https://github.com/yedeya-labs/kanon/commit/05c3aec8d3aab310c1a3b22e529e85190f2f9920))


### CI

* run every required check on merge_group for the merge queue ([#9](https://github.com/yedeya-labs/kanon/issues/9)) ([bd115f3](https://github.com/yedeya-labs/kanon/commit/bd115f34e0b3453d37f246110cac46f23cf6c0a4))

## [0.4.1](https://github.com/yedeya-labs/kanon/compare/v0.4.0...v0.4.1) (2026-09-30)


### Documentation

* give Kanon a public front page and contribution templates ([#6](https://github.com/yedeya-labs/kanon/issues/6)) ([6320c5d](https://github.com/yedeya-labs/kanon/commit/6320c5d814aa4a16b1eab70f18151d6a51490393))

## [0.4.0](https://github.com/yedeya-labs/kanon/compare/v0.3.0...v0.4.0) (2026-09-30)


### Features

* **actions:** check the DCO sign-off on every pull request commit ([#1](https://github.com/yedeya-labs/kanon/issues/1)) ([9d0b4df](https://github.com/yedeya-labs/kanon/commit/9d0b4dfeabc9f5609aa1065615a3bd313e641e36))


### Documentation

* Kanon is public; drop the private-repository setup steps ([#3](https://github.com/yedeya-labs/kanon/issues/3)) ([30a6291](https://github.com/yedeya-labs/kanon/commit/30a62912b8d32fa7a6fffbf68b0c69476f8e02ee))

## [0.3.0](https://github.com/yedeya-labs/kanon/releases/tag/v0.3.0) (2026-09-30)

The first public release of Kanon, under the Apache-2.0 licence.

It contains the rulebook (ten chapters plus adoption and repository layout), the architecture decisions, the PR-title check (`actions/pr-title`) and the reusable release workflow (`.github/workflows/release.yml`). Earlier versions (0.1.0 to 0.2.0) were private and are not published.
