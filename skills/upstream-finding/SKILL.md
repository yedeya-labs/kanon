---
name: upstream-finding
description: How a Kanon lane writes an upstream finding's evidence for Kanon's maintainers. The Overseer and the telemetry Explorer read this file from Kanon's tree, by its path, before they write a finding's `evidence` or `suggested_fix`. It is a lane's instructions, not a command a person runs.
disable-model-invocation: true
user-invocable: false
---

# Writing an upstream finding's evidence

You are a Kanon lane's agent, and you found something only Kanon can act on: an upstream finding. When this repository sends its findings to Kanon with evidence, two fields of each carry text: `evidence` and `suggested_fix`. This file says how to write them. It is one file for every lane that writes to Kanon, so the lanes write the same way.

**Who reads them:** Kanon's maintainers, and a third-party decision provider that helps decide which findings Kanon files publicly. Not this repository's people. So write in Kanon's terms, for someone who knows Kanon and has never seen this repository: extract what Kanon needs, never copy this repository's words.

**Only these two fields.** Your lane's prompt keeps its own rules for a finding's title and body, which stay in this repository's draft. Nothing here changes them.

**Sizes.** `evidence` holds at most 2,000 characters and `suggested_fix` at most 1,000. Longer text is cut at the last whole line before the limit, so put what matters first.

## The template

Write `evidence` as the first four parts, in this order, each starting on a line of its own with its name in bold (`**Expected:**`). Write the fifth into `suggested_fix`.

### Expected

The Kanon rule or behaviour that should have held, by its id: a rule (`K-…`), a lane, a guard. One or two sentences.

### Observed

What happened instead, in Kanon's terms: the lane, the stage that failed, the error and reason codes, the outcome. Describe what you saw, not what you think caused it.

### Where

The Kanon file and line, at the finding's `kanon_version`: a path from the root of Kanon's tree (`scripts/overseer-file.mjs`, `.github/workflows/agent-overseer.yml`), never the runner's path to it, and never a file of this repository.

### Reproduce

The steps, in Kanon's terms: the lane, its trigger and inputs, the value the repository declares that matters (`Upstream findings: drafted`), and what to look at to see it.

### Suggested fix

Written into `suggested_fix`, never `evidence`. It is unverified (`K-SELF-10`): lead with the constraint the change must satisfy, then the change you would try, and what must be checked first. Leave it empty when you have no change to suggest.

## The hard rules

Each holds for both fields, every time.

- **No people, logins or personal names.** Not an author, reviewer, assignee or commenter, not an App's or a bot's login, not a name in a commit.
- **No repository names.** Not this repository's, its owner's, or any other's.
- **No URLs.** No link of any kind, nor a host name.
- **No paths outside Kanon's tree.** Only Kanon's own files, as they are at the finding's release. A path of this repository, the runner's file system or a home directory is left out.
- **No quotes of the adopter's text,** whether code, an issue, a pull request, a comment or a commit message. Say what it did, in Kanon's terms.
- **Roles instead.** Where you need to name someone or something of this repository, name its role: "the PR", "the reviewer", "an adopter workflow", "the adopter's hook".

## The self-check

Before you write the report, re-read each extract against the hard rules, one rule at a time. When you can't write a finding's evidence without breaking one, leave `evidence` and `suggested_fix` empty: the finding is sent as codes only. Then say why in the finding's body, which stays in this repository's draft: name the rule the evidence would have broken, never the text that broke it.

## Not trusted alone

This file is an instruction, and a steered agent can ignore it. What leaves the repository is still bounded by the scrub, the schema and Kanon's intake, which you can't change. Follow it anyway: the scrub removes only what it recognises, and a name it never saw gets through unless you kept it out.
