import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { streamText } from "hono/streaming";
import { Env } from "../types";
import { runHealthCheck, getLatestHealthCheck } from "../core/health-check";
import { createDbClient } from "../db/client";
import { healthChecks } from "../db/schema";
import { desc } from "drizzle-orm";
import { queryMCP } from "../mcp/mcp-client";

const app = new OpenAPIHono<{ Bindings: Env }>();

const HealthCheckSchema = z.object({
  id: z.number(),
  timestamp: z.string(),
  checkType: z.string(),
  status: z.string(),
  durationMs: z.number(),
  stepsJson: z.string(),
  error: z.string().nullable().optional(),
});

// Get latest health check
const getLatestRoute = createRoute({
  method: "get",
  path: "/health/latest",
  summary: "Get latest health check result",
  responses: {
    200: {
      description: "Latest health check",
      content: {
        "application/json": {
          schema: HealthCheckSchema.nullable(),
        },
      },
    },
  },
});

app.openapi(getLatestRoute, async (c) => {
  const db = createDbClient(c.env.DB);
  const result = await db.select().from(healthChecks).orderBy(desc(healthChecks.timestamp)).limit(1);
  return c.json(result[0] || null);
});

// Root health endpoint (User requested: acts like latest + instruction)
const rootHealthRoute = createRoute({
  method: "get",
  path: "/health",
  summary: "Get latest health check with instructions",
  responses: {
    200: {
      description: "Latest health check and instructions",
      content: {
        "application/json": {
          schema: z.object({
            latest: HealthCheckSchema.nullable(),
            message: z.string(),
            note: z.string()
          }),
        },
      },
    },
  },
});

app.openapi(rootHealthRoute, async (c) => {
  const db = createDbClient(c.env.DB);
  const result = await db.select().from(healthChecks).orderBy(desc(healthChecks.timestamp)).limit(1);
  return c.json({
    latest: result[0] || null,
    message: "To run a fresh health check, POST to /api/health/run",
    note: "This is a cached result from the latest background or manual run."
  });
});

// Run manual health check
const runCheckRoute = createRoute({
  method: "post",
  path: "/health/run",
  summary: "Run a manual health check",
  request: {
    query: z.object({
      stream: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Health check result",
      content: {
        "application/json": {
          schema: z.object({
            success: z.boolean(),
            totalDurationMs: z.number(),
            error: z.string().optional(),
            steps: z.array(z.any()),
          }),
        },
        "text/event-stream": { schema: z.string() }
      },
    },
  },
});

app.openapi(runCheckRoute, async (c) => {
  const streamMode = c.req.query("stream") === "true";

  if (streamMode) {
    return streamText(c, async (stream) => {
      const log = async (step: string, status: string, msg?: string) => {
        await stream.write(`[${step}] ${status}: ${msg}\n`);
      };
      await runHealthCheck(c.env, 'manual-api', 'api', log);
    }) as any;
  }

  const result = await runHealthCheck(c.env, 'manual-api', 'api');
  return c.json(result);
});

// dedicated MCP check endpoint
const checkMCPRoute = createRoute({
  method: "post",
  path: "/health/mcp",
  summary: "Directly test upstream MCP connectivity",
  description: "Sends a simple query to the upstream MCP server to verify connectivity and protocol.",
  responses: {
    200: {
      description: "MCP connection successful",
      content: {
        "application/json": {
          schema: z.object({
            success: z.boolean(),
            response: z.any(),
            durationMs: z.number(),
          }),
        },
      },
    },
    500: {
      description: "MCP connection failed",
      content: {
        "application/json": {
          schema: z.object({
            success: z.boolean(),
            error: z.string(),
            durationMs: z.number(),
          }),
        },
      },
    },
  },
});

app.openapi(checkMCPRoute, async (c) => {
  const start = Date.now();
  try {
    // Using a simple, broad query that should return quick results
    const response = await queryMCP("workers", "health-check", c.env.MCP_API_URL);
    const duration = Date.now() - start;

    return c.json({
      success: true,
      response: typeof response === 'string' ? response.substring(0, 100) + '...' : response,
      durationMs: duration
    });
  } catch (error) {
    const duration = Date.now() - start;
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: duration
    }, 500);
  }
});

export default app;
