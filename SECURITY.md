# Security

Kanon runs agents with write access to repositories, so security problems in it matter. Examples include a way for untrusted input to reach a write-capable agent, a workflow that leaks a token, or a check that can be bypassed.

**Please don't report them in a public issue.** Use GitHub's private vulnerability reporting instead (the **Security** tab, then **Report a vulnerability**). You'll get an acknowledgement, and a fix is released as a normal Kanon version, which adopters receive as a Dependabot upgrade.

## Accepted exposures

Kanon keeps a pull request's code away from any credential that can write: a job that runs the code it is testing holds no App token and no other secret ([`K-AGENT-50`](rulebook/03-agents.md)). Two lanes are exceptions, and the Owner accepted them on 2026-10-05. This section says what they expose and what limits it, so you can judge it for your own repository.

### Which lanes, and what runs

- **The revise lane** (`agent-implement-revise.yml`) answers the Reviewer's changes-request on the Implementer's own pull request. It checks out the pull request's branch and runs your project-setup hook (`.github/actions/project-setup`, which installs your toolchain and dependencies) from that branch. Its agent then edits the code and runs your project's gates (lint, type check, tests) on it before it pushes.
- **The rebase lane** (`agent-rebase.yml`) resolves a merge conflict on the Implementer's pull request. It runs your project-setup hook from your default branch, then its agent checks out the pull request's branch, merges your default branch into it, and runs your gates on the result before it pushes.

In both, the pull request's code (its install scripts, its build and its tests) runs on the same runner, in the same job, as two credentials:

- **The Author App's installation token**, which the agent pushes and comments with.
- **The Claude token** (`CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_API_KEY` if you use one), which the agent runs on.

So code in that pull request that turns hostile, through a compromised dependency or a test written from injected text, could read either one while the job runs.

### Why it is accepted

The agent has to test what it pushes, with the token it pushes with. Running the tests in a separate job would take the push away from the agent that tests, and the lane would no longer fix what it found. The code that runs was written by the same App, with the same permissions, in the lane that opened the pull request, so it reaches no identity or permission its author didn't already hold. And the Claude token sits beside the pull request's code in the implement lane that wrote it too, so these two lanes add no new holder of it.

Two risks remain:

- Another agent with write access to code can push to the Implementer's branch: Kanon's Lead, Explorer and Overseer share the Author App, and you may have given another App that access. Code one of them planted would run with the Implementer's token, which can also change workflow files. The status check under "What bounds it" narrows this, because a lane refuses a branch whose latest commit lacks the Implementer's status.
- Anyone who reads the Claude token can run models on your account until you rotate it. It gives no access to your repository.

### What bounds it

- **The token is short-lived and narrow.** A separate job, which runs nothing else, holds the App's private key and mints the token; the key never reaches the job that runs the code ([`K-AGENT-49`](rulebook/03-agents.md)). The token is for your repository alone, carries only contents, issues, pull requests and workflows write ([`K-AGENT-46`](rulebook/03-agents.md)), is revoked as the job's last step, and expires within an hour if revocation fails.
- **Only members start a lane.** Before any token is minted, the lane checks who caused the event (the reviewer, whoever applied the label or ran the dispatch, whoever pushed or merged) and refuses anyone who isn't the repository's owner, a member or collaborator, or one of the Apps you registered ([`K-AGENT-45`](rulebook/03-agents.md)).
- **Only the Implementer's own pull requests.** Each lane acts only on a pull request the Implementer opened whose latest commit carries the `kanon/role: implementer` status that the Author App sets in a fixed step, never an agent. A person's push removes that status, so the lane refuses the pull request from then on, and a person finishes it.
- **Forks get nothing.** A fork's pull request is never the Implementer's, so both lanes refuse it. The revise lane runs on `pull_request` and `pull_request_review` events, which GitHub runs without secrets for a fork's pull request ([`K-AGENT-47`](rulebook/03-agents.md)). The rebase lane's `pull_request_target` trigger reads only that a pull request merged and who merged it, and never checks out or runs that pull request's code ([`K-AGENT-48`](rulebook/03-agents.md)).

Every other lane that runs your project's code either runs it in a job with no write credential, or starts from your default branch's reviewed code. Four lanes run your project-setup hook from it in the job that holds the Author App's token and the Claude token: the implement and triage lanes (`agent-implement.yml`, `agent-triage.yml`), whose agents then test the code they write in that run, and the Lead's split lane (`agent-lead-split.yml`) and the Explorer (`agent-explore.yml`), whose agents write no code. To avoid this exposure entirely, don't install the revise and rebase lanes: a changes-request or a conflict on the Implementer's pull request then waits for a person.
