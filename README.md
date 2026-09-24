# bb-plugin-retitle

Writes [bb](https://getbb.app) thread titles with a small, fast model. The model
reads the conversation and writes a new title after the first reply, and each
time you press ⌘⌥R.

bb writes a title one time, from the first message. When the work changes, the
title does not. This plugin updates it.

## Install

```sh
bb plugin install https://github.com/chug2k/bb-plugin-retitle
```

## Use

- **Automatic.** After the first reply, the plugin writes a new title one time.
  To rename again as the conversation grows, set "Rename again every N
  messages".
- **Keyboard.** Press ⌘⌥R (Ctrl+Alt+R on Windows and Linux) to rename the open
  thread. Change the key in Settings → Keyboard.
- **Header button.** Click the pencil button in the thread header.
- **Quick palette.** Press ⌘⇧P and run "Retitle: rename thread from the
  conversation".
- **CLI.** `bb retitle` renames the current thread. `bb retitle <thread-id>`
  renames a different thread.

The plugin does not replace a title that you typed yourself. If you change a
title, automatic renaming stops for that thread. ⌘⌥R and `bb retitle` still
work.

One exception: bb's own first title looks the same to the plugin as a typed
title. So if you type a title before the first reply ends, the first automatic
rename replaces it.

## Model

The helper uses the provider of the renamed thread, because that provider works
on your machine. It then selects a small model from the provider's model list:

| Provider | Model |
| --- | --- |
| Claude Code | Haiku 4.5 |
| Codex | gpt-5.4-mini |
| Other | The provider's default model |

## Settings

Change the settings in Settings → Installed plugins → Retitle, or with
`bb plugin config retitle set <key> <value>`.

| Setting | Default | Function |
| --- | --- | --- |
| `autoRename` | After the first reply | "Off" renames only when you press ⌘⌥R or run `bb retitle`. |
| `renameEveryMessages` | 0 | After the first rename, rename again after this many new messages. 0 means never. |
| `emoji` | on | Starts each title with one emoji, for example "🐛 Fix flaky login test". |
| `providerId` | empty | Provider for the helper. Empty means the provider of the thread. |
| `model` | empty | Model for the helper. Empty means a small model from the table above. |
| `timeoutSeconds` | 90 | Time to wait for the helper before the rename fails. |

## How it works

A plugin cannot call bb's own title model. So for each rename the plugin:

1. Reads the conversation outline of the thread. bb cuts each message to its
   first 200 characters. The plugin keeps the first message and then the
   newest messages, up to 12,000 characters.
2. Starts a hidden helper thread in the same environment as the renamed thread.
   bb does not make a new worktree.
3. Waits for the answer, sets the title, and deletes the helper thread.

A rename takes about 15 seconds, because the provider must start an agent
session. If the helper cannot start or fails, the rename stops with an error
at once.

The plugin skips hidden threads, threads that another thread started, and
archived threads.

## Development

```sh
npm install --include=dev
npm run typecheck
npm test
bb plugin build
bb plugin install .
```

| File | Content |
| --- | --- |
| `server.ts` | Settings, the helper thread, automatic renaming, RPC, and CLI |
| `lib/title.ts` | The prompt, and the cleanup of the model's answer |
| `lib/policy.ts` | When to rename automatically, and which small model to use |
| `app.tsx` | The ⌘⌥R command, the quick-palette entry, and the header button |

## License

MIT
