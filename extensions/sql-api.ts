// Minimal client for the Snowflake SQL API (v2).
// Docs: https://docs.snowflake.com/en/developer-guide/sql-api/index
//
// Flow:
//  1. POST /api/v2/statements submits a statement. Fast statements return 200
//     with results inline; longer ones return 202 with a statementHandle.
//  2. Poll GET /api/v2/statements/{handle} until the statement completes.
//  3. Large result sets are split into partitions; fetch each with
//     GET /api/v2/statements/{handle}?partition=N and concatenate rows.
// @ts-nocheck
import { randomUUID } from "node:crypto";
import { accountHost, resolveToken, type SnowflakeConnection } from "./connections.ts";

export interface SnowflakeColumn {
  name: string;
  type: string;
  nullable?: boolean;
}

export interface SnowflakeSqlResult {
  statementHandle: string;
  queryId?: string;
  columns: SnowflakeColumn[];
  rows: (string | null)[][];
  /** Total rows the server reports for the statement (may exceed `rows.length` when truncated). */
  numRows: number;
  truncated: boolean;
  elapsedMs: number;
  statement: string;
}

export interface SnowflakeExecOptions {
  warehouse?: string;
  database?: string;
  schema?: string;
  role?: string;
  bindings?: Record<string, { type: string; value: string }>;
  /** Server-side statement timeout, in seconds. */
  timeoutSeconds?: number;
  /** Client-side budget to wait for async completion, in ms. */
  maxWaitMs?: number;
  pollIntervalMs?: number;
  /** Stop fetching additional partitions once this many rows have been collected. */
  maxRows?: number;
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function baseUrl(conn: SnowflakeConnection): string {
  return `https://${accountHost(conn.account)}.snowflakecomputing.com/api/v2`;
}

function headers(conn: SnowflakeConnection, token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    // This client supports PAT token files, not OAuth or key-pair auth.
    "X-Snowflake-Authorization-Token-Type": "PROGRAMMATIC_ACCESS_TOKEN",
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "pi-snowflake-extension/1.0",
  };
}

async function asJson(resp: Response) {
  const text = await resp.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { message: text }; }
}

function statementError(resp: Response, body: any): Error {
  const detail = body?.message || body?.code || JSON.stringify(body);
  return new Error(`Snowflake SQL API error (HTTP ${resp.status}): ${detail}`);
}

function columnsFromMetadata(meta: any): SnowflakeColumn[] {
  return (meta?.rowType ?? []).map((c: any) => ({ name: c.name, type: c.type, nullable: c.nullable }));
}

/**
 * Execute one SQL statement and wait for it to complete, fetching every
 * result partition up to `maxRows`.
 */
export async function executeStatement(
  conn: SnowflakeConnection,
  statement: string,
  opts: SnowflakeExecOptions = {},
): Promise<SnowflakeSqlResult> {
  const started = Date.now();
  const base = baseUrl(conn);
  // Read the token for each HTTP request so rotation also works while polling.
  const requestHeaders = () => headers(conn, resolveToken(conn));
  const maxRows = opts.maxRows ?? 5000;

  const payload: Record<string, unknown> = {
    statement,
    timeout: opts.timeoutSeconds ?? 60,
    database: opts.database ?? conn.database,
    schema: opts.schema ?? conn.schema,
    warehouse: opts.warehouse ?? conn.warehouse,
    role: opts.role ?? conn.role,
    bindings: opts.bindings,
    resultSetMetaData: { format: "json" },
  };

  let resp = await fetch(`${base}/statements?requestId=${randomUUID()}`, {
    method: "POST",
    headers: requestHeaders(),
    body: JSON.stringify(payload),
    signal: opts.signal,
  });
  let body = await asJson(resp);

  if (resp.status !== 200 && resp.status !== 202) throw statementError(resp, body);

  const handle: string = body.statementHandle;
  const deadline = Date.now() + (opts.maxWaitMs ?? 120_000);
  while (resp.status === 202) {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after ${opts.maxWaitMs ?? 120_000}ms waiting for statement ${handle} to complete. ` +
        `It may still be running on Snowflake; re-check with its statement handle.`,
      );
    }
    await sleep(opts.pollIntervalMs ?? 1000);
    resp = await fetch(`${base}/statements/${handle}`, { headers: requestHeaders(), signal: opts.signal });
    body = await asJson(resp);
    if (resp.status !== 200 && resp.status !== 202) throw statementError(resp, body);
  }

  const columns = columnsFromMetadata(body.resultSetMetaData);
  let rows: (string | null)[][] = Array.isArray(body.data) ? body.data : [];
  const numRows: number = body.resultSetMetaData?.numRows ?? rows.length;
  const partitions: any[] = body.resultSetMetaData?.partitionInfo ?? [];
  let truncated = false;

  for (let i = 1; i < partitions.length; i++) {
    if (rows.length >= maxRows) { truncated = true; break; }
    const pResp = await fetch(`${base}/statements/${handle}?partition=${i}`, { headers: requestHeaders(), signal: opts.signal });
    const pBody = await asJson(pResp);
    if (pResp.status !== 200) throw statementError(pResp, pBody);
    rows = rows.concat(Array.isArray(pBody.data) ? pBody.data : []);
  }
  if (rows.length > maxRows) { rows = rows.slice(0, maxRows); truncated = true; }
  if (!truncated && rows.length < numRows) truncated = true;

  return {
    statementHandle: handle,
    queryId: body.statementHandle,
    columns,
    rows,
    numRows,
    truncated,
    elapsedMs: Date.now() - started,
    statement,
  };
}

/** Request cancellation of a running statement (best effort). */
export async function cancelStatement(conn: SnowflakeConnection, statementHandle: string): Promise<void> {
  const token = resolveToken(conn);
  const resp = await fetch(`${baseUrl(conn)}/statements/${statementHandle}/cancel`, {
    method: "POST",
    headers: headers(conn, token),
  });
  if (!resp.ok) {
    const body = await asJson(resp);
    throw statementError(resp, body);
  }
}
