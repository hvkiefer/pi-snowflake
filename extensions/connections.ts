// Shared Snowflake connection handling: reads ~/.snowflake/connections.toml
// (the same file the Snowflake CLI/connector uses) and loads pi settings.
// @ts-nocheck
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SnowflakeConnection {
  name: string;
  account: string;
  user?: string;
  role?: string;
  warehouse?: string;
  database?: string;
  schema?: string;
  authenticator?: string;
  token_file_path?: string;
}

export const readJson = (file: string) => {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
};

export const globalSettingsFile = () => path.join(os.homedir(), ".pi", "agent", "settings.json");
export const connectionsFile = () => path.join(os.homedir(), ".snowflake", "connections.toml");

const PROJECT_SETTINGS_FILENAME = ".pi-snowflake-settings.json";

/**
 * Find the nearest .pi-snowflake-settings.json, searching from `cwd` upward
 * through parent directories, stopping after $HOME (inclusive). Returns
 * undefined if no such file exists.
 */
export function findProjectSettingsFile(cwd: string): string | undefined {
  const home = os.homedir();
  let dir = path.resolve(cwd);
  const withinHome = dir === home || dir.startsWith(home + path.sep);
  for (;;) {
    const candidate = path.join(dir, PROJECT_SETTINGS_FILENAME);
    if (fs.existsSync(candidate)) return candidate;
    if (dir === home || !withinHome) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Parse ~/.snowflake/connections.toml into a map of section -> key/value strings. */
function parseConnectionsToml(): Record<string, Record<string, string>> {
  const file = connectionsFile();
  const sections: Record<string, Record<string, string>> = {};
  let cur = "";
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return sections; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sec = line.match(/^\[([^\]]+)\]/);
    if (sec) { cur = sec[1].trim(); sections[cur] = sections[cur] ?? {}; continue; }
    if (!cur) continue;
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/);
    if (kv) sections[cur][kv[1]] = (kv[2] ?? kv[3] ?? kv[4] ?? "").replace(/\s*#.*$/, "").trim();
  }
  return sections;
}

export function listConnections(): string[] {
  return Object.keys(parseConnectionsToml());
}

/** Read one named connection section. Throws if no name is given or the section is missing. */
export function readConnection(name: string | undefined): SnowflakeConnection {
  if (!name) {
    throw new Error(
      "No Snowflake connection configured. Run /snowflake-connection (or /snowflake-connection --llm) " +
        `to pick one from ${connectionsFile()}, or set 'snowflake.sqlConnection'/'snowflake.llmConnection' in settings.json.`,
    );
  }
  const sections = parseConnectionsToml();
  const out = sections[name];
  if (!out) {
    throw new Error(`Connection '${name}' not found in ${connectionsFile()}. Known connections: ${Object.keys(sections).join(", ") || "(none)"}`);
  }
  if (!out.account) throw new Error(`Connection '${name}' in ${connectionsFile()} must define 'account'`);
  return { name, ...out } as SnowflakeConnection;
}

/** One-line human summary used in selection UIs. */
export function describeConnection(conn: SnowflakeConnection): string {
  const bits = [
    conn.account,
    conn.role && `role=${conn.role}`,
    conn.warehouse && `wh=${conn.warehouse}`,
    conn.database && `db=${conn.database}`,
    conn.schema && `schema=${conn.schema}`,
    conn.authenticator && !conn.token_file_path ? `auth=${conn.authenticator}` : undefined,
  ].filter(Boolean);
  return bits.join("  ");
}

export function canRunSql(conn: SnowflakeConnection): boolean {
  // The SQL API client in sql-api.ts authenticates with a static bearer token
  // read from a file, so only PAT-style connections are supported directly.
  return !!conn.token_file_path;
}

export function resolveToken(conn: SnowflakeConnection): string {
  if (!conn.token_file_path) {
    throw new Error(
      `Connection '${conn.name}' has no 'token_file_path'. Only Programmatic Access Token (PAT) connections ` +
      `are supported; add 'token_file_path' to the [${conn.name}] section in ${connectionsFile()}.`,
    );
  }
  const file = conn.token_file_path.replace(/^~/, os.homedir());
  return fs.readFileSync(file, "utf8").trim();
}

export function accountHost(account: string): string {
  const host = account.toLowerCase().replace(/_/g, "-");
  // The account is interpolated into an HTTPS URL carrying a PAT. Never allow
  // URL delimiters or empty DNS labels to change the destination host.
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(host)) {
    throw new Error("Invalid Snowflake account identifier");
  }
  return host;
}

export type SnowflakeConnectionTarget = "llm" | "sql";

export interface SnowflakeSettings {
  /** Connection used by the Snowflake Cortex model provider. Undefined until configured. */
  llmConnection: string | undefined;
  /** Connection used by the snowflake_sql tool and /snowflake-sql command. Undefined until configured. */
  sqlConnection: string | undefined;
  /** Source file (or env var) from which llmConnection was resolved. */
  llmConnectionSource?: string;
  /** Source file (or env var) from which sqlConnection was resolved. */
  sqlConnectionSource?: string;
  /** Settings files that were found and loaded (in precedence order: highest first). */
  configFiles: string[];
  /** Path to the connections.toml file used to resolve connection entries. */
  connectionsFile: string;
  /** Root-level model defaults from the nearest .pi-snowflake-settings.json. */
  projectModel?: { provider: string | undefined; model: string | undefined; source: string };
  openaiApi: string;
  models: string[];
  sql: {
    timeoutSeconds: number;
    maxWaitMs: number;
    maxRows: number;
    previewRows: number;
  };
}

