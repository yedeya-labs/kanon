# Changelog

## [0.29.0](https://github.com/yedeya-labs/kanon/compare/v0.28.0...v0.29.0) (2026-10-06)


### Features

* **cli:** add kanon doctor, with a versioned JSON output ([#370](https://github.com/yedeya-labs/kanon/issues/370)) ([b9daf5b](https://github.com/yedeya-labs/kanon/commit/b9daf5bc8137852e486c27f66273b2fad793df75))
* **cli:** make kanon init scriptable, with a flag per question and JSON output ([#371](https://github.com/yedeya-labs/kanon/issues/371)) ([1fcf39f](https://github.com/yedeya-labs/kanon/commit/1fcf39f730b7968fdaf522c8a21986bfac603f70))
* close the L5 gaps: Releaser bypass in kanon apps and doctor, dco exempts the Releaser, implementer status binds to the pushed head ([#379](https://github.com/yedeya-labs/kanon/issues/379)) ([53c97da](https://github.com/yedeya-labs/kanon/commit/53c97da14b1ad2dcf3bc93e7a96f29e8e3e183b9))
* **skills:** ship the agent-client skills adopt, doctor and upgrade as the kanon Claude Code plugin ([#374](https://github.com/yedeya-labs/kanon/issues/374)) ([3eea068](https://github.com/yedeya-labs/kanon/commit/3eea068c2ee1a69bedac1ed575ba4475b15695a7))


### Bug Fixes

* **qa:** harden lane role markers, guards and the smoke input, and drop adopter examples ([#378](https://github.com/yedeya-labs/kanon/issues/378)) ([dae9fa5](https://github.com/yedeya-labs/kanon/commit/dae9fa59ba63ea05854af82c751b4d7aa23f8026))


### Documentation

* **adr:** record who adopts Kanon, and build for agent-client developers first ([#364](https://github.com/yedeya-labs/kanon/issues/364)) ([012dcdc](https://github.com/yedeya-labs/kanon/commit/012dcdc4c1d99c459dd0860a42bc8612877a1919))


### CI

* **deps:** Bump the github-actions group across 2 directories with 2 updates ([#354](https://github.com/yedeya-labs/kanon/issues/354)) ([53c80e9](https://github.com/yedeya-labs/kanon/commit/53c80e911233e66851ea3b0c479df153f5b3975c))
* hold Kanon's own pins below v0.28.0 until L5, and run the telemetry collector hourly ([#369](https://github.com/yedeya-labs/kanon/issues/369)) ([dd21ebc](https://github.com/yedeya-labs/kanon/commit/dd21ebc778b0f37cc7ed3e5c2558ea4e0607b10c))

## [0.28.0](https://github.com/yedeya-labs/kanon/compare/v0.27.0...v0.28.0) (2026-10-06)


### ⚠ BREAKING CHANGES

* **lanes:** run the lanes as two Apps, Author and Judge, with fixed secrets and the register's shared-slug rows ([#358](https://github.com/yedeya-labs/kanon/issues/358))
* **lanes:** require the role marker and the implementer status, and refuse revise and rebase outside the status chain ([#333](https://github.com/yedeya-labs/kanon/issues/333))

### Features

* **cli:** kanon init, and the requirements file each release ships ([#328](https://github.com/yedeya-labs/kanon/issues/328)) ([fc86c2d](https://github.com/yedeya-labs/kanon/commit/fc86c2d10d0f9bfd11a0d1a5994c27ea90cef0a0))
* **declarations:** screen the digest for the declared environment name, and resolve `@/` by suffix ([#350](https://github.com/yedeya-labs/kanon/issues/350)) ([6843b8a](https://github.com/yedeya-labs/kanon/commit/6843b8a910e4bde010dc33a53c3ef77fe8f2cc03))
* **lanes:** move the remaining Opus lanes to Opus 5.5 and take gate-candidate off decided issues ([#334](https://github.com/yedeya-labs/kanon/issues/334)) ([21e7506](https://github.com/yedeya-labs/kanon/commit/21e7506344b8accfbdfb514db207a755d5d9f2d7))
* **lanes:** require the role marker and the implementer status, and refuse revise and rebase outside the status chain ([#333](https://github.com/yedeya-labs/kanon/issues/333)) ([4ea8de2](https://github.com/yedeya-labs/kanon/commit/4ea8de22138d0268c085bb39bd1ff1994543be0a))
* **lanes:** run the lanes as two Apps, Author and Judge, with fixed secrets and the register's shared-slug rows ([#358](https://github.com/yedeya-labs/kanon/issues/358)) ([bad955a](https://github.com/yedeya-labs/kanon/commit/bad955adb81292bcd853bf42b4c616f62036e69e))
* **merge:** let a human-gated production promotion widen the green zone to high-risk paths ([#340](https://github.com/yedeya-labs/kanon/issues/340)) ([31141a6](https://github.com/yedeya-labs/kanon/commit/31141a667847d2979a2748f3d9906baca8135373))
* **telemetry:** implement plan 0002 decisions 17 to 19 in the importer, the schema, the function and the register ([#362](https://github.com/yedeya-labs/kanon/issues/362)) ([87be69c](https://github.com/yedeya-labs/kanon/commit/87be69cebc064296f73211cd0f41d734cce3c808))


### Bug Fixes

* **agent-classify:** drop the `code` output nothing reads ([#339](https://github.com/yedeya-labs/kanon/issues/339)) ([00f11dc](https://github.com/yedeya-labs/kanon/commit/00f11dcdbef822c9420c588c6cf305cb69672887))
* **citation:** advisory checks for a typo counted as a dependency and a code-comment coordinate the diff wrote ([#343](https://github.com/yedeya-labs/kanon/issues/343)) ([e4edc3f](https://github.com/yedeya-labs/kanon/commit/e4edc3f367b053a67899ae4763adf0afc555ff22))
* close five guard reviewer follow-ups ([#349](https://github.com/yedeya-labs/kanon/issues/349)) ([4a58180](https://github.com/yedeya-labs/kanon/commit/4a581806f9fc83e518ab9a4661443b7957ae846a))
* credit only a named re-land, judge the release PR's confirmed head, and correct three stale claims ([#355](https://github.com/yedeya-labs/kanon/issues/355)) ([58bb949](https://github.com/yedeya-labs/kanon/commit/58bb94949b67986f4a382c4307a7f463f0955175))
* **telemetry:** close five telemetry reviewer follow-ups before the collector goes live ([#346](https://github.com/yedeya-labs/kanon/issues/346)) ([3941342](https://github.com/yedeya-labs/kanon/commit/39413422e74d0533b9562305bb870aaf43fd8508))
* **telemetry:** close the plan 0002 import, ingest and transcript-count gaps before the collector goes live ([#359](https://github.com/yedeya-labs/kanon/issues/359)) ([9b9cf5b](https://github.com/yedeya-labs/kanon/commit/9b9cf5b39bf9cb0bd934f27379e4f4e915a0cc90))


### Tests

* keep every test's writes out of Kanon's own tree ([#341](https://github.com/yedeya-labs/kanon/issues/341)) ([d9c7256](https://github.com/yedeya-labs/kanon/commit/d9c72565612afbe1e1da5c37732e8fa22026a6fe))


### CI

* **deps:** Bump the kanon group across 1 directory with 6 updates ([#353](https://github.com/yedeya-labs/kanon/issues/353)) ([8f3c2cd](https://github.com/yedeya-labs/kanon/commit/8f3c2cd02167626dd22e8664e4bebb76ec5ab797))
* **deps:** check Kanon's own pins daily ([#332](https://github.com/yedeya-labs/kanon/issues/332)) ([b1caa6d](https://github.com/yedeya-labs/kanon/commit/b1caa6d98d7fb031cd545c98d24b244b71280b81))

## [0.27.0](https://github.com/yedeya-labs/kanon/compare/v0.26.0...v0.27.0) (2026-10-05)


### ⚠ BREAKING CHANGES

* **lanes:** run no tree code beside a write token, except where the Owner accepted it ([#317](https://github.com/yedeya-labs/kanon/issues/317))

### Features

* **declarations:** read an omitted declaration as its documented default ([#323](https://github.com/yedeya-labs/kanon/issues/323)) ([69f9a24](https://github.com/yedeya-labs/kanon/commit/69f9a24b035e27fb515b02868a71d5754f17819b))
* **lanes:** create a missing taxonomy label on first use, from rulebook/labels.json ([#309](https://github.com/yedeya-labs/kanon/issues/309)) ([9cccda0](https://github.com/yedeya-labs/kanon/commit/9cccda0f61cfe5c3419e0bde33323761a0781f5e))
* **lanes:** write persona headers, role markers and the implementer status, and read the marker beside the login ([#310](https://github.com/yedeya-labs/kanon/issues/310)) ([41c88da](https://github.com/yedeya-labs/kanon/commit/41c88da57aa290739566526c0264670b5e39cc60))


### Bug Fixes

* **lanes:** give each smoke run its own concurrency group in every lane ([#319](https://github.com/yedeya-labs/kanon/issues/319)) ([0c49bb8](https://github.com/yedeya-labs/kanon/commit/0c49bb81febb83f86bfcfdd83328f6bb5f1844bc))
* **lanes:** run no tree code beside a write token, except where the Owner accepted it ([#317](https://github.com/yedeya-labs/kanon/issues/317)) ([295963a](https://github.com/yedeya-labs/kanon/commit/295963a5d07ee1f8a275e2059536204a08604094))

## [0.26.0](https://github.com/yedeya-labs/kanon/compare/v0.25.0...v0.26.0) (2026-10-05)


### ⚠ BREAKING CHANGES

* **telemetry:** trust the default branch's ref for the telemetry store and drop its environment ([#293](https://github.com/yedeya-labs/kanon/issues/293))
* **qa-store:** trust the default branch's ref for the QA store, drop its environment, and guard id-token ([#291](https://github.com/yedeya-labs/kanon/issues/291))

### Features

* **lanes:** audit Kanon's own code with the code-audit lane, from its last release ([#306](https://github.com/yedeya-labs/kanon/issues/306)) ([d981b2f](https://github.com/yedeya-labs/kanon/commit/d981b2f13485f8ac5eec71ddae1f84eb4d19350c))
* **qa-store:** trust the default branch's ref for the QA store, drop its environment, and guard id-token ([#291](https://github.com/yedeya-labs/kanon/issues/291)) ([d70de29](https://github.com/yedeya-labs/kanon/commit/d70de296618379cac87b8ede1c6748d199f2388e))
* **telemetry:** move the telemetry collector into Kanon and install it on Kanon ([#311](https://github.com/yedeya-labs/kanon/issues/311)) ([55aab15](https://github.com/yedeya-labs/kanon/commit/55aab15da4a3ebf6acebecf4d7cc78a67849986e))
* **telemetry:** trust the default branch's ref for the telemetry store and drop its environment ([#293](https://github.com/yedeya-labs/kanon/issues/293)) ([77f8a73](https://github.com/yedeya-labs/kanon/commit/77f8a73d19406f5751b3727e164d088e99329223))


### Bug Fixes

* **cli:** `kanon apps` takes --owner for a personal account or an organisation, refuses outside the checkout, and names its token ([#299](https://github.com/yedeya-labs/kanon/issues/299)) ([b38b8b7](https://github.com/yedeya-labs/kanon/commit/b38b8b742e47d1ce9a7356e0b393051e8aaecdf9))
* **lanes:** keep the App private key out of every lane's agent job ([#302](https://github.com/yedeya-labs/kanon/issues/302)) ([c30a83b](https://github.com/yedeya-labs/kanon/commit/c30a83b2b1ebedbd5258618fc62995b696f9a8b5))
* **spec-lib:** read the reference corpus from git, and never crash on a file it can't read ([#305](https://github.com/yedeya-labs/kanon/issues/305)) ([532e211](https://github.com/yedeya-labs/kanon/commit/532e2117cbf690884a0053d9273579259e9e47ba))


### Documentation

* **decisions:** record personal accounts and the two-App model in ADR 0013 ([#301](https://github.com/yedeya-labs/kanon/issues/301)) ([4ba0a17](https://github.com/yedeya-labs/kanon/commit/4ba0a171d0cc4afed4f62005ae3bce5af9a71ad1))


### CI

* **deps:** Bump the kanon group across 1 directory with 4 updates ([#253](https://github.com/yedeya-labs/kanon/issues/253)) ([93af751](https://github.com/yedeya-labs/kanon/commit/93af751ca33e8f9509a4f13a6edcf8821fd3a8fb))

## [0.25.0](https://github.com/yedeya-labs/kanon/compare/v0.24.0...v0.25.0) (2026-10-05)


### ⚠ BREAKING CHANGES

* **lanes:** move the Overseer into Kanon as an optional lane that files only what the adopter can act on ([#271](https://github.com/yedeya-labs/kanon/issues/271))
* **lanes:** move the code audit into Kanon, and read the code trees from the stack document ([#257](https://github.com/yedeya-labs/kanon/issues/257))
* **lanes:** load no project settings in the Reviewer, so its flags are the whole grant ([#282](https://github.com/yedeya-labs/kanon/issues/282))
* **lanes:** restrict the Reviewer's shell to an allow-list that runs no PR code ([#276](https://github.com/yedeya-labs/kanon/issues/276))
* escalate an invariant promotion at merge, fix two brief-guard checks, and drop the old digest webhook name ([#270](https://github.com/yedeya-labs/kanon/issues/270))
* **lanes:** run no PR code in the review job, stamp only this run's verdict, and skip zero-item reconciles ([#235](https://github.com/yedeya-labs/kanon/issues/235))
* **lanes:** read tooling tests' directories from the declared pipeline code, drop the environment's name, and guard against adopter literals ([#237](https://github.com/yedeya-labs/kanon/issues/237))
* **lanes:** sign agent commits off as the recorded delegate, and exempt Kanon from Dependabot's default cooldown ([#245](https://github.com/yedeya-labs/kanon/issues/245))

### Features

* escalate an invariant promotion at merge, fix two brief-guard checks, and drop the old digest webhook name ([#270](https://github.com/yedeya-labs/kanon/issues/270)) ([2a9adc7](https://github.com/yedeya-labs/kanon/commit/2a9adc7055a5d876985cb8fcda3f457b45a693e5))
* **lanes:** move the code audit into Kanon, and read the code trees from the stack document ([#257](https://github.com/yedeya-labs/kanon/issues/257)) ([be2cc00](https://github.com/yedeya-labs/kanon/commit/be2cc001e86a17f1430cc419a114c808d9a7d391))
* **lanes:** move the dispatch sweep into Kanon, reading its cost rows from the store or run artifacts ([#247](https://github.com/yedeya-labs/kanon/issues/247)) ([7a8be8d](https://github.com/yedeya-labs/kanon/commit/7a8be8d9fbde42b46a3e6c96d4816032af9b3e31))
* **lanes:** move the Explorer's sweep into Kanon, on the store contract and the adopter's sweep hook ([#259](https://github.com/yedeya-labs/kanon/issues/259)) ([449182a](https://github.com/yedeya-labs/kanon/commit/449182aacbd071923544253013dfca4d9c1fab16))
* **lanes:** move the Overseer into Kanon as an optional lane that files only what the adopter can act on ([#271](https://github.com/yedeya-labs/kanon/issues/271)) ([d0915f4](https://github.com/yedeya-labs/kanon/commit/d0915f4f2ae54327e5c5b8abe3156ff9e2279453))
* **lanes:** restrict the Reviewer's shell to an allow-list that runs no PR code ([#276](https://github.com/yedeya-labs/kanon/issues/276)) ([4d29e9c](https://github.com/yedeya-labs/kanon/commit/4d29e9c733f5b320d535544bd6a2718740e41505))
* **lanes:** run no PR code in the review job, stamp only this run's verdict, and skip zero-item reconciles ([#235](https://github.com/yedeya-labs/kanon/issues/235)) ([72a740c](https://github.com/yedeya-labs/kanon/commit/72a740c52f0f0b21326e5688642b15678a24e4af))
* **lanes:** run the Implementer on Kanon's own repository, inert until its App exists ([#231](https://github.com/yedeya-labs/kanon/issues/231)) ([be1077e](https://github.com/yedeya-labs/kanon/commit/be1077e1e4fbcbbf0b1c9be5216698318ab80870))


### Bug Fixes

* **citation-guards:** clear the citation and doc-guard backlog ([#227](https://github.com/yedeya-labs/kanon/issues/227)) ([d742bdf](https://github.com/yedeya-labs/kanon/commit/d742bdf549a5b8458f0f86aa781f4c1c6435e4ce))
* free the implement slot without the App token, say what a merge queue's push does at the gate, and don't credit reverted deploys ([#262](https://github.com/yedeya-labs/kanon/issues/262)) ([f3a2217](https://github.com/yedeya-labs/kanon/commit/f3a22177036a0646e0d9e82319418a480387d69a))
* judge the release PR at its branch head, and stop two closing-refs misdiagnoses ([#244](https://github.com/yedeya-labs/kanon/issues/244)) ([26ee2aa](https://github.com/yedeya-labs/kanon/commit/26ee2aaf4da543b79c749a203ee52ecb9853606a))
* **lanes:** keep the App private key out of the spine's agent job ([#281](https://github.com/yedeya-labs/kanon/issues/281)) ([864bfff](https://github.com/yedeya-labs/kanon/commit/864bfff556b629e8a7bcfb33749982758ed331b8))
* **lanes:** load no project settings in the Reviewer, so its flags are the whole grant ([#282](https://github.com/yedeya-labs/kanon/issues/282)) ([b7dfae1](https://github.com/yedeya-labs/kanon/commit/b7dfae1179b478e4a80c7dcce5da827acc49df1b))
* **lanes:** re-dispatch an issue outside a project whose latest implement run left nothing ([#265](https://github.com/yedeya-labs/kanon/issues/265)) ([4a89bd5](https://github.com/yedeya-labs/kanon/commit/4a89bd504ea3df70c40e6639bb0fe3a64813943e))
* **lanes:** read tooling tests' directories from the declared pipeline code, drop the environment's name, and guard against adopter literals ([#237](https://github.com/yedeya-labs/kanon/issues/237)) ([a7986ea](https://github.com/yedeya-labs/kanon/commit/a7986ead1777a00fc53a378d874642e957b2a1df))
* **lanes:** red an implement run that ends green with no branch, PR or comment ([#252](https://github.com/yedeya-labs/kanon/issues/252)) ([a218007](https://github.com/yedeya-labs/kanon/commit/a21800780c2929400c150b416cf7f6dd78af95d0))
* **lanes:** sign agent commits off as the recorded delegate, and exempt Kanon from Dependabot's default cooldown ([#245](https://github.com/yedeya-labs/kanon/issues/245)) ([e49a59f](https://github.com/yedeya-labs/kanon/commit/e49a59fcb588028cf69f30b507345018b3ac2c01))
* **lead:** credit a deploy whose reverted work was re-landed by a new pull request ([#278](https://github.com/yedeya-labs/kanon/issues/278)) ([aa2599e](https://github.com/yedeya-labs/kanon/commit/aa2599e36949eb0e091456edb4dc8c271997a45b))
* **lead:** settle the dispatch-sweep and project-digest backlog ([#242](https://github.com/yedeya-labs/kanon/issues/242)) ([9f0e5f9](https://github.com/yedeya-labs/kanon/commit/9f0e5f9ed2d7520d06114409b324c4e2e47115cc))
* **merge:** read the Merger's register from the default branch, evaluate lane-gate conditions, and record K-MERGE-4's link exception ([#236](https://github.com/yedeya-labs/kanon/issues/236)) ([b352722](https://github.com/yedeya-labs/kanon/commit/b352722739529f6f252d4ec91ecef128422f5d52))
* **qa-store:** make a partial re-run of a store-coupled lane safe, and hold store jobs to the block ([#228](https://github.com/yedeya-labs/kanon/issues/228)) ([0de8a2c](https://github.com/yedeya-labs/kanon/commit/0de8a2c8faf60d289ded4ea263f966f51224de64))


### Documentation

* **plans:** plan the lean installation ([#292](https://github.com/yedeya-labs/kanon/issues/292)) ([ba6cc65](https://github.com/yedeya-labs/kanon/commit/ba6cc65b8c4dc0e19f14bc3af66c8b3c152eee9f))
* **qa:** register the Implementer and Explorer Apps the Owner created ([#289](https://github.com/yedeya-labs/kanon/issues/289)) ([fdfbbd9](https://github.com/yedeya-labs/kanon/commit/fdfbbd9a4910d5045e280243b3a00a0bf31bc2c8))


### Tests

* **lanes:** fail a lane job that GitHub's transitive implicit success() never starts ([#267](https://github.com/yedeya-labs/kanon/issues/267)) ([e38e537](https://github.com/yedeya-labs/kanon/commit/e38e5372e3e7fc7f07a9eb8ac247ed3b06e3772e))
* widen five guards and resolve every script's CLI entry check through realpath ([#256](https://github.com/yedeya-labs/kanon/issues/256)) ([d3c186b](https://github.com/yedeya-labs/kanon/commit/d3c186b9e5793dc8aae11c9e69473bde5d7889a1))


### CI

* fail PR text that names the reference adopter, and a rule Why that cites the project's issues or files ([#258](https://github.com/yedeya-labs/kanon/issues/258)) ([e396bad](https://github.com/yedeya-labs/kanon/commit/e396bad19a1ce3b34ea2d996d6af6234c211fbab))

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
