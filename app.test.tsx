// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { PluginAppBuilder, PluginCommandRegistration } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";

afterEach(cleanup);

const handlers: PluginRpcTestHandlers<typeof rpcContract> = {
  retitle: () => ({ title: "🔄 Git rebase explained", previousTitle: "What git rebase does" }),
};

/**
 * The test harness does not record `app.commands.register`, so run the app's
 * setup against a builder that records only the calls this app makes.
 */
async function captureCommands(): Promise<PluginCommandRegistration[]> {
  const definition = (await import("./app")).default as unknown as {
    setup: (app: PluginAppBuilder) => void;
  };
  const commands: PluginCommandRegistration[] = [];
  const builder = {
    commands: { register: (registration: PluginCommandRegistration) => commands.push(registration) },
    slots: { experimental_appOverlay: () => {}, experimental_threadHeaderAction: () => {} },
  } as unknown as PluginAppBuilder;
  definition.setup(builder);
  return commands;
}

const context = (threadId: string | null) => ({
  threadId,
  projectId: threadId === null ? null : "proj_1",
  openPanel: () => false,
});

describe("registrations", () => {
  it("mounts the RPC bridge as an app overlay", async () => {
    const app = await loadPluginApp(() => import("./app"));
    expect(app.appOverlays.map((overlay) => overlay.id)).toEqual(["rpc-bridge"]);
  });

  it("adds a button to the thread header", async () => {
    const app = await loadPluginApp(() => import("./app"));
    expect(app.threadHeaderActions.map((action) => action.id)).toEqual(["retitle"]);
  });

  it("registers the rename command on ⌘⌥R", async () => {
    await loadPluginApp(() => import("./app"));
    const commands = await captureCommands();

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      id: "retitle",
      title: "Retitle: rename thread from the conversation",
      defaultShortcut: { key: "r", mod: true, alt: true },
    });
  });

  it("shows the command only when a thread is open", async () => {
    await loadPluginApp(() => import("./app"));
    const [command] = await captureCommands();

    expect(command!.isAvailable!(context("thr_1"))).toBe(true);
    expect(command!.isAvailable!(context(null))).toBe(false);
  });
});

describe("the rename command", () => {
  it("renames the open thread through the plugin RPC", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const bridge = renderSlot<object, typeof rpcContract>(app.appOverlays[0]!, {}, {
      rpc: handlers,
    });
    const [command] = await captureCommands();

    await command!.run(context("thr_1"));

    await waitFor(() =>
      expect(bridge.inspection.rpcCalls).toEqual([
        { method: "retitle", input: { threadId: "thr_1" } },
      ]),
    );
  });

  it("does nothing without an open thread", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const bridge = renderSlot<object, typeof rpcContract>(app.appOverlays[0]!, {}, {
      rpc: handlers,
    });
    const [command] = await captureCommands();

    await command!.run(context(null));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(bridge.inspection.rpcCalls).toEqual([]);
  });
});

describe("the header button", () => {
  const props = { threadId: "thr_1", projectId: "proj_1", isCompactViewport: false };
  const label = "Rename from the conversation (⌥⌘R)";

  it("renames the thread it belongs to", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot<typeof props, typeof rpcContract>(app.threadHeaderActions[0]!, props, {
      rpc: handlers,
    });

    fireEvent.click(slot.getByRole("button", { name: label }));

    await waitFor(() =>
      expect(slot.inspection.rpcCalls).toEqual([
        { method: "retitle", input: { threadId: "thr_1" } },
      ]),
    );
  });

  it("is disabled while a rename runs, and ignores a second click", async () => {
    let finish!: () => void;
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot<typeof props, typeof rpcContract>(app.threadHeaderActions[0]!, props, {
      rpc: {
        retitle: () =>
          new Promise((resolve) => {
            finish = () => resolve({ title: "🔄 Git rebase explained", previousTitle: null });
          }),
      },
    });
    const button = slot.getByRole("button", { name: label });

    fireEvent.click(button);
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true));
    fireEvent.click(button);
    finish();

    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    expect(slot.inspection.rpcCalls).toHaveLength(1);
  });

  it("stays usable after a failed rename", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot<typeof props, typeof rpcContract>(app.threadHeaderActions[0]!, props, {
      rpc: {
        retitle: () => {
          throw new Error("The helper thread on claude-code failed.");
        },
      },
    });
    const button = slot.getByRole("button", { name: label });

    fireEvent.click(button);
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(1));
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  });
});
