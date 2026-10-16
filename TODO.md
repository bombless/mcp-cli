# TODO

## Separate authentication state from MCP tool cache

- [ ] Keep OAuth/authentication state (`access_token`, `refresh_token`, client metadata, and pending PKCE state) separate from the cached MCP tool list and schemas.
  - [ ] Store the tool list plus input/output schemas in a dedicated cache file (for example, `tools-cache.json`).
  - [ ] Keep `auth.json` focused on authentication state.
- [ ] Add `mcp refresh` to re-run `tools/list` and replace the local tool/schema cache without requiring OAuth re-authentication.
- [ ] Make `mcp help` show current cached or freshly refreshed tool information consistently; ensure `mcp help <tool-name>` can show both input and output schemas when supplied by the server.
- [ ] Keep `mcp rollback` scoped to restoring authentication state from before the last `mcp connect`; it should not roll back the server's current tool list or restore stale tool schemas.
- [ ] Consider handling `notifications/tools/list_changed` so a long-lived client can refresh its tool cache when the server signals changes.
- [ ] Add tests for tool additions/removals/schema changes, refresh without OTP, and rollback without changing the tool cache.

## Connection and rollback behavior

- [ ] Keep `mcp connect` idempotent when saved credentials are valid; only require `mcp otp` when OAuth authorization is actually needed.
- [ ] Test rollback both when an auth file existed before `mcp connect` and when no auth file existed.
