import { describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin, { HELPER_TITLE } from "./server";

const PLUGIN_ID = "retitle";
const THREAD_ID = "thr_target";
const HELPER_ID = "thr_helper";

type Message = { role: "user" | "assistant"; preview: string };

/**
 * A fake bb host with one thread to rename. The helper thread answers with
 * `answer`, or ends in `helperStatus`. `update` changes the stored title, so a
 * later `get` returns the new one, as on a real server.
 */
function createHost(
  options: {
    title?: string | null;
    thread?: Partial<Parameters<typeof makeThreadResponse>[0]>;
    messages?: Message[];
    answer?: string;
    helperStatus?: "idle" | "error";
    spawnError?: string;
    models?: string[];
    settings?: Record<string, string | number | boolean>;
  } = {},
) {
  const state = {
    title: options.title === undefined ? "What git rebase does" : options.title,
    messages: options.messages ?? [
      { role: "user", preview: "In two sentences: what does git rebase do?" },
      { role: "assistant", preview: "It moves your commits onto a new base." },
    ],
  };
  const spawns: Record<string, unknown>[] = [];
  const updates: { threadId: string; title?: string | null }[] = [];
  const deleted: string[] = [];

  const target = () =>
    makeThreadResponse({
      id: THREAD_ID,
      projectId: "proj_1",
      environmentId: "env_1",
      providerId: "claude-code",
      ...options.thread,
      title: state.title,
    });

  const host = createFakePluginHost({
    pluginId: PLUGIN_ID,
    ...(options.settings ? { settings: options.settings } : {}),
    sdk: {
      providers: {
        models: async () => ({
          modelLoadError: null,
          models: (options.models ?? ["claude-opus-5-5[1m]", "claude-haiku-4-5-20251001"]).map(
            (model) => ({ id: model, model }),
          ),
        }),
      },
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          threadId === THREAD_ID
            ? target()
            : makeThreadResponse({
                id: threadId,
                providerId: "claude-code",
                status: options.helperStatus ?? "idle",
                visibility: "hidden",
                originPluginId: PLUGIN_ID,
              }),
        conversationOutline: async () => ({
          items: state.messages.map((message, index) => ({
            id: `msg_${index}`,
            role: message.role,
            preview: message.preview,
            attachmentSummary: null,
          })),
          maxSeq: state.messages.length,
        }),
        spawn: async (args: unknown) => {
          if (options.spawnError) throw new Error(options.spawnError);
          spawns.push(args as Record<string, unknown>);
          return makeThreadResponse({ id: HELPER_ID, visibility: "hidden" });
        },
        output: async () => ({ output: options.answer ?? '"🔄 Git rebase explained."' }),
        update: async (args: { threadId: string; title?: string | null }) => {
          updates.push(args);
          if (args.title !== undefined) state.title = args.title;
          return target();
        },
        stop: async () => ({ ok: true }),
        delete: async ({ threadId }: { threadId: string }) => {
          deleted.push(threadId);
          return { ok: true };
        },
      },
    },
  });

  return { ...host, state, spawns, updates, deleted };
}

async function load(host: ReturnType<typeof createHost>) {
  await plugin(host.bb);
  return host;
}

/** Let the rename that a thread event starts in the background finish. */
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function idle(host: ReturnType<typeof createHost>, thread: Partial<Parameters<typeof makeThreadResponse>[0]> = {}) {
  return host.harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({ id: THREAD_ID, title: host.state.title, ...thread }),
    lastAssistantText: "done",
  });
}

