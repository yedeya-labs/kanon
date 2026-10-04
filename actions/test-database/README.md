# `test-database`: read whether a project's lanes need a database

Kanon's lanes call this block after the checkout and before the project-setup hook. It reads the project's test-database declaration, `docs/qa/test-database.md` ([`K-LAYOUT-16`](../../rulebook/11-repository-layout.md)), and tells the lane what to pass the hook's `database` input. It starts nothing: a database is the project's, and its hook starts it. You don't call this block yourself. You write the declaration, or leave it out.

## Declare your database

Write `docs/qa/test-database.md`, with one line naming the kind:

```markdown
# Test database

**Test database:** `hook`
```

| Kind | What happens | The hook gets |
|---|---|---|
| no file, or `none` | Nothing starts. `DATABASE_URL` stays unset. | `database: 'false'` |
| `hook` | Your hook starts your database, whatever the engine, and writes `DATABASE_URL` to `$GITHUB_ENV`. | `database: 'true'`: start it, then set up your schema |

The database must be ready when your hook finishes: the agent and its tests find it in `DATABASE_URL`. A lane that edits only prose passes the hook `database: 'false'`, whatever you declare.

**A malformed declaration fails the lane, by name.** That covers a file with no `**Test database:**` line, one with two, and one naming anything else, an engine included. It never silently starts nothing. [`lane-check`](../lane-check/README.md) reads the declaration with the same program, so it fails in your CI first.

**The review lane starts no database.** It runs none of the pull request's code ([#185](https://github.com/yedeya-labs/kanon/issues/185)), so it calls neither this block nor your hook, and takes test results from your CI.

**Add it before, or with, the Kanon upgrade that brings this block.** A lane that checks out a pull request reads the declaration from that branch. So an open PR cut before you added it reads "no file" and gets no database until it is rebased.

## Worked example: Postgres, started by the hook

This is the reference adopter's setup. Its lanes used this Postgres before Kanon stopped choosing one. With `` **Test database:** `hook` `` declared, the hook's first step starts the database and waits for it:

```yaml
- name: Start the project's Postgres
  if: inputs.database == 'true'
  shell: bash
  run: |
    docker rm -f test-database >/dev/null 2>&1 || true
    docker run -d --name test-database \
      -e POSTGRES_USER=kanon -e POSTGRES_PASSWORD=kanon -e POSTGRES_DB=kanon \
      -p 5432:5432 \
      --health-cmd "pg_isready -U kanon" --health-interval 5s --health-timeout 3s --health-retries 10 \
      pgvector/pgvector:pg17 >/dev/null
    for _ in $(seq 60); do
      status="$(docker inspect -f '{{.State.Health.Status}}' test-database 2>/dev/null || echo gone)"
      [ "$status" = healthy ] && break
      [ "$status" = unhealthy ] || [ "$status" = gone ] && break
      sleep 2
    done
    if [ "$status" != healthy ]; then
      echo "::error::the project's Postgres is $status"
      docker logs test-database 2>&1 | tail -40
      exit 1
    fi
    echo "DATABASE_URL=postgres://kanon:kanon@localhost:5432/kanon" >> "$GITHUB_ENV"
```

Its schema setup follows, against `DATABASE_URL`. The whole hook is [`tests/fixtures/test-database/postgres`](../../tests/fixtures/test-database/postgres/.github/actions/project-setup/action.yml). The [test-database smoke](../../.github/workflows/test-database-smoke.yml) runs it on a runner on every pull request, and checks that the database is healthy and reachable at `DATABASE_URL` once the hook returns.

## Why the hook, not a job service

A job service is fixed when the job starts, from the workflow's own text and the caller's inputs. It can't read a file in your repository, and a reusable workflow can't take a service from its caller. A container started in a step of your hook is the same container a service would be (the same image, health check and port on `localhost`), and it is yours to choose.

| Input | Meaning |
|---|---|
| `wanted` | `'true'` (the default) when the lane runs your tests. Anything else reads nothing. |
| `from` | A commit to read the declaration from, instead of the working tree. The verify-acs lane passes the commit it loads your hook from, because the release it checks out may predate the file. A commit it can't read is an error, not "no file". |

| Output | Meaning |
|---|---|
| `database` | `'true'` when the lane wants a database and you declare one. The lane passes it to your hook. |
| `kind` | What you declare: `none` or `hook`. Empty when the lane wants none. |
