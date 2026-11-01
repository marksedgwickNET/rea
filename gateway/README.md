# REA authenticated MCP gateway

This package runs as a Render Docker web service. It clones and builds the existing `marksedgwickNET/rea` repository, starts REA's Streamable HTTP listener on `127.0.0.1:3100`, and exposes only an authenticated HTTPS-facing gateway.

## Render configuration

- Runtime: Docker
- Dockerfile path: `gateway/Dockerfile`
- Region: Frankfurt
- Port: `10000`
- Required secret: `REA_GATEWAY_TOKEN` (at least 32 characters; generate a unique random token)
- Optional: `REA_STARTUP_TIMEOUT_MS` (default 120000)

Do not expose the internal MCP listener publicly. The only public service routes are:
- `GET /health` (Bearer authentication required)
- `POST|GET|DELETE /mcp` (Bearer authentication required)

The health response becomes `{ "service": "rea-gateway", "reaReady": true }` only after a real MCP initialize, initialized notification, and tools/list exchange succeeds.

## Floot server-side resource variables

- `REA_GATEWAY_URL=https://<your-render-service>.onrender.com`
- `REA_GATEWAY_TOKEN=<same secret as Render>`

Never put the token in browser/client code.

## Security and operational notes

- The REA listener binds to loopback only.
- No shell or arbitrary command endpoint is exposed.
- The gateway forwards only MCP `/mcp` traffic and the authenticated health route.
- The Dockerfile pins REA to commit `d672cc23998b6cbb21c485f118595ebfb82fed33` so a later change to `main` cannot silently alter the build.
- The readiness probe closes its temporary MCP session after initialize and tools/list. This matters because REA's HTTP server is designed for one local MCP client at a time.
- The proxy uses an allowlist for response headers rather than forwarding hop-by-hop transport headers.

This is source scaffolding only. It is not a completed deployment; validate the Render build, runtime handshake, and Floot status check before publishing the workbench.
