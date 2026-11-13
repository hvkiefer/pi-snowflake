import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { accountHost, loadSettings, persistConnection } from "../extensions/connections.ts";
import { executeStatement } from "../extensions/sql-api.ts";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-snowflake-test-"));
  t.mock.method(os, "homedir", () => home);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const tokenFile = path.join(home, "test.token");
  fs.writeFileSync(tokenFile, "fake-$(not-a-command)-token");
  return { home, tokenFile, conn: { name: "test", account: "ORG_ACCOUNT", authenticator: "PROGRAMMATIC_ACCESS_TOKEN", token_file_path: tokenFile } };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("account identifiers cannot change the credential destination", () => {
  assert.equal(accountHost("ORG_ACCOUNT"), "org-account");
  assert.equal(accountHost("LOCATOR.eu-west-1"), "locator.eu-west-1");
  for (const bad of ["", "good@evil", "good/evil", "good?x=y", "good#x", ".good", "good..evil", "good:443"]) {
    assert.throws(() => accountHost(bad), /Invalid Snowflake account/);
  }
});

test("SQL sends PAT directly, polls and truncates fetched partitions", async (t) => {
  const { conn, tokenFile } = fixture(t);
  const calls = [];
  const responses = [
    json({ statementHandle: "handle" }, 202),
    json({ statementHandle: "handle", resultSetMetaData: { rowType: [{ name: "VALUE", type: "text" }], numRows: 4, partitionInfo: [{}, {}] }, data: [["a"], ["b"]] }),
    json({ data: [["c"], ["d"]] }),
  ];
  t.mock.method(globalThis, "fetch", async (url, opts) => {
    calls.push({ url, opts });
    if (calls.length === 1) fs.writeFileSync(tokenFile, "rotated-during-query");
    return responses.shift();
  });
  const result = await executeStatement(conn, "select 1", { maxRows: 3, pollIntervalMs: 0 });
  assert.deepEqual(result.rows, [["a"], ["b"], ["c"]]);
  assert.equal(result.numRows, 4);
  assert.equal(result.truncated, true);
  assert.match(calls[0].url, /^https:\/\/org-account\.snowflakecomputing\.com\/api\/v2\/statements\?/);
  assert.equal(calls[0].opts.headers.Authorization, "Bearer fake-$(not-a-command)-token");
  assert.equal(calls[0].opts.headers["X-Snowflake-Authorization-Token-Type"], "PROGRAMMATIC_ACCESS_TOKEN");
  assert.equal(calls[1].opts.headers.Authorization, "Bearer rotated-during-query");
  assert.equal(calls[2].opts.headers.Authorization, "Bearer rotated-during-query");
  assert.match(calls[2].url, /partition=1$/);
  fs.writeFileSync(tokenFile, "rotated");
  responses.push(json({ statementHandle: "second", data: [] }));
  await executeStatement(conn, "select 2");
  assert.equal(calls[3].opts.headers.Authorization, "Bearer rotated");
});

test("SQL reports server errors and timeout without claiming cancellation", async (t) => {
  const { conn } = fixture(t);
  delete conn.authenticator;
  const fetchMock = t.mock.method(globalThis, "fetch", async (_url, opts) => {
    assert.equal(opts.headers["X-Snowflake-Authorization-Token-Type"], "PROGRAMMATIC_ACCESS_TOKEN");
    return json({ message: "denied" }, 403);
  });
  await assert.rejects(executeStatement(conn, "select 1"), /HTTP 403.*denied/);
  fetchMock.mock.mockImplementation(async () => json({ statementHandle: "pending" }, 202));
  await assert.rejects(executeStatement(conn, "select 1", { maxWaitMs: -1 }), /may still be running/);
});

test("untrusted project settings are ignored", (t) => {
  const { home } = fixture(t);
  const project = path.join(home, "repo");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, ".pi-snowflake-settings.json"), JSON.stringify({ snowflake: { sqlConnection: "project" } }));
  const previous = process.env.SNOWFLAKE_PROJECT_SETTINGS_FILE;
  t.after(() => {
    if (previous === undefined) delete process.env.SNOWFLAKE_PROJECT_SETTINGS_FILE;
    else process.env.SNOWFLAKE_PROJECT_SETTINGS_FILE = previous;
  });
  delete process.env.SNOWFLAKE_PROJECT_SETTINGS_FILE;
  assert.equal(loadSettings(project, true).sqlConnection, undefined);
  process.env.SNOWFLAKE_PROJECT_SETTINGS_FILE = path.join(home, "other", ".pi-snowflake-settings.json");
  assert.equal(loadSettings(project, true).sqlConnection, undefined);
  process.env.SNOWFLAKE_PROJECT_SETTINGS_FILE = path.join(project, ".pi-snowflake-settings.json");
  assert.equal(loadSettings(project, true).sqlConnection, "project");
  assert.equal(loadSettings(project, false).sqlConnection, undefined);
});

test("persist creates settings and refuses to overwrite malformed JSON", (t) => {
  const { home } = fixture(t);
  persistConnection("sql", "example");
  const file = path.join(home, ".pi", "agent", "settings.json");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).snowflake.sqlConnection, "example");
  fs.writeFileSync(file, "not-json");
  assert.throws(() => persistConnection("sql", "other"), /invalid settings/);
  assert.equal(fs.readFileSync(file, "utf8"), "not-json");
});
