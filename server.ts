// bb-plugin-retitle — keep thread titles current with a small, fast model.
//
// bb titles a thread one time, from the first message. This plugin writes a
// new title from the conversation: automatically when a turn ends, and on
// demand from ⌘⌥R, the quick palette, or `bb retitle`.
//
// A plugin cannot call bb's own title model (BB_INFERENCE). So the plugin
// starts a short hidden helper thread on a small model, reads its answer, and
// deletes it. The helper uses the environment of the renamed thread, so bb
// does not make a new worktree.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const rpcContract = defineRpcContract({
  retitle: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ title: z.string(), previousTitle: z.string().nullable() }),
  },
});

/** Characters of conversation sent to the model. */
const MAX_TRANSCRIPT_CHARS = 12_000;
const MAX_TITLE_CHARS = 80;
const HELPER_TITLE = "Retitle helper";
const HELPER_POLL_MS = 1_000;
/** In "keep up to date" mode, rename again after this many new messages. */
const MESSAGES_BEFORE_UPDATE = 6;

/**
 * Small models per provider, best first. The plugin uses the first one that
 * the provider's model list contains. Other providers use their default model.
 */
const SMALL_MODELS: Record<string, readonly string[]> = {
  "claude-code": ["claude-haiku-4-5-20251001", "claude-sonnet-5"],
  codex: ["gpt-5.4-mini", "gpt-5.6-luna"],
};

const AUTO_MODES = {
  "Keep the title up to date": "always",
  "After the first reply only": "once",
  Off: "off",
} as const;
type AutoMode = (typeof AUTO_MODES)[keyof typeof AUTO_MODES];

/** The last title this plugin wrote on a thread. */
interface TitleRecord {
  title: string;
  /** Number of outline messages when the plugin wrote the title. */
  messageCount: number;
}

type OutlineItem = { role: "user" | "assistant"; preview: string };

/**
 * bb cuts each outline message to 200 characters. Keep the first message,
 * because it gives the task, and then add messages from the newest back.
 */
function buildTranscript(items: readonly OutlineItem[]): string {
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
    if (used + line.length > MAX_TRANSCRIPT_CHARS) break;
    kept.unshift(line);
    used += line.length;
  }
  const skipped = lines.length - 1 - kept.length;
  return [first, ...(skipped > 0 ? [`[… ${skipped} earlier messages omitted …]`] : []), ...kept]
    .filter((line) => line !== "")
    .join("\n\n");
}

function buildPrompt(args: {
  transcript: string;
  currentTitle: string | null;
  emoji: boolean;
}): string {
  // The rules copy bb's own title prompt, so these titles look like bb's.
  return [
    "You create concise titles for coding tasks.",
    "Do not use any tools. Do not read or change files. Reply with the title only.",
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
    ...(args.currentTitle ? [`The current title is "${args.currentTitle}". Replace it if it no longer fits.`] : []),
    "",
    "<conversation>",
    args.transcript,
    "</conversation>",
  ].join("\n");
}

