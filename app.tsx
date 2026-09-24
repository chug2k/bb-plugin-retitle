// bb-plugin-retitle — frontend entry.
//
// Two surfaces start a rename: the "Retitle" command (quick palette and ⌘⌥R),
// and a button in the thread header. Command callbacks run outside React, so
// an app overlay with no UI gives them the RPC client.
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";
import {
  definePluginApp,
  experimental_Icon as Icon,
  useRpc,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";

type RetitleRpc = ReturnType<typeof useRpc<typeof rpcContract>>;

const BUTTON_LABEL = "Rename from the conversation (⌥⌘R)";

let rpcClient: RetitleRpc | null = null;

function RpcBridge() {
  const rpc = useRpc<typeof rpcContract>();
  useEffect(() => {
    rpcClient = rpc;
    return () => {
      if (rpcClient === rpc) rpcClient = null;
    };
  }, [rpc]);
  return null;
}

/**
 * Threads with a rename in progress in this window. The header button reads
 * it, so the button also shows a rename that ⌘⌥R started.
 */
const pending = new Set<string>();
const listeners = new Set<() => void>();
function setPending(threadId: string, value: boolean) {
  if (value) pending.add(threadId);
  else pending.delete(threadId);
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Rename one thread and report the result in a toast. A second call for the same thread is ignored. */
async function retitle(rpc: RetitleRpc | null, threadId: string): Promise<void> {
  if (rpc === null) {
    toast.error("Retitle is still loading. Try again in a moment.");
    return;
  }
  if (pending.has(threadId)) return;
  setPending(threadId, true);
  const id = toast.loading("Writing a new title…");
  try {
    const { title } = await rpc.call("retitle", { threadId });
    toast.success(`Renamed to "${title}"`, { id });
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Could not rename the thread.", { id });
  } finally {
    setPending(threadId, false);
  }
}

/** One icon-sized button, so it fits the 48 px header row on every viewport. */
function RetitleButton({ threadId }: PluginThreadHeaderActionProps) {
  const rpc = useRpc<typeof rpcContract>();
  const isPending = useSyncExternalStore(
    subscribe,
    () => pending.has(threadId),
    () => false,
  );
  const onClick = useCallback(() => void retitle(rpc, threadId), [rpc, threadId]);

  return (
    <button
      type="button"
      aria-label={BUTTON_LABEL}
      title={isPending ? "Writing a new title…" : BUTTON_LABEL}
      disabled={isPending}
      onClick={onClick}
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none"
    >
      <Icon name="EditFile" aria-hidden className={isPending ? "size-4 animate-pulse" : "size-4"} />
    </button>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "rpc-bridge", component: RpcBridge });

  app.slots.experimental_threadHeaderAction({
    id: "retitle",
    title: "Retitle",
    component: RetitleButton,
  });

  app.commands.register({
    id: "retitle",
    title: "Retitle: rename thread from the conversation",
    defaultShortcut: { key: "r", mod: true, alt: true },
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ threadId }) => {
      if (threadId !== null) void retitle(rpcClient, threadId);
    },
  });
});
