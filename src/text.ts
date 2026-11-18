// Small text helpers: slugs, plain text, summaries, token estimates and a crude stemmer for
// similarity. No language models: everything here is deterministic.

const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

export function slugify(text: string, max = 48): string {
  const latin = [...text.toLowerCase()].map((ch) => TRANSLIT[ch] ?? ch).join("");
  const slug = latin.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug.length <= max) return slug || "section";
  return slug.slice(0, max).replace(/-[^-]*$/, "") || slug.slice(0, max);
}

/** Markdown → readable plain text: no images, link targets, emphasis or list markers. */
export function plain(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[*+-]|\d+\.)\s+/gm, "")
    .replace(/[*_`>|]/g, "")
    .replace(/\\([[\]().\-!#])/g, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

/** First sentence of the first real paragraph (not a table), cut at a word boundary. */
export function summarize(markdown: string, max = 200): string {
  markdown = markdown.replace(/^[ \t]*\|.*$/gm, ""); // table rows read as noise once flattened
  const paragraphs = plain(markdown)
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length >= 60 && !isShout(p));
  const text = paragraphs[0] ?? plain(markdown).replace(/\s+/g, " ").trim();
  const sentence = text.match(/^.{30,}?[.!?…](?=\s|$)/)?.[0] ?? text;
  if (sentence.length <= max) return sentence;
  return `${sentence.slice(0, max).replace(/\s+\S*$/, "")}…`;
}

/** Rough token count for planning, not billing: Cyrillic packs fewer characters per token. */
export function estimateTokens(text: string): number {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  const cyrillic = text.match(/\p{Script=Cyrillic}/gu)?.length ?? 0;
  const perToken = letters && cyrillic / letters > 0.5 ? 3.2 : 4;
  return Math.max(10, Math.round(text.length / perToken / 10) * 10);
}

/** A short line in capitals: an eyebrow label such as «ЭКСПЕРТИЗА», not content. */
export function isShout(line: string): boolean {
  const letters = line.replace(/[^\p{L}]/gu, "");
  return letters.length >= 3 && line.length <= 60 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
}

export function isCyrillic(text: string): boolean {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  const cyrillic = text.match(/\p{Script=Cyrillic}/gu)?.length ?? 0;
  return letters > 0 && cyrillic / letters > 0.5;
}

const STOP = new Set(
  (
    "и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня " +
    "еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там " +
    "потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе " +
    "под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были " +
    "куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них " +
    "какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда " +
    "конечно всю между это эта эти также который которые которая которых нужно очень " +
    "the a an and or of to in on for with is are was be by as at it this that from not you we your our can will"
  ).split(" "),
);

const RU_ENDINGS = [
  "иями", "ями", "ами", "его", "ого", "ему", "ому", "ыми", "ими", "ией", "ость", "ости",
  "ия", "ие", "ий", "ей", "ой", "ый", "ая", "яя", "ое", "ее", "ом", "ем", "ам", "ям", "ах", "ях",
  "ую", "юю", "ов", "ев", "ть", "ы", "и", "а", "я", "о", "е", "у", "ю", "ь",
];

function stem(word: string): string {
  let w = word.replace(/ё/g, "е");
  if (/^\p{Script=Cyrillic}+$/u.test(w)) {
    const ending = RU_ENDINGS.find((e) => w.endsWith(e) && w.length - e.length >= 4);
    if (ending) w = w.slice(0, -ending.length);
  } else {
    w = w.replace(/(?:ing|ed|es|s)$/, (m) => (w.length - m.length >= 4 ? "" : m));
  }
  return w.slice(0, 8);
}

/** Content words for similarity: lowercased, stemmed, stop words and short words dropped. */
export function terms(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\d]+(?:-[\p{L}\d]+)*/gu) ?? [])
    .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w))
    .map(stem);
}
