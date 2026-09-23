import { describe, expect, it } from "vitest";
import {
  AUTO_MODES,
  DEFAULT_AUTO_MODE_LABEL,
  decideAutoRename,
  needsMessageCount,
  parseAutoMode,
  pickSmallModel,
  type ThreadFacts,
} from "./policy";

const PLUGIN_ID = "retitle";

const thread = (overrides: Partial<ThreadFacts> = {}): ThreadFacts => ({
  title: "What git rebase does",
  visibility: "visible",
  parentThreadId: null,
  originPluginId: null,
  archivedAt: null,
  deletedAt: null,
  ...overrides,
});

const decide = (overrides: Partial<Parameters<typeof decideAutoRename>[0]> = {}) =>
  decideAutoRename({
    thread: thread(),
    pluginId: PLUGIN_ID,
    mode: "first-reply",
    renameEveryMessages: 0,
    record: null,
    messageCount: null,
    ...overrides,
  });

describe("parseAutoMode", () => {
  it("maps each settings label to its mode", () => {
    expect(parseAutoMode("After the first reply")).toBe("first-reply");
    expect(parseAutoMode("Off (only when you press ⌘⌥R)")).toBe("off");
  });

  it("falls back to the default for an unknown label", () => {
    expect(parseAutoMode("Keep the title up to date")).toBe("first-reply");
  });

  it("uses a default label that is one of the options", () => {
    expect(Object.keys(AUTO_MODES)).toContain(DEFAULT_AUTO_MODE_LABEL);
  });
});

describe("decideAutoRename", () => {
  it("renames a thread that the plugin has not renamed yet", () => {
    expect(decide()).toEqual({ rename: true });
  });

  it("replaces bb's first title, because it looks like any other title", () => {
    expect(decide({ thread: thread({ title: "bb title from the first message" }) })).toEqual({
      rename: true,
    });
  });

  it("does nothing when automatic renaming is off", () => {
    expect(decide({ mode: "off" })).toMatchObject({ rename: false });
  });

  it.each([
    ["hidden threads", { visibility: "hidden" }],
    ["helper threads of this plugin", { originPluginId: PLUGIN_ID }],
    ["threads that another thread started", { parentThreadId: "thr_parent" }],
    ["archived threads", { archivedAt: 1 }],
    ["deleted threads", { deletedAt: 1 }],
  ])("skips %s", (_name, overrides) => {
    expect(decide({ thread: thread(overrides) })).toMatchObject({ rename: false });
  });

  it("renames only one time when renameEveryMessages is 0", () => {
    const record = { title: "What git rebase does", messageCount: 2 };
    expect(decide({ record, messageCount: 100 })).toEqual({
      rename: false,
      reason: "already renamed",
    });
  });

  it("renames again after enough new messages", () => {
    const record = { title: "What git rebase does", messageCount: 2 };
    expect(decide({ record, renameEveryMessages: 6, messageCount: 8 })).toEqual({
      rename: true,
    });
  });

  it("waits while there are too few new messages", () => {
    const record = { title: "What git rebase does", messageCount: 2 };
    expect(decide({ record, renameEveryMessages: 6, messageCount: 7 })).toEqual({
      rename: false,
      reason: "not enough new messages",
    });
  });

  it("stops when the user changed the title", () => {
    const record = { title: "🔄 Git rebase explained", messageCount: 2 };
    expect(
      decide({
        thread: thread({ title: "My own title" }),
        record,
        renameEveryMessages: 6,
        messageCount: 50,
      }),
    ).toEqual({ rename: false, reason: "the user changed the title" });
  });
});

describe("needsMessageCount", () => {
  const record = { title: "t", messageCount: 2 };

  it("is true only for a renamed thread with periodic renaming on", () => {
    expect(needsMessageCount({ mode: "first-reply", renameEveryMessages: 6, record })).toBe(true);
    expect(needsMessageCount({ mode: "first-reply", renameEveryMessages: 0, record })).toBe(false);
    expect(needsMessageCount({ mode: "first-reply", renameEveryMessages: 6, record: null })).toBe(
      false,
    );
    expect(needsMessageCount({ mode: "off", renameEveryMessages: 6, record })).toBe(false);
  });
});

describe("pickSmallModel", () => {
  it("uses Haiku on Claude Code when the model list has it", () => {
    expect(
      pickSmallModel("claude-code", new Set(["claude-opus-5-5", "claude-haiku-4-5-20251001"])),
    ).toBe("claude-haiku-4-5-20251001");
  });

  it("uses the next choice when the first one is missing", () => {
    expect(pickSmallModel("codex", new Set(["gpt-5.6-luna"]))).toBe("gpt-5.6-luna");
  });

  it("returns undefined when no small model is listed", () => {
    expect(pickSmallModel("codex", new Set())).toBeUndefined();
  });

  it("returns undefined for a provider without a small-model list", () => {
    expect(pickSmallModel("pi", new Set(["anything"]))).toBeUndefined();
  });
});
