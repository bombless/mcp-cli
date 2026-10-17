#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, chmod, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
const ENDPOINT = process.env.MCP_URL ?? "https://bombless.duckdns.org/mcp";
const AUTH_FILE = process.env.MCP_AUTH_FILE ?? join(homedir(), ".config", "mcp-cli", "auth.json");
const CONNECT_BACKUP_FILE = AUTH_FILE + ".connect-backup";
const TOOL_CACHE_FILE = AUTH_FILE + ".tools-cache.json";
const REDIRECT_URI = "http://127.0.0.1:43127/oauth/callback";
const CLIENT_NAME = "mcp-cli";
let sessionId;
let requestId = 0;
function random(size = 32) { return randomBytes(size).toString("base64url"); }
function wellKnown(base, suffix) { return new URL(base).origin + "/.well-known/" + suffix; }
async function loadState() {
    try {
        const parsed = JSON.parse(await readFile(AUTH_FILE, "utf8"));
        if (parsed.tool_output_schemas) {
            // One-time migration from the old auth.json schema cache into the dedicated tool cache.
            if (!(await loadToolCache())) {
                await saveToolCache(Object.entries(parsed.tool_output_schemas).map(([name, outputSchema]) => ({ name, outputSchema })));
            }
            delete parsed.tool_output_schemas;
            await saveState(parsed);
        }
        return parsed;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return {};
        throw new Error("Could not read the authentication state file.");
    }
}
async function saveState(state) {
    await mkdir(dirname(AUTH_FILE), { recursive: true, mode: 0o700 });
    await writeFile(AUTH_FILE, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await chmod(AUTH_FILE, 0o600).catch(() => undefined);
}
async function backupConnectState() {
    let snapshot;
    try {
        snapshot = { existed: true, content: await readFile(AUTH_FILE, "utf8") };
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
        snapshot = { existed: false };
    }
    await mkdir(dirname(CONNECT_BACKUP_FILE), { recursive: true, mode: 0o700 });
    await writeFile(CONNECT_BACKUP_FILE, JSON.stringify(snapshot), { encoding: "utf8", mode: 0o600 });
    await chmod(CONNECT_BACKUP_FILE, 0o600).catch(() => undefined);
}
async function rollbackConnect() {
    let snapshot;
    try {
        snapshot = JSON.parse(await readFile(CONNECT_BACKUP_FILE, "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT") {
            throw new Error('No connect backup found. Run "mcp --connect" before "mcp --rollback".');
        }
        throw new Error("Could not read the connect backup; auth state was not changed.");
    }
    if (snapshot.existed) {
        if (typeof snapshot.content !== "string")
            throw new Error("Connect backup is invalid; auth state was not changed.");
        await mkdir(dirname(AUTH_FILE), { recursive: true, mode: 0o700 });
        await writeFile(AUTH_FILE, snapshot.content, { encoding: "utf8", mode: 0o600 });
        await chmod(AUTH_FILE, 0o600).catch(() => undefined);
    }
    else {
        await unlink(AUTH_FILE).catch(error => {
            if (error.code !== "ENOENT")
                throw error;
        });
    }
    await unlink(CONNECT_BACKUP_FILE);
    console.log("Rolled back the last mcp --connect operation. The previous authentication state has been restored.");
}
async function saveToolCache(tools) {
    await mkdir(dirname(TOOL_CACHE_FILE), { recursive: true, mode: 0o700 });
    await writeFile(TOOL_CACHE_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), tools }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await chmod(TOOL_CACHE_FILE, 0o600).catch(() => undefined);
}
async function loadToolCache() {
    try {
        const cache = JSON.parse(await readFile(TOOL_CACHE_FILE, "utf8"));
        return Array.isArray(cache.tools) ? cache : undefined;
    }
    catch {
        return undefined;
    }
}
async function disconnect() {
    for (const file of [AUTH_FILE, CONNECT_BACKUP_FILE]) {
        await unlink(file).catch(error => {
            if (error.code !== "ENOENT")
                throw error;
        });
    }
    console.log("Disconnected locally. Saved credentials, pending authorization, and rollback backup were removed; tool cache was kept.");
}
async function responseJson(response) {
    const text = await response.text();
    let body;
    try {
        body = text ? JSON.parse(text) : {};
    }
    catch {
        body = undefined;
    }
    if (!response.ok)
        throw new Error("HTTP " + response.status + ": " + (body?.error_description ?? body?.error ?? text.slice(0, 500)));
    return body ?? {};
}
async function getJson(url) { return responseJson(await fetch(url, { headers: { Accept: "application/json" } })); }
function tokenEndpoint(meta) {
    if (!meta.token_endpoint)
        throw new Error("OAuth discovery did not provide token_endpoint");
    return meta.token_endpoint;
}
async function connect() {
    await backupConnectState();
    const saved = await loadState();
    if (saved.access_token) {
        try {
            const tools = await initializeAndList(saved.access_token);
            await saveToolCache(tools);
            console.log(`Already connected. Discovered ${tools.length} tool(s). Run "mcp --help" to list them.`);
            return;
        }
        catch (error) {
            console.error("Saved access token could not connect:", error instanceof Error ? error.message : String(error));
            delete saved.access_token;
        }
    }
    const resourceMeta = await getJson(wellKnown(ENDPOINT, "oauth-protected-resource"));
    const authServer = resourceMeta.authorization_servers?.[0] ?? new URL(ENDPOINT).origin;
    let authMeta;
    try {
        authMeta = await getJson(wellKnown(authServer, "oauth-authorization-server"));
    }
    catch {
        authMeta = await getJson(new URL("/.well-known/openid-configuration", authServer).toString());
    }
    if (!authMeta.authorization_endpoint || !authMeta.token_endpoint || !authMeta.registration_endpoint)
        throw new Error("OAuth discovery is missing authorization_endpoint, token_endpoint, or registration_endpoint");
    let clientInfo = saved.client_info;
    if (!clientInfo || typeof clientInfo.client_id !== "string") {
        const registered = await responseJson(await fetch(authMeta.registration_endpoint, {
            method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ client_name: CLIENT_NAME, redirect_uris: [REDIRECT_URI],
                grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" })
        }));
        if (typeof registered.client_id !== "string" || !registered.client_id)
            throw new Error("OAuth dynamic registration did not return client_id");
        clientInfo = registered;
    }
    if (!clientInfo || typeof clientInfo.client_id !== "string") {
        throw new Error("OAuth client information is missing a valid client_id");
    }
    const verifier = random(48);
    const challenge = Buffer.from(await cryptoSubtleSha256(verifier)).toString("base64url");
    const stateValue = random(24);
    const authorize = new URL(authMeta.authorization_endpoint);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", String(clientInfo.client_id));
    authorize.searchParams.set("redirect_uri", REDIRECT_URI);
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("state", stateValue);
    if (resourceMeta.resource)
        authorize.searchParams.set("resource", resourceMeta.resource);
    if (resourceMeta.scopes_supported?.length)
        authorize.searchParams.set("scope", resourceMeta.scopes_supported.join(" "));
    await saveState({ ...saved, client_info: clientInfo, pending: {
            verifier, state: stateValue, redirectUri: REDIRECT_URI, createdAt: Date.now(), clientInfo, authMeta,
            resource: resourceMeta.resource, scopes: resourceMeta.scopes_supported
        } });
    console.log("Authorization request prepared over HTTP. No browser is needed.");
    console.log("Enter the current six-digit authenticator code: mcp --otp <six-digit-code>");
    console.log("The authorization request expires in 5 minutes.");
}
async function cryptoSubtleSha256(value) {
    return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
async function submitOtp(codeArg) {
    const code = (codeArg ?? "").replace(/\s+/g, "");
    if (!/^\d{6}$/.test(code))
        throw new Error("Usage: mcp --otp <six-digit-code>");
    const saved = await loadState();
    const pending = saved.pending;
    if (!pending)
        throw new Error('No pending authorization. Run "mcp --connect" first.');
    if (Date.now() - pending.createdAt > 5 * 60 * 1000) {
        delete saved.pending;
        await saveState(saved);
        throw new Error('Authorization expired. Run "mcp --connect" again.');
    }
    const approveUrl = new URL("/oauth/authorize/approve", new URL(pending.authMeta.authorization_endpoint).origin);
    approveUrl.searchParams.set("client_id", String(pending.clientInfo.client_id));
    approveUrl.searchParams.set("redirect_uri", pending.redirectUri);
    approveUrl.searchParams.set("state", pending.state);
    approveUrl.searchParams.set("code_challenge", Buffer.from(await cryptoSubtleSha256(pending.verifier)).toString("base64url"));
    const approval = await fetch(approveUrl, { method: "POST", redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" },
        body: new URLSearchParams({ totp: code }) });
    if (approval.status !== 302 && approval.status !== 303) {
        const body = (await approval.text()).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
        if (approval.status === 401)
            throw new Error("Invalid or expired OTP code.");
        throw new Error(`OAuth approval failed (${approval.status}): ${body.slice(0, 300)}`);
    }
    const location = approval.headers.get("location");
    if (!location)
        throw new Error("OAuth approval response has no redirect Location");
    const callback = new URL(location, pending.redirectUri);
    if (callback.searchParams.get("state") !== pending.state)
        throw new Error("OAuth state validation failed");
    const oauthError = callback.searchParams.get("error");
    if (oauthError)
        throw new Error("OAuth authorization failed: " + oauthError);
    const authCode = callback.searchParams.get("code");
    if (!authCode)
        throw new Error("OAuth callback did not contain an authorization code");
    const tokenResponse = await responseJson(await fetch(tokenEndpoint(pending.authMeta), {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: authCode, redirect_uri: pending.redirectUri,
            client_id: String(pending.clientInfo.client_id), code_verifier: pending.verifier })
    }));
    if (!tokenResponse.access_token)
        throw new Error("OAuth token response did not contain access_token");
    const next = { ...saved, access_token: tokenResponse.access_token, refresh_token: tokenResponse.refresh_token,
        client_info: pending.clientInfo, auth_meta: pending.authMeta };
    delete next.pending;
    await saveState(next);
    const tools = await initializeAndList(next.access_token);
    await saveToolCache(tools);
    console.log(`Connected successfully. Discovered ${tools.length} tool(s). Run "mcp --help" to see them.`);
}
async function mcpRequest(accessToken, method, params = {}) {
    const response = await fetch(ENDPOINT, { method: "POST", headers: {
            Authorization: "Bearer " + accessToken, "Content-Type": "application/json",
            Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26",
            ...(sessionId ? { "MCP-Session-Id": sessionId } : {})
        }, body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }) });
    if (response.status === 401)
        throw new Error('MCP token expired or unauthorized. Run "mcp --connect" again.');
    const sid = response.headers.get("mcp-session-id");
    if (sid)
        sessionId = sid;
    const text = await response.text();
    if (!response.ok)
        throw new Error(`MCP request failed (${response.status}): ${text.slice(0, 500)}`);
    if (!text.trim())
        return {};
    let payload;
    try {
        payload = JSON.parse(text);
    }
    catch {
        const lines = text.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim());
        for (const line of lines.reverse()) {
            try {
                payload = JSON.parse(line);
                if (payload?.id !== undefined || payload?.result || payload?.error)
                    break;
            }
            catch { /* next SSE event */ }
        }
    }
    if (!payload)
        throw new Error("Could not parse MCP JSON/SSE response: " + text.slice(0, 300));
    if (payload.error)
        throw new Error(`MCP error ${payload.error.code}: ${payload.error.message}`);
    return payload.result ?? {};
}
async function mcpNotification(accessToken, method, params = {}) {
    const response = await fetch(ENDPOINT, { method: "POST", headers: {
            Authorization: "Bearer " + accessToken, "Content-Type": "application/json",
            Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26",
            ...(sessionId ? { "MCP-Session-Id": sessionId } : {})
        }, body: JSON.stringify({ jsonrpc: "2.0", method, params }) });
    const sid = response.headers.get("mcp-session-id");
    if (sid)
        sessionId = sid;
    if (!response.ok && response.status !== 202) {
        const text = await response.text();
        throw new Error(`MCP notification ${method} failed (${response.status}): ${text.slice(0, 300)}`);
    }
}
async function initializeAndList(accessToken) {
    await mcpRequest(accessToken, "initialize", { protocolVersion: "2025-03-26", capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: "0.1.0" } });
    // MCP notifications are JSON-RPC messages without an id and must not expect a JSON-RPC result.
    await mcpNotification(accessToken, "notifications/initialized");
    const result = await mcpRequest(accessToken, "tools/list", {});
    return Array.isArray(result.tools) ? result.tools : [];
}
function pretty(value) { return JSON.stringify(value, null, 2); }
async function refreshTools() {
    const saved = await loadState();
    if (!saved.access_token)
        throw new Error('Not connected. Run "mcp --connect" and, if prompted, "mcp --otp <six-digit-code>" first.');
    const tools = await initializeAndList(saved.access_token);
    await saveToolCache(tools);
    return tools;
}
async function showHelp(toolName) {
    const saved = await loadState();
    if (!saved.access_token) {
        const cache = await loadToolCache();
        console.log('Not connected. Run "mcp --connect" and, if prompted, "mcp --otp <six-digit-code>".');
        if (cache) {
            console.log(`Cached tool list from ${cache.updatedAt} (${cache.tools.length} tool(s)); run "mcp --refresh" after connecting to update it.`);
            if (toolName) {
                const tool = cache.tools.find(item => item.name === toolName);
                if (!tool) {
                    console.error(`Unknown cached tool "${toolName}". Run "mcp --help" to list cached tools.`);
                    process.exitCode = 1;
                    return;
                }
                const outputSection = tool.outputSchema ? `\n\nOutput schema:\n${pretty(tool.outputSchema)}` : "\n\nOutput schema: Not provided by server.";
                console.log(`${tool.name}${tool.description ? " — " + tool.description : ""}\nInput schema:\n${pretty(tool.inputSchema ?? { type: "object", properties: {} })}${outputSection}`);
                return;
            }
            for (const tool of cache.tools)
                console.log(`- ${tool.name}${tool.description ? ": " + tool.description : ""}`);
        }
        printUsage();
        return;
    }
    const tools = await refreshTools();
    if (toolName) {
        const tool = tools.find(item => item.name === toolName);
        if (!tool) {
            console.error(`Unknown tool "${toolName}". Run "mcp --help" to list available tools.`);
            process.exitCode = 1;
            return;
        }
        const outputSection = tool.outputSchema
            ? `\n\nOutput schema:\n${pretty(tool.outputSchema)}`
            : "\n\nOutput schema: Not provided by server.";
        console.log(`${tool.name}${tool.description ? " — " + tool.description : ""}\nInput schema:\n${pretty(tool.inputSchema ?? { type: "object", properties: {} })}${outputSection}\n\nUsage: mcp ${tool.name} '<json-object>'`);
        return;
    }
    console.log(`Remote MCP: ${ENDPOINT}\nConnected. ${tools.length} tool(s) available.\n`);
    if (!tools.length)
        console.log("The server did not advertise any tools.");
    for (const tool of tools)
        console.log(`- ${tool.name}${tool.description ? ": " + tool.description : ""}`);
    console.log("");
    printUsage();
}
function printUsage() {
    console.log("Usage:");
    console.log("  mcp --connect                 Check saved credentials or start OAuth authorization");
    console.log("  mcp --otp <six-digit-code>    Complete pending OAuth authorization");
    console.log("  mcp --disconnect              Remove local authentication credentials");
    console.log("  mcp --rollback                Restore authentication state from before the last --connect");
    console.log("  mcp --refresh                 Refresh the MCP tool list and schemas without re-authenticating");
    console.log("  mcp --help [tool-name]        Show tool list or a tool's input/output schemas");
    console.log("  mcp --version                 Show CLI version");
    console.log("  mcp <tool-name> '<json>'      Call a remote MCP tool with JSON arguments");
    console.log("\nExamples:");
    console.log("  mcp --connect");
    console.log("  mcp --otp 123456");
    console.log("  mcp --help list_agents");
    console.log("  mcp list_agents '{\"query\":\"hello\"}'");
}
async function callTool(name, jsonArg) {
    const saved = await loadState();
    if (!saved.access_token)
        throw new Error('Not connected. Run "mcp --connect" and, if prompted, "mcp --otp <six-digit-code>" first.');
    let args = {};
    if (jsonArg !== undefined) {
        let parsed;
        try {
            parsed = JSON.parse(jsonArg);
        }
        catch {
            throw new Error("Tool arguments must be valid JSON.");
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error("Tool arguments must be a JSON object, e.g. '{\"query\":\"hello\"}'.");
        args = parsed;
    }
    const tools = await initializeAndList(saved.access_token);
    await saveToolCache(tools);
    const result = await mcpRequest(saved.access_token, "tools/call", { name, arguments: args });
    console.log(pretty(result));
    if (result.isError)
        process.exitCode = 1;
}
async function main() {
    const [command, ...args] = process.argv.slice(2);
    if (!command || command === "--help" || command === "-h") {
        await showHelp(args[0]);
        return;
    }
    if (command === "--connect") {
        await connect();
        return;
    }
    if (command === "--otp") {
        await submitOtp(args[0]);
        return;
    }
    if (command === "--rollback") {
        await rollbackConnect();
        return;
    }
    if (command === "--disconnect") {
        await disconnect();
        return;
    }
    if (command === "--refresh") {
        const tools = await refreshTools();
        console.log(`Refreshed tool cache: ${tools.length} tool(s) saved to ${TOOL_CACHE_FILE}.`);
        return;
    }
    if (command === "--version" || command === "-v") {
        console.log("0.1.0");
        return;
    }
    if (command.startsWith("-")) {
        printUsage();
        throw new Error(`Unknown option: ${command}`);
    }
    await callTool(command, args[0]);
}
main().catch((error) => { console.error("Error:", error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
