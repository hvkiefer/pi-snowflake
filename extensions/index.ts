// Snowflake extension for pi.
//
// Provides:
// - A "snowflake" model provider backed by Snowflake Cortex
//   (Claude -> Anthropic Messages API, OpenAI -> Responses/Completions API).
// - A `snowflake_sql` tool so the agent can run SQL statements through the
//   Snowflake SQL API (https://docs.snowflake.com/en/developer-guide/sql-api/index).
// - `/snowflake-connection` to pick which ~/.snowflake/connections.toml entry
//   is used by the model provider (--llm) or the SQL tool (--sql, the default).
//   The two are independent: the LLM backend and the SQL warehouse connection
//   can be different ~/.snowflake/connections.toml entries.
// - `/snowflake-sql` and `/snowflake-results` to run a query and browse its
//   result as a scrollable table in the terminal.
// - `/snowflake-details` to show the active SQL and LLM connections and their
//   parameters in a popup. A compact, right-aligned, clickable line above the
//   footer (next to the active model indicator) opens the same popup; click
//   support depends on terminal/mode mouse routing, so the command is the
//   reliable, keyboard-only way to open it.
//
// Configure in ~/.pi/agent/settings.json (or <project>/.pi/settings.json):
//   "snowflake": {
//     "llmConnection": "my-cortex-connection",
//     "sqlConnection": "my-warehouse-connection",
//     "openaiApi": "responses", // or "completions"
//     "models": ["claude-opus-5", ...],
//     "sql": { "timeoutSeconds": 60, "maxWaitMs": 120000, "maxRows": 5000, "previewRows": 10 }
//   }
// Or run `/snowflake-connection [name]` (SQL, default) or `/snowflake-connection --llm [name]` inside pi.
// @ts-nocheck
import { BorderedLoader, truncateHead } from "@earendil-works/pi-coding-agent";
import { MouseRegion, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  anthropicMessagesApi,
  createAssistantMessageEventStream,
  openAICompletionsApi,
  openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import {
  accountHost,
  canRunSql,
  describeConnection,
  listConnections,
  loadSettings,
  persistConnection,
  readConnection,
  resolveToken,
  type SnowflakeConnection,
  type SnowflakeConnectionTarget,
} from "./connections.ts";
import { applyStartupModel } from "./startup-model.ts";
import { executeStatement, type SnowflakeColumn } from "./sql-api.ts";
import { showSqlResultTable, showTextPopup } from "./table-view.ts";

function makeStream(openaiApi: string, conn: SnowflakeConnection) {
  return (model, context, options) => {
    const out = createAssistantMessageEventStream();
    (async () => {
      try {
        const pat = resolveToken(conn);
        if (!pat) throw new Error("Empty Snowflake PAT token file");

        if (model.id.startsWith("claude-")) {
          // Anthropic SDK appends /v1/messages to baseURL, so strip /v1.
          const inner = anthropicMessagesApi().streamSimple(
            {
              ...model,
              api: "anthropic-messages",
              baseUrl: model.baseUrl.replace(/\/v1\/?$/, ""),
              compat: { ...model.compat, forceAdaptiveThinking: true },
            },
            context,
            { ...options, apiKey: "snowflake-pat", headers: { ...options?.headers, Authorization: `Bearer ${pat}` } },
          );
          for await (const ev of inner) out.push(ev);
          return;
        }

        const origOnPayload = options?.onPayload;
        if (openaiApi !== "completions") {
          const inner = openAIResponsesApi().streamSimple(
            { ...model, api: "openai-responses", compat: { ...model.compat, supportsLongCacheRetention: false } },
            context,
            {
              ...options,
              apiKey: pat,
              onPayload: async (payload: any, m: any) => {
                const { include, prompt_cache_key, prompt_cache_retention, prompt_cache_options, service_tier, ...rest } = payload;
                if (rest.reasoning) delete rest.reasoning.summary;
                const cleaned = { ...rest, store: false };
                return origOnPayload ? await origOnPayload(cleaned, m) : cleaned;
              },
            },
          );
          for await (const ev of inner) out.push(ev);
          return;
        }

        // Optional fallback: /v1/chat/completions (GPT-5.6/6.x require reasoning_effort="none" when tools are passed)
        const forceNone = /^openai-gpt-(5\.6-|6-(sol|luna))/.test(model.id);
        const inner = openAICompletionsApi().streamSimple(
          { ...model, api: "openai-completions" },
          context,
          {
            ...options,
            apiKey: pat,
            onPayload: async (payload: any, m: any) => {
              const cleaned = { ...payload };
              if (forceNone && cleaned.tools?.length) cleaned.reasoning_effort = "none";
              return origOnPayload ? await origOnPayload(cleaned, m) : cleaned;
            },
          },
        );
        for await (const ev of inner) out.push(ev);
      } catch (e) {
        out.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "error", errorMessage: e instanceof Error ? e.message : String(e), timestamp: Date.now(),
          },
        });
      } finally { out.end(); }
    })();
    return out;
  };
}

