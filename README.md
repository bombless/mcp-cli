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

- `mcp connect` — reuse a saved token or start OAuth authorization and print the login URL.
- `mcp otp <six-digit-code>` — submit the one-time code, finish OAuth, initialize MCP, and discover tools.
- `mcp help` — show connection state, available remote tools, descriptions, and usage.
- `mcp help <tool-name>` — show that tool's input schema.
- `mcp <tool-name> '<json-object>'` — call a remote tool and print its result.

Example:

```sh
mcp connect
# Open the printed authorization URL, then enter the six-digit code:
mcp otp 123456
mcp help
mcp help tool-foo
mcp tool-foo '{"query":"hello"}'
```

The example OTP and tool name are placeholders.

## Authentication and security

OAuth uses dynamic client registration and PKCE. Access/refresh tokens and pending PKCE state are stored in `~/.config/mcp-cli/auth.json` (or the path in `MCP_AUTH_FILE`) with owner-only file permissions. Do not share this file or commit it. If authorization expires, run `mcp connect` again.

The remote endpoint can be overridden with `MCP_URL`.

## Notes

The CLI uses MCP JSON-RPC over HTTP, including session IDs and JSON/SSE responses. Server-specific OAuth approval behavior follows the flow described in feishu-bot PR #4. Verify compatibility against your remote MCP deployment.
