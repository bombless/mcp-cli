# mcp-cli

A TypeScript/Node.js command-line client for the OAuth-protected remote MCP server used by [bombless/feishu-bot PR #4](https://github.com/bombless/feishu-bot/pull/4).

## Requirements

- Node.js 20+
- Access to the configured remote MCP server (`https://bombless.duckdns.org/mcp`)

## Install

Requires Node.js 20 or later and npm. Install the latest version from the repository's default branch:

```sh
npm install -g bombless/mcp-cli
```

This installs the `mcp` command globally. You can also use the full Git URL:

```sh
npm install -g git+https://github.com/bombless/mcp-cli.git
```

To install a specific tag or branch, append `#<tag-or-branch>` to the GitHub shorthand, for example `npm install -g bombless/mcp-cli#v0.1.0`.

### Install from a GitHub Release tarball (recommended, no token needed)

Each version tag (for example `v0.1.1`, which must match `version` in `package.json`) gets a [GitHub Release](https://github.com/bombless/mcp-cli/releases) with a prebuilt tarball attached. The tarball already contains the compiled `dist/`, so no build step runs on your machine and no token is required.

Install the latest release:

```sh
npm install -g https://github.com/bombless/mcp-cli/releases/latest/download/mcp-cli.tgz
```

Install a specific version (replace `0.1.1` with the version you want):

```sh
npm install -g https://github.com/bombless/mcp-cli/releases/download/v0.1.1/bombless-mcp-cli-0.1.1.tgz
```

Or download the tarball first (for offline or air-gapped machines) and install the local file:

```sh
curl -L -O https://github.com/bombless/mcp-cli/releases/latest/download/mcp-cli.tgz
npm install -g ./mcp-cli.tgz
```

Each release has two identical assets: `bombless-mcp-cli-<version>.tgz` (versioned) and `mcp-cli.tgz` (stable name, used by the `latest` URL above).

To upgrade, run the same install command again. To uninstall:

```sh
npm uninstall -g @bombless/mcp-cli
```

### Install from GitHub Packages

The same tag also publishes that version to the GitHub npm registry. Note that GitHub Packages requires authentication even for public packages, so you need a classic personal access token with the `read:packages` scope:

```sh
npm config set @bombless:registry https://npm.pkg.github.com
npm config set //npm.pkg.github.com/:_authToken <YOUR_TOKEN>
npm install -g @bombless/mcp-cli
```

## Development

```sh
git clone https://github.com/bombless/mcp-cli.git
cd mcp-cli
npm install
npm run compile
npm link
```

Or run during development with `npm run dev -- <arguments>`.

## Commands

Connection/configuration management uses options; remote tools remain positional commands:

- `mcp --connect` — reuse saved credentials if valid, otherwise prepare OAuth authorization over HTTP (no browser).
- `mcp --otp <six-digit-code>` — complete a pending OAuth authorization.
- `mcp --disconnect` — remove local credentials, pending authorization, and rollback backup; the tool cache is retained. This does not revoke tokens on the remote authorization server.
- `mcp --rollback` — restore the exact authentication-file state from before the most recent `mcp --connect`. Intended for testing or undoing that connect operation; it does not change the tool cache.
- `mcp --refresh` — fetch the latest `tools/list` and replace the local tool cache without re-authenticating.
- `mcp --help` — show the connection state, latest tool list, and usage.
- `mcp --help <tool-name>` — show a tool's description and input/output schemas when supplied by the server.
- `mcp --version` — show the CLI version.
- `mcp <tool-name> '<json-object>'` — call a remote MCP tool and print its result.

Example:

```sh
mcp --connect
# Only if authorization is requested, submit a current authenticator code:
mcp --otp 123456
mcp --help
mcp --help list_agents
mcp --refresh
mcp list_agents '{"query":"hello"}'
mcp --disconnect
```

The example OTP and tool name are placeholders.

## Authentication and cache files

OAuth uses dynamic client registration and PKCE. Authentication data (access/refresh tokens, client metadata, and pending PKCE state) is stored in `~/.config/mcp-cli/auth.json` (or the path in `MCP_AUTH_FILE`) with owner-only file permissions. Do not share this file or commit it. If authorization expires, run `mcp --connect` and follow the OTP prompt if needed.

The MCP tool list and schemas are stored separately in `auth.json.tools-cache.json`, with owner-only permissions. `mcp --refresh` replaces this cache with the server's current tool definitions. The CLI also refreshes the cache when it lists tools during connection, help, or a tool call. Older `auth.json` files containing `tool_output_schemas` are migrated into the separate cache on first read.

`mcp --connect` snapshots the previous authentication file to `auth.json.connect-backup`. A new `mcp --connect` replaces the previous snapshot. Use `mcp --rollback` before another connect if you need to undo the latest one. `mcp --disconnect` removes credentials and any rollback snapshot, but keeps the tool cache.

The remote endpoint can be overridden with `MCP_URL`.

## Notes

The CLI uses MCP JSON-RPC over HTTP, including session IDs and JSON/SSE responses. The current implementation initializes a protocol session for each command process. Server-specific OAuth approval behavior follows the flow described in feishu-bot PR #4. Verify compatibility against your remote MCP deployment.
