---
name: snowflake-sql
description: Run SQL against Snowflake and interpret its results using the Snowflake SQL API. Use when the user asks to query, inspect, or modify data in Snowflake, lists tables/warehouses/roles, or asks to view a query result as a table.
---

# Snowflake SQL

This skill documents the `pi-snowflake` package's SQL capability, backed by the
[Snowflake SQL API v2](https://docs.snowflake.com/en/developer-guide/sql-api/index).
The extension lives at `../../extensions/index.ts` (relative to this file), with the SQL
client in `../../extensions/sql-api.ts` and connection handling in
`../../extensions/connections.ts`.

## Capabilities

- `snowflake_sql` tool: run one SQL statement (SELECT, DDL, or DML) and get back
  columns, rows, and row count.
- `/snowflake-sql [statement]` command: run a statement interactively and open a
  scrollable table viewer (terminal UI) over the result.
- `/snowflake-results` command: reopen the scrollable table viewer for the most
  recent query result, without re-running it.
- `/snowflake-connection [--llm|--sql] [name]` command: pick which
  `~/.snowflake/connections.toml` entry is used. `--sql` is the default target;
  `--llm` picks the connection used by the Snowflake Cortex model provider. These
  are independent — the LLM backend and the SQL warehouse connection can point at
  different accounts/roles.

## Always call the tool in the current session

Always invoke the `snowflake_sql` tool as a direct tool call in the current pi
session. Never run it by spawning a separate `pi` process (for example `pi -p
"..."` from `bash`, or a subagent), even to "double check" or test something.

The tool's last result is kept in this session's in-memory state and is what
`/snowflake-results` shows. A query run in a different process/session has its
own, separate state — the user cannot open it with `/snowflake-results` here,
and it silently looks like nothing happened from their point of view. If a
query needs to be run, call the tool directly; do not shell out to Snowflake's
API or to another pi invocation as a workaround.

## Before running a query

1. Confirm a SQL connection is configured. If `snowflake_sql` fails with "No
   Snowflake SQL connection configured", tell the user to run
   `/snowflake-connection` (defaults to `--sql`) to pick one, or pass an explicit
   `connection` argument to the tool call.
2. Only Programmatic Access Token (PAT) connections work with the SQL tool: the
   connection's section in `~/.snowflake/connections.toml` must have
   `token_file_path` set. `externalbrowser` and key-pair (`SNOWFLAKE_JWT`)
   connections are not supported by this tool today — they need interactive
   browser or key-pair auth that the extension does not implement. If asked to
   use one of those, tell the user it is not supported and suggest adding a PAT
   connection instead.
3. Prefer explicit `database`/`schema`/`warehouse`/`role` already set on the
   chosen connection. Only pass overrides in the tool call when the user asks for
   a different one than the connection's default.

## Running queries

Call the `snowflake_sql` tool with a `statement`. Useful optional parameters:
`connection`, `warehouse`, `database`, `schema`, `role`, `timeoutSeconds`.

- The tool returns a text summary (row count, column names) plus a Markdown
  preview of the first few rows (`sql.previewRows` in settings, default 10).
  Large results are truncated at `sql.maxRows` (default 5000); the response says
  so when that happened.
- For exploratory queries on unknown tables, add `LIMIT` yourself rather than
  relying on truncation — truncation only limits what is *fetched/shown*, not
  the warehouse compute used to produce the full result.
- When the user wants to see the full result rather than a text preview, run the
  ask the user to run `/snowflake-sql <statement>` (or `/snowflake-results`
  after a tool call) to view fetched rows in the scrollable terminal table. The
  table is also limited by `sql.maxRows`; it is not necessarily the full result.
- Treat `snowflake_sql` like any other data-mutating capability: confirm with
  the user before running `INSERT`, `UPDATE`, `DELETE`, `DROP`, `TRUNCATE`, or
  other destructive/DDL statements, the same way you would for `bash` commands
  with side effects. This instruction is not an enforced permission gate.
- Query text and all fetched tool-result rows can be persisted in Pi session
  history. The preview is sent to the model. Avoid querying sensitive data unless
  the user has authorized the resulting disclosure and retention.

## How the SQL API behaves (for diagnosing errors)

- Statements are submitted as `POST /api/v2/statements`. Fast statements return
  immediately with results; slower ones return HTTP 202 and a `statementHandle`,
  which the client polls via `GET /api/v2/statements/{handle}` until it
  completes or `sql.maxWaitMs` (default 120s) elapses.
- Large result sets are split into partitions; the client fetches each extra
  partition via `GET /api/v2/statements/{handle}?partition=N` and concatenates
  rows, stopping once `sql.maxRows` is reached.
- Authentication uses `Authorization: Bearer <token>` with
  `X-Snowflake-Authorization-Token-Type: PROGRAMMATIC_ACCESS_TOKEN`, where the
  token is read fresh from the connection's `token_file_path` on every call (no
  caching), so a rotated PAT token file is picked up automatically.
- A timeout error ("Timed out after Nms waiting for statement ... to complete")
  means the statement may still be running on the warehouse; it is not
  necessarily cancelled. Mention this to the user rather than assuming it
  failed outright.
- Common failure causes to recognize from error text: `HTTP 401` with a network
  policy message means the Snowflake account requires a network policy that
  isn't satisfied from this environment — this is an account/security
  configuration issue, not something fixable from the client. `HTTP 404` on the
  statement usually means a bad or expired `statementHandle` or account name
  mismatch (check `account` casing/format in `connections.toml`).

## Settings reference

In `~/.pi/agent/settings.json` or `<project>/.pi/settings.json`:

```json
{
  "snowflake": {
    "llmConnection": "my-cortex-connection",
    "sqlConnection": "my-warehouse-connection",
    "sql": {
      "timeoutSeconds": 60,
      "maxWaitMs": 120000,
      "maxRows": 5000,
      "previewRows": 10
    }
  }
}
```

A legacy single `"connection"` key is still honored as a shared fallback for
both `llmConnection` and `sqlConnection` when the specific key is absent.

Settings are resolved in this order (highest priority first): environment
variables (e.g. `SNOWFLAKE_SQL_CONNECTION`), a `.pi-snowflake-settings.json`
file, `.pi/settings.json` in the current project, then the global
`settings.json`.

The `.pi-snowflake-settings.json` file is discovered by searching the current
directory and then its parent directories, up to and including `$HOME`,
stopping at the first match. Outside `$HOME`, only the current directory is
searched. The custom file is disabled unless the operator sets
`SNOWFLAKE_PROJECT_SETTINGS_FILE` to its absolute path after reviewing it,
and Pi trusts the project. Only that exact nearest file is approved. It does
not itself trigger Pi's trust prompt. It uses the same `{ "snowflake": { ... } }`
shape as `settings.json`:

```json
{
  "snowflake": {
    "sqlConnection": "my-warehouse-connection"
  }
}
```

## Connections file format

`~/.snowflake/connections.toml` (same file the Snowflake CLI/connector reads):

```toml
[my-warehouse-connection]
account = "MY-ACCOUNT-LOCATOR"
user = "MY_USER"
authenticator = "PROGRAMMATIC_ACCESS_TOKEN"
token_file_path = "/home/me/.snowflake/my.token"
role = "MY_ROLE"
warehouse = "MY_WAREHOUSE"
database = "MY_DB"
schema = "MY_SCHEMA"
```

Run `/snowflake-connection` (no name) to see every section defined in that file,
with a one-line summary (account, role, warehouse, database, schema) for each,
and pick one interactively.
