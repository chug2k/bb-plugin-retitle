---
name: retitle
description: Rename a bb thread so that its title agrees with the conversation. Use when the user asks to rename, retitle, or fix the title of a thread.
---

# Retitle a thread

The Retitle plugin writes thread titles with a small model. By default it
renames a thread one time, after the first reply. After that, it renames only
when the user asks.

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

In the app, the same action is ⌘⌥R, the pencil button in the thread header,
and the quick-palette command
"Retitle: rename thread from the conversation".

Settings (`bb plugin config retitle`): `autoRename`,
`renameEveryMessages`, `emoji`, `providerId`,
`model`, `timeoutSeconds`. See the plugin README for details.
