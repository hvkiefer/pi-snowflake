import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadSettings } from "../extensions/connections.ts";
import { applyStartupModel } from "../extensions/startup-model.ts";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-snowflake-model-"));
  t.mock.method(os, "homedir", () => home);
  const previous = process.env.SNOWFLAKE_PROJECT_SETTINGS_FILE;
  process.env.SNOWFLAKE_PROJECT_SETTINGS_FILE = path.join(home, "repo", ".pi-snowflake-settings.json");
  t.after(() => {
    if (previous === undefined) delete process.env.SNOWFLAKE_PROJECT_SETTINGS_FILE;
    else process.env.SNOWFLAKE_PROJECT_SETTINGS_FILE = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const repo = path.join(home, "repo");
  const cwd = path.join(repo, "nested");
  fs.mkdirSync(cwd, { recursive: true });
  const save = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
    if (path.basename(file) === ".pi-snowflake-settings.json") process.env.SNOWFLAKE_PROJECT_SETTINGS_FILE = file;
  };
  return { home, repo, cwd, save };
}

function runtime() {
  const selected = [];
  const warnings = [];
  const target = { provider: "snowflake", id: "claude-opus-4-6" };
  const ctx = {
    hasUI: true,
    isProjectTrusted: () => true,
    ui: { notify: (message, level) => warnings.push({ message, level }) },
    model: { provider: "other", id: "previous" },
    sessionManager: { getBranch: () => [{ type: "model_change" }] },
    modelRegistry: { find: (provider, id) => provider === target.provider && id === target.id ? target : undefined },
  };
  const pi = { setModel: async (model) => { selected.push(model); return true; } };
  const settings = { projectModel: { provider: target.provider, model: target.id, source: "/project/.pi-snowflake-settings.json" } };
  return { ctx, pi, settings, selected, warnings, target };
}

test("nearest file loads root defaults and existing Snowflake settings", (t) => {
  const { home, repo, cwd, save } = fixture(t);
  save(path.join(home, ".pi", "agent", "settings.json"), { defaultProvider: "global", defaultModel: "global-model" });
  save(path.join(cwd, ".pi", "settings.json"), { defaultProvider: "project", defaultModel: "project-model" });
  const file = path.join(repo, ".pi-snowflake-settings.json");
  save(file, { defaultProvider: "snowflake", defaultModel: "claude-opus-4-6", snowflake: { sql: { previewRows: 7 } } });
  const loaded = loadSettings(cwd);
  assert.deepEqual(loaded.projectModel, { provider: "snowflake", model: "claude-opus-4-6", source: file });
  assert.equal(loaded.sql.previewRows, 7);
  assert.equal(loaded.configFiles[0], file);
  save(path.join(cwd, ".pi-snowflake-settings.json"), { defaultProvider: "nearest", defaultModel: "nearest-model" });
  assert.equal(loadSettings(cwd).projectModel?.provider, "nearest");
});

test("omitted defaults inherit ordinary settings without activating when the custom file has none", (t) => {
  const { home, repo, cwd, save } = fixture(t);
  save(path.join(home, ".pi", "agent", "settings.json"), { defaultProvider: "global", defaultModel: "global-model" });
  save(path.join(cwd, ".pi", "settings.json"), { defaultModel: "project-model" });
  assert.equal(loadSettings(cwd).projectModel, undefined);
  const file = path.join(repo, ".pi-snowflake-settings.json");
  save(file, { snowflake: {} });
  assert.equal(loadSettings(cwd).projectModel, undefined);
  save(file, { defaultProvider: "snowflake" });
  assert.deepEqual(loadSettings(cwd).projectModel, { provider: "snowflake", model: "project-model", source: file });
  save(file, { defaultProvider: 123, defaultModel: "  " });
  assert.deepEqual(loadSettings(cwd).projectModel, { provider: undefined, model: undefined, source: file });
});

test("fresh startup and /new select the registered default without writing preferences", async () => {
  for (const reason of ["startup", "new"]) {
    const r = runtime();
    await applyStartupModel(r.pi, { reason }, r.ctx, r.settings, []);
    assert.deepEqual(r.selected, [r.target]);
    assert.deepEqual(r.warnings, []);
  }
});