function registerProvider(pi, cfg) {
  const conn = readConnection(cfg.llmConnection);
  if (!resolveToken(conn)) throw new Error("Empty Snowflake PAT token file");
  const host = accountHost(conn.account);

  pi.registerProvider("snowflake", {
    name: "Snowflake Cortex",
    baseUrl: `https://${host}.snowflakecomputing.com/api/v2/cortex/v1`,
    // A non-secret placeholder makes Pi's auth check pass. The stream reads the
    // PAT directly from the file for each request; it never enters a shell.
    apiKey: "snowflake-pat",
    api: "snowflake-cortex",
    streamSimple: makeStream(cfg.openaiApi, conn),
    models: cfg.models.map((id: string) => ({
      type: "chat",
      id,
      name: `Snowflake ${id}`,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000000,
      maxTokens: 16384,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: !id.startsWith("claude-"),
        supportsReasoningEffort: !id.startsWith("claude-"),
        supportsUsageInStreaming: true,
        maxTokensField: "max_completion_tokens",
      },
    })),
  });
}

function buildMarkdownPreview(columns: SnowflakeColumn[], rows: (string | null)[][], limit: number): string {
  if (columns.length === 0) return "(no columns)";
  const names = columns.map((c) => c.name);
  const header = `| ${names.join(" | ")} |`;
  const sep = `| ${names.map(() => "---").join(" | ")} |`;
  const body = rows.slice(0, limit).map((row) => `| ${row.map((v) => (v === null ? "NULL" : String(v).replace(/\|/g, "\\|"))).join(" | ")} |`);
  return [header, sep, ...body].join("\n");
}

const SqlParams = Type.Object({
  statement: Type.String({ description: "SQL statement to run against Snowflake." }),
  connection: Type.Optional(
    Type.String({ description: "Connection name from ~/.snowflake/connections.toml. Defaults to the connection set via /snowflake-connection." }),
  ),
  warehouse: Type.Optional(Type.String({ description: "Override the connection's warehouse." })),
  database: Type.Optional(Type.String({ description: "Override the connection's database." })),
  schema: Type.Optional(Type.String({ description: "Override the connection's schema." })),
  role: Type.Optional(Type.String({ description: "Override the connection's role." })),
  timeoutSeconds: Type.Optional(Type.Number({ description: "Server-side statement timeout, in seconds." })),
});

const SqlOutput = Type.Object({
  columns: Type.Array(Type.Object({ name: Type.String(), type: Type.String() })),
  rows: Type.Array(Type.Array(Type.Union([Type.String(), Type.Null()]))),
  numRows: Type.Number(),
  truncated: Type.Boolean(),
});

interface LastSqlResult {
  connection: string;
  statement: string;
  columns: SnowflakeColumn[];
  rows: (string | null)[][];
  numRows: number;
  truncated: boolean;
  elapsedMs: number;
}

