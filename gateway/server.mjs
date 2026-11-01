import http from "node:http";
import { spawn } from "node:child_process";
import { timingSafeEqual, randomBytes } from "node:crypto";

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";
const TOKEN = process.env.REA_GATEWAY_TOKEN;
const REA_DIR = process.env.REA_DIR || "/opt/rea";
const REA_BIN = process.env.REA_BIN || `${REA_DIR}/scripts/rea.mjs`;
const REA_PORT = Number(process.env.MCP_PORT || 3100);
const UPSTREAM = `http://127.0.0.1:${REA_PORT}/mcp`;
const STARTUP_TIMEOUT_MS = Number(process.env.REA_STARTUP_TIMEOUT_MS || 120000);

if (!TOKEN || TOKEN.length < 32) {
  throw new Error("REA_GATEWAY_TOKEN must be set to a random value of at least 32 characters");
}

let child;
let ready = false;
let stopping = false;

function authorised(req) {
  const value = req.headers.authorization || "";
  const supplied = value.startsWith("Bearer ") ? value.slice(7) : "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { "content-type": "application/json", "content-length": body.length, "cache-control": "no-store" });
  res.end(body);
}

async function mcpRequest(body, sessionId) {
  const headers = {
    "content-type": "application/json",
    "accept": "application/json, text/event-stream",
    "mcp-protocol-version": "2025-03-26"
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return fetch(UPSTREAM, {
    method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(12000)
  });
}

async function verifyMcp() {
  const id = randomBytes(8).toString("hex");
  let sessionId;
  try {
    const init = await mcpRequest({
      jsonrpc: "2.0", id, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "rea-gateway-health", version: "1.0.0" } }
    });
    if (!init.ok) throw new Error(`MCP initialize returned ${init.status}`);
    sessionId = init.headers.get("mcp-session-id");
    if (!sessionId) throw new Error("MCP initialize did not return a session");
    const text = await init.text();
    if (!text.includes('"result"')) throw new Error("MCP initialize response did not contain a result");

    const sessionHeaders = {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
      "mcp-protocol-version": "2025-03-26",
      "mcp-session-id": sessionId
    };
    const initialized = await fetch(UPSTREAM, {
      method: "POST", headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      signal: AbortSignal.timeout(10000)
    });
    if (!initialized.ok && initialized.status !== 202) throw new Error(`MCP initialized notification returned ${initialized.status}`);

    const tools = await fetch(UPSTREAM, {
      method: "POST", headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: `${id}-tools`, method: "tools/list", params: {} }),
      signal: AbortSignal.timeout(15000)
    });
    if (!tools.ok) throw new Error(`MCP tools/list returned ${tools.status}`);
    const toolText = await tools.text();
    if (!toolText.includes('"result"') || !toolText.includes('"tools"')) throw new Error("MCP tools/list response was invalid");
    return true;
  } finally {
    if (sessionId) {
      try {
        const closed = await fetch(UPSTREAM, {
          method: "DELETE",
          headers: { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-03-26" },
          signal: AbortSignal.timeout(5000)
        });
        if (!closed.ok && closed.status !== 404 && closed.status !== 405) {
          console.error(`MCP readiness session cleanup returned ${closed.status}`);
        }
      } catch (error) {
        console.error(`MCP readiness session cleanup failed: ${error.message}`);
      }
    }
  }
}

function startRea() {
  child = spawn(process.execPath, [REA_BIN, "mcp", "--http", "--host", "127.0.0.1", "--port", String(REA_PORT)], {
    cwd: REA_DIR,
    env: { ...process.env, MCP_HOST: "127.0.0.1", MCP_PORT: String(REA_PORT) },
    stdio: ["ignore", "ignore", "inherit"]
  });
  child.on("exit", (code) => {
    ready = false;
    if (!stopping) console.error(`REA process exited (${code}); gateway remains unavailable`);
  });
}

async function waitForReady() {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline && !stopping) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`REA exited during startup (${child.exitCode})`);
    try {
      await verifyMcp();
      ready = true;
      console.log("REA MCP runtime passed initialize and tools/list readiness checks");
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  throw new Error(`REA MCP readiness timeout: ${lastError?.message || "startup cancelled"}`);
}

const server = http.createServer(async (req, res) => {
  if (!authorised(req)) return sendJson(res, 401, { error: "unauthorized" });
  if (req.url === "/health" && req.method === "GET") {
    return sendJson(res, ready ? 200 : 503, { service: "rea-gateway", reaReady: ready });
  }
  if (req.url !== "/mcp" || !["GET", "POST", "DELETE"].includes(req.method || "")) {
    return sendJson(res, 404, { error: "not_found" });
  }
  if (!ready) return sendJson(res, 503, { error: "rea_unavailable" });

  try {
    const headers = new Headers();
    for (const name of ["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id"]) {
      const value = req.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }
    const upstream = await fetch(UPSTREAM, {
      method: req.method,
      headers,
      body: req.method === "POST" ? req : undefined,
      duplex: req.method === "POST" ? "half" : undefined
    });
    const responseHeaders = new Headers();
    for (const name of [
      "content-type", "content-length", "cache-control", "mcp-session-id",
      "mcp-protocol-version", "last-event-id", "retry-after"
    ]) {
      const value = upstream.headers.get(name);
      if (value !== null) responseHeaders.set(name, value);
    }
    res.writeHead(upstream.status, Object.fromEntries(responseHeaders.entries()));
    if (!upstream.body) return res.end();
    for await (const chunk of upstream.body) {
      if (!res.write(chunk)) await new Promise(resolve => res.once("drain", resolve));
    }
    res.end();
  } catch (error) {
    console.error(`MCP proxy failure: ${error.message}`);
    if (!res.headersSent) sendJson(res, 502, { error: "upstream_unavailable" });
    else res.destroy();
  }
});

server.listen(PORT, HOST, async () => {
  console.log(`Authenticated REA gateway listening on ${HOST}:${PORT}`);
  try {
    startRea();
    await waitForReady();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    server.close();
    child?.kill("SIGTERM");
  }
});

async function shutdown() {
  if (stopping) return;
  stopping = true;
  ready = false;
  server.close();
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise(resolve => child.once("exit", resolve)),
      new Promise(resolve => setTimeout(resolve, 8000))
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
