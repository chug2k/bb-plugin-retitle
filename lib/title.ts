// The prompt for the helper model, and the cleanup of its answer. These
// functions are pure, so the tests can run them without a bb server.

/** Characters of conversation sent to the model. */
export const MAX_TRANSCRIPT_CHARS = 12_000;
export const MAX_TITLE_CHARS = 80;
/** A usable title is at most this long. The prompt asks for about 40. */
export const MAX_USABLE_TITLE_CHARS = 60;

export interface OutlineItem {
  role: "user" | "assistant";
  preview: string;
}

/**
 * bb cuts each outline message to 200 characters. Keep the first message,
 * because it gives the task, and then add messages from the newest back.
 */
export function buildTranscript(
  items: readonly OutlineItem[],
  maxChars: number = MAX_TRANSCRIPT_CHARS,
): string {
  const lines = items
    .map((item) => {
      const text = item.preview.replace(/\s+/g, " ").trim();
      return text === "" ? null : `${item.role === "user" ? "User" : "Assistant"}: ${text}`;
    })
    .filter((line): line is string => line !== null);

  const first = lines[0] ?? "";
  const kept: string[] = [];
  let used = first.length;
  for (let i = lines.length - 1; i >= 1; i--) {
    const line = lines[i]!;
    if (used + line.length > maxChars) break;
    kept.unshift(line);
    used += line.length;
  }
  const skipped = lines.length - 1 - kept.length;
  return [first, ...(skipped > 0 ? [`[… ${skipped} earlier messages omitted …]`] : []), ...kept]
    .filter((line) => line !== "")
    .join("\n\n");
}

export function buildPrompt(args: {
  transcript: string;
  currentTitle: string | null;
  emoji: boolean;
}): string {
  // The conversation comes first and the task last. With the task first, a
  // small model sometimes answers the instructions ("I understand…") and
  // ignores the conversation. The rules copy bb's own title prompt, so these
  // titles look like bb's.
  return [
    "Below is a conversation between a user and a coding agent.",
    "",
    "<conversation>",
    args.transcript,
    "</conversation>",
    "",
    "Write a concise title for the conversation above.",
    "Do not use any tools. Do not read or change files. Do not answer the conversation or ask a question. Reply with the title only.",
    "",
    "The title is short, clear, sentence case, and in the same language as the conversation.",
    "Keep it under about 40 characters; for scripts that do not separate words with spaces, that is roughly 20 characters.",
    args.emoji
      ? "Start the title with one emoji that fits the topic, then a space. Use no other emoji."
      : "Use no emoji.",
    "No quotes and no trailing period.",
    "",
    "Consider the user's intent when titling to make it useful. For instance, if they detail specific tools to use to solve a problem, it is the problem that should be the title, not the tools that should be used.",
    "Title what the conversation is about now, not only how it started.",
    ...(args.currentTitle
      ? [`The current title is "${args.currentTitle}". Replace it if it no longer fits.`]
      : []),
  ].join("\n");
}

/** Take the first line that is not empty, and remove quotes and markdown. */
export function cleanTitle(raw: string): string | null {
  const line = raw
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part !== "");
  if (line === undefined) return null;
  const title = line
    .replace(/^(title|new title)\s*:\s*/i, "")
    .replace(/^[#>*_`\s-]+|[*_`\s]+$/g, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\.$/, "")
    .trim();
  if (title === "") return null;
  return title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 1)}…` : title;
}

/**
 * Words that start a reply to the prompt, not a title. A small model
 * sometimes answers "I understand…" or asks which task to title.
 */
const CHATTER = /^(i\b|i'm\b|i am\b|sure\b|okay\b|ok\b|here is\b|here's\b|understood\b|certainly\b|what\b.*\?$|please\b)/i;

/**
 * True when a cleaned answer can be a title: short, one statement, and not a
 * reply to the prompt. The check ignores a leading emoji.
 */
export function isUsableTitle(title: string): boolean {
  if (title.length > MAX_USABLE_TITLE_CHARS) return false;
  if (title.endsWith("?")) return false;
  const words = title.replace(/^[^\p{L}\p{N}]+/u, "");
  return words !== "" && !CHATTER.test(words);
}