export default function (pi) {
  const cwd = () => process.cwd();

  // Project trust is not available during the factory. Start with global/env
  // settings and apply trusted project settings after the session starts.
  const initialSettings = loadSettings(cwd(), false);
  const settingsFor = (ctx) => loadSettings(ctx.cwd ?? cwd(), ctx.isProjectTrusted());
  if (initialSettings.llmConnection) {
    try { registerProvider(pi, initialSettings); }
    catch (e) { console.error(`Snowflake: failed to register provider: ${e instanceof Error ? e.message : e}`); }
  }

  let lastResult: LastSqlResult | undefined;

  const reconstructLastResult = (ctx) => {
    lastResult = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role !== "toolResult" || msg.toolName !== "snowflake_sql") continue;
      if (msg.details) lastResult = msg.details as LastSqlResult;
    }
  };

  // Tracks the most recently seen ExtensionContext so the clickable widget
  // (which only gets `tui`/`theme`, not `ctx`) can still open the popup.
  let currentCtx: any;

  function buildConnectionDetailLines(theme: any, settings): string[] {
    const lines: string[] = [];

    const section = (title: string, name: string | undefined, source: string | undefined) => {
      lines.push(theme.style(title, { bold: true, fg: "accent" }));
      if (!name) {
        lines.push(`  ${theme.fg("dim", "(not configured)")}`);
        lines.push("");
        return;
      }
      let conn: SnowflakeConnection;
      try { conn = readConnection(name); }
      catch (e) {
        lines.push(`  ${theme.fg("error", String(e.message ?? e))}`);
        if (source) lines.push(`  ${theme.fg("dim", "config file".padEnd(14))} ${source}`);
        lines.push("");
        return;
      }
      const rows: [string, string | undefined][] = [
        ["connection", conn.name],
        ["config file", source],
        ["account", conn.account],
        ["user", conn.user],
        ["role", conn.role],
        ["warehouse", conn.warehouse],
        ["database", conn.database],
        ["schema", conn.schema],
        ["authenticator", conn.authenticator],
        ["sql capable", canRunSql(conn) ? "yes (PAT)" : "no (needs token_file_path)"],
      ];
      for (const [k, v] of rows) {
        lines.push(`  ${theme.fg("dim", k.padEnd(14))} ${v ?? theme.fg("dim", "-")}`);
      }
      lines.push("");
    };

    section("SQL connection  (snowflake_sql tool, /snowflake-sql)", settings.sqlConnection, settings.sqlConnectionSource);
    section("LLM connection  (Snowflake Cortex model provider)", settings.llmConnection, settings.llmConnectionSource);

    lines.push(theme.style("Configuration files", { bold: true, fg: "accent" }));
    lines.push(
      `  ${theme.fg("dim", "settings".padEnd(14))} ${
        settings.configFiles?.length ? settings.configFiles.join(", ") : theme.fg("dim", "(none)")
      }`,
    );
    lines.push(`  ${theme.fg("dim", "connections".padEnd(14))} ${settings.connectionsFile}`);
    lines.push("");

    lines.push(theme.style("SQL settings", { bold: true, fg: "accent" }));
    lines.push(`  ${theme.fg("dim", "timeoutSeconds".padEnd(14))} ${settings.sql.timeoutSeconds}`);
    lines.push(`  ${theme.fg("dim", "maxWaitMs".padEnd(14))} ${settings.sql.maxWaitMs}`);
    lines.push(`  ${theme.fg("dim", "maxRows".padEnd(14))} ${settings.sql.maxRows}`);
    lines.push(`  ${theme.fg("dim", "previewRows".padEnd(14))} ${settings.sql.previewRows}`);

    return lines;
  }

  const openConnectionDetails = (ctx) => {
    if (ctx.mode !== "tui") { ctx.ui.notify("snowflake-details requires interactive mode", "error"); return; }
    void showTextPopup(ctx, "Snowflake connections", (theme) =>
      buildConnectionDetailLines(theme, settingsFor(ctx)),
    );
  };

  // A single compact, right-aligned line placed directly above the footer
  // (where the active model is shown). Click it, or run /snowflake-details,
  // to open the full connection-details popup.
  const updateConnectionWidget = (ctx) => {
    currentCtx = ctx;
    if (ctx.mode !== "tui" || !ctx.ui.setWidget) return;
    ctx.ui.setWidget(
      "snowflake-connections",
      (_tui, theme) => {
        const label = "❄ snowflake-details";
        const styled = theme.fg("dim", label);
        const base = {
          render: (width: number) => {
            const pad = Math.max(0, width - visibleWidth(label));
            return [truncateToWidth(" ".repeat(pad) + styled, width)];
          },
          invalidate: () => {},
        };
        return new MouseRegion(base, (event) => {
          if (event.type !== "click" || event.button !== "left") return undefined;
          if (currentCtx) openConnectionDetails(currentCtx);
          return { handled: true };
        });
      },
      { placement: "belowEditor" },
    );
  };

  pi.on("session_start", async (event, ctx) => {
    const settings = settingsFor(ctx);
    if (ctx.isProjectTrusted() && settings.llmConnection) {
      try { registerProvider(pi, settings); }
      catch (e) {
        // Do not silently leave a previously registered account active.
        pi.unregisterProvider("snowflake");
        console.error(`Snowflake: failed to register provider: ${e instanceof Error ? e.message : e}`);
      }
    }
    await applyStartupModel(pi, event, ctx, settings);
    reconstructLastResult(ctx);
    updateConnectionWidget(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => { reconstructLastResult(ctx); updateConnectionWidget(ctx); });

  async function resolveConnection(ctx, override?: string): Promise<SnowflakeConnection> {
    const settings = settingsFor(ctx);
    const name = override || settings.sqlConnection;
    if (!name) {
      throw new Error(
        "No Snowflake SQL connection configured. Run /snowflake-connection to pick one, or pass a 'connection' override.",
      );
    }
    const conn = readConnection(name);
    if (!canRunSql(conn)) {
      throw new Error(
        `Connection '${name}' cannot run SQL: it has no 'token_file_path'. Pick a Programmatic Access ` +
        `Token (PAT) connection with /snowflake-connection, or pass a 'connection' override.`,
      );
    }
    return conn;
  }

  pi.registerTool({
    name: "snowflake_sql",
    label: "Snowflake SQL",
    description:
      "Run a SQL statement against Snowflake via the Snowflake SQL API and return the result. " +
      "Use for SELECT queries, DDL, and DML. Results are limited by maxRows; tell the user to run " +
      "/snowflake-results to browse the fetched rows in the terminal.",
    promptSnippet: "snowflake_sql(statement, connection?) - run SQL against Snowflake",
    promptGuidelines: [
      "Call snowflake_sql directly in the current session rather than spawning a separate 'pi' process " +
        "(e.g. via bash) to run the query. Results from a different process are not visible to this " +
        "session's /snowflake-results table viewer.",
    ],
    parameters: SqlParams,
    outputSchema: SqlOutput,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const settings = settingsFor(ctx);
      const conn = await resolveConnection(ctx, params.connection);

      const result = await executeStatement(conn, params.statement, {
        warehouse: params.warehouse,
        database: params.database,
        schema: params.schema,
        role: params.role,
        timeoutSeconds: params.timeoutSeconds ?? settings.sql.timeoutSeconds,
        maxWaitMs: settings.sql.maxWaitMs,
        maxRows: settings.sql.maxRows,
        signal,
      });

      const details: LastSqlResult = {
        connection: conn.name,
        statement: params.statement,
        columns: result.columns,
        rows: result.rows,
        numRows: result.numRows,
        truncated: result.truncated,
        elapsedMs: result.elapsedMs,
      };
      lastResult = details;

      const previewRows = settings.sql.previewRows;
      const preview = buildMarkdownPreview(result.columns, result.rows, previewRows);
      const remaining = result.rows.length - previewRows;
      const text = [
        `Ran on connection '${conn.name}' in ${result.elapsedMs}ms.`,
        `${result.numRows} row(s), ${result.columns.length} column(s): ${result.columns.map((c) => c.name).join(", ")}${result.truncated ? ` (showing ${result.rows.length})` : ""}`,
        "",
        preview,
        remaining > 0 ? `\n...${remaining} more row(s) not shown. Run /snowflake-results to view the full table.` : "",
      ].join("\n");

      const previewResult = truncateHead(text);
      const content = previewResult.truncated
        ? `${previewResult.content}\n\n[Preview truncated. Run /snowflake-results to view fetched rows.]`
        : text;
      return {
        content: [{ type: "text", text: content }],
        details,
        structuredContent: {
          columns: result.columns.map((c) => ({ name: c.name, type: c.type })),
          rows: result.rows,
          numRows: result.numRows,
          truncated: result.truncated,
        },
      };
    },
  });

  pi.registerCommand("snowflake-connection", {
    description:
      "Show/set the Snowflake connection used by the SQL tool (default) or the LLM provider (--llm). " +
      "Usage: /snowflake-connection [--llm|--sql] [name]. Persisted in settings.json.",
    handler: async (arg, ctx) => {
      const trimmed = (arg || "").trim();
      let target: SnowflakeConnectionTarget = "sql";
      let rest = trimmed;
      if (/^--llm(\s+|$)/.test(rest)) { target = "llm"; rest = rest.replace(/^--llm\s*/, ""); }
      else if (/^--sql(\s+|$)/.test(rest)) { target = "sql"; rest = rest.replace(/^--sql\s*/, ""); }
      let name = rest.trim();

      const settings = settingsFor(ctx);
      const cur = target === "llm" ? settings.llmConnection : settings.sqlConnection;
      const curLabel = cur ?? "(none configured)";

      if (!name) {
        const names = listConnections();
        if (!names.length || !ctx.ui.select) { ctx.ui.notify(`Current ${target} connection: ${curLabel}`, "info"); return; }
        const labels = names.map((n) => {
          try { return `${n === cur ? "* " : "  "}${n}  —  ${describeConnection(readConnection(n))}`; }
          catch { return `${n === cur ? "* " : "  "}${n}`; }
        });
        const picked = await ctx.ui.select(`Snowflake ${target} connection (current: ${curLabel})`, labels);
        if (!picked) return;
        name = names[labels.indexOf(picked)];
      }

      let conn;
      try {
        conn = readConnection(name);
        if (target === "llm") {
          accountHost(conn.account);
          if (!resolveToken(conn)) throw new Error("Empty Snowflake PAT token file");
        }
      } catch (e) { ctx.ui.notify(String(e.message ?? e), "error"); return; }
      if (target === "sql" && !canRunSql(conn)) {
        ctx.ui.notify(`Warning: connection '${name}' has no 'token_file_path'; the SQL tool needs a PAT connection to work.`, "warning");
      }

      try { persistConnection(target, name); }
      catch (e) { ctx.ui.notify(String(e.message ?? e), "error"); return; }
      const effective = settingsFor(ctx);
      const activeName = target === "llm" ? effective.llmConnection : effective.sqlConnection;
      if (target === "llm") {
        try { registerProvider(pi, effective); }
        catch (e) {
          pi.unregisterProvider("snowflake");
          ctx.ui.notify(`Saved '${name}', but could not register the effective LLM connection: ${String(e.message ?? e)}`, "error");
          return;
        }
      }
      updateConnectionWidget(ctx);
      if (activeName !== name) {
        ctx.ui.notify(`Saved '${name}' globally, but ${target} still uses '${activeName}' due to a higher-priority setting.`, "warning");
      } else {
        ctx.ui.notify(`Snowflake ${target} connection set to '${name}'`, "info");
      }
    },
  });

  pi.registerCommand("snowflake-sql", {
    description: "Run a SQL statement against Snowflake and show the result as a scrollable table",
    handler: async (arg, ctx) => {
      let statement = (arg || "").trim();
      if (!statement) {
        if (ctx.mode !== "tui" || !ctx.ui.input) {
          ctx.ui.notify("Usage: /snowflake-sql <statement>", "error");
          return;
        }
        statement = ((await ctx.ui.input("Snowflake SQL statement", "select current_version()")) ?? "").trim();
        if (!statement) return;
      }

      const settings = settingsFor(ctx);
      let conn;
      try { conn = await resolveConnection(ctx); } catch (e) { ctx.ui.notify(String(e.message ?? e), "error"); return; }

      const run = (signal?: AbortSignal) =>
        executeStatement(conn, statement, {
          timeoutSeconds: settings.sql.timeoutSeconds,
          maxWaitMs: settings.sql.maxWaitMs,
          maxRows: settings.sql.maxRows,
          signal,
        });

      let result;
      let error;
      if (ctx.mode === "tui") {
        const outcome = await ctx.ui.custom<any>((tui, theme, _kb, done) => {
          const loader = new BorderedLoader(tui, theme, `Running query via '${conn.name}'...`);
          loader.onAbort = () => done({ cancelled: true });
          run(loader.signal).then((r) => done({ result: r })).catch((e) => done({ error: e }));
          return loader;
        });
        if (outcome?.cancelled) { ctx.ui.notify("Cancelled", "info"); return; }
        result = outcome?.result;
        error = outcome?.error;
      } else {
        try { result = await run(); } catch (e) { error = e; }
      }

      if (error) { ctx.ui.notify(String(error.message ?? error), "error"); return; }

      lastResult = {
        connection: conn.name,
        statement,
        columns: result.columns,
        rows: result.rows,
        numRows: result.numRows,
        truncated: result.truncated,
        elapsedMs: result.elapsedMs,
      };

      if (ctx.mode === "tui") {
        await showSqlResultTable(ctx, "Snowflake SQL", result.columns, result.rows, {
          elapsedMs: result.elapsedMs,
          numRows: result.numRows,
          truncated: result.truncated,
          connection: conn.name,
        });
      } else {
        ctx.ui.notify(`${result.numRows} row(s) in ${result.elapsedMs}ms`, "info");
      }
    },
  });

  pi.registerCommand("snowflake-results", {
    description: "Show the most recent Snowflake SQL result as a scrollable table",
    handler: async (_arg, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("snowflake-results requires interactive mode", "error"); return; }
      if (!lastResult) { ctx.ui.notify("No Snowflake query results yet. Run /snowflake-sql or ask the agent to run one.", "info"); return; }
      await showSqlResultTable(ctx, "Snowflake SQL", lastResult.columns, lastResult.rows, {
        elapsedMs: lastResult.elapsedMs,
        numRows: lastResult.numRows,
        truncated: lastResult.truncated,
        connection: lastResult.connection,
      });
    },
  });

  pi.registerCommand("snowflake-details", {
    description: "Show the active Snowflake SQL and LLM connections and their parameters",
    handler: async (_arg, ctx) => openConnectionDetails(ctx),
  });
}