const DEFAULT_MODELS = [
  "claude-opus-5.5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6",
  "claude-sonnet-5.5", "claude-sonnet-5", "claude-sonnet-4-6",
  "openai-gpt-6.1-sol", "openai-gpt-6-astra", "openai-gpt-6-sol", "openai-gpt-6-luna",
  "openai-gpt-5.6-sol", "openai-gpt-5.6-terra", "openai-gpt-5.6-luna",
  "openai-gpt-5.5", "openai-gpt-5.4",
];

export function loadSettings(cwd: string, projectTrusted = true): SnowflakeSettings {
  const globalFile = globalSettingsFile();
  const projectPiFile = path.join(cwd, ".pi", "settings.json");
  // Pi does not prompt for this filename. The operator must explicitly name
  // the exact nearest file they approved, in addition to Pi project trust.
  const approvedFile = process.env.SNOWFLAKE_PROJECT_SETTINGS_FILE;
  const candidate = projectTrusted && approvedFile && path.isAbsolute(approvedFile)
    ? findProjectSettingsFile(cwd) : undefined;
  const dotSnowflakeFile = candidate && candidate === path.resolve(approvedFile!) ? candidate : undefined;

  const gRaw = readJson(globalFile);
  const pRaw = projectTrusted ? readJson(projectPiFile) : {};
  const dRaw = dotSnowflakeFile ? readJson(dotSnowflakeFile) : {};

  const g = gRaw.snowflake ?? {};
  const p = pRaw.snowflake ?? {};
  // Project-local override: nearest .pi-snowflake-settings.json, discovered by
  // walking up from `cwd` to $HOME. Takes precedence over .pi/settings.json
  // and the global settings file, but not over environment variables.
  const d = dRaw.snowflake ?? {};
  const env = process.env;
  const gs = g.sql ?? {};
  const ps = p.sql ?? {};
  const ds = d.sql ?? {};

  const configFiles: string[] = [];
  if (dotSnowflakeFile) configFiles.push(dotSnowflakeFile);
  if (pRaw.snowflake !== undefined) configFiles.push(projectPiFile);
  if (gRaw.snowflake !== undefined || fs.existsSync(globalFile)) configFiles.push(globalFile);

  const resolveConn = (
    envKey: string,
    prop: "llmConnection" | "sqlConnection",
  ): { value: string | undefined; source: string | undefined } => {
    if (env[envKey]) return { value: env[envKey], source: `env (${envKey})` };
    if (d[prop] && dotSnowflakeFile) return { value: d[prop], source: dotSnowflakeFile };
    if (p[prop]) return { value: p[prop], source: projectPiFile };
    if (g[prop]) return { value: g[prop], source: globalFile };
    // Back-compat: a single 'connection' setting (or SNOWFLAKE_CONNECTION) used to
    // configure both the LLM provider and the SQL tool. Keep it as a shared
    // fallback when the new, independent settings are not set.
    if (env.SNOWFLAKE_CONNECTION) return { value: env.SNOWFLAKE_CONNECTION, source: "env (SNOWFLAKE_CONNECTION)" };
    if (d.connection && dotSnowflakeFile) return { value: d.connection, source: dotSnowflakeFile };
    if (p.connection) return { value: p.connection, source: projectPiFile };
    if (g.connection) return { value: g.connection, source: globalFile };
    return { value: undefined, source: undefined };
  };

  const llm = resolveConn("SNOWFLAKE_LLM_CONNECTION", "llmConnection");
  const sql = resolveConn("SNOWFLAKE_SQL_CONNECTION", "sqlConnection");
  const nonEmptyString = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  const hasProjectModel = dotSnowflakeFile &&
    (dRaw.defaultProvider !== undefined || dRaw.defaultModel !== undefined);

  return {
    projectModel: hasProjectModel ? {
      provider: nonEmptyString(dRaw.defaultProvider ?? pRaw.defaultProvider ?? gRaw.defaultProvider),
      model: nonEmptyString(dRaw.defaultModel ?? pRaw.defaultModel ?? gRaw.defaultModel),
      source: dotSnowflakeFile,
    } : undefined,
    llmConnection: llm.value,
    sqlConnection: sql.value,
    llmConnectionSource: llm.source,
    sqlConnectionSource: sql.source,
    configFiles,
    connectionsFile: connectionsFile(),
    openaiApi: env.SNOWFLAKE_OPENAI_API || d.openaiApi || p.openaiApi || g.openaiApi || "responses",
    models: env.SNOWFLAKE_MODELS?.split(",").map((x) => x.trim()).filter(Boolean) || d.models || p.models || g.models || DEFAULT_MODELS,
    sql: {
      timeoutSeconds: ds.timeoutSeconds ?? ps.timeoutSeconds ?? gs.timeoutSeconds ?? 60,
      maxWaitMs: ds.maxWaitMs ?? ps.maxWaitMs ?? gs.maxWaitMs ?? 120_000,
      maxRows: ds.maxRows ?? ps.maxRows ?? gs.maxRows ?? 5000,
      previewRows: ds.previewRows ?? ps.previewRows ?? gs.previewRows ?? 10,
    },
  };
}

export function persistConnection(target: SnowflakeConnectionTarget, name: string) {
  const file = globalSettingsFile();
  let st: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      st = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!st || typeof st !== "object" || Array.isArray(st)) throw new Error("Expected a JSON object");
    } catch {
      throw new Error(`Cannot update invalid settings file: ${file}`);
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const key = target === "llm" ? "llmConnection" : "sqlConnection";
  st.snowflake = { ...(st.snowflake ?? {}), [key]: name };
  fs.writeFileSync(file, JSON.stringify(st, null, 2) + "\n");
}