test("restored conversations, reload, resume, fork, CLI overrides and absent defaults retain their model", async () => {
  for (const reason of ["reload", "resume", "fork"]) {
    const r = runtime();
    await applyStartupModel(r.pi, { reason }, r.ctx, r.settings, []);
    assert.deepEqual(r.selected, []);
  }
  for (const args of [["--model", "explicit"], ["--provider", "explicit"], ["--models", "other/model"], ["--continue"], ["-c"], ["--resume"], ["-r"], ["--session", "saved"], ["--session-id", "saved"], ["--fork", "saved"]]) {
    const r = runtime();
    await applyStartupModel(r.pi, { reason: "startup" }, r.ctx, r.settings, args);
    assert.deepEqual(r.selected, []);
  }
  const r = runtime();
  r.ctx.sessionManager.getBranch = () => [{ type: "message" }];
  await applyStartupModel(r.pi, { reason: "startup" }, r.ctx, r.settings, []);
  assert.deepEqual(r.selected, []);
  await applyStartupModel(r.pi, { reason: "startup" }, r.ctx, {}, []);
  assert.deepEqual(r.selected, []);
});

test("CLI prompt text and option values are not mistaken for overrides", async () => {
  for (const args of [["--", "--model", "prompt"], ["--append-system-prompt", "--model"], ["--system-prompt", "--provider"]]) {
    const r = runtime();
    await applyStartupModel(r.pi, { reason: "startup" }, r.ctx, r.settings, args);
    assert.deepEqual(r.selected, [r.target]);
  }
});

test("malformed and non-object JSON leaves model defaults unset", (t) => {
  const { repo, cwd } = fixture(t);
  const file = path.join(repo, ".pi-snowflake-settings.json");
  for (const text of ["null", "[]", "42", "invalid"]) {
    fs.writeFileSync(file, text);
    assert.equal(loadSettings(cwd).projectModel, undefined);
  }
});

test("untrusted projects cannot apply model defaults", async () => {
  const r = runtime();
  r.ctx.isProjectTrusted = () => false;
  await applyStartupModel(r.pi, { reason: "startup" }, r.ctx, r.settings, []);
  assert.deepEqual(r.selected, []);
});

test("defaults outside the active model scope are not applied", async () => {
  const r = runtime();
  r.ctx.scopedModels = [{ model: r.ctx.model }];
  await applyStartupModel(r.pi, { reason: "startup" }, r.ctx, r.settings, []);
  assert.deepEqual(r.selected, []);
  assert.match(r.warnings[0].message, /outside the active model scope/);
  r.ctx.scopedModels = [{ model: r.target }];
  await applyStartupModel(r.pi, { reason: "new" }, r.ctx, r.settings, []);
  assert.deepEqual(r.selected, [r.target]);
});

test("explicit startup thinking is reapplied only after successful model selection", async () => {
  const r = runtime();
  const thinking = [];
  r.pi.setThinkingLevel = (level) => thinking.push(level);
  await applyStartupModel(r.pi, { reason: "startup" }, r.ctx, r.settings, ["--thinking", "high"]);
  assert.deepEqual(thinking, ["high"]);
  r.pi.setModel = async () => false;
  await applyStartupModel(r.pi, { reason: "startup" }, r.ctx, r.settings, ["--thinking", "low"]);
  assert.deepEqual(thinking, ["high"]);
});

test("unchanged model is not selected again", async () => {
  const r = runtime();
  r.ctx.model = r.target;
  await applyStartupModel(r.pi, { reason: "startup" }, r.ctx, r.settings, []);
  assert.deepEqual(r.selected, []);
});

test("invalid, unknown, unauthenticated and failed model selections warn without throwing", async () => {
  for (const failure of ["invalid", "unknown", "unauthenticated", "throw"]) {
    const r = runtime();
    if (failure === "invalid") r.settings.projectModel.provider = undefined;
    if (failure === "unknown") r.settings.projectModel.model = "unknown";
    if (failure === "unauthenticated") r.pi.setModel = async () => false;
    if (failure === "throw") r.pi.setModel = async () => { throw new Error("failed"); };
    await applyStartupModel(r.pi, { reason: "startup" }, r.ctx, r.settings, []);
    assert.equal(r.warnings.length, 1);
    assert.equal(r.warnings[0].level, "warning");
    assert.ok(r.warnings[0].message.includes(r.settings.projectModel.source));
  }
});

test("headless failures use stderr", async (t) => {
  const r = runtime();
  r.ctx.hasUI = false;
  r.settings.projectModel.model = "unknown";
  const errors = t.mock.method(console, "error", () => {});
  await applyStartupModel(r.pi, { reason: "startup" }, r.ctx, r.settings, []);
  assert.equal(errors.mock.callCount(), 1);
});
