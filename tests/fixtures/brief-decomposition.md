## 3. Decomposition

Four issues, in the shape of the first real brief the reconciler filed: a numbered section
heading, metadata lines that wrap, labels after a middle dot, and acceptance criteria that cite
spec clauses. Where a criterion is behavioural it is a `[PAY-n]` citation, because those
invariants live in `docs/qa/specs/payments.md` and **are** the acceptance criteria. Where a
criterion is a deliverable, it is written plainly.

**Every proposed invariant is `[seed]` and stays `[seed]` through implementation.**
Approving this brief is agreeing to the plan; confirming the behaviour is a separate act by
a person, later. No agent on this project promotes anything.

---

### Issue A — Complete `docs/qa/specs/payments.md` and its transition table

**Milestone:** Development Automation · **Labels:** `pipeline-improvement`

The spec for this area is the file this brief creates. It holds the project's new `[seed]`
criteria and a deliberately incomplete transition table. This issue completes it, and that
table is what issues B and C are both built on: B needs each writer's legal from-states, and
C needs the list of writers to check against.

Acceptance criteria (all deliverables: this issue writes prose and tooling registration, not
behaviour):

1. The transition table in `payments.md` names **every** writer of the order status with its
   decided legal from-states and a one-line justification per row.
2. Each row cites the function that performs the write, by name.
3. The table states which transitions are terminal, and no row leaves a terminal state.

---

### Issue B — Move the status guard into the one function that writes the status

**Milestone:** Production Ready · **Labels:** `sev:critical` · **Closes #897; supersedes the caller-side guards in PR #869**

**Depends on:** Issue A (needs the decided from-states), and on the PR #869
disposition (decision 1).

Acceptance criteria:

- **[PAY-1]** A write of the order status from a state outside its legal from-states is
  refused by the writer itself, whichever caller asked for it.
- **[PAY-2]** A refused write changes nothing and returns a reason a caller can show.
- **[PAY-3]** A write from a legal state still succeeds exactly as before.

The guard moves from the callers into the writer, so a new caller cannot forget it. The
caller-side guards stay until this lands, and are removed in the same change.

---

### Issue C — Make the class un-repeatable: list the writers and fail lint on a new unguarded one

**Milestone:** Development Automation · **Labels:** `pipeline-improvement`

**Depends on:** Issue A (needs the writer list). Runs in parallel with B.

A lint rule reads the transition table and fails when a function writes the order status
without being a row of it, so the next writer is a red build rather than a review comment.

Acceptance criteria (deliverables):

1. The rule fails on a fixture writer that the table does not list, naming the function.
2. The rule passes on the current tree.
3. The rule's message names the table it reads, so the fix is obvious from the failure.

---

### Issue D — Withhold the actions the new guard refuses

**Milestone:** Production Ready · **Labels:** `follow-up`

**Depends on:** Issue B (the guard must exist before a surface can mirror it).

Acceptance criteria:

- **[PAY-4]** An action the guard would refuse is not offered for an order in that state.
- **[PAY-5]** An action that is offered and then refused, because the state changed in the
  meantime, shows the writer's reason rather than a generic error.

**Scope note:** this is only the surfaces the *new* refusals affect. The other half is PR
#869's and is not re-done here.

---

## 4. Sequencing

A first, then B and C in parallel, then D.
