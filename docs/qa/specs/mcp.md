# Kanon's hosted MCP server

What Kanon's hosted, remote MCP server answers and refuses, where a project has needed a clause to cite. It is a read-only surface over the status core (the `STAT` area, [`status.md`](status.md)). Seeded by project [#1327](https://github.com/yedeya-labs/kanon/issues/1327)'s brief, whose decisions 1 to 5 choose how it authenticates, where it runs, whom it serves and how fresh it is: the authentication, tenancy and freshness clauses below are written to the answers the Owner gave on 2026-10-23, which were the recommended ones. Every clause is `[seed]` until a human promotes it (`K-SPEC-8`).

**Id prefix:** `MCP`

## Protocol and tools

- `[MCP-1]` `[seed]` The hosted server answers the MCP Streamable HTTP transport's `initialize`, `tools/list`, `tools/call` and `ping` at the protocol version `docs/status.md` names, and answers any other request with JSON-RPC's method-not-found error; a notification (a message with no `id`, such as `notifications/initialized`) is accepted with HTTP 202 and no body, whatever its method, and never answered with a JSON-RPC response or error.
- `[MCP-2]` `[seed]` The hosted server lists exactly the tools `docs/status.md` names, one per status view, each annotated read-only, and each tool returns the same object as that view's section of `kanon-status/v1` for the same reads; a test calls every tool over a recording reader and finds no GitHub write.
- `[MCP-3]` `[seed]` The hosted server has no tool, method or route that writes to GitHub, and no store of its own: its handler holds no write to a table, a bucket or a file.

## Authentication and tenancy

- `[MCP-4]` `[seed]` A request to the hosted server with no credential, or with one it can't verify or that has expired, gets HTTP 401 with a `WWW-Authenticate` header naming the server's protected-resource metadata, and runs no tool.
- `[MCP-5]` `[seed]` The hosted server calls GitHub only with the requesting person's own user-to-server token from Kanon's status App, so an answer holds only what that person can already read, in a repository where that App is installed; it mints no installation token and accepts no personal access token.
- `[MCP-6]` `[seed]` The hosted server keeps no GitHub token at rest: a person's GitHub tokens travel only inside the access and refresh tokens the server issues, encrypted under the server's key, and those tokens expire after the lifetimes `docs/status.md` states.
- `[MCP-7]` `[seed]` The hosted server answers a tool call about a repository where its status App isn't installed, or that the person can't read, with a tool error saying the App isn't installed on that owner, or that the repository isn't one the App can reach with the person's access, and reads none of that repository's content.
- `[MCP-8]` `[seed]` The hosted server logs, per request, only the method or the authorisation route, the tool's name, the outcome, the duration, the number of GitHub requests it made and GitHub's remaining rate limit: never a token, a login, or any text it read from GitHub; a test runs every tool and the authorisation flow over a capturing logger.

## Freshness

- `[MCP-9]` `[seed]` Every answer of the hosted server carries the time its GitHub reads were made, and any cache it keeps is per person, keyed by the person's token and never shared between people, and lives no longer than the time `docs/status.md` states.

## Hosting

- `[MCP-10]` `[seed]` The hosted server's CloudFormation template creates only the resource types its test lists, sets the function's reserved concurrency, and creates no table and no bucket.
- `[MCP-11]` `[seed]` The hosted server's deploy smoke passes only when the deployed server answers an unauthenticated `tools/list` with 401 and serves its protected-resource metadata.
