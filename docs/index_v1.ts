import { buildRouter } from "./router";
import { RoomDO } from "./do/RoomDO";
import { buildOpenAPIDocument } from "./utils/openapi";
import { mcpRoutes } from "./mcp";
import type { Env } from "./types";
import { stringify } from "yaml";
import { z } from "zod";

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
    if (url.pathname === "/openapi.json" || url.pathname === "/openapi.yaml") {
      const doc = buildOpenAPIDocument(url.origin);
      if (url.pathname === "/openapi.yaml") {
        const yaml = stringify(doc);
        return new Response(yaml, { headers: { "Content-Type": "application/yaml" } });
      }
      return Response.json(doc);
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
          const isZodError = e instanceof z.ZodError;
          return new Response(
            JSON.stringify({
              success: false,
              error: e?.message ?? "MCP error",
              details: isZodError ? e.issues : undefined,
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }
          );
        }
      }
      return new Response("MCP endpoint not found", { status: 404 });
    }

    // For all other requests, use the Hono router for REST and RPC.
    const app = buildRouter();
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

// Export the Durable Object class.
export { RoomDO };
