/**
 * @file src/routes/health.ts
 * @description Health check handler for the Cloudflare Worker.
 * @owner AI-Builder
 */

import type { Context } from 'hono'


/**
 * Creates the JSON payload returned by the health endpoint.
 * @returns An object describing the health status of the service.
 */
export const createHealthPayload = () => ({ ok: true as const })

/**
 * Hono route handler for the `/healthz` endpoint.
 * @param context - The Hono request context.
 * @returns A JSON response containing the service health payload.
 */
export const healthHandler = (context: Context<{ Bindings: Env }>) => {
  return context.json(createHealthPayload())
}

/**
 * @extension_point
 * Use this module to extend health reporting with additional diagnostics.
 */
