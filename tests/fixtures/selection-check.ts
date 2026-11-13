// Loaded by Pi's extension loader in the offline connection-selection test.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import extension from "../../extensions/index.ts";

export default async function () {
  const registrations = [];
  const messages = [];
  let command;
  extension({
    registerProvider: (_name, cfg) => registrations.push(cfg.baseUrl),
    unregisterProvider: () => registrations.push("unregistered"),
    on: () => {}, registerTool: () => {},
    registerCommand: (name, options) => { if (name === "snowflake-connection") command = options.handler; },
  });
  const ctx = { cwd: os.homedir(), isProjectTrusted: () => true, mode: "print", ui: { notify: (message, level) => messages.push({ message, level }) } };
  await command("--llm other", ctx);
  const first = [...registrations];
  const file = path.join(os.homedir(), ".pi", "agent", "settings.json");
  fs.writeFileSync(file, "invalid JSON");
  await command("--llm other", ctx);
  fs.writeFileSync(process.env.TEST_OUTPUT_FILE, JSON.stringify({ first, registrations, messages }));
}
