// src/index.ts
import { Hono } from 'hono';
import julesQueue from './queues/julesQueue';
import statusQueue from './queues/statusQueue';
import { SessionActor } from './session-actor';
import { julesApi } from './utils/julesApi';

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

export default {
  fetch: app.fetch,
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

      const julesSession = await julesApi.getSession(env, session.julesSessionId);

      if (julesSession.outputs && julesSession.outputs.some((o: any) => o.pullRequest)) {
        await env.STATUS_QUEUE.send({
          type: 'UPDATE_SESSION',
          sessionId: session.id,
          julesSessionId: session.julesSessionId,
          status: 'completed',
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
          julesSessionId: session.julesSessionId,
          prompt: 'An error was detected. Please provide a hint.',
          meta: {
            source: 'cron',
            timestamp: new Date().toISOString(),
          },
        });
      }
    }
  },
};

export { SessionActor };
/**
 * @file src/index.ts
 * @description Merged worker entrypoint combining legacy routes, MCP adapters, and GitHub wrapper features.
 * @owner AI-Builder
 */
import type { CFEnv } from "./env";
import type { WorkerEnv, ExecutionContext, MessageBatch, ExportedHandler, Ai } from "./types";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { swaggerUI } from "@hono/swagger-ui";
import { stringify } from "yaml";
import { z } from "zod";


import { buildRouter } from "./routes/router";
import { buildOpenAPIDocument } from "./docs/openapi";
import { mcpRoutes } from "./protocols/mcp";
import { RoomDO } from "./do/RoomDO";
import octokitApi from "./octokit";
import toolsApi from "./octokit/tools";
import flowsApi from "./flows";
import { healthHandler } from "./routes/health";
import { app } from "./core/app";

// type WorkersAiBinding = {
//   run(model: string, request: Record<string, unknown>): Promise<unknown>;
// };



const workerApp = app as unknown as OpenAPIHono<{ Bindings: Env }>;

// --- Middleware ----------------------------------------------------------------

