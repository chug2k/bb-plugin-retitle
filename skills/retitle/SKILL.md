---
name: retitle
description: Rename a bb thread so that its title agrees with the conversation. Use when the user asks to rename, retitle, or fix the title of a thread.
---

# Retitle a thread

The Retitle plugin writes thread titles with a small model. It renames threads
automatically when a turn ends, so usually you do not have to do anything.

To rename a thread now:

```
bb retitle              # the current thread (BB_THREAD_ID)
bb retitle <thread-id>  # a different thread
bb retitle --json       # {"threadId","title","previousTitle"}
```

A rename takes about 15 seconds.

To set an exact title, do not use this command. Use
`bb thread update --self --title "<title>"`. After a manual title, automatic
renaming stops for that thread.

In the app, the same action is ⌘⌥R and the quick-palette command
"Retitle: rename thread from the conversation".

Settings (`bb plugin config retitle`): `autoRename`, `emoji`, `providerId`,
`model`, `timeoutSeconds`. See the plugin README for details.
