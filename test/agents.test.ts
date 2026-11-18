import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { agentAnnotator, installedAgents } from "../src/agents.ts";
import { annotate } from "../src/annotate.ts";
import { buildGraph } from "../src/graph.ts";
import { parsePage } from "../src/parse.ts";

const graph = () =>
  buildGraph([
    parsePage("https://example.com/a/", "# Price\n\nWhat an AI agent costs to build and to run every month.\n\n## Model\n\nCloud models charge for the text they read and write, so volume decides the bill. [Payback](/b/)"),
    parsePage("https://example.com/b/", "# Payback\n\nWhether an AI agent saves money, with a simple monthly calculation.\n\n## Calculation\n\nSaving per month: operations times minutes saved, divided by sixty, times the hourly cost."),
  ]);

/** Answers like the model would, built from the page it was given. */
const ANSWER = `const page = JSON.parse(input.slice(input.indexOf("{")));
const answer = {
  nodes: [page.page, ...page.sections].map((n) => ({ id: n.id, summary: "About " + n.title, when: "you need " + n.title })),
  edges: page.links.map((l) => ({ key: l.key, why: "adds " + l.toTitle, keep: true })),
};`;

/** A fake agent CLI on PATH: a Node script that reads the page from stdin. */
async function fakeAgents(scripts: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-sitemap-bin-"));
  for (const [name, body] of Object.entries(scripts)) {
    const path = join(dir, name);
    await writeFile(path, `#!/usr/bin/env node\nlet input = "";\nprocess.stdin.on("data", (c) => (input += c));\nprocess.stdin.on("end", () => {\n${body}\n});\n`);
    await chmod(path, 0o755);
  }
  return dir;
}

async function withPath<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const before = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${before}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = before;
  }
}

test("annotates through Claude Code with structured output", async () => {
  const bin = await fakeAgents({
    claude: `${ANSWER}
const args = process.argv.slice(2);
if (!args.includes("-p") || !args.includes("--json-schema") || args[args.indexOf("--tools") + 1] !== "") process.exit(2);
console.log(JSON.stringify({ type: "result", is_error: false, result: "", structured_output: answer, usage: { input_tokens: 120, output_tokens: 30 } }));`,
  });
  const g = graph();
  const report = await withPath(bin, () =>
    annotate(g, agentAnnotator("claude"), { cachePath: join(bin, "cache.json"), model: "claude", concurrency: 2 }),
  );
  assert.deepEqual(report.failed, []);
  assert.equal(report.usage.input, 240);
  assert.equal(g.nodes.get("a/model")!.when, "you need Model");
  assert.equal(g.edges.find((e) => e.kind === "links")!.why, "adds Payback");
});

test("annotates through Codex, reading the answer from --output-last-message", async () => {
  const bin = await fakeAgents({
    codex: `${ANSWER}
const args = process.argv.slice(2);
if (args[0] !== "exec" || args[1] !== "-" || !args.includes("--output-schema")) process.exit(2);
require("node:fs").writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify(answer));`,
  });
  const g = graph();
  const report = await withPath(bin, () => annotate(g, agentAnnotator("codex"), { cachePath: join(bin, "cache.json"), model: "codex" }));
  assert.deepEqual(report.failed, []);
  assert.equal(g.nodes.get("b/calculation")!.summary, "About Calculation");
});

test("a signed-out agent fails the pages, not the build", async () => {
  const bin = await fakeAgents({
    claude: `console.log(JSON.stringify({ type: "result", is_error: true, result: "Not logged in · Please run /login" }));`,
  });
  const g = graph();
  const messages: string[] = [];
  const report = await withPath(bin, () =>
    annotate(g, agentAnnotator("claude"), { cachePath: join(bin, "cache.json"), model: "claude", log: (m) => messages.push(m) }),
  );
  assert.equal(report.failed.length, 2);
  assert.match(messages.join("\n"), /Not logged in/);
});

test("finds agent CLIs on PATH", async () => {
  const bin = await fakeAgents({ codex: "" });
  assert.deepEqual(await installedAgents({ PATH: bin }), ["codex"]);
});
