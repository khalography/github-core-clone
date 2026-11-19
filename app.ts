// app.ts — the forge's HTTP server: one process, four surfaces.
//
//   GET  /healthz            the env's boot probe (200 {"ok":true}, twice)
//   /api/v3/...              GitHub REST v3 (rest.ts)
//   POST /api/graphql       GitHub GraphQL v4 (graphql.ts)
//   POST /mcp               Model Context Protocol (mcp.ts)
//   /<owner>/<repo>.git/... git smart HTTP (githttp.ts)
//
// Anything else is a JSON 404, never HTML. Every JSON reply carries a
// non-empty X-GitHub-Request-Id (http.ts).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathOf, sendError, sendJson } from './http.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './githttp.ts';

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (await handleRest(req, res)) return;
        if (await handleGraphql(req, res)) return;
        if (await handleMcp(req, res)) return;
        if (await handleGit(req, res)) return;

        // Everything else, every method: GitHub's 404 body.
        sendError(res, 404, 'Not Found');
      } catch (err) {
        if (!res.headersSent) {
          sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        } else {
          res.end();
        }
      }
    })();
  });
  // Every reply is a single small write; disable Nagle so it goes out at
  // once instead of waiting for the peer's ACK (the timed workloads are
  // sequential request/response pairs on keep-alive connections).
  server.on('connection', (socket) => socket.setNoDelay(true));
  return server;
}
