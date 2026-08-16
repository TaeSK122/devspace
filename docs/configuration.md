# Configuration Reference

DevSpace can be configured through `devspace init`, persisted config files, or
environment variables.

The default files are:

```text
~/.devspace/config.json
~/.devspace/auth.json
```

Use another config directory with:

```bash
DEVSPACE_CONFIG_DIR=/path/to/config npx @waishnav/devspace serve
```

## Commands

```bash
npx @waishnav/devspace init
npx @waishnav/devspace serve
npx @waishnav/devspace doctor
npx @waishnav/devspace config get
npx @waishnav/devspace config set publicBaseUrl https://devspace.example.com
npx @waishnav/devspace config set liveSessions true
```

## Core Environment Variables

| Variable | Purpose |
| --- | --- |
| `HOST` | Local bind host. Defaults to `127.0.0.1`. |
| `PORT` | Local port. Defaults to `7676`. |
| `DEVSPACE_ALLOWED_ROOTS` | Comma-separated local roots that workspaces may open. |
| `DEVSPACE_PUBLIC_BASE_URL` | Public origin for the server, without `/mcp`. |
| `DEVSPACE_ALLOWED_HOSTS` | Optional Host header allowlist override. |
| `DEVSPACE_OAUTH_OWNER_TOKEN` | Owner password for OAuth approval. Must be at least 16 characters. |
| `DEVSPACE_WORKTREE_ROOT` | Directory for managed Git worktrees. Defaults to `~/.devspace/worktrees`. |
| `DEVSPACE_STATE_DIR` | Directory for SQLite state. Defaults to `~/.local/share/devspace`. |
| `DEVSPACE_LIVE_SESSIONS` | Set to `1` to expose persistent native CLI session tools. Disabled by default. |

## Persistent Native CLI Sessions

Live Sessions are an opt-in local execution feature for letting an MCP host drive a real native terminal program while the user watches it safely. The host remains the semantic Controller; DevSpace only transports exact input bytes, exposes bounded rendered state, and persists mechanical lifecycle state.

Enable the feature with either:

```bash
npx @waishnav/devspace config set liveSessions true
```

or for one server run:

```bash
DEVSPACE_LIVE_SESSIONS=1 npx @waishnav/devspace serve
```

This path currently requires a POSIX environment with `tmux` available on `PATH`. It has been exercised on macOS. Windows support is not claimed for this feature.

When enabled, the MCP surface adds:

- `live_list_sessions`
- `live_start_session`
- `live_read_session`
- `live_send_input`
- `live_brake_session`
- `live_resolve_session`

These tools are independent of `DEVSPACE_TOOL_MODE`; they can be exposed alongside the default `minimal` surface.

`live_start_session` launches the requested executable directly with argv values rather than interpolating a shell command. DevSpace keeps the real program inside a persistent tmux PTY. Session state is stored in DevSpace's SQLite state so interrupted or unavailable work remains visible across DevSpace restarts.

Before sending input, the host must call `live_read_session`, inspect the rendered state, and pass its returned screen fingerprint unchanged to `live_send_input`. DevSpace rechecks that fingerprint immediately before pasting input. If the screen changed — for example because a trust, update, or approval prompt appeared — the send fails and the host must read again rather than retry blindly.

`live_send_input.text` is transported literally. Embedded terminal control characters are therefore not rewritten or blocked and may be interpreted by the native TTY; use `live_brake_session` or the monitor Emergency Brake for managed interrupts so interrupted lifecycle state is persisted first.

The user can watch active sessions with:

```bash
npx @waishnav/devspace live watch
```

