# Changelog

## [0.24.0](https://github.com/yedeya-labs/kanon/compare/v0.23.0...v0.24.0) (2026-10-04)


### Features

* **qa-store:** define the QA store contract and ship its AWS implementation ([#222](https://github.com/yedeya-labs/kanon/issues/222)) ([cc9db0e](https://github.com/yedeya-labs/kanon/commit/cc9db0eef9668a1a94326e1eb1fbe0e925de9925))

## [0.23.0](https://github.com/yedeya-labs/kanon/compare/v0.22.0...v0.23.0) (2026-10-04)


### ⚠ BREAKING CHANGES

* **lanes:** declare the weekly digest's audience, narrow K-LAYOUT-18's exemption, and name the environment early ([#221](https://github.com/yedeya-labs/kanon/issues/221))

### Features

* **lanes:** declare the weekly digest's audience, narrow K-LAYOUT-18's exemption, and name the environment early ([#221](https://github.com/yedeya-labs/kanon/issues/221)) ([c4908d8](https://github.com/yedeya-labs/kanon/commit/c4908d8f29d80e06315cd800fd21820fb3f53121))

## [0.22.0](https://github.com/yedeya-labs/kanon/compare/v0.21.0...v0.22.0) (2026-10-04)


### Features

* **lanes:** move the project and weekly digests into Kanon, and fix each caller's file name ([#216](https://github.com/yedeya-labs/kanon/issues/216)) ([b12d9f2](https://github.com/yedeya-labs/kanon/commit/b12d9f22234f86400ebc54d7cc3351588c5a7f91))


### Documentation

* **plans:** read the dispatch sweep's cost rows from the store first, and record plan 0004's progress ([#211](https://github.com/yedeya-labs/kanon/issues/211)) ([fa0b47b](https://github.com/yedeya-labs/kanon/commit/fa0b47bbc1bda7f71495b3a935299158d72605ad))

## [0.21.0](https://github.com/yedeya-labs/kanon/compare/v0.20.0...v0.21.0) (2026-10-04)


### Features

* **lanes:** move the Merger and the Lead's reconciler into Kanon ([#206](https://github.com/yedeya-labs/kanon/issues/206)) ([5a58927](https://github.com/yedeya-labs/kanon/commit/5a5892753d68da1097bf156ebee609bcb6d2944d))
* **telemetry:** read a lane's cost rows from its run artifacts ([#204](https://github.com/yedeya-labs/kanon/issues/204)) ([9f4bcf5](https://github.com/yedeya-labs/kanon/commit/9f4bcf58058c82fe80d984c8ad13f81de73a0f8f))

## [0.20.0](https://github.com/yedeya-labs/kanon/compare/v0.19.0...v0.20.0) (2026-10-04)


### ⚠ BREAKING CHANGES

* **lead:** read the reference environment's deploy from the adoption record ([#198](https://github.com/yedeya-labs/kanon/issues/198))

### Features

* **lead:** read the reference environment's deploy from the adoption record ([#198](https://github.com/yedeya-labs/kanon/issues/198)) ([162ce14](https://github.com/yedeya-labs/kanon/commit/162ce14ba30a73a60ee0dfcc90cb7548a04f546a))


### Documentation

* **plans:** record the Owner's decisions on plan 0004 ([#196](https://github.com/yedeya-labs/kanon/issues/196)) ([658749f](https://github.com/yedeya-labs/kanon/commit/658749fdec8ca0211cd1d399ceb3bd452355213c))

## [0.19.0](https://github.com/yedeya-labs/kanon/compare/v0.18.0...v0.19.0) (2026-10-03)


### Features

* **lanes:** write protocol strings with role names, and narrow each lane's App token ([#155](https://github.com/yedeya-labs/kanon/issues/155)) ([efdcd0a](https://github.com/yedeya-labs/kanon/commit/efdcd0a0bf7895059bdaf998ddf73e98fd725dbb))


### Bug Fixes

* **lane-check:** pass the release caller, parse the declaration files, and let an adopter run apps-check ([#172](https://github.com/yedeya-labs/kanon/issues/172)) ([6226585](https://github.com/yedeya-labs/kanon/commit/6226585889ee0d6a9491747c204c1785d6c844a6))


### Documentation

* **adoption:** close the gaps a first adopter hit setting up the review lane ([#156](https://github.com/yedeya-labs/kanon/issues/156)) ([a449ec1](https://github.com/yedeya-labs/kanon/commit/a449ec1e150d20f7e441497b0f13ec4f5215115c))
* **plans:** plan the move of the remaining lanes, and record step 6 as paused ([#194](https://github.com/yedeya-labs/kanon/issues/194)) ([d1ee46f](https://github.com/yedeya-labs/kanon/commit/d1ee46fb40fa51273ac1f16c63bb2ad13d096b11))

## [0.18.0](https://github.com/yedeya-labs/kanon/compare/v0.17.0...v0.18.0) (2026-10-03)


### Features

* **guards:** escalate agent instruction changes, and check a wrapped caller's pin ([#149](https://github.com/yedeya-labs/kanon/issues/149)) ([cb2de9a](https://github.com/yedeya-labs/kanon/commit/cb2de9afa0741f7b1b2b48cc2c47eb203024c30c))


### Bug Fixes

* **guards:** cite Kanon's rules in brief-guard's messages, not the reference adopter's documents ([#145](https://github.com/yedeya-labs/kanon/issues/145)) ([4b5c307](https://github.com/yedeya-labs/kanon/commit/4b5c307dff8d0b9e7ec60d6d686005e1d7709d4b))
* **spec:** read a bare pytest or Go test file name in a spec as the file it names ([#147](https://github.com/yedeya-labs/kanon/issues/147)) ([90edeeb](https://github.com/yedeya-labs/kanon/commit/90edeebc8fbd86d3e51edb0a5b71869a234ea1f1))
* **spec:** read only the titles of tests pytest collects and go test runs ([#148](https://github.com/yedeya-labs/kanon/issues/148)) ([20b0ea6](https://github.com/yedeya-labs/kanon/commit/20b0ea6517f94392894ca5519e4d939795b7d662))
* **tests:** catch an account id in an ECR hostname in the public-tree guard ([#144](https://github.com/yedeya-labs/kanon/issues/144)) ([1ea29d1](https://github.com/yedeya-labs/kanon/commit/1ea29d10439410a426dc56a17f3055bde1787136))

## [0.17.0](https://github.com/yedeya-labs/kanon/compare/v0.16.0...v0.17.0) (2026-10-03)


### ⚠ BREAKING CHANGES

* **lanes:** take the reference adopter's stack out of the lane prompts ([#140](https://github.com/yedeya-labs/kanon/issues/140))
* **lanes:** start only the test database the project declares ([#139](https://github.com/yedeya-labs/kanon/issues/139))
* **guards:** read the brief and doc-path exemptions from the adopter's exemptions file ([#137](https://github.com/yedeya-labs/kanon/issues/137))
* **guards:** read the adopter's escalation paths and pipeline code from its escalation file ([#135](https://github.com/yedeya-labs/kanon/issues/135))
* **guards:** take roadmap milestones from the repository, not the reference adopter's names ([#136](https://github.com/yedeya-labs/kanon/issues/136))

### Features

* **guards:** read the adopter's escalation paths and pipeline code from its escalation file ([#135](https://github.com/yedeya-labs/kanon/issues/135)) ([610b111](https://github.com/yedeya-labs/kanon/commit/610b111430eba95041df177e34caa663abb61a04))
* **guards:** read the brief and doc-path exemptions from the adopter's exemptions file ([#137](https://github.com/yedeya-labs/kanon/issues/137)) ([b95d2c4](https://github.com/yedeya-labs/kanon/commit/b95d2c442372d431b0cb80f910d7602c29fc8423))
* **guards:** take roadmap milestones from the repository, not the reference adopter's names ([#136](https://github.com/yedeya-labs/kanon/issues/136)) ([781c391](https://github.com/yedeya-labs/kanon/commit/781c3916fedc09afd267d0fd119439aa05784387))
* **lanes:** start only the test database the project declares ([#139](https://github.com/yedeya-labs/kanon/issues/139)) ([4774799](https://github.com/yedeya-labs/kanon/commit/477479924f4a64689c1c703b5a176c20ee7d42eb))
* **lanes:** take the reference adopter's stack out of the lane prompts ([#140](https://github.com/yedeya-labs/kanon/issues/140)) ([5900e22](https://github.com/yedeya-labs/kanon/commit/5900e2278affd0d361fd2b8c2d09ac4643d76338))


### Bug Fixes

* **release:** pass a package's first release, whose manifest entry is new ([#134](https://github.com/yedeya-labs/kanon/issues/134)) ([715d507](https://github.com/yedeya-labs/kanon/commit/715d507250c43f666cfeb6f1f8b8b66cac3fcacb))
* **telemetry:** keep the version-2 telemetry artifact 90 days ([#133](https://github.com/yedeya-labs/kanon/issues/133)) ([e79b5a6](https://github.com/yedeya-labs/kanon/commit/e79b5a6988ad2f20ff09cd5ceed61c355f5a3781))
* **tests:** don't read a commit hash's digits as an AWS account id ([#131](https://github.com/yedeya-labs/kanon/issues/131)) ([beb0d98](https://github.com/yedeya-labs/kanon/commit/beb0d980e5c45440054f713948ff3e982c2edbef))

## [0.16.0](https://github.com/yedeya-labs/kanon/compare/v0.15.1...v0.16.0) (2026-10-03)


### Features

* **spec:** recognise tests and their titles by a fixed per-language convention ([#125](https://github.com/yedeya-labs/kanon/issues/125)) ([3aef40c](https://github.com/yedeya-labs/kanon/commit/3aef40c52a3e859035050b95110d166b181cc75a))


### Bug Fixes

* **release:** refuse a release PR that moves a version backwards or to one it doesn't release ([#126](https://github.com/yedeya-labs/kanon/issues/126)) ([5b80abd](https://github.com/yedeya-labs/kanon/commit/5b80abdce2efc1cb436d7d52a18e8839df1537ae))


### Documentation

* **plans:** let step 6 go ahead without the telemetry store ([#122](https://github.com/yedeya-labs/kanon/issues/122)) ([3eb5613](https://github.com/yedeya-labs/kanon/commit/3eb5613ee908262524890f935d95a1d076cd6a26))

## [0.15.1](https://github.com/yedeya-labs/kanon/compare/v0.15.0...v0.15.1) (2026-10-03)


### Bug Fixes

* **citation:** count a coordinate into an untracked, git-ignored dependency as external on any stack ([#119](https://github.com/yedeya-labs/kanon/issues/119)) ([b448e21](https://github.com/yedeya-labs/kanon/commit/b448e2149b572150a0dde31c825a55bd0dd585a0))
* **release:** skip the root changelog.json for node as well as python in the release-PR guard ([#121](https://github.com/yedeya-labs/kanon/issues/121)) ([d21d622](https://github.com/yedeya-labs/kanon/commit/d21d62214d8ff4914268f69d5708f61f23b803da))

## [0.15.0](https://github.com/yedeya-labs/kanon/compare/v0.14.0...v0.15.0) (2026-10-03)


### Features

* **guards:** run Kanon's guards on a project with no package.json ([#106](https://github.com/yedeya-labs/kanon/issues/106)) ([acca437](https://github.com/yedeya-labs/kanon/commit/acca4371e012cd497ff31c828a37b6456804e283))
* **lanes:** set up Kanon's pinned Node in `kanon-path`, and give every agent step `KANON` ([#113](https://github.com/yedeya-labs/kanon/issues/113)) ([e650162](https://github.com/yedeya-labs/kanon/commit/e6501623d9b5290f2b07da577d39cfb8b129946c))
* **release:** choose the release type by the adopter's language, with `simple` as the default ([#107](https://github.com/yedeya-labs/kanon/issues/107)) ([9c5c3a7](https://github.com/yedeya-labs/kanon/commit/9c5c3a73adcaf573d3be8b205c23a0f42271c3bc))


### Bug Fixes

* **lanes:** refuse a lane whose caller, run from another branch, pins another Kanon version ([#112](https://github.com/yedeya-labs/kanon/issues/112)) ([d0e821a](https://github.com/yedeya-labs/kanon/commit/d0e821a95d3a8dfa927adc554dcc5a4453712613))
* **review:** give one commit one verdict, and answer an explicit request with the verdict after it ([#104](https://github.com/yedeya-labs/kanon/issues/104)) ([e9c95be](https://github.com/yedeya-labs/kanon/commit/e9c95beb8da1aac57f63818f613dfc629a5b758f))
* **review:** judge whoever applied the review label on CI's completion, not the pusher ([#111](https://github.com/yedeya-labs/kanon/issues/111)) ([1208a04](https://github.com/yedeya-labs/kanon/commit/1208a04107166f63cf30c4034673c95cbb48a959))
* **telemetry:** make verify.mjs exercise the table's write deny with a probe role ([#116](https://github.com/yedeya-labs/kanon/issues/116)) ([29de990](https://github.com/yedeya-labs/kanon/commit/29de990b30cb546b1371ab14c61748bc75451573))


### Documentation

* **plans:** record the Owner's decisions on the backfill role, verify mode and concurrency ([#102](https://github.com/yedeya-labs/kanon/issues/102)) ([f1b7757](https://github.com/yedeya-labs/kanon/commit/f1b7757a15e6aa50a737b9ba452de6517b7e6567))

## [0.14.0](https://github.com/yedeya-labs/kanon/compare/v0.13.0...v0.14.0) (2026-10-02)


### Features

* **telemetry:** deploy the hosted store with CloudFormation, and verify it ([#100](https://github.com/yedeya-labs/kanon/issues/100)) ([9bfd1cb](https://github.com/yedeya-labs/kanon/commit/9bfd1cbef22d30f00fc9454b91d029d3e9ee4cca))


### Documentation

* **qa:** add Kanon's own adoption record and record the end of bootstrap ([#98](https://github.com/yedeya-labs/kanon/issues/98)) ([70eccc1](https://github.com/yedeya-labs/kanon/commit/70eccc181ffba5ff03d28ac802036d8bf1109d7e))

## [0.13.0](https://github.com/yedeya-labs/kanon/compare/v0.12.0...v0.13.0) (2026-10-02)


### Features

* **telemetry:** validate a version-2 run row and upload it beside the old one ([#96](https://github.com/yedeya-labs/kanon/issues/96)) ([c6c2190](https://github.com/yedeya-labs/kanon/commit/c6c2190629f7f7bd7711f89df765892a8725fbf2))


### Tests

* **ci:** keep actionlint's unit tests off the network ([#94](https://github.com/yedeya-labs/kanon/issues/94)) ([dee8960](https://github.com/yedeya-labs/kanon/commit/dee896016649edaef9f9cac3bf9947f4d1d52499))

## [0.12.0](https://github.com/yedeya-labs/kanon/compare/v0.11.0...v0.12.0) (2026-10-02)


### Features

* **cli:** create the bucket milestones with `kanon milestones` ([#87](https://github.com/yedeya-labs/kanon/issues/87)) ([9724f50](https://github.com/yedeya-labs/kanon/commit/9724f502ca16f429213a7f052935e73982fa2d71))


### Bug Fixes

* **lanes:** judge the project-setup hook by its outcome only, and run actionlint in CI ([#83](https://github.com/yedeya-labs/kanon/issues/83)) ([a818d31](https://github.com/yedeya-labs/kanon/commit/a818d310c613ccc42dc5936cde03661aacf5467e))
* **lanes:** mint App tokens with `client-id`, not the deprecated `app-id` ([#84](https://github.com/yedeya-labs/kanon/issues/84)) ([796f6e3](https://github.com/yedeya-labs/kanon/commit/796f6e3320bac93c156e94050dfce825d3091a6f))
* **release:** refuse a release PR that changes more than version strings ([#82](https://github.com/yedeya-labs/kanon/issues/82)) ([4b427ce](https://github.com/yedeya-labs/kanon/commit/4b427ce330d6994c0b992c508b3ee92955569fa6))


### Documentation

* **plans:** amend plan 0002 for the work-item row and the new run fields ([#80](https://github.com/yedeya-labs/kanon/issues/80)) ([b927fe9](https://github.com/yedeya-labs/kanon/commit/b927fe90fe1f2afab6668460a465353270d7ff9a))
* **plans:** plan the metrics: cost, efficiency, accuracy and the work-item row ([#76](https://github.com/yedeya-labs/kanon/issues/76)) ([86533be](https://github.com/yedeya-labs/kanon/commit/86533beabc3f7908bc2e9160b63d944635b265a1))

## [0.11.0](https://github.com/yedeya-labs/kanon/compare/v0.10.0...v0.11.0) (2026-10-02)


### Features

* **lanes:** move the lead, lead-split and rebase lanes into Kanon ([#71](https://github.com/yedeya-labs/kanon/issues/71)) ([d744dd9](https://github.com/yedeya-labs/kanon/commit/d744dd9082d873a3cc1a98b652c42e5b28548034))


### Documentation

* **qa:** add Kanon's reviewer playbook and severity rubric ([#74](https://github.com/yedeya-labs/kanon/issues/74)) ([4449b23](https://github.com/yedeya-labs/kanon/commit/4449b238b58a9f2d90fb890bad94b86b979626a0))


### CI

* review Kanon's own pull requests with the released review lane ([#70](https://github.com/yedeya-labs/kanon/issues/70)) ([ef2c35f](https://github.com/yedeya-labs/kanon/commit/ef2c35fe0070d449afa95cc30662dceb6b14ae52))

## [0.10.0](https://github.com/yedeya-labs/kanon/compare/v0.9.1...v0.10.0) (2026-10-02)


### Features

* **lanes:** move the review and verify-acs lanes into Kanon, and restore K-MERGE-17's list from the default branch ([#67](https://github.com/yedeya-labs/kanon/issues/67)) ([18c6bcd](https://github.com/yedeya-labs/kanon/commit/18c6bcdd94a42024b58acd3ca77f6ca5d6b0397f))

## [0.9.1](https://github.com/yedeya-labs/kanon/compare/v0.9.0...v0.9.1) (2026-10-02)


### Bug Fixes

* **library:** name merge-reconcile's called filter job, and drop a stale exemption ([#65](https://github.com/yedeya-labs/kanon/issues/65)) ([2388d69](https://github.com/yedeya-labs/kanon/commit/2388d6927582d45a26cf1aca9e61f628809fcff5))
* read DCO inputs from the default branch, and let the brief guard accept measurement items ([#64](https://github.com/yedeya-labs/kanon/issues/64)) ([717b624](https://github.com/yedeya-labs/kanon/commit/717b6243976c83ad707d7d66d115601082d8d1ce))

## [0.9.0](https://github.com/yedeya-labs/kanon/compare/v0.8.1...v0.9.0) (2026-10-02)


### Features

* **lanes:** gate every lane on membership before it mints a token ([#61](https://github.com/yedeya-labs/kanon/issues/61)) ([64e0a15](https://github.com/yedeya-labs/kanon/commit/64e0a1545ab64dc3f342d2b2a499221ff6e3d8b9))

## [0.8.1](https://github.com/yedeya-labs/kanon/compare/v0.8.0...v0.8.1) (2026-10-02)


### Bug Fixes

* **cli:** make the `kanon apps` pre-check write a secret, and add an `apps-check` workflow ([#59](https://github.com/yedeya-labs/kanon/issues/59)) ([2cad45d](https://github.com/yedeya-labs/kanon/commit/2cad45dc6f1984fc02af8e58e43765801a5fe224))
* **library:** report a skipped cost read in the dispatch sweep (port of RA-2714) ([#60](https://github.com/yedeya-labs/kanon/issues/60)) ([8912e2b](https://github.com/yedeya-labs/kanon/commit/8912e2b1cb6f6c5440f58a12edd02f4fb0344373))


### Documentation

* **readme:** show the CI badge for pushes to main only ([#57](https://github.com/yedeya-labs/kanon/issues/57)) ([2e4328c](https://github.com/yedeya-labs/kanon/commit/2e4328ca0b5b80dd06141762c2aba8d9e7c1889b))

## [0.8.0](https://github.com/yedeya-labs/kanon/compare/v0.7.0...v0.8.0) (2026-10-02)


### Features

* **lanes:** move the pipeline library, kanon-path, and the implement and merge-reconcile lanes into Kanon ([#51](https://github.com/yedeya-labs/kanon/issues/51)) ([ce55a9b](https://github.com/yedeya-labs/kanon/commit/ce55a9ba956dbbe04dde4e3c01317e4cbdf43054))


### CI

* run the checks that judge a Kanon PR from the last release ([#52](https://github.com/yedeya-labs/kanon/issues/52)) ([c197455](https://github.com/yedeya-labs/kanon/commit/c1974552586bd367029477f0b34e203ee4ca6b0d))

## [0.7.0](https://github.com/yedeya-labs/kanon/compare/v0.6.1...v0.7.0) (2026-10-02)


### Features

* **cli:** add `kanon apps`, which creates an adopter's agent Apps from manifests ([#45](https://github.com/yedeya-labs/kanon/issues/45)) ([b4d6560](https://github.com/yedeya-labs/kanon/commit/b4d65601f32a4a9de0aa9371d8249b1e1d7ccebb))
* delegate sign-off for an adopter's own agents, and make security a principle ([#44](https://github.com/yedeya-labs/kanon/issues/44)) ([a0b6cd3](https://github.com/yedeya-labs/kanon/commit/a0b6cd3f9477380cf9fa6c152de89f8ba3858117))

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
