// bb-plugin-retitle — write thread titles with a small, fast model.
//
// bb titles a thread one time, from the first message. This plugin writes a
// new title from the conversation: once after the first reply, and when you
// press ⌘⌥R, run the quick-palette command, or run `bb retitle`. A setting
// also renames a thread again after a number of new messages.
//
// A plugin cannot call bb's own title model (BB_INFERENCE). So the plugin
// starts a short hidden helper thread on a small model, reads its answer, and
// deletes it. The helper uses the environment of the renamed thread, so bb
// does not make a new worktree.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  AUTO_MODES,
  DEFAULT_AUTO_MODE_LABEL,
  decideAutoRename,
  needsMessageCount,
  parseAutoMode,
  pickSmallModel,
  type ThreadFacts,
  type TitleRecord,
} from "./lib/policy";
import { buildPrompt, buildTranscript, cleanTitle, isUsableTitle } from "./lib/title";

export const rpcContract = defineRpcContract({
  retitle: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ title: z.string(), previousTitle: z.string().nullable() }),
  },
});

export const HELPER_TITLE = "Retitle helper";
/** Helper runs for one rename, when the answer is not a usable title. */
const MAX_ATTEMPTS = 2;
const HELPER_POLL_MS = 1_000;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    autoRename: {
      type: "select",
      label: "Automatic renaming",
      description:
        "Rename a thread one time, after its first reply. The plugin does not replace a title that you typed yourself.",
      options: Object.keys(AUTO_MODES),
      default: DEFAULT_AUTO_MODE_LABEL,
    },
    renameEveryMessages: {
      type: "number",
      label: "Rename again every N messages",
      description:
        "After the first rename, rename the thread again after this many new messages. 0 means never.",
      default: 0,
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
    try {
      const catalog = await bb.sdk.providers.models(
        thread.environmentId !== null
          ? { providerId, environmentId: thread.environmentId }
          : { providerId },
      );
      const available = new Set(catalog.models.flatMap((entry) => [entry.id, entry.model]));
      const model = pickSmallModel(providerId, available);
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
    targetArchived: boolean;
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
        // If the plugin stops during a run, bb removes the helper with its
        // target. bb accepts only a live thread as the owner.
        ...(args.targetArchived ? {} : { lifecycleOwnerThreadId: args.targetThreadId }),
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
    const execution = await resolveHelperExecution({ providerId: thread.providerId, environmentId });
    const prompt = buildPrompt({
      transcript,
      currentTitle: thread.title ?? null,
      emoji: config.emoji,
    });

    let title: string | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && title === null; attempt++) {
      const answer = cleanTitle(
        await askHelper({
          projectId: thread.projectId,
          environmentId,
          execution,
          targetThreadId: threadId,
          targetArchived: thread.archivedAt !== null,
          prompt,
        }),
      );
      if (answer !== null && isUsableTitle(answer)) title = answer;
      else bb.log.warn(`attempt ${attempt} for ${threadId} gave no usable title: ${JSON.stringify(answer)}`);
    }
    if (title === null) throw new Error("The helper model did not return a usable title.");

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

  async function autoRetitle(thread: ThreadFacts & { id: string }): Promise<void> {
    if (inFlight.has(thread.id)) return;
    const mode = parseAutoMode(config.autoRename);
    const renameEveryMessages = config.renameEveryMessages;
    const record = (await bb.storage.kv.get<TitleRecord>(recordKey(thread.id))) ?? null;
    const messageCount = needsMessageCount({ mode, renameEveryMessages, record })
      ? (await bb.sdk.threads.conversationOutline({ threadId: thread.id })).items.length
      : null;
    const decision = decideAutoRename({
      thread,
      pluginId: bb.pluginId,
      mode,
      renameEveryMessages,
      record,
      messageCount,
    });
    if (decision.rename) await retitleOnce(thread.id);
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
