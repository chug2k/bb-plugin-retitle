// bb-plugin-retitle — frontend entry.
//
// Registers the "Retitle" command (quick palette and ⌘⌥R). Command callbacks
// run outside React, so an app overlay with no UI gives them the RPC client.
import { useEffect } from "react";
import { toast } from "sonner";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";

type RetitleRpc = ReturnType<typeof useRpc<typeof rpcContract>>;

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

async function retitle(threadId: string) {
  const rpc = rpcClient;
  if (rpc === null) {
    toast.error("Retitle is still loading. Try again in a moment.");
    return;
  }
  const id = toast.loading("Writing a new title…");
  try {
    const { title } = await rpc.call("retitle", { threadId });
    toast.success(`Renamed to "${title}"`, { id });
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Could not rename the thread.", { id });
  }
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "rpc-bridge", component: RpcBridge });

  app.commands.register({
    id: "retitle",
    title: "Retitle: rename thread from the conversation",
    defaultShortcut: { key: "r", mod: true, alt: true },
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ threadId }) => {
      if (threadId !== null) void retitle(threadId);
    },
  });
});
