import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { annotate, stopOnFatal } from "../src/annotate.ts";
import { buildGraph } from "../src/graph.ts";
import { PRESETS, presetAnnotator } from "../src/openai.ts";
import { parsePage } from "../src/parse.ts";

const cli = new URL("../src/cli.ts", import.meta.url).pathname;

const graph = () =>
  buildGraph([
    parsePage("https://example.com/a/", "# Price\n\nWhat an AI agent costs to build and to run every month.\n\n## Model\n\nCloud models charge for the text they read and write, so volume decides the bill. [Payback](/b/)"),
    parsePage("https://example.com/b/", "# Payback\n\nWhether an AI agent saves money, with a simple monthly calculation.\n\n## Calculation\n\nSaving per month: operations times minutes saved, divided by sixty, times the hourly cost."),
  ]);

interface Seen {
  auth?: string;
  body: Record<string, any>;
}

/** An OpenAI-compatible endpoint on localhost that answers like a provider would. */
async function provider(reply: (body: Record<string, any>) => { status?: number; content?: string }): Promise<{ url: string; seen: Seen[]; close: () => void }> {
  const seen: Seen[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    seen.push({ auth: req.headers.authorization, body });
    const { status = 200, content } = reply(body);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(status === 200 ? JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 20 } }) : JSON.stringify({ error: { message: "Authentication Fails" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, seen, close: () => server.close() };
}

/** The answer a model gives, for the page in the request. */
function answerFor(body: Record<string, any>): string {
  const page = JSON.parse(body.messages[1].content);
  return JSON.stringify({
    nodes: [page.page, ...page.sections].map((n: any) => ({ id: n.id, summary: "About " + n.title, when: "you need " + n.title })),
    edges: page.links.map((l: any) => ({ key: l.key, why: "adds " + l.toTitle, keep: true })),
  });
}

test("DeepSeek: JSON mode with the shape in the prompt, the token as a bearer, a fenced reply parsed", async () => {
  const api = await provider((body) => ({ content: "```json\n" + answerFor(body) + "\n```" }));
  try {
    const g = graph();
    const report = await annotate(g, presetAnnotator({ ...PRESETS.deepseek, baseUrl: api.url }, "sk-test"), { cachePath: join(await mkdtemp(join(tmpdir(), "as-")), "c.json"), model: "deepseek" });
    assert.deepEqual(report.failed, []);
    assert.equal(report.usage.input, 100);
    const { auth, body } = api.seen[0];
    assert.equal(auth, "Bearer sk-test");
    assert.equal(body.model, "deepseek-flash");
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.match(body.messages[0].content, /Answer with one JSON object only/);
    assert.equal(g.nodes.get("a/model")!.when, "you need Model");
  } finally {
    api.close();
  }
});

test("OpenRouter: the schema is enforced and only providers that support it are used", async () => {
  const api = await provider((body) => ({ content: answerFor(body) }));
  try {
    await annotate(graph(), presetAnnotator({ ...PRESETS.openrouter, baseUrl: api.url }, "or-test"), { cachePath: join(await mkdtemp(join(tmpdir(), "as-")), "c.json"), model: "openrouter" });
    const { body } = api.seen[0];
    assert.equal(body.response_format.type, "json_schema");
    assert.equal(body.response_format.json_schema.strict, true);
    assert.deepEqual(body.provider, { require_parameters: true });
    assert.doesNotMatch(body.messages[0].content, /Answer with one JSON object only/);
  } finally {
    api.close();
  }
});

test("a rejected token stops after the first page", async () => {
  const api = await provider(() => ({ status: 401 }));
  try {
    const report = await annotate(graph(), stopOnFatal(presetAnnotator({ ...PRESETS.kimi, baseUrl: api.url }, "bad")), { cachePath: join(await mkdtemp(join(tmpdir(), "as-")), "c.json"), model: "kimi", concurrency: 1 });
    assert.equal(report.failed.length, 2);
    assert.equal(api.seen.length, 1);
  } finally {
    api.close();
  }
});

test("onboarding asks for the token once, keeps it outside the repository and builds with it", async () => {
  const api = await provider((body) => ({ content: answerFor(body) }));
  const cwd = await mkdtemp(join(tmpdir(), "agent-sitemap-token-"));
  const text = (topic: string) => `${topic} for people who run a company: what it costs, how long it takes and what to check first.\n\n## How\n\nThe steps, the numbers and the mistakes that cost the most when ${topic} goes wrong.`;
  for (const [path, content] of Object.entries({
    "public/robots.txt": "Sitemap: https://studio.example/sitemap.xml\n",
    "blog/a/post.md": `---\ntitle: Agent cost\n---\n\n${text("agent cost")}`,
    "blog/b/post.md": `---\ntitle: Payback\n---\n\n${text("payback")}`,
  })) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), content);
  }
  const home = join(cwd, ".config-home");
  const env = { ...process.env, AGENT_SITEMAP_INTERACTIVE: "1", ANTHROPIC_API_KEY: "", DEEPSEEK_API_KEY: "", MOONSHOT_API_KEY: "", OPENROUTER_API_KEY: "", XDG_CONFIG_HOME: home, AGENT_SITEMAP_LLM_BASE_URL: api.url, PATH: "/usr/bin:/bin:" + dirname(process.execPath) };
  const run = (lines: string[]) =>
    new Promise<string>((resolve) => {
      const child = spawn("node", [cli], { cwd, env });
      let out = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (out += c));
      child.on("close", () => resolve(out));
      child.stdin.end(lines.map((l) => `${l}\n`).join(""));
    });
  try {
    // No agents on this PATH: 1) No model 2) DeepSeek 3) Kimi 4) OpenRouter.
    const out = await run(["", "", "2", "sk-deep"]);
    assert.match(out, /2\) DeepSeek API, deepseek-flash · token needed/);
    assert.match(out, /Get a token at https:\/\/platform\.deepseek\.com\/api_keys/);
    assert.match(out, /Annotating 2 pages with DeepSeek API \(deepseek-flash\)/);
    assert.equal(api.seen[0].auth, "Bearer sk-deep");

    const credentials = join(home, "agent-sitemap", "credentials.json");
    assert.deepEqual(JSON.parse(await readFile(credentials, "utf8")), { DEEPSEEK_API_KEY: "sk-deep" });
    assert.equal((await stat(credentials)).mode & 0o777, 0o600);
    const config = await readFile(join(cwd, "agent-sitemap.config.json"), "utf8");
    assert.equal(JSON.parse(config).llm, "deepseek");
    assert.doesNotMatch(config, /sk-deep/);
  } finally {
    api.close();
  }
});

