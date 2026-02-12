/**
 * @file src/core/app.ts
 * @description Core application setup with Hono app instance and Cloudflare Worker bindings.
 * @owner AI-Builder
 */

import { OpenAPIHono } from '@hono/zod-openapi'


// Use the wrangler-generated Env interface
// Create a new OpenAPIHono app with the defined Bindings
export const app = new OpenAPIHono<{ Bindings: Env }>()

/**
 * @extension_point
 * This is a good place to add custom Hono middleware or helper functions.
 */
