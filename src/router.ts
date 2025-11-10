import { Hono, Context } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { dispatchRPC } from "./rpc";
import type { Env } from "./types";

/**
 * Creates a standardized JSON error response.
 * @param c - The Hono context object.
 * @param e - The error object.
 * @param defaultMessage - A default message to use if the error has no message.
 * @returns A Response object with a 400 status code.
 */
function createErrorResponse(c: Context, e: any, defaultMessage: string) {
  const isZodError = e instanceof z.ZodError;
  return c.json(
    {
      success: false,
      error: e?.message ?? defaultMessage,
      details: isZodError ? e.issues : undefined,
    },
    400
  );
}

/**
 * Builds the Hono router for the REST and HTTP-RPC endpoints.
 * @returns An instance of the Hono router.
 */
export function buildRouter() {
  const app = new Hono<{ Bindings: Env }>();

  app.use(
    "/api/*",
    cors({
      origin: "*",
    })
  );

  app.get("/", (c) => {
    return c.json({
      ok: true,
      ts: new Date().toISOString(),
      version: "1.0.0",
    });
  });

  app.post("/api/tasks", async (c) => {
    try {
      const body = await c.req.json();
      const res = await dispatchRPC("createTask", body, c.env, c.executionCtx);
      return c.json(res);
    } catch (e: any) {
      return createErrorResponse(c, e, "Failed to create task");
    }
  });

  app.get("/api/tasks", async (c) => {
    const res = await dispatchRPC("listTasks", null, c.env, c.executionCtx);
    return c.json(res);
  });

  app.post("/api/analyze", async (c) => {
    try {
      const body = await c.req.json();
      const res = await dispatchRPC("runAnalysis", body, c.env, c.executionCtx);
      return c.json(res);
    } catch (e: any) {
      return createErrorResponse(c, e, "Failed to run analysis");
    }
  });

  app.post("/rpc", async (c) => {
    try {
      const { method, params } = await c.req.json<{ method: string; params: unknown }>();
      const result = await dispatchRPC(method, params, c.env, c.executionCtx);
      return c.json({ success: true, result });
    } catch (e: any) {
      return createErrorResponse(c, e, "RPC error");
    }
  });

  return app;
}
