#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const ENDPOINT = process.env.MCP_URL ?? "https://bombless.duckdns.org/mcp";
const AUTH_FILE = process.env.MCP_AUTH_FILE ?? join(homedir(), ".config", "mcp-cli", "auth.json");
const REDIRECT_URI = "http://127.0.0.1:43127/oauth/callback";
const CLIENT_NAME = "mcp-cli";
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Tool = { name: string; description?: string; inputSchema?: Record<string, unknown>; [key: string]: unknown };
type OAuthState = {
  access_token?: string;
  refresh_token?: string;
  client_info?: Record<string, unknown>;
  auth_meta?: Record<string, string>;
  pending?: {
    verifier: string; state: string; redirectUri: string; createdAt: number;
    clientInfo: Record<string, unknown>; authMeta: Record<string, string>;
    resource?: string; scopes?: string[];
  };
};
type ResourceMeta = { authorization_servers?: string[]; resource?: string; scopes_supported?: string[] };
let sessionId: string | undefined;
let requestId = 0;

function random(size = 32): string { return randomBytes(size).toString("base64url"); }
function b64url(data: Buffer): string { return data.toString("base64url"); }
function wellKnown(base: string, suffix: string): string {
  const url = new URL(base);
  return url.origin + "/.well-known/" + suffix;
}
async function loadState(): Promise<OAuthState> {
  try { return JSON.parse(await readFile(AUTH_FILE, "utf8")) as OAuthState; }
  catch { return {}; }
}
async function saveState(state: OAuthState): Promise<void> {
  await mkdir(dirname(AUTH_FILE), { recursive: true, mode: 0o700 });
  await writeFile(AUTH_FILE, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await chmod(AUTH_FILE, 0o600).catch(() => undefined);
}
async function responseJson(response: Response): Promise<any> {
  const text = await response.text();
  let body: any;
  try { body = text ? JSON.parse(text) : {}; } catch { body = undefined; }
  if (!response.ok) {
    const message = body?.error_description ?? body?.error ?? text.slice(0, 500);
    throw new Error("HTTP " + response.status + ": " + message);
  }
  return body ?? {};
}
async function getJson(url: string): Promise<any> {
  return responseJson(await fetch(url, { headers: { Accept: "application/json" } }));
}
function tokenEndpoint(meta: Record<string, string>): string {
  if (!meta.token_endpoint) throw new Error("OAuth discovery did not provide token_endpoint");
  return meta.token_endpoint;
}
async function connect(): Promise<void> {
  const saved = await loadState();
  if (saved.access_token) {
    try {
      const tools = await initializeAndList(saved.access_token);
      console.log(`Already connected. Discovered ${tools.length} tool(s). Run "mcp help" to list them.`);
      return;
    } catch (error) {
      console.error("Saved access token could not connect:", error instanceof Error ? error.message : String(error));
      if (!saved.refresh_token) delete saved.access_token;
    }
  }

  const resourceMeta = await getJson(wellKnown(ENDPOINT, "oauth-protected-resource")) as ResourceMeta;
  const authServer = resourceMeta.authorization_servers?.[0] ?? new URL(ENDPOINT).origin;
  let authMeta: Record<string, string>;
  try {
    authMeta = await getJson(wellKnown(authServer, "oauth-authorization-server"));
  } catch {
    authMeta = await getJson(new URL("/.well-known/openid-configuration", authServer).toString());
  }
  if (!authMeta.authorization_endpoint || !authMeta.token_endpoint || !authMeta.registration_endpoint) {
    throw new Error("OAuth discovery is missing authorization_endpoint, token_endpoint, or registration_endpoint");
  }
  let clientInfo = saved.client_info;
  if (!clientInfo || typeof clientInfo.client_id !== "string") {
    clientInfo = await responseJson(await fetch(authMeta.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        redirect_uris: [REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none"
      })
    }));
    if (!clientInfo.client_id) throw new Error("OAuth dynamic registration did not return client_id");
  }

  const verifier = random(48);
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const stateValue = random(24);
  const authorize = new URL(authMeta.authorization_endpoint);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", String(clientInfo.client_id));
  authorize.searchParams.set("redirect_uri", REDIRECT_URI);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("state", stateValue);
  if (resourceMeta.resource) authorize.searchParams.set("resource", resourceMeta.resource);
  if (resourceMeta.scopes_supported?.length) authorize.searchParams.set("scope", resourceMeta.scopes_supported.join(" "));
  const pending = {
    verifier, state: stateValue, redirectUri: REDIRECT_URI, createdAt: Date.now(),
    clientInfo, authMeta, resource: resourceMeta.resource, scopes: resourceMeta.scopes_supported
  };
  await saveState({ ...saved, client_info: clientInfo, pending });
  console.log("Open this URL and complete the remote login/2FA step:");
  console.log(authorize.toString());
  console.log("\nThen run: mcp otp <six-digit-code>");
  console.log("The authorization request expires in 5 minutes.");
}

