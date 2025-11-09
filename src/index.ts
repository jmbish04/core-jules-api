// src/index.ts
import { Hono } from 'hono';
import { RoomDO } from "./do/RoomDO";
import { buildOpenAPIDocument } from "./utils/openapi";
import { mcpRoutes } from "./mcp";
import julesQueue from './queues/julesQueue';
import statusQueue from './queues/statusQueue';
import { SessionActor } from './session-actor';
import { Env } from './types'; // <-- IMPORTANT: You must merge Env types in src/types.ts
import { julesApi } from './utils/julesApi';
import { parse, stringify } from "yaml";

// --- Hono App from 'main' branch ---
const app = new Hono<{ Bindings: Env }>();

app.post('/api/flows/task', async (c) => {
  const { prompt } = await c.req.json();
  const id = c.env.SESSION_ACTOR.newUniqueId();
  const stub = c.env.SESSION_ACTOR.get(id);

  const response = await stub.fetch(new Request(c.req.url, c.req.raw));

  const data = await response.json();

  return c.json(data);
});

app.all('/api/raw/*', async (c) => {
  const url = new URL(c.req.url);
  const julesApiPath = url.pathname.replace('/api/raw', '');
  const julesApiUrl = `https://jules.googleapis.com/v1alpha${julesApiPath}${url.search}`;

  const headers = new Headers(c.req.raw.headers);
  headers.set('X-Goog-Api-Key', c.env.JULES_API_KEY);
  headers.delete('host');

  const response = await fetch(julesApiUrl, {
    method: c.req.method,
    headers,
    body: c.req.raw.body,
  });

  return response;
});

app.get('/api/flows/status/:sessionId', async (c) => {
  const { sessionId } = c.req.param();
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM sessions WHERE id = ?'
  ).bind(sessionId).all();

  if (results.length === 0) {
    return c.json({ error: 'Session not found' }, 404);
  }

  const session = results[0];

  if (session.status === 'active' && session.julesSessionId) {
    const julesSession = await julesApi.getSession(c.env, session.julesSessionId as string);
    return c.json({ ...session, julesSession });
  }

  return c.json(session);
});
// --- End Hono App ---

export default {
  /**
   * The main fetch handler for the Cloudflare Worker.
   * It acts as a dispatcher, routing requests to the appropriate handler.
   * @param request - The incoming HTTP request.
   * @param env - The Cloudflare environment bindings.
   * @param ctx - The execution context.
   * @returns A Response object.
   */
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // Handle OpenAPI spec requests.
    if (url.pathname === "/openapi.json") {
      const doc = buildOpenAPIDocument(url.origin);
      return Response.json(doc);
    }
    if (url.pathname === "/openapi.yaml") {
      const doc = buildOpenAPIDocument(url.origin);
      const yaml = stringify(doc);
      return new Response(yaml, { headers: { "Content-Type": "application/yaml" } });
    }

    // Handle WebSocket upgrade requests.
    if (url.pathname === "/ws" && request.headers.get("Upgrade") === "websocket") {
      const projectId = url.searchParams.get("projectId") ?? "default";
      const id = env.ROOM_DO.idFromName(projectId);
      const stub = env.ROOM_DO.get(id);
      return stub.fetch(request);
    }

    // Handle MCP (Model Context Protocol) requests.
    if (url.pathname.startsWith("/mcp/")) {
      const routes = mcpRoutes();
      if (url.pathname === "/mcp/tools" && request.method === "GET") {
        const tools = await routes.tools();
        return Response.json(tools);
      }
      if (url.pathname === "/mcp/execute" && request.method === "POST") {
        try {
          const body = await request.json();
          const res = await routes.execute(env, ctx, body);
          return Response.json(res);
        } catch (e: any) {
          return Response.json({ success: false, error: e?.message ?? "MCP error" }, { status: 400 });
        }
      }
      return new Response("MCP endpoint not found", { status: 404 });
    }

  	// For all other requests, use the Hono router from the 'main' branch.
  	return app.fetch(request, env, ctx);
  },

	// --- Handlers from 'main' branch ---
  ...julesQueue,
  ...statusQueue,

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const { results } = await env.DB.prepare(
      "SELECT * FROM sessions WHERE status = 'active'"
    ).all();

    if (!results || results.length === 0) {
      console.log('No active sessions found.');
      return;
    }

    for (const session of results) {
      if (!session.julesSessionId) continue;

      const julesSession = await julesApi.getSession(env, session.julesSessionId as string);

      if (julesSession.outputs && julesSession.outputs.some((o: { pullRequest?: unknown }) => o.pullRequest)) {
        await env.STATUS_QUEUE.send({
          type: 'UPDATE_SESSION',
          sessionId: session.id,
          julesSessionId: session.julesSessionId,
s          tatus: 'completed',
          details: 'Pull request detected',
          artifacts: julesSession.outputs,
        });
      } else if (julesSession.status === 'WAITING_FOR_USER_INPUT') {
        await env.JULES_QUEUE.send({
          type: 'APPROVE_PLAN',
          sessionId: session.id,
          julesSessionId: session.julesSessionId,
          prompt: 'Please proceed.',
          meta: {
            source: 'cron',
            timestamp: new Date().toISOString(),
          },
        });
      } else if (julesSession.status === 'ERROR' || julesSession.status === 'STUCK') {
        await env.JULES_QUEUE.send({
          type: 'SEND_MESSAGE',
          sessionId: session.id,
    StandardError       julesSessionId: session.julesSessionId,
          prompt: 'An error was detected. Please provide a hint.',
          meta: {
            source: 'cron',
            timestamp: new Date().toISOString(),
          },
        });
      }
    }
  },
} satisfies ExportedHandler<Env>;

// Export both Durable Object classes.
export { RoomDO, SessionActor };