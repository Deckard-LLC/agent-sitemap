// Measures what the map changes for an agent: the same questions answered twice, once starting at
// the site's home page and once at the map. A local stand serves the live site and the map under
// one address and logs every page the agent fetches; the agent is Claude Code with curl as its
// only tool; Claude Code also grades each answer against the reference.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";

export interface Question {
  id: string;
  question: string;
  /** What a correct answer says. */
  answer: string;
  /** Path of the page that holds the answer, for «found the page». */
  page?: string;
}

export interface EvalFile {
  questions: Question[];
  /** How many times each question is asked in each condition. */
  runs?: number;
  /** Claude Code model for the agent and the judge. */
  model?: string;
}

export type Condition = "no map" | "map";

export interface Run {
  question: string;
  condition: Condition;
  run: number;
  answer: string;
  verdict: "correct" | "partial" | "wrong" | "error";
  why: string;
  foundPage: boolean | null;
  fetches: number;
  fetched: string[];
  chars: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  seconds: number;
  costUsd: number;
}

export const TEMPLATE: EvalFile = {
  runs: 1,
  model: "sonnet",
  questions: [
    {
      id: "example",
      question: "A question a visitor might ask, whose answer is somewhere on the site",
      answer: "What a correct answer says, in a sentence",
      page: "/path/of/the/page/with/the/answer/",
    },
  ],
};

export async function loadEval(path: string): Promise<EvalFile> {
  const file = JSON.parse(readFileSync(path, "utf8")) as EvalFile;
  if (!Array.isArray(file.questions) || !file.questions.length) throw new Error(`${path} has no questions`);
  for (const q of file.questions) {
    if (!q.id || !q.question || !q.answer) throw new Error(`${path}: every question needs id, question and answer`);
  }
  return file;
}

/** The live site and the map under one local address; absolute links to the site are rewritten. */
export async function startStand(site: string, mapDir: string): Promise<{ origin: string; log: { path: string; chars: number }[]; close: () => Promise<void> }> {
  const live = new URL(site).origin;
  const log: { path: string; chars: number }[] = [];
  let origin = "";
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", origin);
    let status = 200;
    let type = "text/plain; charset=utf-8";
    let body = "";
    try {
      if (url.pathname.startsWith("/ai/")) {
        const path = normalize(join(mapDir, decodeURIComponent(url.pathname.slice(4))));
        if (path.startsWith(normalize(mapDir)) && existsSync(path) && statSync(path).isFile()) {
          body = readFileSync(path, "utf8");
          type = path.endsWith(".json") ? "application/json" : "text/markdown; charset=utf-8";
        } else status = 404;
      } else {
        const upstream = await fetch(live + url.pathname + url.search, {
          headers: { Accept: String(req.headers.accept ?? "*/*"), "User-Agent": "agent-sitemap-eval" },
          redirect: "follow",
          signal: AbortSignal.timeout(30_000),
        });
        status = upstream.status;
        type = upstream.headers.get("content-type") ?? type;
        body = await upstream.text();
      }
    } catch (error) {
      status = 502;
      body = String(error);
    }
    body = body.replaceAll(live, origin);
    log.push({ path: url.pathname, chars: body.length });
    res.writeHead(status, { "Content-Type": type });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, log, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

const agentPrompt = (origin: string, start: string, question: string) => `Answer a question about the website at ${origin}/ (a local copy of a company's site).
Use only this site. Fetch pages with curl, for example: curl -s -H 'Accept: text/markdown' <url>
The site returns Markdown when asked with that header. Do not use any other source or your own knowledge.
Start at ${start}
When you have found the answer, reply in the language of the question in one to three sentences and give the URL of the page where you found it. If the site does not have the answer, say so.

Question: ${question}`;

const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "why"],
  properties: { verdict: { type: "string", enum: ["correct", "partial", "wrong"] }, why: { type: "string" } },
};

const judgePrompt = (q: Question, answer: string) => `Grade an answer against a reference.
correct: it states the key facts of the reference and contradicts none of them.
partial: some key facts are missing, nothing contradicts the reference.
wrong: it contradicts the reference, misses its point, or says the site has no answer.
Wording and extra true details do not matter.

Question: ${q.question}
Reference: ${q.answer}
Answer: ${answer}`;

interface ClaudeResult {
  is_error?: boolean;
  result?: string;
  structured_output?: { verdict?: string; why?: string };
  num_turns?: number;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
}

function claude(args: string[], input: string): Promise<ClaudeResult> {
  return new Promise((resolve) => {
    const child = spawn("claude", ["-p", "--output-format", "json", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", "local", ...args], {
      cwd: mkdtempSync(join(tmpdir(), "agent-sitemap-eval-")),
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    const timer = setTimeout(() => child.kill(), 10 * 60_000);
    child.on("error", (error) => resolve({ is_error: true, result: `could not start claude: ${error.message}` }));
    child.on("close", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out.slice(out.indexOf("{"))) as ClaudeResult);
      } catch {
        resolve({ is_error: true, result: out.trim().slice(0, 300) || "no answer" });
      }
    });
    child.stdin.end(input);
  });
}

