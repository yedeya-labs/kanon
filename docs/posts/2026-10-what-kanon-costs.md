# What it costs to let Claude review and implement on GitHub

*Draft for the Owner's review ([#582](https://github.com/yedeya-labs/kanon/issues/582)). Figures from Kanon's own repository, 2026-10-07 to 2026-10-21.*

**About $1 a reviewed pull request, and $2.50 an implemented issue, at API list price.** That is what two weeks of Kanon running on itself cost: 360 pull requests reviewed and 155 issues implemented by Claude Code agents, measured run by run. This post shows the numbers, how they were measured, and what they don't tell you.

## Why Kanon exists

Kanon is a set of GitHub workflows and two GitHub Apps that let Claude Code agents review pull requests, merge the low-risk ones and implement issues, under rules that fail the build when they're broken.

Writing rules down for an agent isn't enough. A July 2026 study, [RepoComplianceBench](https://arxiv.org/abs/2607.26819), gave four frontier coding agents 106 real issues from 49 repositories that publish rules for AI contributions. The agents opened the repository's rules file on their own in 3.5% of runs. Rules that ask an agent to *refuse* or *hand off to a person* were followed in 0% of runs, for all four agents. Quoting the rule to the agent verbatim barely moved that, and one round of feedback naming the violation lifted it to at most 23%.

So Kanon doesn't ask. Its rules are CI checks, tests and GitHub settings. The agent that writes code and the agent that approves it are two separate GitHub Apps, so one can't approve its own work. A pull request can't change the rules it is judged by, and the Reviewer never runs the pull request's code.

## The numbers

Every model run in Kanon's lanes records its cost and tokens. These are all 977 runs from 2026-10-07 to 2026-10-21, read from Kanon's telemetry store. A figure is the median, with the 90th percentile in brackets.

| Item | Sample | API list price | Subscription tokens |
|---|---|---|---|
| A reviewed pull request (every review run on it) | 360 PRs | **$1.13** ($2.74) | 1.7M (4.9M) |
| An implemented issue (implement, review, revise and rebase runs to merge) | 155 issues | **$2.49** ($6.47) | 3.6M (10.7M) |
| One review run | 657 runs | $0.73 ($1.46) | 1.0M (2.7M) |
| One implement run | 167 runs | $1.26 ($3.64) | 1.9M (6.6M) |

Every lane, with its sample, is in [What a model run costs](../lanes.md#what-a-model-run-costs).

**Two ways to pay.** Kanon runs on an Anthropic API key or a Claude subscription token.

- **With an API key** you pay the list price above, unless your account has its own rates.
- **With a subscription** a run costs no money but spends your plan's usage limits. Anthropic doesn't publish those limits as a number, so we show tokens and can't say how many runs a week a plan allows.

**The whole bill.** Kanon ran about thirty pull requests a day in this window, nearly all written by its own agents. Its 977 model runs came to $1,023 at list price, about $73 a day: $39 of it reviewing, $23 implementing. GitHub Actions minutes are separate and free on a public repository; [`actions-minutes.md`](../actions-minutes.md) has them per lane.

## What that means for your repository

Most teams start with review only. At Kanon's median, and in brackets if every item cost as much as the 90th percentile:

| Your pace | Review only | 30 of those PRs written by the Implementer |
|---|---|---|
| 50 PRs a month | about $57 ($137) | about $97 ($249) |
| 200 PRs a month | about $226 ($548) | about $267 ($660) |

An implemented issue's figure already includes the reviews of its pull request, so the second column is 30 implemented issues plus review of the rest.

For scale: Anthropic estimates its managed [Code Review](https://techcrunch.com/2026/03/09/anthropic-launches-code-review-tool-to-check-flood-of-ai-generated-code/) at $15 to $25 a review on average. It's a different product, a deeper multi-agent review that Anthropic hosts, so this isn't a like-for-like comparison. But a Reviewer that runs on your own key at about a dollar a pull request is cheap enough to put on every one.

## What these numbers don't tell you

- **It's one repository.** Kanon's pull requests are small and mostly agent-written, and its test suite is fast. Larger diffs cost more to review.
- **The API-key column is list price, not a bill.** Every run in the window ran on a subscription; we priced its tokens at list price.
- **Cost isn't quality.** This post measures what a review costs, not how often the Reviewer is right. We don't publish a quality figure yet.
- **Not every rule is enforced yet.** Kanon has 226 rules. 116 are enforced by a check, 55 in part, and 55 are still prose only. The [README](../../README.md#what-is-enforced-honestly) keeps that count current, and a test fails when it drifts.
- **Small samples are left out.** A lane with fewer than ten runs gets a median and no 90th percentile.

## Try it

Start with the Reviewer alone: it reviews every pull request labelled `review:please` and does nothing else. In Claude Code, from your repository, follow the [quickstart](../../README.md#quickstart) and type `/kanon:adopt`.
