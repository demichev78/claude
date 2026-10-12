# sidecar

A Claude Code mod that docks a sidebar on the right of the terminal with stacked cards:

- Model: the main loop's model and effort level
- Limits: session (5h), weekly and per-model plan usage, with reset times
- Context: percent of the window used, broken down by category
- Cache: warm, cold or unknown, time until it goes cold, the last request's cache reads, writes and uncached tokens, and a Keep warm button (6h window, one small request after 50 idle minutes)
- Agents: running subagents as a tree; click one to read its output
- Recent changes: the last 10 files edited, with line counts and a preview

The sidecar docks only in the fullscreen layout (`/tui fullscreen`) at 110 columns or wider, and hides itself when the terminal is narrower. `/sidecar` opens it and `/sidecar close` hides it.

## Install

Needs Claude Code 2.1.287 or later.

```sh
claude plugin marketplace add demichev78/claude
claude plugin install sidecar@demichev-local
```

Then run `/reload-plugins` in an open session, or start a new one.

## Develop

```sh
claude plugin validate mods/sidecar
claude plugin test mods/sidecar
```
