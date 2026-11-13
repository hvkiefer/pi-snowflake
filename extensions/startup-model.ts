import type { SnowflakeSettings } from "./connections.ts";

// Pi does not expose model-selection provenance to extensions. Protect CLI
// selections/restores, respecting `--` and values consumed by built-in options.
function startupOptions(args: string[]): { override: boolean; thinking?: string } {
  let thinking: string | undefined;
  const valueOptions = new Set([
    "--api-key", "--system-prompt", "--append-system-prompt", "--name", "-n",
    "--session-dir", "--tools", "-t", "--exclude-tools", "-xt",
    "--thinking", "--export", "--extension", "-e", "--skill", "--prompt-template",
    "--theme", "--use-theme", "--mode", "--tui-mode",
  ]);
  const overrides = new Set([
    "--model", "--provider", "--models", "--continue", "-c", "--resume", "-r",
    "--session", "--session-id", "--fork",
  ]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (overrides.has(arg)) return { override: true };
    if (arg === "--thinking" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(args[i + 1])) {
      thinking = args[i + 1];
    }
    if (valueOptions.has(arg)) i++;
  }
  return { override: false, thinking };
}

/** Apply project model defaults without changing saved preferences. */
export async function applyStartupModel(pi, event, ctx, settings: SnowflakeSettings, args = process.argv.slice(2)) {
  if (event.reason !== "startup" && event.reason !== "new") return;
  if (!settings.projectModel || !ctx.isProjectTrusted()) return;
  // Match Pi's restoration rule: an existing conversation retains its model.
  if (ctx.sessionManager.getBranch().some((entry) => entry.type === "message" || entry.type === "compaction")) return;
  const options = event.reason === "startup" ? startupOptions(args) : { override: false };
  if (options.override) return;

  const { provider, model: id } = settings.projectModel;
  const warn = (message: string) => {
    const text = `Snowflake: ${message} (${settings.projectModel.source})`;
    if (ctx.hasUI) ctx.ui.notify(text, "warning");
    else console.error(text);
  };
  if (!provider || !id) {
    warn("defaultProvider and defaultModel must resolve to non-empty strings");
    return;
  }
  const model = ctx.modelRegistry.find(provider, id);
  if (!model) {
    warn(`Default model '${provider}/${id}' is not registered; keeping the current model`);
    return;
  }
  if (ctx.scopedModels?.length && !ctx.scopedModels.some((entry) =>
    entry.model.provider === provider && entry.model.id === id,
  )) {
    warn(`Default model '${provider}/${id}' is outside the active model scope; keeping the current model`);
    return;
  }
  if (ctx.model?.provider === provider && ctx.model?.id === id) return;
  try {
    if (!await pi.setModel(model)) {
      warn(`Authentication is not configured for '${provider}/${id}'; keeping the current model`);
    } else if (options.thinking) {
      // setModel applies the target's saved thinking default; CLI takes priority.
      pi.setThinkingLevel(options.thinking);
    }
  } catch (error) {
    warn(`Could not select '${provider}/${id}': ${error instanceof Error ? error.message : String(error)}`);
  }
}