workerApp.use("*", async (c, next) => {
  const startTime = Date.now();
  const correlationId = c.req.header("X-Correlation-ID") ?? crypto.randomUUID();

  await next();

  c.res.headers.set("X-Correlation-ID", correlationId);
  const latency = Date.now() - startTime;
  const payloadSizeBytes = Number.parseInt(c.req.header("content-length") ?? "0", 10) || 0;

  const logEntry = {
    level: "info" as const,
    message: `[route] ${c.req.method} ${c.req.path}`,
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    latency,
    payloadSizeBytes,
    correlationId,
    timestamp: new Date().toISOString(),
  };

  console.log(
    JSON.stringify({
      ...logEntry,
      latency: `${latency}ms`,
      payloadSize: `${payloadSizeBytes} bytes`,
    })
  );

  try {
    const db = c.env.DB;
    if (db && typeof db.prepare === "function") {
      await db
        .prepare(
          `INSERT INTO request_logs (
            timestamp,
            level,
            message,
            method,
            path,
            status,
            latency_ms,
            payload_size_bytes,
            correlation_id,
            metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          logEntry.timestamp,
          logEntry.level,
          logEntry.message,
          logEntry.method,
          logEntry.path,
          logEntry.status,
          logEntry.latency,
          logEntry.payloadSizeBytes,
          logEntry.correlationId,
          JSON.stringify({
            userAgent: c.req.header("user-agent") ?? null,
            referer: c.req.header("referer") ?? null,
            host: c.req.header("host") ?? null,
            correlationId,
          })
        )
        .run();
    }
  } catch (error) {
    console.error("Failed to persist request log to D1", error);
  }
});

const requireApiKey: MiddlewareHandler<{ Bindings: CFEnv }> = async (c, next) => {
  if (c.req.method === "OPTIONS") {
    await next();
    return;
  }

  const expectedApiKey = c.env.WORKER_API_KEY;

  if (!expectedApiKey) {
    console.warn("WORKER_API_KEY is not configured; skipping API key enforcement");
    await next();
    return;
  }

  const headerApiKey = c.req.header("x-api-key");
  const bearerToken = c.req.header("authorization")?.startsWith("Bearer ")
    ? c.req.header("authorization")?.slice("Bearer ".length)
    : undefined;

  const providedApiKey = headerApiKey ?? bearerToken;

  if (providedApiKey !== expectedApiKey) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  await next();
};

workerApp.use("/api/*", requireApiKey);
workerApp.use("/mcp/*", requireApiKey);
workerApp.use("/a2a/*", requireApiKey);

// --- Route Composition ----------------------------------------------------------

workerApp.get("/healthz", healthHandler);
workerApp.doc("/openapi.json", {
  openapi: "3.0.0",
  info: {
    version: "1.0.0",
    title: "Cloudflare Worker GitHub Proxy",
  },
  servers: [
    { url: "/api", description: "API Interface" },
    { url: "/mcp", description: "Machine-to-Cloud Interface" },
    { url: "/a2a", description: "Agent-to-Agent Interface" },
  ],
});
workerApp.get("/doc", swaggerUI({ url: "/openapi.json" }));

const sharedApi = new OpenAPIHono<{ Bindings: CFEnv }>();
const legacyRouter = buildRouter();

sharedApi.route("/octokit", octokitApi as unknown as Hono<{ Bindings: CFEnv }>);
sharedApi.route("/tools", toolsApi as unknown as Hono<{ Bindings: CFEnv }>);
sharedApi.route("/flows", flowsApi as unknown as Hono<{ Bindings: CFEnv }>);
sharedApi.route("/", legacyRouter as unknown as Hono<{ Bindings: CFEnv }>);

workerApp.route("/api", sharedApi);
workerApp.route("/a2a", sharedApi);
workerApp.route("/", legacyRouter as unknown as Hono<{ Bindings: CFEnv }>);

const mcpHandlers = mcpRoutes();
const mcpRouter = new Hono<{ Bindings: CFEnv }>();

mcpRouter.get("/tools", async (c) => {
  const tools = await mcpHandlers.tools();
  return c.json(tools);
});

mcpRouter.post("/execute", async (c) => {
  try {
    const body = await c.req.json();
    const result = await mcpHandlers.execute(c.env, c.executionCtx, body);
    return c.json(result);
  } catch (error) {
    const isZodError = error instanceof z.ZodError;
    return c.json(
      {
        success: false,
        error: (error as Error)?.message ?? "MCP error",
        details: isZodError ? (error as z.ZodError).issues : undefined,
      },
      400
    );
  }
});

workerApp.route("/mcp", mcpRouter);

// --- Fetch Handler --------------------------------------------------------------

async function handleFetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/openapi.json") {
    const doc = buildOpenAPIDocument(url.origin);
    return Response.json(doc);
  }

  if (url.pathname === "/openapi.yaml") {
    const doc = buildOpenAPIDocument(url.origin);
    const yaml = stringify(doc);
    return new Response(yaml, { headers: { "Content-Type": "application/yaml" } });
  }

  if (url.pathname === "/ws" && request.headers.get("Upgrade") === "websocket") {
    const projectId = url.searchParams.get("projectId") ?? "default";
    const id = env.ROOM_DO.idFromName(projectId);
    const stub = env.ROOM_DO.get(id);
    return stub.fetch(request);
  }

  return workerApp.fetch(request, env, ctx);
}

// --- Queue Handler --------------------------------------------------------------

async function handleQueue(batch: MessageBatch, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
  const aiBinding = (env as any).AI;

  if (!aiBinding || typeof aiBinding.run !== "function") {
    throw new Error("AI binding is not configured on the environment");
  }

  for (const message of batch.messages) {
    const { sessionId, searchId, searchTerm } = message.body as Record<string, string>;

    const searchResults = await searchRepositoriesWithRetry(searchTerm, env, ctx);

    for (const repo of searchResults.items ?? []) {
      const { results } = await env.DB.prepare(
        "SELECT id FROM repo_analysis WHERE session_id = ? AND repo_full_name = ?"
      )
        .bind(sessionId, repo.full_name)
        .all();

      if (results.length > 0) {
        continue;
      }

      const analysis = await analyzeRepository(repo, searchTerm, aiBinding);

      await env.DB.prepare(
        "INSERT INTO repo_analysis (session_id, search_id, repo_full_name, repo_url, description, relevancy_score) VALUES (?, ?, ?, ?, ?, ?)"
      )
        .bind(sessionId, searchId, repo.full_name, repo.html_url, repo.description, analysis.relevancyScore)
        .run();
    }

    await env.DB.prepare("UPDATE searches SET status = ? WHERE id = ?").bind("completed", searchId).run();

    const orchestrator = (env as any).ORCHESTRATOR.get((env as any).ORCHESTRATOR.idFromName("orchestrator"));
    await orchestrator.workflowComplete(searchId);

    message.ack();
  }
}

async function searchRepositoriesWithRetry(searchTerm: string, env: CFEnv, ctx: ExecutionContext, retries = 3): Promise<{ items?: any[] }> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const request = new Request(
        `http://localhost/api/octokit/search/repos?q=${encodeURIComponent(searchTerm)}`,
        {
          headers: {
            "x-api-key": env.WORKER_API_KEY ?? "",
            "User-Agent": "Cloudflare-Worker",
          },
        }
      );
      const response = await workerApp.fetch(request, env, ctx);
      if (response.status === 200) {
        return await response.json();
      }
    } catch (error) {
      if (attempt === retries - 1) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  throw new Error("Unable to fetch repository search results");
}

async function analyzeRepository(repo: any, searchTerm: string, ai: Ai) {
  const response = await ai.run("@cf/meta/llama-2-7b-chat-int8", {
    prompt: `Given the following repository description, rate its relevancy to the search term "${searchTerm}" on a scale of 0 to 1, where 1 is highly relevant and 0 is not relevant at all. Return only the score.\n\nDescription: ${repo.description}`,
  });

  const scoreText = extractAiText(response);
  const score = Number.parseFloat(scoreText);

  return { relevancyScore: Number.isFinite(score) ? score : 0 };
}

function extractAiText(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }

  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (typeof record.response === "string") {
      return record.response;
    }
    if (typeof record.content === "string") {
      return record.content;
    }
    if (Array.isArray(record.output_text)) {
      return record.output_text.join("");
    }
    if (typeof record.output_text === "string") {
      return record.output_text;
    }
    if (Array.isArray(record.responses) && record.responses.length > 0) {
      const first = record.responses[0];
      if (typeof first === "string") {
        return first;
      }
      if (first && typeof first === "object") {
        const responseField = (first as Record<string, unknown>).response;
        if (typeof responseField === "string") {
          return responseField;
        }
      }
    }
  }

  return "";
}

const worker = {
  fetch: handleFetch,
  queue: handleQueue,
};

export default worker satisfies ExportedHandler<WorkerEnv>;
export { RoomDO };
