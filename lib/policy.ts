// When the plugin renames a thread automatically, and which model it uses.
// These functions are pure, so the tests can run them without a bb server.

/** Labels shown in the settings, and the mode each one selects. */
export const AUTO_MODES = {
  "After the first reply": "first-reply",
  "Off (only when you press ⌘⌥R)": "off",
} as const;
export type AutoMode = (typeof AUTO_MODES)[keyof typeof AUTO_MODES];
export const DEFAULT_AUTO_MODE_LABEL = "After the first reply";

export function parseAutoMode(label: string): AutoMode {
  return AUTO_MODES[label as keyof typeof AUTO_MODES] ?? "first-reply";
}

/** The last title this plugin wrote on a thread. */
export interface TitleRecord {
  title: string;
  /** Number of outline messages when the plugin wrote the title. */
  messageCount: number;
}

/** The thread facts that the rules use. */
export interface ThreadFacts {
  title: string | null;
  visibility: string;
  parentThreadId: string | null;
  originPluginId: string | null;
  archivedAt: number | null;
  deletedAt: number | null;
}

export type Decision = { rename: true } | { rename: false; reason: string };

/**
 * Decide if a thread that just went idle gets a new title.
 *
 * bb writes a title from the first message, and that title cannot be told
 * apart from a typed one. So the first rename replaces any title. After that,
 * the plugin renames only when `renameEveryMessages` is more than 0, and only
 * while the title is still the one it wrote. A changed title means that the
 * user typed it, so the plugin stops.
 *
 * `messageCount` is the current number of outline messages. The caller can
 * pass null when `needsMessageCount` is false, to save a server call.
 */
export function decideAutoRename(args: {
  thread: ThreadFacts;
  pluginId: string;
  mode: AutoMode;
  renameEveryMessages: number;
  record: TitleRecord | null;
  messageCount: number | null;
}): Decision {
  const { thread } = args;
  if (args.mode === "off") return { rename: false, reason: "automatic renaming is off" };
  if (thread.visibility === "hidden") return { rename: false, reason: "hidden thread" };
  if (thread.originPluginId === args.pluginId) {
    return { rename: false, reason: "helper thread of this plugin" };
  }
  if (thread.parentThreadId !== null) {
    return { rename: false, reason: "started by another thread" };
  }
  if (thread.archivedAt !== null || thread.deletedAt !== null) {
    return { rename: false, reason: "archived or deleted" };
  }

  if (args.record === null) return { rename: true };

  if (args.renameEveryMessages <= 0) return { rename: false, reason: "already renamed" };
  if (args.record.title !== thread.title) {
    return { rename: false, reason: "the user changed the title" };
  }
  if (args.messageCount === null) return { rename: false, reason: "message count unknown" };
  if (args.messageCount - args.record.messageCount < args.renameEveryMessages) {
    return { rename: false, reason: "not enough new messages" };
  }
  return { rename: true };
}

/** True when `decideAutoRename` needs the current message count. */
export function needsMessageCount(args: {
  mode: AutoMode;
  renameEveryMessages: number;
  record: TitleRecord | null;
}): boolean {
  return args.mode !== "off" && args.record !== null && args.renameEveryMessages > 0;
}

/**
 * Small models per provider, best first. The plugin uses the first one that
 * the provider's model list contains. Other providers use their default model.
 */
export const SMALL_MODELS: Record<string, readonly string[]> = {
  "claude-code": ["claude-haiku-4-5-20251001", "claude-sonnet-5"],
  codex: ["gpt-5.4-mini", "gpt-5.6-luna"],
};

/** The small model to use, or undefined for the provider's default model. */
export function pickSmallModel(
  providerId: string,
  available: ReadonlySet<string>,
): string | undefined {
  return (SMALL_MODELS[providerId] ?? []).find((model) => available.has(model));
}
