import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// Optional integration smoke test: no Snowflake or network access required.
test("Pi loads the package and registers a provider without shelling out with the PAT", (t) => {
  const pi = process.env.PI_BIN;
  if (!pi) return t.skip("Set PI_BIN to the Pi executable to run this integration test");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-snowflake-smoke-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const marker = path.join(home, "shell-executed");
  const tokenFile = path.join(home, "test.token");
  fs.writeFileSync(tokenFile, `fake-$(touch ${marker})`);
  fs.mkdirSync(path.join(home, ".snowflake"));
  fs.writeFileSync(path.join(home, ".snowflake", "connections.toml"), `[test]\naccount = "ORG_ACCOUNT"\nauthenticator = "PROGRAMMATIC_ACCESS_TOKEN"\ntoken_file_path = "${tokenFile}"\n[other]\naccount = "OTHER_ACCOUNT"\ntoken_file_path = "${tokenFile}"\n`);
  const env = { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: path.join(home, "agent"), PI_OFFLINE: "1", SNOWFLAKE_LLM_CONNECTION: "test", SNOWFLAKE_MODELS: "claude-test" };
  const result = spawnSync(pi, ["--offline", "--no-extensions", "--no-skills", "--no-context-files", "--extension", process.cwd(), "--list-models", "snowflake"], { cwd: home, env, encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /claude-test/);
  assert.doesNotMatch(result.stdout + result.stderr, /fake-\$\(/);
  assert.equal(fs.existsSync(marker), false);

  const install = spawnSync(pi, ["install", process.cwd()], { cwd: home, env, encoding: "utf8", timeout: 30000 });
  assert.equal(install.status, 0, install.stderr);
  const installed = spawnSync(pi, ["--offline", "--no-skills", "--no-context-files", "--list-models", "snowflake"], { cwd: home, env, encoding: "utf8", timeout: 30000 });
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /claude-test/);

  const outputFile = path.join(home, "provider-result.json");
  const check = spawnSync(pi, ["--offline", "--no-extensions", "--no-skills", "--no-context-files", "--extension", path.join(process.cwd(), "tests", "fixtures", "provider-check.ts"), "--list-models"], {
    cwd: home,
    env: { ...env, SNOWFLAKE_MODELS: "openai-gpt-test,claude-test", TEST_TOKEN_FILE: tokenFile, TEST_OUTPUT_FILE: outputFile },
    encoding: "utf8", timeout: 30000,
  });
  assert.equal(check.status, 0, check.stderr);
  assert.ok(fs.existsSync(outputFile), check.stderr);
  const output = JSON.parse(fs.readFileSync(outputFile, "utf8"));
  assert.equal(output.apiKey, "snowflake-pat");
  assert.deepEqual(output.seen, [`Bearer fake-$(touch ${marker})`, "Bearer rotated-test-token", "Bearer rotated-test-token"]);
  assert.equal(fs.existsSync(marker), false);

  const selectionFile = path.join(home, "selection-result.json");
  const selection = spawnSync(pi, ["--offline", "--no-extensions", "--no-skills", "--no-context-files", "--extension", path.join(process.cwd(), "tests", "fixtures", "selection-check.ts"), "--list-models"], {
    cwd: home, env: { ...env, TEST_OUTPUT_FILE: selectionFile }, encoding: "utf8", timeout: 30000,
  });
  assert.equal(selection.status, 0, selection.stderr);
  assert.ok(fs.existsSync(selectionFile), selection.stderr);
  const selected = JSON.parse(fs.readFileSync(selectionFile, "utf8"));
  assert.equal(selected.first.length, 2);
  assert.ok(selected.first.every((url) => url.includes("org-account.snowflakecomputing.com")));
  assert.deepEqual(selected.registrations, selected.first);
  assert.match(selected.messages[0].message, /higher-priority setting/);
  assert.match(selected.messages[1].message, /invalid settings/);
});

test("global opt-in loads parent settings before model selection", (t) => {
  const pi = process.env.PI_BIN;
  if (!pi) return t.skip("Set PI_BIN to the Pi executable to run this integration test");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-snowflake-parent-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cwd = path.join(home, "workspace", "nested");
  const tokenFile = path.join(home, "test.token");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(home, ".snowflake"));
  fs.writeFileSync(tokenFile, "fake-token");
  fs.writeFileSync(path.join(home, ".snowflake", "connections.toml"), `[test]\naccount = "ORG_ACCOUNT"\ntoken_file_path = "${tokenFile}"\n`);
  fs.writeFileSync(path.join(home, "workspace", ".pi-snowflake-settings.json"), JSON.stringify({
    defaultProvider: "snowflake", defaultModel: "claude-test",
    snowflake: { llmConnection: "test", models: ["claude-test"] },
  }));
  const globalFile = path.join(home, ".pi", "agent", "settings.json");
  fs.mkdirSync(path.dirname(globalFile), { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: path.join(home, "agent"), PI_OFFLINE: "1" };
  const args = ["--offline", "--no-extensions", "--no-skills", "--no-context-files", "--extension", process.cwd(), "--list-models", "snowflake"];
  const before = spawnSync(pi, args, { cwd, env, encoding: "utf8", timeout: 30000 });
  assert.equal(before.status, 0, before.stderr);
  assert.doesNotMatch(before.stdout, /claude-test/);
  fs.writeFileSync(globalFile, JSON.stringify({ snowflake: { allowSettingsFromParentDirectories: true } }));
  const after = spawnSync(pi, args, { cwd, env, encoding: "utf8", timeout: 30000 });
  assert.equal(after.status, 0, after.stderr);
  assert.match(after.stdout, /claude-test/);
  const rpc = spawnSync(pi, ["--offline", "--approve", "--no-extensions", "--no-skills", "--no-context-files", "--no-mcp", "--extension", process.cwd(), "--mode", "rpc", "--no-session"], {
    cwd, env, input: '{"type":"get_state"}\n', encoding: "utf8", timeout: 30000,
  });
  assert.equal(rpc.status, 0, rpc.stderr);
  const state = rpc.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((item) => item.type === "response" && item.command === "get_state");
  assert.equal(state?.data?.model?.provider, "snowflake");
  assert.equal(state?.data?.model?.id, "claude-test");
});
