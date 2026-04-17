# Claude Code Plugin

A personal Claude Code plugin — curated agents, skills, commands, hooks, rules, and MCP configs focused on:

- Writing articles and long-form content
- Java / Spring Boot development
- Python development
- Frontend / TypeScript / Web
- Go, Swift / iOS
- Healthcare domain knowledge
- Market research

Forked from [everything-claude-code](https://github.com/affaan-m/everything-claude-code) and pruned to remove languages, domains, and platform scaffolding not in active use.

## Layout

```
agents/          Specialized subagents (code-reviewer, planner, tdd-guide, …)
skills/          Workflow skills and domain knowledge
commands/        Slash commands
hooks/           Trigger-based automations
rules/           Always-follow guidelines (common + per-language)
mcp-configs/     MCP server configurations
scripts/         Node.js utilities for hooks and setup
tests/           Test suite
```

## Install

This repo installs as a local Claude Code plugin through the `/plugin` marketplace flow. No files are copied into `~/.claude/` directly.

### 1. Verify layout

```bash
./install.sh
```

This checks that the plugin files are intact and prints the install commands for the next step.

### 2. Register the marketplace and install the plugin

In any Claude Code session, run the two slash commands:

```text
/plugin marketplace add /Users/demichev/WORK/Projects/claude
/plugin install claude-config@demichev-local
```

Use your repo's absolute path in the first command. After `/plugin install`, Claude Code auto-registers:

- Agents under `agents/`
- Skills under `skills/`
- Slash commands under `commands/`
- Hooks declared in `hooks/hooks.json`
- MCP servers declared in `mcp-configs/`

No edits to `~/.claude/settings.json` are required.

### 3. Use

Restart Claude Code or start a new session. Type `/` in the prompt to browse the installed slash commands.

## Update

After editing the repo, either start a new session (cache refreshes automatically) or force an immediate refresh:

```text
/plugin marketplace update demichev-local
```

## Uninstall

```text
/plugin uninstall claude-config@demichev-local
/plugin marketplace remove demichev-local
```

This fully removes the plugin, its hooks, and its MCP registrations. The repo itself is untouched.

## Commands

See [COMMANDS-QUICK-REF.md](COMMANDS-QUICK-REF.md) for the full list.

Most common:

- `/plan` — Plan a feature before coding
- `/tdd` — Test-driven development
- `/code-review` — Review code quality and security
- `/build-fix` — Fix build errors
- `/e2e` — Generate and run Playwright E2E tests
- `/docs` — Look up library docs via Context7

## Agents

See [AGENTS.md](AGENTS.md) for usage and delegation rules.

## Rules

See [RULES.md](RULES.md) and [rules/](rules/).

## Development

```bash
node tests/run-all.js        # run all tests
npm install                  # restore dev dependencies
npm run lint                 # eslint + markdownlint
```

## License

MIT — see [LICENSE](LICENSE).
