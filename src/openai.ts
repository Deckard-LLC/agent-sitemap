// The --llm pass through any API that speaks the OpenAI Chat Completions protocol. The providers
// below are presets: address, model and how they return JSON are fixed here; only the token is the
// user's. A token comes from the environment or, once entered, from ~/.config/agent-sitemap.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SCHEMA, SYSTEM, type Annotator, type PageAnnotation } from "./annotate.ts";

export interface Preset {
  id: "deepseek" | "kimi" | "openrouter";
  label: string;
  baseUrl: string;
  model: string;
  /** Environment variable that holds the token. */
  keyEnv: string;
  /** Where to get a token. */
  keyUrl: string;
  /** «schema»: the API enforces the JSON schema; «object»: it guarantees JSON, the shape is checked here. */
  json: "schema" | "object";
  /** Provider-specific fields for the request body. */
  extra?: Record<string, unknown>;
}

export const PRESETS: Record<Preset["id"], Preset> = {
  deepseek: {
    id: "deepseek",
    label: "DeepSeek API",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-flash",
    keyEnv: "DEEPSEEK_API_KEY",
    keyUrl: "https://platform.deepseek.com/api_keys",
    json: "object",
  },
  kimi: {
    id: "kimi",
    label: "Kimi API (Moonshot)",
    baseUrl: "https://api.moonshot.ai/v1",
    model: "kimi-k3",
    keyEnv: "MOONSHOT_API_KEY",
    keyUrl: "https://platform.kimi.ai/console/api-keys",
    json: "object",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter: any model with one token",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "deepseek/deepseek-v4.1-flash",
    keyEnv: "OPENROUTER_API_KEY",
    keyUrl: "https://openrouter.ai/settings/keys",
    json: "schema",
    // Route only to providers of the model that enforce the schema.
    extra: { provider: { require_parameters: true } },
  },
};

export const isPreset = (value: string): value is Preset["id"] => value in PRESETS;

/** Without a schema the model needs the shape in words, and the word «JSON» (DeepSeek requires it). */
const SHAPE = `\n\nAnswer with one JSON object only, no prose, in exactly this shape:\n{"nodes":[{"id":"…","summary":"…","when":"…"}],"edges":[{"key":"…","why":"…","keep":true}]}`;

export function presetAnnotator(preset: Preset, token: string, model = preset.model): Annotator {
  return async (input) => {
    let lastError: Error | null = null;
    // Up to three attempts: a rate limit, a server error or a reply that is not the JSON asked for.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      // A proxy or a self-hosted gateway in front of the provider can take its place.
      const baseUrl = process.env.AGENT_SITEMAP_LLM_BASE_URL?.replace(/\/+$/, "") || preset.baseUrl;
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Title": "agent-sitemap" },
        signal: AbortSignal.timeout(5 * 60_000),
        body: JSON.stringify({
          model,
          max_tokens: 8000,
          messages: [
            { role: "system", content: preset.json === "object" ? SYSTEM + SHAPE : SYSTEM },
            { role: "user", content: JSON.stringify(input) },
          ],
          response_format:
            preset.json === "schema"
              ? { type: "json_schema", json_schema: { name: "page_annotation", strict: true, schema: SCHEMA } }
              : { type: "json_object" },
          ...preset.extra,
        }),
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300).replace(/\s+/g, " ");
        lastError = new Error(`${preset.label} ${response.status}: ${statusMeaning(response.status)} ${detail}`.trim());
        if (response.status === 429 || response.status >= 500) continue;
        throw lastError;
      }
      const body = (await response.json()) as {
        choices?: { message?: { content?: string }; finish_reason?: string }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = body.choices?.[0];
      if (choice?.finish_reason === "length") throw new Error(`answer for page ${input.page.id} was cut off`);
      try {
        return {
          result: shaped(choice?.message?.content ?? ""),
          usage: { input: body.usage?.prompt_tokens ?? 0, output: body.usage?.completion_tokens ?? 0 },
        };
      } catch (error) {
        lastError = error as Error;
      }
    }
    throw lastError ?? new Error("no answer");
  };
}

function statusMeaning(status: number): string {
  if (status === 401 || status === 403) return "invalid API key or no access.";
  if (status === 402) return "insufficient balance on the account.";
  if (status === 404) return "model not found.";
  if (status === 429) return "rate limit.";
  return "";
}

/** The reply as an annotation: JSON, maybe in a code fence, with the arrays the schema asks for. */
function shaped(content: string): PageAnnotation {
  const text = content.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`the reply is not JSON: ${content.slice(0, 120)}`);
  const value = JSON.parse(text.slice(start, end + 1)) as Partial<PageAnnotation>;
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) throw new Error("the reply has no nodes and edges");
  return { nodes: value.nodes, edges: value.edges };
}

// Tokens entered during setup live outside the repository, readable by this user only.
const CREDENTIALS = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agent-sitemap", "credentials.json");

export async function tokenFor(preset: Preset): Promise<string | null> {
  const fromEnv = process.env[preset.keyEnv]?.trim();
  if (fromEnv) return fromEnv;
  const saved = (await readFile(CREDENTIALS, "utf8").then(JSON.parse, () => ({}))) as Record<string, string>;
  return saved[preset.keyEnv]?.trim() || null;
}

export async function saveToken(preset: Preset, token: string): Promise<string> {
  const saved = (await readFile(CREDENTIALS, "utf8").then(JSON.parse, () => ({}))) as Record<string, string>;
  saved[preset.keyEnv] = token.trim();
  await mkdir(dirname(CREDENTIALS), { recursive: true, mode: 0o700 });
  await writeFile(CREDENTIALS, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  await chmod(CREDENTIALS, 0o600);
  return CREDENTIALS;
}
