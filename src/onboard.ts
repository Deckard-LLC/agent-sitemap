// First run in a terminal: three short questions instead of flags. Each has an answer found in the
// repository already, so Enter goes through: the site's address, the pages, and who writes hints.
import { createInterface } from "node:readline";
import { configOf, CONFIG_FILE, type Config, type Detection, type LlmChoice } from "./detect.ts";

export interface LlmOptions {
  /** Agent CLIs found on PATH. */
  agents: ("claude" | "codex")[];
  /** ANTHROPIC_API_KEY is set. */
  apiKey: boolean;
}

const tty = process.stdout.isTTY;
const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[22m` : s);
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[22m` : s);

/** Asks, and returns the settings to save; null when the user stops. */
export async function onboard(found: Detection, llm: LlmOptions): Promise<Config | null> {
  const rl = lines();
  try {
    console.log(`\n${bold("agent-sitemap")}: a map of this site for AI agents. Three questions; Enter takes the suggested answer.\n`);

    // 1. Address
    console.log(`${bold("1/3  Site address")}  ${dim("links in the map point under it")}`);
    if (found.site) console.log(`     found ${found.site.url} in ${found.site.from}`);
    else console.log(`     not found in the repository. No address yet? Leave it empty: links inside the map will be relative.`);
    const site = await address(rl, found.site?.url ?? "");

    // 2. Pages
    console.log(`\n${bold("2/3  Pages")}`);
    if (!found.sources.length) {
      console.log(`     no built site (dist, build, out, _site) and no Markdown with a title in front matter.`);
      console.log(`     Build the site, or list the files in ${CONFIG_FILE} under "from", then run again.`);
      return null;
    }
    for (const source of found.sources) console.log(`     ${source.note}`);
    console.log(`     the map goes to ${found.out}${found.staticDir ? `, served with the site from ${found.staticDir}` : ""}`);
    if (found.llmsTxt) console.log(`     ${found.llmsTxt} gets one line pointing to the map`);
    if (!(await yes(rl, "     Build the map from these?"))) {
      console.log(`\nNothing saved. Write ${CONFIG_FILE} by hand (see the README) or run again.`);
      return null;
    }

    // 3. Hints
    console.log(`\n${bold("3/3  Hints from a model")}  ${dim("«read if…» next to every note, «why follow» next to every link")}`);
    const choices: { value: LlmChoice; label: string }[] = [{ value: "none", label: "No model: hints are the first sentence of each note. Free, the same map every time" }];
    if (llm.agents.includes("claude")) choices.push({ value: "claude", label: "Claude Code on this machine, under your subscription" });
    if (llm.agents.includes("codex")) choices.push({ value: "codex", label: "Codex on this machine, under your subscription" });
    if (llm.apiKey) choices.push({ value: "api", label: "Claude API, with ANTHROPIC_API_KEY: paid per page" });
    if (choices.length === 1) console.log(`     no Claude Code, Codex or ANTHROPIC_API_KEY here: the map is built without a model.`);
    const choice = choices.length === 1 ? choices[0] : await pick(rl, choices);
    if (choice.value !== "none") console.log(`     one request per page; answers are cached, so rebuilds pay only for changed pages`);

    return { ...configOf(found, site), llm: choice.value };
  } finally {
    rl.close();
  }
}

async function address(rl: Lines, suggested: string): Promise<string> {
  for (;;) {
    const answer = (await rl.ask(`     Address${suggested ? ` [${suggested}]` : ""}: `)).trim();
    const value = answer || suggested;
    if (!value) return "";
    try {
      const url = new URL(/^https?:\/\//.test(value) ? value : `https://${value}`);
      return `${url.origin}/`;
    } catch {
      console.log(`     «${value}» is not an address, e.g. https://example.com`);
    }
  }
}

async function yes(rl: Lines, question: string): Promise<boolean> {
  const answer = (await rl.ask(`${question} [Y/n]: `)).trim().toLowerCase();
  return !answer || ["y", "yes", "д", "да"].includes(answer);
}

async function pick<T extends { label: string }>(rl: Lines, choices: T[]): Promise<T> {
  choices.forEach((choice, i) => console.log(`     ${i + 1}) ${choice.label}`));
  for (;;) {
    const answer = (await rl.ask(`     Choose [1]: `)).trim();
    if (!answer) return choices[0];
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1];
    console.log(`     a number from 1 to ${choices.length}`);
  }
}

interface Lines {
  ask(prompt: string): Promise<string>;
  close(): void;
}

/**
 * Answers line by line. Unlike readline's question(), a line that arrives before its question is
 * kept, so answers piped in (scripts, tests) are not lost; at the end of input every answer is empty.
 */
function lines(): Lines {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const queue: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  let ended = false;
  rl.on("line", (line) => (waiting.length ? waiting.shift()!(line) : queue.push(line)));
  rl.on("close", () => {
    ended = true;
    for (const resolve of waiting.splice(0)) resolve("");
  });
  return {
    ask(prompt) {
      process.stdout.write(prompt);
      if (queue.length) return Promise.resolve(queue.shift()!);
      if (ended) return Promise.resolve("");
      return new Promise((resolve) => waiting.push(resolve));
    },
    close: () => rl.close(),
  };
}