async function submitOtp(codeArg?: string): Promise<void> {
  const code = (codeArg ?? "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(code)) throw new Error("Usage: mcp otp <six-digit-code>");
  const saved = await loadState();
  const pending = saved.pending;
  if (!pending) throw new Error('No pending authorization. Run "mcp connect" first.');
  if (Date.now() - pending.createdAt > 5 * 60 * 1000) {
    delete saved.pending; await saveState(saved);
    throw new Error('Authorization expired. Run "mcp connect" again.');
  }
  const authMeta = pending.authMeta;
  const approveUrl = new URL("/oauth/authorize/approve", new URL(authMeta.authorization_endpoint).origin);
  approveUrl.searchParams.set("client_id", String(pending.clientInfo.client_id));
  approveUrl.searchParams.set("redirect_uri", pending.redirectUri);
  approveUrl.searchParams.set("state", pending.state);
  approveUrl.searchParams.set("code_challenge", createHash("sha256").update(pending.verifier).digest("base64url"));
  const approval = await fetch(approveUrl, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" },
    body: new URLSearchParams({ totp: code })
  });
  if (approval.status !== 302 && approval.status !== 303) {
    const body = (await approval.text()).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (approval.status === 401) throw new Error("Invalid or expired OTP code.");
    throw new Error(`OAuth approval failed (${approval.status}): ${body.slice(0, 300)}`);
  }
  const location = approval.headers.get("location");
  if (!location) throw new Error("OAuth approval response has no redirect Location");
  const callback = new URL(location, pending.redirectUri);
  if (callback.searchParams.get("state") !== pending.state) throw new Error("OAuth state validation failed");
  const oauthError = callback.searchParams.get("error");
  if (oauthError) throw new Error("OAuth authorization failed: " + oauthError);
  const authCode = callback.searchParams.get("code");
  if (!authCode) throw new Error("OAuth callback did not contain an authorization code");

  const tokenResponse = await responseJson(await fetch(tokenEndpoint(authMeta), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code: authCode,
      redirect_uri: pending.redirectUri, client_id: String(pending.clientInfo.client_id),
      code_verifier: pending.verifier
    })
  }));
  if (!tokenResponse.access_token) throw new Error("OAuth token response did not contain access_token");
  const next: OAuthState = {
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token,
    client_info: pending.clientInfo,
    auth_meta: authMeta
  };
  await saveState(next);
  const tools = await initializeAndList(next.access_token!);
  console.log(`Connected successfully. Discovered ${tools.length} tool(s). Run "mcp help" to see them.`);
}

