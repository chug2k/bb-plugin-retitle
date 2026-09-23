// The prompt for the helper model, and the cleanup of its answer. These
// functions are pure, so the tests can run them without a bb server.

/** Characters of conversation sent to the model. */
export const MAX_TRANSCRIPT_CHARS = 12_000;
export const MAX_TITLE_CHARS = 80;

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

/** Example titles, shown to the model so it sees the exact answer format. */
const EXAMPLES = [
  ["🐛", "Fix flaky login test"],
  ["🧭", "Add back and forward thread navigation"],
  ["📦", "Publish the retitle plugin"],
] as const;

export function buildPrompt(args: {
  transcript: string;
  currentTitle: string | null;
  emoji: boolean;
}): string {
  // The conversation comes first and the task last. With the task first, a
  // small model sometimes answered the instructions ("I understand…") and
  // ignored the conversation. The examples show the exact answer format. The
  // title rules copy bb's own title prompt, so these titles look like bb's.
  const examples = EXAMPLES.map(([emoji, text]) => (args.emoji ? `${emoji} ${text}` : text));
  return [
    "Here is a conversation between a user and a coding agent.",
    "",
    "<conversation>",
    args.transcript,
    "</conversation>",
    "",
    "Your task: write a title for the conversation above.",
    "",
    "Rules:",
    "- Sentence case, in the same language as the conversation.",
    "- Under about 40 characters; for scripts that do not separate words with spaces, that is roughly 20 characters.",
    args.emoji
      ? "- Start with one emoji that fits the topic, then a space. Use no other emoji."
      : "- No emoji.",
    "- No quotes and no trailing period.",
    "- Title the problem, not the tools. If the user names tools to solve a problem, the problem is the title.",
    "- Title what the conversation is about now, not only how it started.",
    ...(args.currentTitle
      ? [`- The current title is "${args.currentTitle}". Replace it if it no longer fits.`]
      : []),
    "",
    "Example titles:",
    ...examples,
    "",
    "Do not use tools. Do not answer the conversation, and do not ask a question.",
    "Your whole reply is the title, on one line, with nothing before or after it.",
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

