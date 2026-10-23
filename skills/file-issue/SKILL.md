---
name: file-issue
description: How an agent files a GitHub issue under Kanon's rules, with its labels and milestone in one gh issue create. Use it every time you file an issue in a repository that runs Kanon. You choose the labels, the severity and the subject; Kanon's plan command chooses the milestone and any gate-candidate label, and gives back the exact arguments. A Kanon lane reads this file from Kanon's tree, by its path.
user-invocable: false
---

# Filing an issue

You are about to file an issue. Kanon's planning command decides where it goes: its milestone, and whether it is a candidate for the launch gate. You never decide either yourself, and you never copy the rule that decides them into your own words. The rule lives in one place, `scripts/issue-triage-defaults.mjs`, and this file only says how to ask it (`K-WORK-8`).

## What you decide

These are judgments only the filer can make, so the command reads them and never guesses them:

- **The title and the body.** What your own instructions say to write, in the form every issue takes (`K-WORK-14`): a `## What must be true` heading over the verified constraint and its evidence, which are the acceptance criteria, and any remedy you propose under exactly `## Possible approach — UNVERIFIED, not acceptance criteria`, with a line on what must be checked before building it. No other heading may propose a remedy: not "Suggested fix", "Proposed fix", "Fix", "Remedy", "Solution", nor "Possible approach" in another form. The plan command checks both.
- **The labels.** The ones your own instructions name, such as the kind of issue and who found it. Never add `gate-candidate` yourself: the command adds it where the rule gives it, and refuses an issue that carries it where the rule does not.
- **The severity.** Exactly one `sev:*` label, rated by evidence with the rubric in `docs/qa/explorer-playbook.md` (`K-WORK-9`). A review follow-up must carry one.
- **The subject.** Is the issue about the product, or about the engineering platform and the pipeline: a CI guard, a test harness, a lane, a doc of the pipeline? Name it with `--subject product` or `--subject pipeline`. Route by what the issue is about, never by who found it (`K-WORK-4`). Left out, the subject is read from the labels: an issue labelled `pipeline-improvement` is pipeline work, and any other is product work.
- **A brief's milestone, only when you transcribe one.** When you file the work items of a plan a person approved, and the plan names a milestone, pass it as given with `--explicit-milestone "<title>"` (`K-WORK-5`). Never pass one of your own choosing.

## Steps

1. Write the body to a file. Then ask the command for the plan, with one `--label` for each label and `--body` naming that file:

   ```sh
   node "$KANON/scripts/issue-triage-defaults.mjs" plan --label <name> --label <name> --subject <product|pipeline> --body <file>
   ```

   In a Kanon lane, `$KANON` is Kanon's tree. Anywhere else, the script is `scripts/issue-triage-defaults.mjs` two directories up from this file.

2. **Exit 0:** it prints one JSON object. Its `ghArgs` field is the labels and the milestone, as one shell-quoted string. File the issue in one call, with the same body file and exactly those arguments, nothing added:

   ```sh
   gh issue create --title "<title>" --body-file <file> <ghArgs>
   ```

   Its `args` field holds the same arguments as a list, if you build the call another way. File the body the command checked: change the file after the check, and ask again. Never follow it with a `gh issue edit` that changes the labels or the milestone (`K-WORK-2`).

3. **Exit 1:** it prints `{"refused": "<why>"}` and no arguments. The reason names each rule it breaks: a missing severity or a label the rule does not give, or a body with no "What must be true" section or with a remedy under any heading but the fixed one (`K-WORK-14`). Fix what it names, in the labels or the body file, and ask again. Never file an issue the command refused, and never file one without asking it.

4. **Exit 2:** a flag it does not take, a missing `--body`, or a body file it can't read. The flags are `--label`, `--subject`, `--explicit-milestone` and `--body`, each with a value.

## Why one command

When each filer carried its own copy of the routing, the copies drifted: a routing table and four prompts once disagreed for a day, and only someone reading them noticed. With one command, a change to the rule is one change, made where its tests are, and every filer follows it from then on. The body check is there for the same reason: a remedy written in an issue gets built as written, and of hundreds of agent-filed issues, a few dozen put one under a heading of their own or left out what must be true, though every prompt asked for both.