async function mcpRequest(accessToken: string, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + accessToken,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26",
      ...(sessionId ? { "MCP-Session-Id": sessionId } : {})
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params })
  });
  if (response.status === 401) throw new Error('MCP token expired or unauthorized. Run "mcp connect" again.');
  const sid = response.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  const text = await response.text();
  if (!response.ok) throw new Error(`MCP request failed (${response.status}): ${text.slice(0, 500)}`);
  if (!text.trim()) return {};
  let payload: any;
  try { payload = JSON.parse(text); } catch {
    const dataLines = text.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim());
    for (const line of dataLines.reverse()) {
      try { payload = JSON.parse(line); if (payload?.id !== undefined || payload?.result || payload?.error) break; } catch { /* next SSE event */ }
    }
  }
  if (!payload) throw new Error("Could not parse MCP JSON/SSE response: " + text.slice(0, 300));
  if (payload.error) throw new Error(`MCP error ${payload.error.code}: ${payload.error.message}`);
  return payload.result ?? {};
}
async function initializeAndList(accessToken: string): Promise<Tool[]> {
  await mcpRequest(accessToken, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: CLIENT_NAME, version: "0.1.0" }
  });
  await mcpRequest(accessToken, "notifications/initialized", {});
  const result = await mcpRequest(accessToken, "tools/list", {});
  return Array.isArray(result.tools) ? result.tools as Tool[] : [];
}
async function getTools(accessToken: string): Promise<Tool[]> {
  return initializeAndList(accessToken);
}
function pretty(value: unknown): string { return JSON.stringify(value, null, 2); }

async function help(toolName?: string): Promise<void> {
  const saved = await loadState();
  if (!saved.access_token) {
    console.log('Not connected yet. Run "mcp connect", then "mcp otp <six-digit-code>".');
    printUsage();
    return;
  }
  const tools = await getTools(saved.access_token);
  if (toolName) {
    const tool = tools.find(item => item.name === toolName);
    if (!tool) {
      console.error(`Unknown tool "${toolName}". Run "mcp help" to list available tools.`);
      process.exitCode = 1;
      return;
    }
    console.log(`${tool.name}${tool.description ? " — " + tool.description : ""}\n`);
    console.log("Input schema:");
    console.log(pretty(tool.inputSchema ?? { type: "object", properties: {} }));
    console.log(`\nUsage: mcp ${tool.name} '<json-object>'`);
    return;
  }
  console.log(`Remote MCP: ${ENDPOINT}`);
  console.log(`Connected. ${tools.length} tool(s) available.\n`);
  if (!tools.length) console.log("The server did not advertise any tools.");
  for (const tool of tools) {
    console.log(`- ${tool.name}${tool.description ? ": " + tool.description : ""}`);
  }
  console.log("");
  printUsage();
}
function printUsage(): void {
  console.log("Usage:");
  console.log("  mcp connect                 Start OAuth login (or reuse saved credentials)");
  console.log("  mcp otp <six-digit-code>    Complete login with the one-time code");
  console.log("  mcp help                    Show connection and remote tool overview");
  console.log("  mcp help <tool-name>        Show a tool's description and JSON input schema");
  console.log("  mcp <tool-name> '<json>'    Call a remote tool with JSON arguments");
  console.log("\nExample: mcp tool-foo '{\"query\":\"hello\"}'");
}
async function callTool(name: string, jsonArg?: string): Promise<void> {
  const saved = await loadState();
  if (!saved.access_token) throw new Error('Not connected. Run "mcp connect" and "mcp otp <six-digit-code>" first.');
  let args: Record<string, unknown> = {};
  if (jsonArg !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(jsonArg); }
    catch { throw new Error("Tool arguments must be valid JSON."); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Tool arguments must be a JSON object, e.g. '{\"query\":\"hello\"}'.");
    }
    args = parsed as Record<string, unknown>;
  }
  const result = await mcpRequest(saved.access_token, "tools/call", { name, arguments: args });
  console.log(pretty(result));
  if (result.isError) process.exitCode = 1;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    await help(args[0]); return;
  }
  if (command === "connect") { await connect(); return; }
  if (command === "otp") { await submitOtp(args[0]); return; }
  if (command === "--version" || command === "-v") { console.log("0.1.0"); return; }
  if (command.startsWith("-")) { printUsage(); process.exitCode = 2; return; }
  await callTool(command, args[0]);
}
main().catch((error: unknown) => {
  console.error("Error:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
