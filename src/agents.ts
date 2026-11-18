// The --llm pass through a coding agent already installed and signed in on this machine, instead
// of an API key: Claude Code (`claude -p`) or Codex (`codex exec`). Same prompt and JSON schema as
// the API; the agent runs with no tools, so it only reads the page it is given and answers.
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { SCHEMA, SYSTEM, type Annotator, type PageAnnotation } from "./annotate.ts";

export type Agent = "claude" | "codex";

const TIMEOUT_MS = 10 * 60_000;

/** Which agent CLIs are on PATH, in order of preference. */
export async function installedAgents(env = process.env): Promise<Agent[]> {
  const found: Agent[] = [];
  for (const agent of ["claude", "codex"] as const) if (await onPath(agent, env)) found.push(agent);
  return found;
}

export interface SignIn {
  signedIn: boolean;
  /** What to run to sign in. */
  hint: string;
}

/**
 * Whether the agent CLI is signed in, asked without spending anything: `claude auth status`,
 * `codex login status`. When the CLI cannot say (an older version), it counts as signed in and
 * the first request will tell.
 */
export async function signIn(agent: Agent): Promise<SignIn> {
  const hint = agent === "claude" ? "claude auth login" : "codex login";
  try {
    if (agent === "claude") {
      const status = JSON.parse(await run("claude", ["auth", "status"], "", undefined, 20_000)) as { loggedIn?: boolean };
      return { signedIn: status.loggedIn !== false, hint };
    }
    const out = await run("codex", ["login", "status"], "", undefined, 20_000);
    return { signedIn: !/not logged in/i.test(out), hint };
  } catch (error) {
    return { signedIn: !/not logged in|not signed in/i.test((error as Error).message), hint };
  }
}

/**
 * Runs the agent's own sign-in in this terminal (it opens the browser and waits), then asks again
 * whether it is signed in.
 */
export async function login(agent: Agent): Promise<boolean> {
  const args = agent === "claude" ? ["auth", "login"] : ["login"];
  await new Promise<void>((resolve) => {
    const child = spawn(agent, args, { stdio: "inherit" });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
  return (await signIn(agent)).signedIn;
}

/** Errors that will not go away on the next page: stop asking after the first one. */
const FATAL = /not logged in|please run \/login|not signed in|invalid api key|authentication|unauthorized|usage limit|rate limit reached for/i;

export function agentAnnotator(agent: Agent, model?: string): Annotator {
  const annotate = agent === "claude" ? claudeCode(model) : codex(model);
  let stopped: Error | null = null;
  return async (input) => {
    if (stopped) throw stopped;
    try {
      return await annotate(input);
    } catch (error) {
      if (FATAL.test((error as Error).message)) stopped = error as Error;
      throw error;
    }
  };
}

function claudeCode(model?: string): Annotator {
  return async (input) => {
    const args = [
      "-p",
      "--output-format", "json",
      "--no-session-persistence",
      "--tools", "",
      "--system-prompt", SYSTEM,
      "--json-schema", JSON.stringify(SCHEMA),
      ...(model ? ["--model", model] : []),
    ];
    const stdout = await run("claude", args, JSON.stringify(input));
    let answer: { is_error?: boolean; result?: string; structured_output?: unknown; usage?: { input_tokens?: number; output_tokens?: number } };
    try {
      answer = JSON.parse(stdout);
    } catch {
      throw new Error(`claude answered something that is not JSON: ${stdout.slice(0, 200)}`);
    }
    // «Not logged in · Please run /login», a usage limit and the like come back as an error result.
    if (answer.is_error) throw new Error(`claude: ${answer.result ?? "unknown error"}`);
    const result = (answer.structured_output ?? jsonIn(answer.result ?? "")) as PageAnnotation;
    return {
      result,
      usage: answer.usage ? { input: answer.usage.input_tokens ?? 0, output: answer.usage.output_tokens ?? 0 } : undefined,
    };
  };
}

function codex(model?: string): Annotator {
  return async (input) => {
    const dir = await mkdtemp(join(tmpdir(), "agent-sitemap-codex-"));
    try {
      await writeFile(join(dir, "schema.json"), JSON.stringify(SCHEMA));
      const args = [
        "exec", "-",
        "--output-schema", join(dir, "schema.json"),
        "--output-last-message", join(dir, "answer.json"),
        "--sandbox", "read-only",
        "--skip-git-repo-check",
        "--ephemeral",
        ...(model ? ["--model", model] : []),
      ];
      // Codex has no separate system prompt in exec mode: the instructions lead the input.
      await run("codex", args, `${SYSTEM}\n\nThe page, as JSON:\n${JSON.stringify(input)}`, dir);
      return { result: jsonIn(await readFile(join(dir, "answer.json"), "utf8")) as PageAnnotation };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

function run(command: string, args: string[], stdin: string, cwd?: string, timeout = TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: cwd ?? tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} gave no answer in ${Math.round(timeout / 1000)} seconds`));
    }, timeout);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`could not start ${command}: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || (command === "claude" && stdout.trim().startsWith("{"))) resolve(stdout);
      else reject(new Error(`${command} exited with ${code}: ${(stderr || stdout).trim().split("\n").slice(-3).join(" ")}`));
    });
    child.stdin.end(stdin);
  });
}

/** The JSON object in an answer, also when it comes wrapped in prose or a code fence. */
function jsonIn(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`no JSON in the answer: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1));
}

async function onPath(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      try {
        await access(join(dir, command + ext));
        return true;
      } catch {
        // not here
      }
    }
  }
  return false;
}