/** Asks every question in both conditions, `runs` times; reports each run as it ends. */
export async function runEval(
  file: EvalFile,
  stand: { origin: string; log: { path: string; chars: number }[] },
  onRun: (run: Run) => void,
): Promise<Run[]> {
  const model = file.model ?? "sonnet";
  const runs: Run[] = [];
  const starts: Record<Condition, string> = { "no map": `${stand.origin}/`, map: `${stand.origin}/ai/index.md` };
  for (let n = 1; n <= (file.runs ?? 1); n++) {
    for (const q of file.questions) {
      for (const condition of ["no map", "map"] as const) {
        const before = stand.log.length;
        const started = Date.now();
        const agent = await claude(["--model", model, "--tools", "Bash", "--allowedTools", "Bash(curl:*)"], agentPrompt(stand.origin, starts[condition], q.question));
        const fetched = stand.log.slice(before);
        const answer = agent.result ?? "";
        let verdict: Run["verdict"] = "error";
        let why = answer;
        // A failed agent (limit reached, signed out) is not graded: its run says why.
        if (!agent.is_error) {
          const judged = await claude(["--model", model, "--tools", "", "--json-schema", JSON.stringify(JUDGE_SCHEMA)], judgePrompt(q, answer));
          const v = judged.structured_output?.verdict;
          verdict = v === "correct" || v === "partial" || v === "wrong" ? v : "error";
          why = judged.structured_output?.why ?? judged.result ?? "";
        }
        const u = agent.usage ?? {};
        const run: Run = {
          question: q.id,
          condition,
          run: n,
          answer,
          verdict,
          why,
          foundPage: q.page ? fetched.some((f) => samePage(f.path, q.page!)) : null,
          fetches: fetched.length,
          fetched: fetched.map((f) => f.path),
          chars: fetched.reduce((sum, f) => sum + f.chars, 0),
          inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          outputTokens: u.output_tokens ?? 0,
          turns: agent.num_turns ?? 0,
          seconds: Math.round((Date.now() - started) / 1000),
          costUsd: agent.total_cost_usd ?? 0,
        };
        runs.push(run);
        onRun(run);
        // The same reason will stop every later run: a limit or a sign-out.
        if (agent.is_error && /limit|not logged in|login/i.test(answer)) return runs;
      }
    }
  }
  return runs;
}

/** /blog/x/ fetched directly, or a note of it in the map: /ai/blog/x.md, /ai/blog/x/<section>.md. */
function samePage(fetched: string, page: string): boolean {
  const key = page.replace(/^\/+|\/+$/g, "");
  const path = fetched.replace(/\/+$/, "");
  if (path === `/${key}` || (key === "" && path === "")) return true;
  const note = key === "" ? "home" : key;
  return path === `/ai/${note}.md` || path.startsWith(`/ai/${note}/`);
}

/** The comparison as a table, plus one line with the change the map makes. */
export function report(runs: Run[]): string {
  const ok = runs.filter((r) => r.verdict !== "error");
  const lines: string[] = [];
  const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
  const num = (n: number) => Math.round(n).toLocaleString("en-US");
  const mark = { correct: "✓", partial: "~", wrong: "✗", error: "!" } as const;
  lines.push(`${pad("question", 18)} ${pad("start", 7)} ${pad("answer", 7)} ${pad("fetches", 8)} ${pad("chars read", 11)} ${pad("tokens in", 10)} ${pad("turns", 6)} ${pad("time", 6)} cost`);
  for (const r of runs) {
    lines.push(
      `${pad(r.question, 18)} ${pad(r.condition, 7)} ${pad(mark[r.verdict], 7)} ${pad(String(r.fetches), 8)} ${pad(num(r.chars), 11)} ${pad(num(r.inputTokens), 10)} ${pad(String(r.turns), 6)} ${pad(`${r.seconds}s`, 6)} $${r.costUsd.toFixed(3)}`,
    );
  }
  const mean = (c: Condition, f: (r: Run) => number) => {
    const xs = ok.filter((r) => r.condition === c);
    return xs.length ? xs.reduce((s, r) => s + f(r), 0) / xs.length : NaN;
  };
  const correct = (c: Condition) => `${ok.filter((r) => r.condition === c && r.verdict === "correct").length}/${ok.filter((r) => r.condition === c).length}`;
  const change = (f: (r: Run) => number) => {
    const a = mean("no map", f);
    const b = mean("map", f);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return "n/a";
    const pct = Math.round(((b - a) / a) * 100);
    return `${pct > 0 ? "+" : ""}${pct}%`;
  };
  lines.push("");
  if (!ok.some((r) => r.condition === "no map") || !ok.some((r) => r.condition === "map")) {
    lines.push("Not enough finished runs in both conditions to compare.");
  } else {
    lines.push(`Correct answers: ${correct("no map")} without the map, ${correct("map")} with it.`);
    lines.push(
      `With the map, on average: tokens ${change((r) => r.inputTokens)}, pages fetched ${change((r) => r.fetches)}, ` +
        `text read ${change((r) => r.chars)}, time ${change((r) => r.seconds)}, cost ${change((r) => r.costUsd)}.`,
    );
    lines.push(
      `«Text read» is the site the agent read. «Tokens in» also counts the agent's own instructions, read again on every turn,` +
        `\nso it follows the number of turns more than the site; with one run per question, expect it to vary between runs.`,
    );
  }
  const failed = runs.filter((r) => r.verdict === "error");
  if (failed.length) lines.push(`${failed.length} ${failed.length === 1 ? "run" : "runs"} did not finish: ${failed[0].answer.slice(0, 160)}`);
  return lines.join("\n");
}

export async function saveRuns(path: string, runs: Run[]): Promise<void> {
  await writeFile(path, `${JSON.stringify({ at: new Date().toISOString(), runs }, null, 2)}\n`);
}
