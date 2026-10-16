# TODO

## MCP tool cache and session updates

- [x] Separate OAuth/authentication state from the cached MCP tool list and schemas.
- [x] Store the tool list plus input/output schemas in a dedicated cache file, separate from `auth.json`.
- [x] Add `mcp --refresh` to re-run `tools/list` and replace the local tool/schema cache without OAuth re-authentication.
- [x] Make `mcp --help` and `mcp --help <tool-name>` show the current tool list and input/output schemas when supplied by the server.
- [x] Keep `mcp --rollback` scoped to restoring authentication state from before the last `mcp --connect`; it does not roll back tool cache contents.
- [ ] Consider handling `notifications/tools/list_changed` in a future long-running client; the current CLI process exits after each command.
- [ ] Add automated tests for tool additions/removals/schema changes, refresh without OTP, and rollback without changing the tool cache.

## Unified command syntax

- [x] Replace `mcp connect`, `mcp otp`, and `mcp help` with `mcp --connect`, `mcp --otp <code>`, and `mcp --help [tool-name]`.
- [x] Add `mcp --disconnect` to clear local authentication and pending authorization while retaining the tool cache.
- [x] Keep `mcp --rollback` for restoring the exact pre-connect authentication state for testing/undo.
- [x] Keep `mcp <tool-name> [json-arguments]` as the direct remote-tool invocation syntax.
- [x] Keep `mcp --connect` idempotent when saved credentials are valid; only require OTP when OAuth authorization is actually needed.
- [x] Test rollback when an auth file existed before connect and when no auth file existed (manual temporary-file test).
- [ ] Add automated tests for option parsing, disconnect semantics, and rollback behavior.