The monitor provides mouse-selectable tabs in a fixed status bar that remains visible while worker output scrolls. Running sessions use a green background with white text; the currently selected tab is additionally bold. Any non-running mechanical state (`completed`, `failed`, `interrupted_by_user`, `interrupted_by_controller`, or `unavailable`) uses a red background with white text. Each inner worker view is attached read-only, so ordinary accidental typing does not reach the worker. `Ctrl-C` in this monitor is reserved as the user Emergency Brake for the currently selected live session. User Brake records `interrupted_by_user`; a Controller-initiated `live_brake_session` records `interrupted_by_controller`. Both are persisted before signalling and neither state is automatically resumed.

**To stop watching without stopping the worker, click the black `[ Close Monitor ]` control with green text on the right side of the tmux status bar. Do not press `Ctrl-C` just to leave the monitor.** The close control shuts down only the outer monitor and its inner read-only viewer clients; the separate worker tmux server and managed workers continue running. After the command returns to the shell, the Terminal tab or window can be closed normally without terminating the worker.

Use:

```bash
npx @waishnav/devspace live list
npx @waishnav/devspace live resolve <id>
```

`live resolve` only records that the user and Controller have reconciled an `interrupted_by_user`, `interrupted_by_controller`, or `unavailable` session. It does not restart, resume, or delete the old process/session state.

Brake snapshots the managed pane process tree before the first interrupt and tracks process-group identities across escalation, so descendants that were still owned by that tree at Brake time are stopped even if the pane parent exits first. A process that had already fully daemonized, reparented away from the managed tree, and detached from the controlling terminal before Brake is outside the terminal's safely provable ownership boundary; DevSpace does not guess at unrelated system processes.

## Native Artifact Download

Native-file download is disabled by default. Enable it when ChatGPT needs to hand
an attached or generated file into an already-open workspace:

```bash
DEVSPACE_ARTIFACTS=1 npx @waishnav/devspace serve
```

This feature currently supports Linux. It is not registered on macOS, Windows,
or BSD because the secure publication path depends on traversable,
descriptor-anchored directory paths provided by Linux procfs.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEVSPACE_ARTIFACTS` | `0` | Expose `download_artifact` for trusted native files. |
| `DEVSPACE_ARTIFACT_MAX_FILE_BYTES` | `104857600` | Maximum streamed size of one file (100 MiB). |

The same settings may be persisted in `~/.devspace/config.json` as
`artifactsEnabled` and `artifactMaxFileBytes`.

`download_artifact` accepts the native file object supplied by the MCP connector,
a `workspaceId` returned by `open_workspace`, and a relative workspace `path`.
DevSpace safely creates missing parent directories, refuses to overwrite an
existing destination, and returns only the normalized workspace-relative path.
It does not accept conflict modes, expected hashes, arbitrary URL strings, local
paths, embedded credentials, or extra object fields.

There is no artifact root, total quota, TTL, pinning, persistent database record,
or background artifact cleanup service. See [Native File Download](artifact-exchange.md)
for the supported connector shape and security boundaries.

## OAuth

DevSpace uses a single-user OAuth approval flow.

| Variable | Default |
| --- | --- |
| `DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` |
| `DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` |
| `DEVSPACE_OAUTH_SCOPES` | `devspace` |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | `chatgpt.com,localhost,127.0.0.1` |

MCP clients discover metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

## Tool Modes

`DEVSPACE_TOOL_MODE` controls the tool surface.

| Value | Behavior |
| --- | --- |
| `minimal` | Default. Exposes `open_workspace`, `read`, `write`, `edit`, and `bash`. Clients use `bash` with tools such as `rg`, `find`, and `ls` for inspection. |
| `full` | Exposes the minimal tools plus dedicated `grep`, `glob`, and `ls` tools. |
| `codex` | Experimental. Exposes `open_workspace`, `read`, `apply_patch`, `exec_command`, and `write_stdin`. Existing mutation and shell tools are hidden. |

`DEVSPACE_MINIMAL_TOOLS` remains a backward-compatible alias when
`DEVSPACE_TOOL_MODE` is unset: `1` selects `minimal` and `0` selects `full`.
The `codex` mode must be selected through `DEVSPACE_TOOL_MODE` and always uses
its fixed short tool names regardless of `DEVSPACE_TOOL_NAMING`.

Codex-mode commands run without a PTY by default. Set `tty: true` on
`exec_command` for interactive terminal programs. PTY support uses the optional
`node-pty` dependency; `write_stdin` can send input, poll output, and resize PTY
sessions.

## Widgets

`DEVSPACE_WIDGETS` controls ChatGPT Apps iframe usage.

| Value | Behavior |
| --- | --- |
| `full` | Default. Widget UI is attached to exposed workspace, file, edit, and shell tools. |
| `changes` | Enables the aggregate `show_changes` tool and attaches widget UI to `open_workspace` and `show_changes`. |
| `off` | Disables widget UI. |

## Skills

| Variable | Purpose |
| --- | --- |
| `DEVSPACE_SKILLS` | Set to `0` to hide skills. Enabled by default. |
| `DEVSPACE_SUBAGENTS` | Set to `1` to expose configured agent profiles as Subagents. Experimental and disabled by default. |
| `DEVSPACE_AGENT_DIR` | Defaults to `~/.codex`; its `skills` child is loaded for compatibility. |
| `DEVSPACE_SKILL_PATHS` | Optional comma-separated additional skill directories. |

DevSpace discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`
- `~/.devspace/skills`