/** Take the first line that is not empty, and remove quotes and markdown. */
function cleanTitle(raw: string): string | null {
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

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    autoRename: {
      type: "select",
      label: "Automatic renaming",
      description:
        "When to write a new title. The plugin never replaces a title that you typed yourself.",
      options: Object.keys(AUTO_MODES),
      default: "Keep the title up to date",
    },
    emoji: {
      type: "boolean",
      label: "Emoji",
      description: "Start each title with one emoji that fits the topic.",
      default: true,
    },
    providerId: {
      type: "string",
      label: "Helper provider",
      description:
        "Agent provider for the helper thread (see `bb provider list`). Leave empty to use the provider of the renamed thread.",
      default: "",
    },
    model: {
      type: "string",
      label: "Helper model",
      description:
        "Model for the helper thread (see `bb provider models <provider>`). Leave empty to use a small model of the provider.",
      default: "",
    },
    timeoutSeconds: {
      type: "number",
      label: "Timeout (seconds)",
      default: 90,
    },
  });
  let config = await settings.get();
  settings.onChange((next) => {
    config = next;
  });
  const autoMode = (): AutoMode =>
    AUTO_MODES[config.autoRename as keyof typeof AUTO_MODES] ?? "always";

  const recordKey = (threadId: string) => `title:${threadId}`;

  /**
   * Select the provider and model for the helper. The provider of the renamed
   * thread works on this machine, so it is the default. A setting overrides
   * each value. The plugin uses a small model only when the provider lists it.
   */
  async function resolveHelperExecution(thread: {
    providerId: string;
    environmentId: string | null;
  }): Promise<{ providerId: string; model?: string }> {
    const providerId = config.providerId.trim() || thread.providerId;
    const configuredModel = config.model.trim();
    if (configuredModel !== "") return { providerId, model: configuredModel };

    const preferred = SMALL_MODELS[providerId] ?? [];
    if (preferred.length === 0) return { providerId };
    try {
      const catalog = await bb.sdk.providers.models(
        thread.environmentId !== null
          ? { providerId, environmentId: thread.environmentId }
          : { providerId },
      );
      const available = new Set(catalog.models.flatMap((entry) => [entry.id, entry.model]));
      const model = preferred.find((candidate) => available.has(candidate));
      return model !== undefined ? { providerId, model } : { providerId };
    } catch (error) {
      bb.log.warn(`could not read ${providerId} models; using its default: ${String(error)}`);
      return { providerId };
    }
  }

  /** Wait until the helper answers, fails, or the time ends. */
  async function waitForHelper(helperId: string): Promise<void> {
    const deadline = Date.now() + config.timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      const helper = await bb.sdk.threads.get({ threadId: helperId });
      if (helper.status === "idle") return;
      if (helper.status === "error" || helper.deletedAt !== null) {
        throw new Error(
          `The helper thread on ${helper.providerId} failed. Make sure that the provider is installed and signed in, or select a different provider in the Retitle settings.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, HELPER_POLL_MS));
    }
    throw new Error(`The helper model did not answer in ${config.timeoutSeconds} seconds.`);
  }

  async function askHelper(args: {
    projectId: string;
    environmentId: string | null;
    execution: { providerId: string; model?: string };
    targetThreadId: string;
    prompt: string;
  }): Promise<string> {
    let helper: Awaited<ReturnType<typeof bb.sdk.threads.spawn>>;
    try {
      helper = await bb.sdk.threads.spawn({
        projectId: args.projectId,
        environment:
          args.environmentId !== null
            ? { type: "reuse", environmentId: args.environmentId }
            : { type: "project-default" },
        prompt: args.prompt,
        // With an explicit title, bb does not write its own title for the helper.
        title: HELPER_TITLE,
        providerId: args.execution.providerId,
        ...(args.execution.model !== undefined ? { model: args.execution.model } : {}),
        reasoningLevel: "low",
        visibility: "hidden",
        // Plugin metadata marks the helper as this plugin's thread, so
        // automatic renaming skips it.
        pluginMetadata: { helper: true },
        // If the plugin stops during a run, bb removes the helper with its target.
        lifecycleOwnerThreadId: args.targetThreadId,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not start the helper on ${args.execution.providerId}: ${reason} Select a different provider in the Retitle settings.`,
      );
    }
    bb.log.info(
      `helper ${helper.id} for ${args.targetThreadId}: ${args.execution.providerId}/${args.execution.model ?? "(provider default)"}`,
    );
    try {
      await waitForHelper(helper.id);
      const { output } = await bb.sdk.threads.output({ threadId: helper.id });
      if (output === null) throw new Error("The helper model returned no text.");
      return output;
    } finally {
      await bb.sdk.threads.stop({ threadId: helper.id }).catch(() => {});
      await bb.sdk.threads
        .delete({ threadId: helper.id, childThreadsConfirmed: true })
        .catch((error: unknown) => {
          bb.log.warn(`could not delete helper thread ${helper.id}: ${String(error)}`);
        });
    }
  }

  async function retitle(threadId: string) {
    const thread = await bb.sdk.threads.get({ threadId });
    const outline = await bb.sdk.threads.conversationOutline({ threadId });
    const transcript = buildTranscript(outline.items);
    if (transcript === "") throw new Error("This thread has no messages yet.");

    const environmentId = thread.environmentId ?? null;
    const raw = await askHelper({
      projectId: thread.projectId,
      environmentId,
      execution: await resolveHelperExecution({ providerId: thread.providerId, environmentId }),
      targetThreadId: threadId,
      prompt: buildPrompt({
        transcript,
        currentTitle: thread.title ?? null,
        emoji: config.emoji,
      }),
    });
    const title = cleanTitle(raw);
    if (title === null) throw new Error("The helper model returned an empty title.");

    await bb.sdk.threads.update({ threadId, title });
    const record: TitleRecord = { title, messageCount: outline.items.length };
    await bb.storage.kv.set(recordKey(threadId), record);
    bb.log.info(`retitled ${threadId}: ${title}`);
    return { title, previousTitle: thread.title ?? null };
  }

  /** One rename at a time for each thread. A second request joins the first. */
  const inFlight = new Map<string, Promise<{ title: string; previousTitle: string | null }>>();
  function retitleOnce(threadId: string) {
    const running = inFlight.get(threadId);
    if (running) return running;
    const run = retitle(threadId).finally(() => inFlight.delete(threadId));
    inFlight.set(threadId, run);
    return run;
  }

  /**
   * Decide if a thread that just went idle gets a new title.
   *
   * bb writes a title from the first message, and that title cannot be told
   * apart from a typed one. So the first rename replaces any title. After
   * that, the plugin renames only while the title is still the one it wrote:
   * a changed title means that you typed it, and the plugin stops.
   */
  async function autoRetitle(thread: {
    id: string;
    title: string | null;
    visibility: string;
    parentThreadId: string | null;
    originPluginId: string | null;
    archivedAt: number | null;
    deletedAt: number | null;
  }): Promise<void> {
    const mode = autoMode();
    if (mode === "off") return;
    // Skip hidden threads (this includes the helpers), threads that another
    // thread started (their parent gave the title), and closed threads.
    if (thread.visibility === "hidden" || thread.originPluginId === bb.pluginId) return;
    if (thread.parentThreadId !== null) return;
    if (thread.archivedAt !== null || thread.deletedAt !== null) return;
    if (inFlight.has(thread.id)) return;

    const record = await bb.storage.kv.get<TitleRecord>(recordKey(thread.id));
    if (record !== undefined) {
      if (mode === "once") return;
      if (record.title !== thread.title) return;
      const outline = await bb.sdk.threads.conversationOutline({ threadId: thread.id });
      if (outline.items.length - record.messageCount < MESSAGES_BEFORE_UPDATE) return;
    }
    await retitleOnce(thread.id);
  }

  bb.events.on("thread.idle", ({ thread }) => {
    void autoRetitle(thread).catch((error: unknown) => {
      bb.log.warn(`automatic rename of ${thread.id} failed: ${String(error)}`);
    });
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    void bb.storage.kv.delete(recordKey(thread.id)).catch(() => {});
  });

  bb.rpc.register(rpcContract, {
    retitle: ({ threadId }) => retitleOnce(threadId),
  });

  const usage =
    "Usage: bb retitle [<thread-id>] [--json]\n\nWithout an id, the command renames the current thread (BB_THREAD_ID).";
  bb.cli.register({
    name: "retitle",
    summary: "Write a new thread title from the conversation with a small model",
    commands: [
      {
        name: "thread",
        summary: "Rename a thread by id (default: the current thread)",
        usage: "bb retitle [<thread-id>] [--json]",
      },
    ],
    async run(argv, ctx) {
      const json = argv.includes("--json");
      const rest = argv.filter((arg) => arg !== "--json");
      // `bb retitle thread <id>` agrees with the help text. The word is optional.
      if (rest[0] === "thread") rest.shift();
      if (rest.includes("--help") || rest.includes("-h") || rest[0] === "help") {
        return { exitCode: 0, stdout: usage };
      }
      if (rest.length > 1 || rest.some((arg) => arg.startsWith("-"))) {
        return { exitCode: 1, stderr: usage };
      }
      const threadId = rest[0] ?? ctx.threadId;
      if (!threadId) {
        return { exitCode: 1, stderr: `No thread id, and BB_THREAD_ID is not set.\n\n${usage}` };
      }
      try {
        const result = await retitleOnce(threadId);
        return {
          exitCode: 0,
          stdout: json ? JSON.stringify({ threadId, ...result }) : `Renamed to "${result.title}"`,
        };
      } catch (error) {
        return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
      }
    },
  });
}