test("--llm --llm-with picks the provider from the command line", async () => {
  const api = await provider((body) => ({ content: answerFor(body) }));
  const cwd = await mkdtemp(join(tmpdir(), "agent-sitemap-flag-"));
  const text = (topic: string) => `${topic} for people who run a company: what it costs, how long it takes and what to check first.\n\n## How\n\nThe steps, the numbers and the mistakes that cost the most when ${topic} goes wrong.`;
  await mkdir(join(cwd, "blog/a"), { recursive: true });
  await mkdir(join(cwd, "blog/b"), { recursive: true });
  await writeFile(join(cwd, "blog/a/post.md"), `---\ntitle: Agent cost\n---\n\n${text("agent cost")}`);
  await writeFile(join(cwd, "blog/b/post.md"), `---\ntitle: Payback\n---\n\n${text("payback")}`);
  const out = await new Promise<string>((resolve) => {
    const child = spawn("node", [cli, "https://studio.example", "--from", "blog/*/post.md=/blog/*/", "--llm", "--llm-with", "kimi"], {
      cwd,
      env: { ...process.env, MOONSHOT_API_KEY: "sk-kimi", AGENT_SITEMAP_LLM_BASE_URL: api.url, XDG_CONFIG_HOME: join(cwd, ".config-home") },
    });
    let text = "";
    child.stdout.on("data", (c) => (text += c));
    child.stderr.on("data", (c) => (text += c));
    child.on("close", () => resolve(text));
  });
  try {
    assert.match(out, /Annotating 2 pages with Kimi API \(Moonshot\) \(kimi-k3\)/);
    assert.equal(api.seen[0].auth, "Bearer sk-kimi");
    assert.equal(api.seen[0].body.model, "kimi-k3");
  } finally {
    api.close();
  }
});
