// Loaded by Pi's extension loader in the offline provider smoke test.
import fs from "node:fs";
import extension from "../../extensions/index.ts";

export default async function () {
  let provider;
  extension({
    registerProvider: (_name, cfg) => { provider = cfg; },
    on: () => {}, registerTool: () => {}, registerCommand: () => {},
  });
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (_url, options) => {
    seen.push(new Headers(options?.headers).get("authorization"));
    return new Response(JSON.stringify({ error: { message: "mock failure" } }), {
      status: 401, headers: { "content-type": "application/json" },
    });
  };
  try {
    const run = async (id) => {
      const model = { ...provider.models.find((m) => m.id === id), baseUrl: provider.baseUrl, api: provider.api, provider: "snowflake" };
      for await (const _event of provider.streamSimple(model, { messages: [] }, {})) {}
    };
    await run("openai-gpt-test");
    fs.writeFileSync(process.env.TEST_TOKEN_FILE, "rotated-test-token");
    await run("openai-gpt-test");
    await run("claude-test");
    fs.writeFileSync(process.env.TEST_OUTPUT_FILE, JSON.stringify({ apiKey: provider.apiKey, seen }));
  } finally {
    globalThis.fetch = originalFetch;
  }
}