It also keeps compatibility with:

- the bundled `subagent-delegation` skill when `DEVSPACE_SUBAGENTS=1`, unless `~/.devspace/skills/subagent-delegation/SKILL.md` exists
- `DEVSPACE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `DEVSPACE_SKILL_PATHS`

When Subagents are enabled, DevSpace discovers agent profiles
from:

- `~/.devspace/agents/*.md`
- project `.devspace/agents/*.md`

`open_workspace` returns a compact catalog containing profile names,
descriptions, providers, and optional models/thinking levels so the host model can choose an
agent without reading provider-specific launch details. `devspace agents ls`
lists existing subagent sessions for the current workspace, scoped by the
workspace environment injected into shell commands. The `subagent-delegation`
skill teaches the model to use only the minimal `devspace agents ls`,
`devspace agents run`, and `devspace agents show` workflow.

Starter profile templates are available under `examples/agents/`. Copy or adapt
them into one of the active profile directories before use.

Legacy project paths such as `.pi/skills` can be added through `DEVSPACE_SKILL_PATHS` when needed.

Example:

```bash
DEVSPACE_SKILL_PATHS="$HOME/.claude/skills,$HOME/company/skills" \
npx @waishnav/devspace serve
```

## Logging

| Variable | Default |
| --- | --- |
| `DEVSPACE_LOG_LEVEL` | `info` |
| `DEVSPACE_LOG_FORMAT` | `json` |
| `DEVSPACE_LOG_REQUESTS` | `1` |
| `DEVSPACE_LOG_ASSETS` | `0` |
| `DEVSPACE_LOG_TOOL_CALLS` | `1` |
| `DEVSPACE_LOG_SHELL_COMMANDS` | `0` |
| `DEVSPACE_TRUST_PROXY` | `0` |

Set `DEVSPACE_LOG_FORMAT=pretty` for local debugging.

Set `DEVSPACE_LOG_SHELL_COMMANDS=1` only when you intentionally want command
previews in logs.

## Env-Only Example

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)" \
DEVSPACE_ALLOWED_ROOTS="$HOME/personal,$HOME/work" \
DEVSPACE_PUBLIC_BASE_URL="https://devspace.example.com" \
DEVSPACE_WORKTREE_ROOT="$HOME/.devspace/worktrees" \
DEVSPACE_ARTIFACTS="1" \
DEVSPACE_TOOL_MODE="minimal" \
DEVSPACE_WIDGETS="full" \
npx @waishnav/devspace serve
```

The environment assignments must be part of the same command invocation, or
exported first.
