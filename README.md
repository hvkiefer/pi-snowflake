# pi-snowflake

A [pi](https://pi.dev) package that adds Snowflake support:

- A `snowflake` model provider backed by Snowflake Cortex (Claude via the
  Anthropic Messages API; OpenAI models via the Responses or Chat Completions
  API).
- A `snowflake_sql` tool that runs SQL statements through the
  [Snowflake SQL API v2](https://docs.snowflake.com/en/developer-guide/sql-api/index),
  including async polling and multi-partition result fetching.
- `/snowflake-connection`, `/snowflake-sql`, and `/snowflake-results` commands,
  including a scrollable terminal table viewer for query results.
- A bundled `snowflake-sql` skill that teaches the model how to use the tool
  and commands, how the SQL API behaves, and how to diagnose common errors.

See `skills/snowflake-sql/SKILL.md` for full usage and configuration details.

## Install

Requires Pi with the `@earendil-works` extension APIs (tested against Pi 1.5.2)
and Node.js 22.19 or newer. Install from GitHub:

```bash
pi install git:github.com/hvkiefer/pi-snowflake
```

To update the package later, run:

```bash
pi update git:github.com/hvkiefer/pi-snowflake
```

For local development, install from a checkout instead:

```bash
pi install ./pi-snowflake
```

If you already use a local copy of this extension, remove that package from Pi
before installing the GitHub version to avoid registering it twice.

## Configure

Requires a Programmatic Access Token (PAT) connection in
`~/.snowflake/connections.toml`:

```toml
[my-connection]
account = "MY-ACCOUNT-LOCATOR"
user = "MY_USER"
authenticator = "PROGRAMMATIC_ACCESS_TOKEN"
token_file_path = "/home/me/.snowflake/my.token"
role = "MY_ROLE"
warehouse = "MY_WAREHOUSE"
database = "MY_DB"
schema = "MY_SCHEMA"
```

The account must be an identifier, not a URL or full hostname. Both SQL and
Cortex require a PAT token file; browser and key-pair authentication are not
supported. The TOML reader supports simple one-line connection sections and
string values, not the full TOML specification. Avoid escapes or `#` in values.
Protect token files with restrictive filesystem permissions.

Then, inside pi, run `/snowflake-connection` (SQL tool) and
`/snowflake-connection --llm` (Cortex model provider) to pick connections, or
set them directly in `~/.pi/agent/settings.json`:

```json
{
  "snowflake": {
    "llmConnection": "my-cortex-connection",
    "sqlConnection": "my-warehouse-connection",
    "openaiApi": "responses",
    "sql": { "timeoutSeconds": 60, "maxWaitMs": 120000, "maxRows": 5000, "previewRows": 10 }
  }
}
```

A legacy single `"connection"` key is honored as a shared fallback for both.

For each specific connection, precedence is its environment variable
(`SNOWFLAKE_SQL_CONNECTION` or `SNOWFLAKE_LLM_CONNECTION`), the nearest
`.pi-snowflake-settings.json`, project `.pi/settings.json`, then global
`settings.json`. The legacy `SNOWFLAKE_CONNECTION` and `connection` settings
are fallbacks after all specific settings. `SNOWFLAKE_OPENAI_API` and
`SNOWFLAKE_MODELS` override the corresponding settings. A selected connection
is saved globally and can be masked by a higher-priority setting.

The `.pi-snowflake-settings.json` file is discovered by searching the current
directory and its parents, stopping at the first match. Within `$HOME`, the
search stops at `$HOME`. Outside `$HOME`, it stops at the filesystem root.
This custom file is **disabled by default** because it does not trigger Pi's
project trust prompt. To opt in to parent searches, add this setting to
`~/.pi/agent/settings.json`:

```json
{
  "snowflake": {
    "allow-settings-from-parent-directories": true
  }
}
```

Only the global setting enables this behavior. It accepts the nearest file even
when Pi does not trust the project, including during early model registration.
Review parent settings files before enabling it: they can select connections,
models, and other Snowflake options. This permission applies in every directory
where you run Pi. Project `.pi/settings.json` remains subject to Pi's own trust
decision, and project model defaults are still applied only when Pi trusts the
project.

Alternatively, leave the setting disabled and set
`SNOWFLAKE_PROJECT_SETTINGS_FILE` to the absolute path of the exact file you
approve. This alternative also requires Pi to trust the project.

The custom file uses the same `{ "snowflake": { ... } }` shape as
`settings.json`:

```json
{
  "defaultProvider": "snowflake",
  "defaultModel": "claude-opus-4-6",
  "snowflake": {
    "llmConnection": "my-cortex-connection",
    "sqlConnection": "my-warehouse-connection"
  }
}
```

The optional top-level `defaultProvider` and `defaultModel` select the model
for fresh sessions at startup and for `/new`. They override the ordinary Pi
model defaults without modifying your saved settings. If only one is supplied,
the other is inherited from `.pi/settings.json`, then the global
`settings.json`. Use both keys to make the choice independent of those files.

These model defaults apply only when the custom file is explicitly enabled and Pi trusts the project. An explicit startup
`--model`, `--provider`, or `--models` takes precedence, and the default must be
within any active model scope. Explicit startup `--thinking` is preserved, subject
to the selected model's supported levels. Existing conversations keep their restored model; `/reload`, `/resume`, and forks do not
apply these defaults. After changing the file, start a fresh session or use
`/new`. The model must already be registered and have authentication configured;
otherwise the extension warns and keeps the current model. These keys can also
select a registered provider other than `snowflake`. A Cortex connection that
exists only in project settings is registered after project trust is resolved;
use a global or environment connection if Pi must see it during early CLI model
selection. Extension contexts do not expose model-selection provenance: an SDK
caller's explicit `options.model` or an empty session restored through an SDK
cannot always be distinguished from automatic startup selection.

## Security and limitations

- `snowflake_sql` and `/snowflake-sql` execute SQL with the selected connection's
  privileges, including DDL and DML. The skill asks the model to seek confirmation,
  but the extension does not enforce approval. Use a least-privilege role and a
  separate permission extension when an enforced gate is needed.
- Queries and fetched rows may contain sensitive data. Tool calls, previews and
  all fetched rows are included in Pi session history and structured output;
  the preview is also sent to the model. `/snowflake-results` displays only the
  rows fetched up to `maxRows`, not necessarily the complete server result.
- Cortex sends prompts and context to Snowflake. Registered model IDs and
  capabilities are static estimates, and zero prices do not mean requests are free.
  Availability, limits and billing depend on the account and region. Configure
  `snowflake.models` or `SNOWFLAKE_MODELS` for your account.
- The PAT is read from the token file for every SQL and Cortex request. Do not
  commit credentials or connection files. The extension requires the standard
  `snowflakecomputing.com` endpoint; custom domains are not supported.
- A cancelled or timed-out SQL request may still be running on Snowflake.
  The client does not automatically cancel it.

`/snowflake-details` shows connection metadata and config paths. Commands run in
interactive Pi unless otherwise noted. SQL result browsing requires a TUI.

## Tests

With a TypeScript-enabled Node.js build (22.19 or newer):

```bash
node --experimental-strip-types --test tests/*.test.ts
```

Node must be built with TypeScript stripping support. Alternatively, use an
installed `tsx` runner:

```bash
tsx --test tests/*.test.ts
```

Set `PI_BIN` to the Pi executable to include the offline Pi loader and mocked
provider smoke test, for example `PI_BIN=$(command -v pi) npm test`. No live
Snowflake account is needed. A live SQL/Cortex integration test is still
recommended before a release.

## License

MIT
