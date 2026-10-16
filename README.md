# mcp-cli

A TypeScript/Node.js command-line client for the OAuth-protected remote MCP server used by [bombless/feishu-bot PR #4](https://github.com/bombless/feishu-bot/pull/4).

## Requirements

- Node.js 20+
- Access to the configured remote MCP server (`https://bombless.duckdns.org/mcp`)

## Install and run

```sh
npm install
npm run build
npm link
```

Or run during development with `npm run dev -- <command>`.

## Commands

- `mcp connect` — save a rollback snapshot, then reuse a saved token or prepare the OAuth authorization session over HTTP (no browser).
- `mcp rollback` (or `mcp connect --rollback`) — restore the exact auth-file contents from before the most recent `mcp connect`, including undoing state changes made later by `mcp otp`.
- `mcp otp <six-digit-code>` — submit the one-time code, finish OAuth, initialize MCP, and discover tools.
- `mcp help` — show connection state, available remote tools, descriptions, and usage.
- `mcp help <tool-name>` — show that tool's input schema and its output schema when the server provides one.
- `mcp <tool-name> '<json-object>'` — call a remote tool and print its result.

Example:

```sh
mcp connect
# Enter the current six-digit authenticator code directly; no browser needed:
mcp otp 123456
mcp help
mcp help tool-foo
mcp tool-foo '{"query":"hello"}'
```

The example OTP and tool name are placeholders.

## Authentication and security

OAuth uses dynamic client registration and PKCE. Access/refresh tokens and pending PKCE state are stored in `~/.config/mcp-cli/auth.json` (or the path in `MCP_AUTH_FILE`) with owner-only file permissions. Do not share this file or commit it. If authorization expires, run `mcp connect` again.

The remote endpoint can be overridden with `MCP_URL`. The connect rollback snapshot is stored next to the auth file as `auth.json.connect-backup` (or alongside the path set by `MCP_AUTH_FILE`) with owner-only permissions. A new `mcp connect` replaces the previous snapshot; run `mcp rollback` before starting another connect operation if you want to undo the earlier one.

## Notes

The CLI uses MCP JSON-RPC over HTTP, including session IDs and JSON/SSE responses. Server-specific OAuth approval behavior follows the flow described in feishu-bot PR #4. Verify compatibility against your remote MCP deployment.