describe("renaming on demand", () => {
  it("writes the cleaned answer onto the thread", async () => {
    const host = await load(createHost());

    const result = await host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID });

    expect(result).toEqual({
      title: "🔄 Git rebase explained",
      previousTitle: "What git rebase does",
    });
    expect(host.updates).toEqual([{ threadId: THREAD_ID, title: "🔄 Git rebase explained" }]);
  });

  it("runs a hidden helper on Haiku in the environment of the thread", async () => {
    const host = await load(createHost());

    await host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID });

    expect(host.spawns).toHaveLength(1);
    expect(host.spawns[0]).toMatchObject({
      projectId: "proj_1",
      environment: { type: "reuse", environmentId: "env_1" },
      title: HELPER_TITLE,
      providerId: "claude-code",
      model: "claude-haiku-4-5-20251001",
      reasoningLevel: "low",
      visibility: "hidden",
      lifecycleOwnerThreadId: THREAD_ID,
    });
  });

  it("deletes the helper after it answers", async () => {
    const host = await load(createHost());

    await host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID });

    expect(host.deleted).toEqual([HELPER_ID]);
  });

  it("uses the provider's default model when no small model is listed", async () => {
    const host = await load(createHost({ models: ["claude-opus-5-5[1m]"] }));

    await host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID });

    expect(host.spawns[0]).not.toHaveProperty("model");
  });

  it("uses the provider and model from the settings when they are set", async () => {
    const host = await load(
      createHost({ settings: { providerId: "codex", model: "gpt-5.4-mini" } }),
    );

    await host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID });

    expect(host.spawns[0]).toMatchObject({ providerId: "codex", model: "gpt-5.4-mini" });
  });

  it("asks for an emoji by default and not when the setting is off", async () => {
    const withEmoji = await load(createHost());
    await withEmoji.harness.behavior.callRpc("retitle", { threadId: THREAD_ID });
    expect(withEmoji.spawns[0]!.prompt).toContain("- Start with one emoji");

    const without = await load(createHost({ settings: { emoji: false } }));
    await without.harness.behavior.callRpc("retitle", { threadId: THREAD_ID });
    expect(without.spawns[0]!.prompt).toContain("- No emoji.");
  });

  it("fails at once when the helper thread fails, and still deletes it", async () => {
    const host = await load(createHost({ helperStatus: "error" }));

    await expect(
      host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID }),
    ).rejects.toThrow(/helper thread on claude-code failed/);
    expect(host.updates).toEqual([]);
    expect(host.deleted).toEqual([HELPER_ID]);
  });

  it("reports a helper that cannot start", async () => {
    const host = await load(createHost({ spawnError: "HTTP 503: provider is not ready." }));

    await expect(
      host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID }),
    ).rejects.toThrow(/Could not start the helper on claude-code: HTTP 503/);
  });

  it("does not write an empty answer", async () => {
    const host = await load(createHost({ answer: "  \n" }));

    await expect(
      host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID }),
    ).rejects.toThrow(/empty title/);
    expect(host.updates).toEqual([]);
  });

  it("does not name an archived thread as the helper's owner", async () => {
    const host = await load(createHost({ thread: { archivedAt: 1 } }));

    await host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID });

    expect(host.spawns[0]).not.toHaveProperty("lifecycleOwnerThreadId");
  });

  it("refuses a thread without messages", async () => {
    const host = await load(createHost({ messages: [] }));

    await expect(
      host.harness.behavior.callRpc("retitle", { threadId: THREAD_ID }),
    ).rejects.toThrow(/no messages/);
    expect(host.spawns).toEqual([]);
  });
});

describe("renaming automatically", () => {
  it("renames a thread after its first reply by default", async () => {
    const host = await load(createHost());

    await idle(host);
    await settle();

    expect(host.updates).toEqual([{ threadId: THREAD_ID, title: "🔄 Git rebase explained" }]);
  });

  it("renames only one time by default", async () => {
    const host = await load(createHost());

    await idle(host);
    await settle();
    host.state.messages.push(...Array.from({ length: 20 }, () => ({ role: "user" as const, preview: "more" })));
    await idle(host);
    await settle();

    expect(host.updates).toHaveLength(1);
  });

  it("does nothing when automatic renaming is off", async () => {
    const host = await load(
      createHost({ settings: { autoRename: "Off (only when you press ⌘⌥R)" } }),
    );

    await idle(host);
    await settle();

    expect(host.spawns).toEqual([]);
  });

  it("renames again after the set number of new messages", async () => {
    const host = await load(createHost({ settings: { renameEveryMessages: 6 } }));
    await idle(host);
    await settle();

    host.state.messages.push(...Array.from({ length: 5 }, () => ({ role: "user" as const, preview: "more" })));
    await idle(host);
    await settle();
    expect(host.updates).toHaveLength(1);

    host.state.messages.push({ role: "user", preview: "one more" });
    await idle(host);
    await settle();
    expect(host.updates).toHaveLength(2);
  });

  it("stops after the user changes the title", async () => {
    const host = await load(createHost({ settings: { renameEveryMessages: 6 } }));
    await idle(host);
    await settle();

    host.state.title = "My own title";
    host.state.messages.push(...Array.from({ length: 10 }, () => ({ role: "user" as const, preview: "more" })));
    await idle(host);
    await settle();

    expect(host.updates).toHaveLength(1);
  });

  it.each([
    ["hidden threads", { visibility: "hidden" as const }],
    ["threads that another thread started", { parentThreadId: "thr_parent" }],
    ["helper threads of this plugin", { originPluginId: PLUGIN_ID }],
  ])("skips %s", async (_name, thread) => {
    const host = await load(createHost());

    await idle(host, thread);
    await settle();

    expect(host.spawns).toEqual([]);
  });
});

describe("bb retitle", () => {
  it("renames the current thread", async () => {
    const host = await load(createHost());

    const result = await host.harness.behavior.runCli([], { threadId: THREAD_ID } as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('Renamed to "🔄 Git rebase explained"');
  });

  it("renames a thread by id and prints JSON", async () => {
    const host = await load(createHost());

    const result = await host.harness.behavior.runCli([THREAD_ID, "--json"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      threadId: THREAD_ID,
      title: "🔄 Git rebase explained",
      previousTitle: "What git rebase does",
    });
  });

  it("fails without a thread id", async () => {
    const host = await load(createHost());

    const result = await host.harness.behavior.runCli([]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/BB_THREAD_ID is not set/);
  });

  it("prints the usage for --help", async () => {
    const host = await load(createHost());

    const result = await host.harness.behavior.runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^Usage: bb retitle/);
  });

  it("reports a failed rename with exit code 1", async () => {
    const host = await load(createHost({ helperStatus: "error" }));

    const result = await host.harness.behavior.runCli([THREAD_ID]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/helper thread on claude-code failed/);
  });
});
