---
name: inbox
description: Answer "what's waiting on me?" by running `kanon inbox --json` and listing, with links, the pull requests ready for the person's merge and the decisions asked of them; never answer it from memory. And before you ask the person to decide anything, in chat or anywhere else, record the decision on GitHub first, as a comment in Kanon's fixed form on the issue or pull request it concerns, labelled `decision:needed`; record their answer there and take the label off. Use when the person asks what waits on them, what is ready to merge, or which decisions are open, and every time you, or a subagent you run, are about to ask the person a decision.
---

# The inbox

You keep two things true for the person you work with. What waits on them is read from GitHub when they ask, never from what you remember (`K-WORK-25`). And no decision you need from them exists only in this conversation: it is written on GitHub, in a fixed form, before you ask it (`K-WORK-24`). Your context is compacted, a subagent hands back only part of what it knew, and a session ends; a decision kept only there gets lost, and so does the list of what is ready to merge. The repository doesn't forget.

This skill never notifies anyone. It reads when asked, and writes only the comments and labels of a decision you are asking or recording.

## How to run `kanon`

Run it from the repository's checkout, through the release this skill ships in:

<!-- x-release-please-start-version -->

```sh
npx --yes --package github:yedeya-labs/kanon#v0.42.0 kanon inbox --json
```

<!-- x-release-please-end -->

Read only standard output, one JSON document. Standard error says which token `gh` used and whose it is; never decide anything from it. Pass `--repo <owner>/<repo>` when the checkout's origin remote isn't the repository the person means.

**The contract is `kanon-status/v1`.** The inbox is its `inbox` section, documented in `docs/status.md` in Kanon's repository at the release in the `npx` line (`https://github.com/yedeya-labs/kanon/blob/<release>/docs/status.md`, "The inbox"). If `.schema` is anything else, say this skill and the command disagree, and stop. Ignore a field you don't know.

## Ground rules

- **Never merge.** Never approve a pull request or post a review from the person's token: it would read as their verdict. The inbox lists what is ready for the person to merge; merging it is theirs.
- **Never print a secret.** Never print a token or an environment variable that holds one. The document names whose token `gh` used, never the token.
- **Only a person can** answer a decision that is theirs. Never answer one yourself, never mark one answered that they haven't answered, and never take `decision:needed` off a thread whose answer you haven't recorded on it.
- **The person signs off.** This skill commits nothing. If you commit for another reason, it is with `git commit -s` under the person's own identity.
- **Never answer "what's waiting on me?" from memory,** nor from a list you or a subagent kept. Run the command, every time, and answer from its document.
- **Never ask a decision only in chat.** If it isn't on GitHub yet, record it first (below), then ask, with the link.

## What's waiting on me?

1. **Run it.** `kanon inbox --json`, as above. Read `.exitCode` and `.status`:

   | Code | Status | What you do |
   |---|---|---|
   | 0 | `ok` | Go on to step 2. |
   | 2 | `error` | This skill passed something the command refused: show `.error` and stop. It is a bug in the skill. |
   | 3 | `error` | It couldn't run: show `.error` in plain words. Usually the checkout has no origin remote on GitHub (pass `--repo`), `gh` isn't signed in, or the repository has no App register on its default branch, which the readiness view needs to judge a pull request. |
   | 4 | `incomplete` | A read didn't complete, so there is no answer: `.inbox.error` names it, and `.inbox.reads[].why` and `.inbox.reads[].resetAt` say why and when a rate limit resets. Say so, and never give a partial list. |

2. **List what is ready for their merge,** each of `.inbox.merges` as its title and link, `.inbox.merges[].title` and `.inbox.merges[].url`, with `.inbox.merges[].reason` when they ask why. Say it is ready by the readiness view's definition, which this release's `docs/status.md` states in "The pull-request readiness view": nothing more is implied. A pull request with a decision asked on it and not answered is never in this list, only in the next.

3. **List the decisions waiting on them,** each of `.inbox.asks`: its thread, `.inbox.asks[].title` and `.inbox.asks[].url`, and the link of the decision itself, `.inbox.asks[].ask`. Then say what needs fixing:
   - `.inbox.asks[].form` is `missing`: the thread carries the label and nobody wrote the decision down. If it is yours, or this session's, write the ask now (below); otherwise say so.
   - `incomplete`: the ask lacks a part of the form. Offer to post a whole one.
   - `.inbox.asks[].answered` is true: the answer is recorded and the label was left on. Offer to take it off. A pull request in this state is no longer held out of the merges.

4. **Nothing waiting** is an answer too: say both lists are empty.

## Asking a decision

Before you ask the person to decide anything:

1. **Choose its thread:** the issue or pull request the decision concerns. When the decision has no issue or pull request of its own, use its project's tracking issue. Never open a new issue just to ask.
2. **Write the ask** to a file, in this form, and nothing before its first line:

   ```text
   <!-- kanon:decision-needed -->

   **Question.** What is to be decided, in one or two sentences a person can answer without this conversation.

   **Options.**
   1. The first option, and what it changes.
   2. The second option, and what it changes.

   **Recommendation.** Which option you recommend, and why.
   ```

3. **Post it and label the thread** in the same turn. For an issue: `gh issue comment <number> -R <owner>/<repo> --body-file <file>`, then `gh issue edit <number> -R <owner>/<repo> --add-label decision:needed`. For a pull request: `gh pr comment <number> -R <owner>/<repo> --body-file <file>`, then `gh pr edit <number> -R <owner>/<repo> --add-label decision:needed`. Show the person the draft first only when they asked to see drafts.
4. **Then ask in chat,** briefly, with the comment's link.

A subagent you run follows the same steps: it records the decision on GitHub before it hands back, and its hand-back names the link. When a hand-back carries a decision without a link, record it yourself before you ask it.

## Recording the answer

When the person answers, in chat or on GitHub:

1. Post the answer on the same thread, from a file, in this form:

   ```text
   <!-- kanon:decision-answered -->

   **Decision.** What was decided.

   **Decided by.** Who decided it, and where: in this conversation, or the link of their comment.
   ```

2. Take the label off: `gh issue edit <number> -R <owner>/<repo> --remove-label decision:needed`, or `gh pr edit` for a pull request.
3. Then act on it. A decision that changes an issue's scope belongs in that issue's body too.

If they answered on GitHub themselves, their comment is the answer: post the answer form only to say where it is, and take the label off.
