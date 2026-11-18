// First run in a terminal: three short questions instead of flags. Each has an answer found in the
// repository already, so Enter goes through: the site's address, the pages, and who writes hints.
// In a terminal the questions are interactive (arrows to choose, Enter to confirm); with answers
// piped in (scripts, tests) they are read line by line.
import { confirm, input, select } from "@inquirer/prompts";
import { createInterface } from "node:readline";
import { configOf, CONFIG_FILE, type Config, type Detection, type LlmChoice } from "./detect.ts";

export interface LlmOption {
  value: Exclude<LlmChoice, "none">;
  label: string;
  /** Not signed in yet: the command that signs in, and a way to run it right away. */
  signIn?: { hint: string; run: () => Promise<boolean> };
}

interface Choice<T> {
  value: T;
  label: string;
  description?: string;
  unavailable?: string;
}

/** The three kinds of question the onboarding asks. */
interface Asker {
  text(message: string, suggested: string, validate: (value: string) => string | true): Promise<string>;
  yes(message: string): Promise<boolean>;
  choose<T>(message: string, choices: Choice<T>[]): Promise<T>;
  close(): void;
}

const tty = Boolean(process.stdout.isTTY);
const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[22m` : s);
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[22m` : s);

/** Asks, and returns the settings to save; null when the user stops. */
export async function onboard(found: Detection, models: LlmOption[]): Promise<Config | null> {
  const ask = process.stdin.isTTY && tty ? interactive() : lines();
  try {
    console.log(`\n${bold("agent-sitemap")} builds a map of this site for AI agents. Three questions; Enter takes the suggested answer.\n`);

    // 1. Address
    console.log(`${bold("1/3  Site address")}  ${dim("links in the map point under it")}`);
    console.log(
      found.site
        ? `     found ${found.site.url} in ${found.site.from}`
        : `     not found in the repository. No address yet? Leave it empty: links inside the map will be relative.`,
    );
    const site = normalize(await ask.text("Site address", found.site?.url ?? "", (value) => (normalize(value) === null ? `«${value}» is not an address, e.g. https://example.com` : true)));

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
    if (!(await ask.yes("Build the map from these?"))) {
      console.log(`\nNothing saved. Write ${CONFIG_FILE} by hand (see the README) or run again.`);
      return null;
    }

    // 3. Hints
    console.log(`\n${bold("3/3  Hints from a model")}  ${dim("«read if…» next to every note, «why follow» next to every link")}`);
    const choices: Choice<LlmChoice>[] = [
      { value: "none", label: "No model", description: "hints are the first sentence of each note; free, the same map every time" },
      ...models.map((m) => ({
        value: m.value,
        label: m.signIn ? `${m.label} · sign in first` : m.label,
        description: m.signIn
          ? `not signed in yet: choosing it runs ${m.signIn.hint} here, then goes on`
          : "one request per page, cached: rebuilds pay only for changed pages",
      })),
    ];
    let llm: LlmChoice = "none";
    if (choices.length === 1) console.log(`     no Claude Code, Codex or ANTHROPIC_API_KEY here: the map is built without a model.`);
    else llm = await ask.choose("Who writes the hints?", choices);

    const chosen = models.find((m) => m.value === llm);
    if (chosen?.signIn) {
      console.log(`\n     Signing in: ${chosen.signIn.hint}\n`);
      const ok = await chosen.signIn.run();
      console.log(
        ok
          ? `\n     Signed in.`
          : `\n     Still not signed in. The choice is saved; until you run ${chosen.signIn.hint}, the map is built without hints.`,
      );
    }

    return { ...configOf(found, site ?? ""), llm };
  } catch (error) {
    // Ctrl+C in a prompt.
    if ((error as Error).name === "ExitPromptError") {
      console.log(`\nStopped. Nothing saved.`);
      return null;
    }
    throw error;
  } finally {
    ask.close();
  }
}

/** «example.com» → https://example.com/; empty stays empty; anything else is not an address. */
function normalize(value: string): string | null {
  const text = value.trim();
  if (!text) return "";
  try {
    const url = new URL(/^https?:\/\//.test(text) ? text : `https://${text}`);
    return url.hostname.includes(".") || url.hostname === "localhost" ? `${url.origin}/` : null;
  } catch {
    return null;
  }
}

/** Prompts with arrows and a cursor, as in npm create and the NestJS CLI. */
function interactive(): Asker {
  const theme = { prefix: { idle: "    ", done: "    " } };
  return {
    text: (message, suggested, validate) => input({ message, default: suggested || undefined, validate, theme }),
    yes: (message) => confirm({ message, default: true, theme }),
    choose: <T,>(message: string, choices: Choice<T>[]) =>
      select<T>({
        message,
        theme,
        choices: choices.map((c) => ({ value: c.value, name: c.label, description: c.description, disabled: c.unavailable ?? false })),
      }),
    close: () => {},
  };
}

/**
 * Answers line by line, for answers piped in. Unlike readline's question(), a line that arrives
 * before its question is kept; at the end of input every answer is the suggested one.
 */
function lines(): Asker {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const queue: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  let ended = false;
  rl.on("line", (line) => (waiting.length ? waiting.shift()!(line) : queue.push(line)));
  rl.on("close", () => {
    ended = true;
    for (const resolve of waiting.splice(0)) resolve("");
  });
  const next = (prompt: string): Promise<string> => {
    process.stdout.write(prompt);
    if (queue.length) return Promise.resolve(queue.shift()!);
    if (ended) return Promise.resolve("");
    return new Promise((resolve) => waiting.push(resolve));
  };
  return {
    async text(message, suggested, validate) {
      for (;;) {
        const value = (await next(`     ${message}${suggested ? ` [${suggested}]` : ""}: `)).trim() || suggested;
        const verdict = validate(value);
        if (verdict === true) return value;
        console.log(`     ${verdict}`);
      }
    },
    async yes(message) {
      const answer = (await next(`     ${message} [Y/n]: `)).trim().toLowerCase();
      return !answer || ["y", "yes", "д", "да"].includes(answer);
    },
    async choose<T>(message: string, choices: Choice<T>[]) {
      console.log(`     ${message}`);
      choices.forEach((c, i) => console.log(`     ${i + 1}) ${c.label}${c.unavailable ? ` (${c.unavailable})` : c.description ? `: ${c.description}` : ""}`));
      for (;;) {
        const answer = (await next(`     Choose [1]: `)).trim();
        const n = answer ? Number(answer) : 1;
        const choice = Number.isInteger(n) ? choices[n - 1] : undefined;
        if (choice && !choice.unavailable) return choice.value;
        console.log(choice ? `     ${choice.unavailable}` : `     a number from 1 to ${choices.length}`);
      }
    },
    close: () => rl.close(),
  };
}
