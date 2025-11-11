#!/bin/bash
#
# This script extracts all necessary GitHub-related files from your
# 'github-worker' project to create a self-contained package.
# This package can be integrated into your Jules wrapper to provide
# robust GitHub functionality for your agents.

set -e

# Define the root directory for the new package
OUTPUT_DIR="jules_github_wrapper"
SRC_DIR="$OUTPUT_DIR/src"

echo "Creating directory structure in $OUTPUT_DIR..."

# Create all necessary directories
mkdir -p "$SRC_DIR/utils"
mkdir -p "$SRC_DIR/octokit/rest"
mkdir -p "$SRC_DIR/octokit/graphql"
mkdir -p "$SRC_DIR/tools"
mkdir -p "$SRC_DIR/flows"
mkdir -p "$SRC_DIR/routes"
mkdir -p "$OUTPUT_DIR/docs"

# --- Create Core Logic Files ---

# Main entrypoint, ties all routes together
cat <<'EOF' > "$SRC_DIR/index.ts"
/**
 * @file src/index.ts
 * @description This is the main entry point for the Cloudflare Worker.
 * @owner AI-Builder
*/

import { OpenAPIHono } from '@hono/zod-openapi'
import type { MiddlewareHandler } from 'hono'
import { swaggerUI } from '@hono/swagger-ui'
import { app, Bindings } from './utils/hono'
import { GitHubWorkerRPC } from './rpc'

// Import routes
import octokitApi from './octokit'
import toolsApi from './tools'
import agentsApi from './routes/api/agents'
import retrofitApi from './retrofit'
import flowsApi from './flows'
import { webhookHandler } from './routes/webhook-handler'
import { healthHandler } from './routes/health'

// --- 1. Middleware ---

// Logging middleware
app.use('*', async (c, next) => {
  const startTime = Date.now()
  const correlationId = c.req.header('X-Correlation-ID') || crypto.randomUUID()

  await next()

  c.res.headers.set('X-Correlation-ID', correlationId)
  const endTime = Date.now()
  const latency = endTime - startTime
  const payloadSizeHeader = c.req.header('content-length') || '0'
  const payloadSizeBytes = Number.parseInt(payloadSizeHeader, 10) || 0
  const logEntry = {
    level: 'info' as const,
    message: `[route] ${c.req.method} ${c.req.path}`,
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    latency,
    payloadSizeBytes,
    correlationId,
    timestamp: new Date().toISOString(),
  }

  console.log(
    JSON.stringify({
      ...logEntry,
      latency: `${latency}ms`,
      payloadSize: `${payloadSizeBytes} bytes`,
    })
  )

  try {
    await c.env.CORE_GITHUB_API.prepare(
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
          userAgent: c.req.header('user-agent') || null,
          referer: c.req.header('referer') || null,
          host: c.req.header('host') || null,
          correlationId,
        })
      )
      .run()
  } catch (error) {
    console.error('Failed to persist request log to D1', error)
  }
})

const requireApiKey: MiddlewareHandler<{ Bindings: Bindings }> = async (c, next) => {
  if (c.req.method === 'OPTIONS') {
    await next()
    return
  }

  const expectedApiKey = c.env.WORKER_API_KEY

  if (!expectedApiKey) {
    console.error('WORKER_API_KEY is not configured')
    return c.json({ error: 'Service misconfigured' }, 500)
  }

  const providedApiKey = c.req.header('x-api-key')
    || (c.req.header('authorization')?.startsWith('Bearer ')
      ? c.req.header('authorization')?.slice('Bearer '.length)
      : undefined)

  if (providedApiKey !== expectedApiKey) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  await next()
}

app.use('/api/*', requireApiKey)
app.use('/mcp/*', requireApiKey)
app.use('/a2a/*', requireApiKey)


// --- 2. Route Definitions ---

// Health check endpoint
app.get('/healthz', healthHandler)

// Webhook endpoint (no API key required, uses GitHub signature verification)
app.post('/webhook', webhookHandler)

// The OpenAPI documentation will be available at /doc
app.doc('/openapi.json', {
  openapi: '3.0.0',
  info: {
    version: '1.0.0',
    title: 'Cloudflare Worker GitHub Proxy',
  },
  servers: [
    { url: '/api', description: 'API Interface' },
    { url: '/mcp', description: 'Machine-to-Cloud Interface' },
    { url: '/a2a', description: 'Agent-to-Agent Interface' },
  ],
})

// Optional: Add swagger UI
app.get('/doc', swaggerUI({ url: '/openapi.json' }))

// --- 3. API Routes ---

// Create ONE shared router instance for all business logic
const sharedApi = new OpenAPIHono<{ Bindings: Bindings }>()
sharedApi.route('/octokit', octokitApi)
sharedApi.route('/tools', toolsApi)
sharedApi.route('/agents', agentsApi)
sharedApi.route('/retrofit', retrofitApi)
sharedApi.route('/flows', flowsApi)

// Mount the shared router under all three top-level paths
app.route('/api', sharedApi)
app.route('/mcp', sharedApi)
app.route('/a2a', sharedApi)


// --- 4. Export the app ---

type WorkersAiBinding = {
  run(model: string, request: Record<string, unknown>): Promise<unknown>
}

/**
 * GitHubWorker - Main worker class with RPC support
 *
 * This class can be used in two ways:
 * 1. As an HTTP worker (via the fetch method)
 * 2. As an RPC service binding (via the exposed RPC methods)
 *
 * Example usage as service binding in another worker's wrangler.jsonc:
 * {
 * "services": [
 * {
 * "binding": "GITHUB_WORKER",
 * "service": "github-worker"
 * }
 * ]
 * }
 *
 * Then in the other worker:
 * const result = await env.GITHUB_WORKER.upsertFile({ owner: '...', repo: '...', ... })
 */
export default class GitHubWorker {
  private rpc: GitHubWorkerRPC | null = null
  private env: Env | null = null

  /**
   * HTTP fetch handler
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    this.env = env
    return app.fetch(request, env, ctx)
  }

  /**
   * Queue message handler
   */
  async queue(batch: MessageBatch, env: Env, ctx: ExecutionContext): Promise<void> {
    this.env = env
    const aiBinding = env.AI as WorkersAiBinding | undefined

    if (!aiBinding || typeof aiBinding.run !== 'function') {
      throw new Error('AI binding is not configured on the environment')
    }

    for (const message of batch.messages) {
      const { sessionId, searchId, searchTerm } = message.body

      // 1. Execute the search
      const searchResults = await searchRepositoriesWithRetry(searchTerm, env, ctx)

      // 2. Analyze each repository
      for (const repo of searchResults.items) {
        // 2a. Check if the repository has already been analyzed for this session
        const { results } = await env.DB.prepare(
          'SELECT id FROM repo_analysis WHERE session_id = ? AND repo_full_name = ?'
        ).bind(sessionId, repo.full_name).all()

        if (results.length > 0) {
          continue
        }

        // 2b. Analyze the repository
        const analysis = await analyzeRepository(repo, searchTerm, aiBinding)

        // 2c. Persist the analysis to D1
        await env.DB.prepare(
          'INSERT INTO repo_analysis (session_id, search_id, repo_full_name, repo_url, description, relevancy_score) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(
          sessionId,
          searchId,
          repo.full_name,
          repo.html_url,
          repo.description,
          analysis.relevancyScore
        ).run()
      }

      // 3. Update the search status
      await env.DB.prepare(
        'UPDATE searches SET status = ? WHERE id = ?'
      ).bind('completed', searchId).run()

      // 4. Notify the orchestrator that the workflow is complete
      const orchestrator = env.ORCHESTRATOR.get(
        env.ORCHESTRATOR.idFromName('orchestrator')
      )
      await orchestrator.workflowComplete(searchId)

      message.ack()
    }
  }

  // ==================== RPC Methods ====================
  // These methods can be called directly when this worker is used as a service binding

  private getRPC(env: Env): GitHubWorkerRPC {
    if (!this.rpc || this.env !== env) {
      this.env = env
      this.rpc = new GitHubWorkerRPC(env)
    }
    return this.rpc
  }

  /**
   * Check the health status of the worker
   */
  async health(env: Env) {
    return this.getRPC(env).health()
  }

  /**
   * Create or update a file in a GitHub repository
   */
  async upsertFile(request: Parameters<GitHubWorkerRPC['upsertFile']>[0], env: Env) {
    return this.getRPC(env).upsertFile(request)
  }

  /**
   * List repository contents with a tree-style representation
   */
  async listRepoTree(request: Parameters<GitHubWorkerRPC['listRepoTree']>[0], env: Env) {
    return this.getRPC(env).listRepoTree(request)
  }

  /**
   * Open a new pull request
   */
  async openPullRequest(request: Parameters<GitHubWorkerRPC['openPullRequest']>[0], env: Env) {
    return this.getRPC(env).openPullRequest(request)
  }

  /**
   * Create a new issue
   */
  async createIssue(request: Parameters<GitHubWorkerRPC['createIssue']>[0], env: Env) {
    return this.getRPC(env).createIssue(request)
  }

  /**
   * Generic proxy for GitHub REST API calls
   */
  async octokitRest(request: Parameters<GitHubWorkerRPC['octokitRest']>[0], env: Env) {
    return this.getRPC(env).octokitRest(request)
  }

  /**
   * Execute a GraphQL query against the GitHub API
   */
  async octokitGraphQL(request: Parameters<GitHubWorkerRPC['octokitGraphQL']>[0], env: Env) {
    return this.getRPC(env).octokitGraphQL(request)
  }

  /**
   * Create a new agent session for GitHub search and analysis
   */
  async createSession(request: Parameters<GitHubWorkerRPC['createSession']>[0], env: Env) {
    return this.getRPC(env).createSession(request)
  }

  /**
   * Get the status of an agent session
   */
  async getSessionStatus(request: Parameters<GitHubWorkerRPC['getSessionStatus']>[0], env: Env) {
    return this.getRPC(env).getSessionStatus(request)
  }

  /**
   * Search for GitHub repositories
   */
  async searchRepositories(request: Parameters<GitHubWorkerRPC['searchRepositories']>[0], env: Env) {
    return this.getRPC(env).searchRepositories(request)
  }

  /**
   * Batch upsert multiple files in a single call
   */
  async batchUpsertFiles(requests: Parameters<GitHubWorkerRPC['batchUpsertFiles']>[0], env: Env) {
    return this.getRPC(env).batchUpsertFiles(requests)
  }

  /**
   * Batch create multiple issues in a single call
   */
  async batchCreateIssues(requests: Parameters<GitHubWorkerRPC['batchCreateIssues']>[0], env: Env) {
    return this.getRPC(env).batchCreateIssues(requests)
  }
}

async function searchRepositoriesWithRetry(
  searchTerm: string,
  env: Env,
  ctx: ExecutionContext,
  retries = 3
): Promise<any> {
  for (let i = 0; i < retries; i++) {
    try {
      const request = new Request(`http://localhost/api/octokit/search/repos?q=${encodeURIComponent(searchTerm)}`, {
        headers: {
          'x-api-key': env.WORKER_API_KEY,
          'User-Agent': 'Cloudflare-Worker'
        },
      })
      const response = await app.fetch(request, env, ctx)
      if (response.status === 200) {
        return await response.json()
      }
    } catch (error) {
      if (i === retries - 1) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)))
    }
  }
}

async function analyzeRepository(
  repo: any,
  searchTerm: string,
  ai: WorkersAiBinding
): Promise<{ relevancyScore: number }> {
  const response = await ai.run('@cf/meta/llama-2-7b-chat-int8', {
    prompt: `Given the following repository description, rate its relevancy to the search term "${searchTerm}" on a scale of 0 to 1, where 1 is highly relevant and 0 is not relevant at all. Return only the score.\n\nDescription: ${repo.description}`,
  })

  const scoreText = extractAiText(response)
  const score = Number.parseFloat(scoreText)

  return { relevancyScore: Number.isFinite(score) ? score : 0 }
}

function extractAiText(result: unknown): string {
  if (typeof result === 'string') {
    return result
  }

  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>
    if (typeof record.response === 'string') {
      return record.response
    }
    if (typeof record.content === 'string') {
      return record.content
    }
    if (Array.isArray(record.output_text)) {
      return record.output_text.join('')
    }
    if (typeof record.output_text === 'string') {
      return record.output_text
    }
    if (Array.isArray(record.responses) && record.responses.length > 0) {
      const first = record.responses[0]
      if (typeof first === 'string') {
        return first
      }
      if (first && typeof first === 'object' && typeof (first as Record<string, unknown>).response === 'string') {
        return (first as Record<string, unknown>).response as string
      }
    }
  }

  return ''
}


// Export Durable Objects
export { RetrofitAgent } from './retrofit/RetrofitAgent'
export { OrchestratorAgent } from './agents/orchestrator'

// Export Workflows
export { GithubSearchWorkflow } from './workflows/search'

/**
 * @extension_point
 * This is a good place to add new top-level routes or middleware.
 * For example, you could add an authentication middleware here.
 */
EOF

# Hono setup and types
cat <<'EOF' > "$SRC_DIR/utils/hono.ts"
/**
 * @file src/utils/hono.ts
 * @description This file contains Hono-related helper functions and types.
 * @owner AI-Builder
 */

import { OpenAPIHono } from '@hono/zod-openapi'
import type { D1Database } from '@cloudflare/workers-types'
import { v4 as uuidv4 } from 'uuid'

// Define the Bindings for the Cloudflare Worker
export type Bindings = {
  GITHUB_TOKEN: string
  LOG_LEVEL: string
  ETAG_KV: KVNamespace
  WORKER_API_KEY: string
  CORE_GITHUB_API: D1Database
  CLOUDFLARE_API_TOKEN?: string
  GITHUB_ACTION_CLOUDFLARE_ACCOUNT_ID?: string
}

// Create a new OpenAPIHono app with the defined Bindings
export const app = new OpenAPIHono<{ Bindings: Bindings }>()

/**
 * @extension_point
 * This is a good place to add custom Hono middleware or helper functions.
 */
EOF

# Base64 utility
cat <<'EOF' > "$SRC_DIR/utils/base64.ts"
/**
 * @file src/utils/base64.ts
 * @description This file contains base64 encoding and decoding utilities that correctly handle Unicode.
 * @owner AI-Builder
 */

/**
 * Encodes a string to base64, correctly handling Unicode characters.
 * @param {string} str - The string to encode.
 * @returns {string} The base64-encoded string.
 */
export const encode = (str: string): string => {
  // btoa doesn't handle Unicode characters correctly on its own.
  // The common workaround is to convert the string to a UTF-8 string of characters
  // that btoa can handle.
  try {
    return btoa(unescape(encodeURIComponent(str)));
  } catch (e) {
    console.error('Failed to base64 encode string:', e);
    // Re-throw the error to prevent incorrect encoding from being used.
    throw e;
  }
}

/**
 * Decodes a base64 string, correctly handling Unicode characters.
 * @param {string} str - The base64 string to decode.
 * @returns {string} The decoded string.
 */
export const decode = (str: string): string => {
  try {
    return decodeURIComponent(escape(atob(str)));
  } catch (e) {
    console.error('Failed to base64 decode string:', e);
    // Fallback for safety.
    return atob(str);
  }
}

/**
 * @extension_point
 * This is a good place to add other encoding/decoding functions.
 */
EOF

# ETag Caching utility
cat <<'EOF' > "$SRC_DIR/utils/etagCache.ts"
/**
 * @file src/utils/etagCache.ts
 * @description This file contains utilities for ETag-based caching using a KV namespace.
 * @owner AI-Builder
 */

import { MiddlewareHandler } from 'hono'
import { Bindings } from './hono'

/**
 * Creates a cache key from a request URL.
 * @param {string} url - The request URL.
 * @returns {string} The cache key.
 */
const getCacheKey = (url: string): string => `etag:${url}`

/**
 * A Hono middleware for ETag-based caching.
 *
 * This middleware performs two functions:
 * 1. **Checks for 304 Not Modified**: It compares the request's 'if-none-match' header
 *    against a cached ETag in the ETAG_KV. If they match, it returns a 304.
 * 2. **Caches new ETags**: After the request is handled, it checks the response.
 *    If a new 'etag' header is present, it's stored in the KV store with an optional TTL.
 *    If no 'etag' is present, any stale ETag in the KV store is deleted.
 *
 * @param {object} [options] - Caching options.
 * @param {number} [options.ttl] - The time-to-live (in seconds) for the cached ETag.
 *   If not provided, the ETag will be stored indefinitely.
 * @returns {MiddlewareHandler} The Hono middleware.
 */
export const etagCache = (options?: {
  ttl?: number
}): MiddlewareHandler<{ Bindings: Bindings }> => {
  return async (c, next) => {
    const cacheKey = getCacheKey(c.req.url)
    const ifNoneMatch = c.req.header('if-none-match')

    // 1. Check if the ETag is in the cache
    if (ifNoneMatch) {
      const cachedEtag = await c.env.ETAG_KV.get(cacheKey)
      if (cachedEtag === ifNoneMatch) {
        // Client has the latest version, return 304 Not Modified
        return c.newResponse(null, 304)
      }
    }

    await next()

    // 2. If the response has an ETag, store it in the cache
    const etag = c.res.headers.get('etag')
    if (etag) {
      // Store the new ETag. If a TTL is provided, use it.
      const kvOptions = options?.ttl && options.ttl > 0
        ? { expirationTtl: options.ttl }
        : {}
      await c.env.ETAG_KV.put(cacheKey, etag, kvOptions)
    } else {
      // If the response doesn't have an ETag (e.g., resource not cacheable),
      // delete any stale cached entry to prevent incorrect 304s.
      await c.env.ETAG_KV.delete(cacheKey)
    }
  }
}

/**
 * @extension_point
 * This is a good place to add other advanced caching strategies.
 * For example, you could add a middleware that uses the standard Cache API
 * (`caches.default`) to store and serve entire Response objects,
 * using 'cache-control' headers for TTL.
 */
EOF

# Rate Limiting utility
cat <<'EOF' > "$SRC_DIR/utils/rateLimit.ts"
/**
 * @file src/utils/rateLimit.ts
 * @description This file contains utilities for handling GitHub API rate limiting.
 * @owner AI-Builder
 */

import { MiddlewareHandler } from 'hono'

/**
 * A placeholder middleware for handling rate limiting.
 * @returns {MiddlewareHandler} The Hono middleware.
 */
export const rateLimit = (): MiddlewareHandler => {
  return async (c, next) => {
    // This is a placeholder implementation.
    // A real implementation would use Octokit's built-in rate limit handling
    // and retry mechanisms, which are already configured in `src/octokit/core.ts`.
    // This middleware could be used for more advanced strategies, like per-user rate limiting.
    console.warn('rateLimit() middleware is not yet implemented.');
    await next();
  };
};

/**
 * @extension_point
 * This is a good place to add a custom rate limit handler or middleware.
 */
EOF

# Health check route
cat <<'EOF' > "$SRC_DIR/routes/health.ts"
/**
 * @file src/routes/health.ts
 * @description Health check handler for the Cloudflare Worker.
 * @owner AI-Builder
 */

import type { Context } from 'hono'

import type { Bindings } from '../utils/hono'

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
export const healthHandler = (context: Context<{ Bindings: Bindings }>) => {
  return context.json(createHealthPayload())
}

/**
 * @extension_point
 * Use this module to extend health reporting with additional diagnostics.
 */
EOF

# --- Create Octokit (Generic API) Files ---

# Octokit core setup
cat <<'EOF' > "$SRC_DIR/octokit/core.ts"
/**
 * @file src/octokit/core.ts
 * @description This file initializes the Octokit REST and GraphQL clients with retry and throttling plugins.
 * @owner AI-Builder
 */

import { Octokit } from '@octokit/rest'
import { graphql } from '@octokit/graphql'
import { retry } from '@octokit/plugin-retry'
import { throttling } from '@octokit/plugin-throttling'
import { Bindings } from '../utils/hono'

const MyOctokit = Octokit.plugin(retry, throttling)

let octokit: Octokit
let gql: typeof graphql

/**
 * Initializes the Octokit clients.
 * @param {Bindings} bindings - The Cloudflare Worker bindings.
 */
const initOctokit = (bindings: Bindings) => {
  if (!octokit) {
    octokit = new MyOctokit({
      auth: bindings.GITHUB_TOKEN,
      throttle: {
        onRateLimit: (retryAfter, options, octokit, retryCount) => {
          octokit.log.warn(
            `Request quota exhausted for request ${options.method} ${options.url}`
          );

          if (retryCount < 1) {
            // only retries once
            octokit.log.info(`Retrying after ${retryAfter} seconds!`);
            return true;
          }
        },
        onSecondaryRateLimit: (retryAfter, options, octokit) => {
          // does not retry, only logs a warning
          octokit.log.warn(
            `SecondaryRateLimit detected for request ${options.method} ${options.url}`
          );
        },
      },
    })
  }
  if (!gql) {
    gql = graphql.defaults({
      headers: {
        authorization: `token ${bindings.GITHUB_TOKEN}`,
      },
    })
  }
}

/**
 * Returns the Octokit REST client.
 * @returns {Octokit} The Octokit REST client.
 */
export const getOctokit = (bindings: Bindings): Octokit => {
  initOctokit(bindings)
  return octokit
}

/**
 * Returns the Octokit GraphQL client.
 * @returns {graphql} The Octokit GraphQL client.
 */
export const getGraphql = (bindings: Bindings): typeof graphql => {
  initOctokit(bindings)
  return gql
}

/**
 * @extension_point
 * This is a good place to add other Octokit plugins or custom configurations.
 */
EOF

# Octokit main router
cat <<'EOF' > "$SRC_DIR/octokit/index.ts"
/**
 * @file src/octokit/index.ts
 * @description This file exports the Octokit API routes.
 * @owner AI-Builder
 */

import { OpenAPIHono } from '@hono/zod-openapi'
import restApi from './rest'
import graphqlApi from './graphql/graphql'
import { Bindings } from '../utils/hono'

const octokitApi = new OpenAPIHono<{ Bindings: Bindings }>()

octokitApi.route('/rest', restApi)
octokitApi.route('/', graphqlApi)

export default octokitApi

/**
 * @extension_point
 * This is a good place to add new Octokit-related routes.
 */
EOF

# Octokit REST proxy
cat <<'EOF' > "$SRC_DIR/octokit/rest/index.ts"
/**
 * @file src/octokit/rest/index.ts
 * @description This file contains the implementation of the generic GitHub REST API proxy.
 * @owner AI-Builder
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { getOctokit } from '../core'
import { Bindings } from '../../utils/hono'
import { etagCache } from '../../utils/etagCache'
import { Context } from 'hono'

// --- 1. Zod Schema Definitions ---

const RestResponseSchema = z.any().openapi({
  description: 'The response from the GitHub API.',
})

// --- 2. Route Definitions ---

const getRoute = createRoute({
  method: 'get',
  path: '/:namespace/:method',
  request: {
    params: z.object({
      namespace: z.string(),
      method: z.string(),
    }),
  },
  responses: {
    200: {
      description: 'Successful response from the GitHub API.',
      content: {
        'application/json': {
          schema: RestResponseSchema,
        },
      },
    },
    304: {
      description: 'Not Modified.',
    },
  },
  description: 'Generic proxy for the GitHub REST API (GET requests).',
})

const postRoute = createRoute({
  method: 'post',
  path: '/:namespace/:method',
  request: {
    params: z.object({
      namespace: z.string(),
      method: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: z.record(z.any()).optional(),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Successful response from the GitHub API.',
      content: {
        'application/json': {
          schema: RestResponseSchema,
        },
      },
    },
  },
  description: 'Generic proxy for the GitHub REST API (POST requests).',
})


// --- 3. Hono App and Handler ---

const rest = new OpenAPIHono<{ Bindings: Bindings }>()

rest.use('*', etagCache())

const handler = async (c: Context<{ Bindings: Bindings }>) => {
  const { namespace, method } = c.req.valid('param')
  const octokit = getOctokit(c.env)

  // @ts-ignore
  if (!octokit[namespace] || !octokit[namespace][method]) {
    return c.json({ error: 'Not Found' }, 404)
  }

  let params
  if (c.req.method === 'POST') {
    params = c.req.valid('json')
  } else {
    params = c.req.query()
  }

  // @ts-ignore
  const { data, headers, status } = await octokit[namespace][method](params)

  return c.newResponse(JSON.stringify(data), {
    status,
    headers: headers as HeadersInit,
  })
}

rest.openapi(getRoute, handler)
rest.openapi(postRoute, handler)

export default rest

/**
 * @extension_point
 * This is a good place to add any custom logic to the REST API proxy,
 * such as response caching or filtering.
 */
EOF

# Octokit GraphQL proxy
cat <<'EOF' > "$SRC_DIR/octokit/graphql/graphql.ts"
/**
 * @file src/octokit/graphql/graphql.ts
 * @description This file contains the implementation of the GitHub GraphQL API proxy.
 * @owner AI-Builder
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { getGraphql } from '../core'
import { Bindings } from '../../utils/hono'

// --- 1. Zod Schema Definitions ---

const GraphqlRequestSchema = z.object({
  query: z.string().openapi({ example: '{ viewer { login } }' }),
  variables: z.record(z.any()).optional().openapi({ example: { first: 10 } }),
})

const GraphqlResponseSchema = z.object({
  data: z.record(z.any()),
  errors: z.array(z.record(z.any())).optional(),
})

// --- 2. Route Definition ---

const graphqlRoute = createRoute({
  method: 'post',
  path: '/',
  request: {
    body: {
      content: {
        'application/json': {
          schema: GraphqlRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: GraphqlResponseSchema,
        },
      },
      description: 'GraphQL query executed successfully.',
    },
  },
  description: 'Proxy for the GitHub GraphQL API.',
})

// --- 3. Hono App and Handler ---

const graphql = new OpenAPIHono<{ Bindings: Bindings }>()

graphql.openapi(graphqlRoute, async (c) => {
  const { query, variables } = c.req.valid('json')
  const gql = getGraphql(c.env)

  const response = await gql(query, variables)

  return c.json({ data: response })
})

const graphqlApi = new OpenAPIHono<{ Bindings: Bindings }>()
graphqlApi.route('/graphql', graphql)

export default graphqlApi

/**
 * @extension_point
 * This is a good place to add any custom logic to the GraphQL proxy,
 * such as query caching or rate limiting.
 */
EOF

# --- Create Tools (Agent-Friendly) Files ---

# Tools main router
cat <<'EOF' > "$SRC_DIR/tools/index.ts"
/**
 * @file src/tools/index.ts
 * @description This file exports all the tool routes.
 * @owner AI-Builder
 */

import { OpenAPIHono } from '@hono/zod-openapi'
import files from './files'
import prs from './prs'
import issues from './issues'
import { Bindings } from '../utils/hono'

const toolsApi = new OpenAPIHono<{ Bindings: Bindings }>()

toolsApi.route('/', files)
toolsApi.route('/', prs)
toolsApi.route('/', issues)

export default toolsApi

/**
 * @extension_point
 * This is a good place to add new tool routes.
 * Just import the new tool and add a new `route` call.
 */
EOF

# Files tool
cat <<'EOF' > "$SRC_DIR/tools/files.ts"
/**
 * @file src/tools/files.ts
 * @description This file contains the implementation of the file upsert tool.
 * @owner AI-Builder
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { getOctokit } from '../octokit/core'
import { encode } from '../utils/base64'
import { Bindings } from '../utils/hono'

// --- 1. Zod Schema Definitions ---

const UpsertFileRequestSchema = z.object({
  owner: z.string().openapi({ example: 'octocat' }),
  repo: z.string().openapi({ example: 'Hello-World' }),
  path: z.string().openapi({ example: 'test.txt' }),
  content: z.string().openapi({ example: 'Hello, world!' }),
  message: z.string().openapi({ example: 'feat: add test.txt' }),
  sha: z.string().optional().openapi({ example: '95b966ae1c166bd92f8ae7d1c313e738c731dfc3' }),
})

const UpsertFileResponseSchema = z.object({
  content: z.object({
    name: z.string(),
    path: z.string(),
    sha: z.string(),
    size: z.number(),
    url: z.string().url(),
    html_url: z.string().url(),
    git_url: z.string().url(),
    download_url: z.string().url().nullable(),
    type: z.string(),
  }),
  commit: z.object({
    sha: z.string(),
    url: z.string().url(),
    html_url: z.string().url(),
    message: z.string(),
  }),
})

const ListRepoTreeRequestSchema = z.object({
  owner: z.string().openapi({ example: 'octocat' }),
  repo: z.string().openapi({ example: 'Hello-World' }),
  ref: z
    .string()
    .optional()
    .openapi({ example: 'main', description: 'Git reference (branch, tag, or commit SHA). Defaults to HEAD.' }),
  path: z
    .string()
    .optional()
    .openapi({ example: 'src', description: 'Restrict the listing to a specific directory path.' }),
  recursive: z
    .boolean()
    .optional()
    .openapi({ example: true, description: 'When true, retrieves the full tree recursively.' }),
})

const TreeEntrySchema = z.object({
  path: z.string(),
  type: z.string(),
  mode: z.string(),
  sha: z.string(),
  size: z.number().nullable(),
  url: z.string().url().nullable(),
  depth: z.number().int().min(0),
  displayPath: z.string(),
})

const ListRepoTreeResponseSchema = z.object({
  entries: z.array(TreeEntrySchema),
  listing: z.string(),
  truncated: z.boolean(),
})

// --- 2. Route Definition ---

const upsertFileRoute = createRoute({
  method: 'post',
  path: '/files/upsert',
  request: {
    body: {
      content: {
        'application/json': {
          schema: UpsertFileRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: UpsertFileResponseSchema,
        },
      },
      description: 'File created or updated successfully.',
    },
  },
  'x-agent': true,
  description: 'Create or update a file in a GitHub repository.',
})

// --- 3. Hono App and Handler ---

const files = new OpenAPIHono<{ Bindings: Bindings }>()

files.openapi(upsertFileRoute, async (c) => {
  const { owner, repo, path, content, message, sha } = c.req.valid('json')
  const octokit = getOctokit(c.env)

  const { data } = await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    message,
    content: encode(content),
    sha,
  })

  // The response from Octokit is more verbose than our schema, so we need to map it.
  const response: z.infer<typeof UpsertFileResponseSchema> = {
    content: {
      name: data.content!.name,
      path: data.content!.path,
      sha: data.content!.sha,
      size: data.content!.size,
      url: data.content!.url,
      html_url: data.content!.html_url,
      git_url: data.content!.git_url,
      download_url: data.content!.download_url,
      type: data.content!.type,
    },
    commit: {
      sha: data.commit.sha!,
      url: data.commit.url,
      html_url: data.commit.html_url,
      message: data.commit.message,
    },
  }

  return c.json(response)
})

const listRepoTreeRoute = createRoute({
  method: 'post',
  path: '/files/tree',
  request: {
    body: {
      content: {
        'application/json': {
          schema: ListRepoTreeRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: ListRepoTreeResponseSchema,
        },
      },
      description: 'Repository tree retrieved successfully.',
    },
  },
  'x-agent': true,
  description: 'List repository contents with an ls-style tree representation.',
})

files.openapi(listRepoTreeRoute, async (c) => {
  const { owner, repo, ref, path, recursive } = c.req.valid('json')
  const octokit = getOctokit(c.env)

  const treeSha = ref ?? 'HEAD'
  const recursiveFlag = recursive ?? true

  const { data } = await octokit.git.getTree({
    owner,
    repo,
    tree_sha: treeSha,
    recursive: recursiveFlag ? '1' : undefined,
  })

  const normalizedPath = path?.replace(/^\/+|\/+$/g, '')

  const filteredTree = normalizedPath
    ? data.tree.filter((entry) => {
        if (!entry.path) {
          return false
        }

        return entry.path === normalizedPath || entry.path.startsWith(`${normalizedPath}/`)
      })
    : data.tree

  const sortedEntries = [...filteredTree].sort((a, b) => {
    const pathA = a.path ?? ''
    const pathB = b.path ?? ''
    return pathA.localeCompare(pathB)
  })

  const formattedEntries = sortedEntries.map((entry) => {
    const pathValue = entry.path ?? ''
    const segments = (() => {
      if (!pathValue) {
        return [] as string[]
      }

      if (!normalizedPath) {
        return pathValue.split('/').filter(Boolean)
      }

      if (pathValue === normalizedPath) {
        return [] as string[]
      }

      if (pathValue.startsWith(`${normalizedPath}/`)) {
        return pathValue
          .slice(normalizedPath.length + 1)
          .split('/')
          .filter(Boolean)
      }

      return pathValue.split('/').filter(Boolean)
    })()

    const relativeDepth = normalizedPath
      ? segments.length
      : Math.max(0, segments.length - 1)

    const indent = '  '.repeat(relativeDepth)
    const suffix = entry.type === 'tree' ? '/' : ''

    const displayPath = normalizedPath && pathValue === normalizedPath
      ? './'
      : segments.length === 0
        ? (pathValue || './') + suffix
        : `${indent}${segments[segments.length - 1]}${suffix}`

    return {
      path: pathValue,
      type: entry.type ?? 'blob',
      mode: entry.mode ?? '',
      sha: entry.sha ?? '',
      size: typeof entry.size === 'number' ? entry.size : null,
      url: entry.url ?? null,
      depth: relativeDepth,
      displayPath,
    }
  })

  const header = 'MODE     TYPE   SIZE      SHA                                      PATH'
  const listingLines = formattedEntries.map((entry) => {
    const sizeValue = entry.size === null ? '-' : entry.size.toString()
    return `${entry.mode.padEnd(8)} ${entry.type.padEnd(5)} ${sizeValue.padStart(8)} ${entry.sha} ${entry.displayPath}`
  })

  const listing = [header, ...listingLines].join('\n')

  return c.json({
    entries: formattedEntries,
    listing,
    truncated: data.truncated ?? false,
  })
})

export default files

/**
 * @extension_point
 * This is a good place to add other file-related tools,
 * such as reading, deleting, or listing files.
 */
EOF

# Pull Requests tool
cat <<'EOF' > "$SRC_DIR/tools/prs.ts"
/**
 * @file src/tools/prs.ts
 * @description This file contains the implementation of the open pull request tool.
 * @owner AI-Builder
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { getOctokit } from '../octokit/core'
import { Bindings } from '../utils/hono'

// --- 1. Zod Schema Definitions ---

const OpenPrRequestSchema = z.object({
  owner: z.string().openapi({ example: 'octocat' }),
  repo: z.string().openapi({ example: 'Hello-World' }),
  head: z.string().openapi({ example: 'feature-branch' }),
  base: z.string().openapi({ example: 'main' }),
  title: z.string().openapi({ example: 'feat: new feature' }),
  body: z.string().optional().openapi({ example: 'This PR adds a new feature.' }),
})

const OpenPrResponseSchema = z.object({
  id: z.number(),
  number: z.number(),
  html_url: z.string().url(),
  state: z.string(),
  title: z.string(),
  body: z.string().nullable(),
})

// --- 2. Route Definition ---

const openPrRoute = createRoute({
  method: 'post',
  path: '/prs/open',
  request: {
    body: {
      content: {
        'application/json': {
          schema: OpenPrRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: OpenPrResponseSchema,
        },
      },
      description: 'Pull request opened successfully.',
    },
  },
  'x-agent': true,
  description: 'Open a new pull request in a GitHub repository.',
})

// --- 3. Hono App and Handler ---

const prs = new OpenAPIHono<{ Bindings: Bindings }>()

prs.openapi(openPrRoute, async (c) => {
  const { owner, repo, head, base, title, body } = c.req.valid('json')
  const octokit = getOctokit(c.env)

  const { data } = await octokit.pulls.create({
    owner,
    repo,
    head,
    base,
    title,
    body,
  })

  const response: z.infer<typeof OpenPrResponseSchema> = {
    id: data.id,
    number: data.number,
    html_url: data.html_url,
    state: data.state,
    title: data.title,
    body: data.body,
  }

  return c.json(response)
})

export default prs

/**
 * @extension_point
 * This is a good place to add other PR-related tools,
 * such as listing, merging, or closing pull requests.
 */
EOF

# Issues tool
cat <<'EOF' > "$SRC_DIR/tools/issues.ts"
/**
 * @file src/tools/issues.ts
 * @description This file contains the implementation of the create issue tool.
 * @owner AI-Builder
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { getOctokit } from '../octokit/core'
import { Bindings } from '../utils/hono'

// --- 1. Zod Schema Definitions ---

const CreateIssueRequestSchema = z.object({
  owner: z.string().openapi({ example: 'octocat' }),
  repo: z.string().openapi({ example: 'Hello-World' }),
  title: z.string().openapi({ example: 'Bug: Something is broken' }),
  body: z.string().optional().openapi({ example: 'Here are the steps to reproduce...' }),
  labels: z.array(z.string()).optional().openapi({ example: ['bug', 'critical'] }),
})

const CreateIssueResponseSchema = z.object({
  id: z.number(),
  number: z.number(),
  html_url: z.string().url(),
  state: z.string(),
  title: z.string(),
  body: z.string().nullable(),
})

// --- 2. Route Definition ---

const createIssueRoute = createRoute({
  method: 'post',
  path: '/issues/create',
  request: {
    body: {
      content: {
        'application/json': {
          schema: CreateIssueRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: CreateIssueResponseSchema,
        },
      },
      description: 'Issue created successfully.',
    },
  },
  'x-agent': true,
  description: 'Create a new issue in a GitHub repository.',
})

// --- 3. Hono App and Handler ---

const issues = new OpenAPIHono<{ Bindings: Bindings }>()

issues.openapi(createIssueRoute, async (c) => {
  const { owner, repo, title, body, labels } = c.req.valid('json')
  const octokit = getOctokit(c.env)

  const { data } = await octokit.issues.create({
    owner,
    repo,
    title,
    body,
    labels,
  })

  const response: z.infer<typeof CreateIssueResponseSchema> = {
    id: data.id,
    number: data.number,
    html_url: data.html_url,
    state: data.state,
    title: data.title,
    body: data.body,
  }

  return c.json(response)
})

export default issues

/**
 * @extension_point
 * This is a good place to add other issue-related tools,
 * such as listing, updating, or commenting on issues.
 */
EOF

# --- Create Flows (Automation) Files ---

# Flows main router
cat <<'EOF' > "$SRC_DIR/flows/index.ts"
/**
 * @file src/flows/index.ts
 * @description High-level flows for repository management and workflow setup
 * @owner AI-Builder
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { D1Database } from '@cloudflare/workers-types'
import { getOctokit } from '../octokit/core'
import { Bindings } from '../utils/hono'
import { DEFAULT_WORKFLOWS, shouldIncludeCloudflareWorkflow } from './workflowTemplates'
import { encode } from '../utils/base64'

// --- 1. Zod Schema Definitions ---

const CreateNewRepoRequestSchema = z.object({
  owner: z.string().openapi({ 
    example: 'octocat',
    description: 'Repository owner (organization or user)' 
  }),
  name: z.string().openapi({ 
    example: 'my-worker',
    description: 'Repository name' 
  }),
  description: z.string().optional().openapi({ 
    example: 'My Cloudflare Worker',
    description: 'Repository description' 
  }),
  private: z.boolean().optional().default(false).openapi({ 
    example: false,
    description: 'Whether the repository should be private' 
  }),
  auto_init: z.boolean().optional().default(true).openapi({ 
    example: true,
    description: 'Initialize repo with README' 
  }),
})

const CreateNewRepoResponseSchema = z.object({
  repo: z.object({
    id: z.number(),
    name: z.string(),
    full_name: z.string(),
    html_url: z.string().url(),
    private: z.boolean(),
  }),
  workflows: z.array(z.object({
    path: z.string(),
    status: z.string(),
    message: z.string().optional(),
  })),
  secrets: z.array(z.object({
    name: z.string(),
    status: z.string(),
    message: z.string().optional(),
  })),
})

const RetrofitWorkflowsRequestSchema = z.object({
  owner: z.string().openapi({ 
    example: 'octocat',
    description: 'Repository owner to filter by' 
  }),
  repos: z.array(z.string()).optional().openapi({ 
    example: ['repo1', 'repo2'],
    description: 'Specific repository names to retrofit (if empty, uses date filters)' 
  }),
  date_active_gt: z.string().optional().openapi({ 
    example: '2024-01-01',
    description: 'Filter repos with last activity greater than this date (ISO 8601)' 
  }),
  date_active_lt: z.string().optional().openapi({ 
    example: '2024-12-31',
    description: 'Filter repos with last activity less than this date (ISO 8601)' 
  }),
  date_added_gt: z.string().optional().openapi({ 
    example: '2024-01-01',
    description: 'Filter repos created after this date (ISO 8601)' 
  }),
  date_added_lt: z.string().optional().openapi({ 
    example: '2024-12-31',
    description: 'Filter repos created before this date (ISO 8601)' 
  }),
  force: z.boolean().optional().default(false).openapi({ 
    example: false,
    description: 'Force overwrite existing workflow files' 
  }),
})

const RetrofitWorkflowsResponseSchema = z.object({
  summary: z.object({
    total_repos_processed: z.number(),
    successful: z.number(),
    skipped: z.number(),
    failed: z.number(),
  }),
  results: z.array(z.object({
    repo_name: z.string(),
    status: z.enum(['success', 'skipped', 'failure']),
    workflows_added: z.array(z.string()),
    message: z.string().optional(),
  })),
})

// --- 2. Route Definitions ---

const createNewRepoRoute = createRoute({
  method: 'post',
  path: '/flows/create-new-repo',
  request: {
    body: {
      content: {
        'application/json': {
          schema: CreateNewRepoRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: CreateNewRepoResponseSchema,
        },
      },
      description: 'Repository created successfully with default workflows.',
    },
  },
  'x-agent': true,
  description: 'Create a new repository with default GitHub Actions workflows.',
})

const retrofitWorkflowsRoute = createRoute({
  method: 'post',
  path: '/flows/retrofit-workflows',
  request: {
    body: {
      content: {
        'application/json': {
          schema: RetrofitWorkflowsRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: RetrofitWorkflowsResponseSchema,
        },
      },
      description: 'Workflows retrofitted successfully.',
    },
  },
  'x-agent': true,
  description: 'Add default workflows to existing repositories based on filters.',
})

// --- 3. Hono App and Handlers ---

const flows = new OpenAPIHono<{ Bindings: Bindings }>()

/**
 * Helper function to log retrofit operation to D1
 */
async function logRetrofitOperation(
  db: D1Database,
  repoName: string,
  action: string,
  status: 'success' | 'skipped' | 'failure',
  statusDetails: Record<string, any>
): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO gh_management_config (timestamp, repo_name, action, status, status_details)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(
      new Date().toISOString(),
      repoName,
      action,
      status,
      JSON.stringify(statusDetails)
    ).run()
  } catch (error) {
    console.error('Failed to log retrofit operation:', error)
  }
}

/**
 * Helper function to check if workflow files already exist
 */
async function getExistingWorkflows(
  octokit: any,
  owner: string,
  repo: string
): Promise<string[]> {
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path: '.github/workflows',
    })
    
    if (Array.isArray(data)) {
      return data.map((file: any) => file.path)
    }
    return []
  } catch (error: any) {
    // 404 means .github/workflows doesn't exist yet
    if (error.status === 404) {
      return []
    }
    throw error
  }
}

/**
 * Helper function to get repository root files
 */
async function getRepoRootFiles(
  octokit: any,
  owner: string,
  repo: string
): Promise<string[]> {
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path: '',
    })
    
    if (Array.isArray(data)) {
      return data.map((file: any) => file.name)
    }
    return []
  } catch (error) {
    console.error('Failed to get repo root files:', error)
    return []
  }
}

/**
 * Helper function to create or update workflow files
 */
async function upsertWorkflowFile(
  octokit: any,
  owner: string,
  repo: string,
  path: string,
  content: string,
  force: boolean
): Promise<{ status: string; message?: string }> {
  try {
    // Check if file exists
    let sha: string | undefined
    try {
      const { data } = await octokit.repos.getContent({
        owner,
        repo,
        path,
      })
      if ('sha' in data) {
        sha = data.sha
      }
    } catch (error: any) {
      if (error.status !== 404) {
        throw error
      }
    }

    // If file exists and force is false, skip
    if (sha && !force) {
      return { status: 'skipped', message: 'File already exists' }
    }

    // Create or update the file
    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path,
      message: sha 
        ? `chore: update ${path}` 
        : `chore: add ${path}`,
      content: encode(content),
      sha,
    })

    return { status: 'success', message: sha ? 'Updated' : 'Created' }
  } catch (error: any) {
    return { 
      status: 'failure', 
      message: error.message || 'Unknown error' 
    }
  }
}

/**
 * Helper function to set repository secret
 * Note: This is a placeholder implementation. In production, secrets should be
 * set using GitHub CLI or API with proper NaCl encryption.
 * The GitHub API requires secrets to be encrypted with the repo's public key
 * using libsodium sealed boxes before submission.
 */
async function setRepoSecret(
  octokit: any,
  owner: string,
  repo: string,
  secretName: string,
  secretValue: string
): Promise<{ status: string; message?: string }> {
  try {
    // For now, we'll skip the actual secret creation since we don't have
    // the libsodium encryption library available in the Cloudflare Worker.
    // This would need to be implemented with tweetnacl or libsodium-wrappers
    // in a future version.
    console.log(`[setRepoSecret] Would set secret ${secretName} for ${owner}/${repo}`)
    return { 
      status: 'skipped', 
      message: 'Secret encryption not implemented - use GitHub CLI or manual setup' 
    }
  } catch (error: any) {
    return { 
      status: 'failure', 
      message: error.message || 'Failed to set secret' 
    }
  }
}

// --- Handler: Create New Repo ---

flows.openapi(createNewRepoRoute, async (c) => {
  const { owner, name, description, private: isPrivate, auto_init } = c.req.valid('json')
  const octokit = getOctokit(c.env)

  console.log(`[flows/create-new-repo] Creating repository ${owner}/${name}`)

  // 1. Create the repository
  const { data: repo } = await octokit.repos.createInOrg({
    org: owner,
    name,
    description,
    private: isPrivate,
    auto_init,
  })

  console.log(`[flows/create-new-repo] Repository created: ${repo.full_name}`)

  // Wait a bit for repo initialization
  await new Promise(resolve => setTimeout(resolve, 2000))

  // 2. Add default workflow files
  const workflowResults = []
  for (const workflow of DEFAULT_WORKFLOWS) {
    const result = await upsertWorkflowFile(
      octokit,
      owner,
      name,
      workflow.path,
      workflow.content,
      false
    )
    workflowResults.push({
      path: workflow.path,
      status: result.status,
      message: result.message,
    })
    console.log(`[flows/create-new-repo] Workflow ${workflow.path}: ${result.status}`)
  }

  // 3. Set up repository secrets
  const secretResults = []
  const secrets = [
    { name: 'CLOUDFLARE_API_TOKEN', envKey: 'CLOUDFLARE_API_TOKEN' },
    { name: 'CLOUDFLARE_ACCOUNT_ID', envKey: 'GITHUB_ACTION_CLOUDFLARE_ACCOUNT_ID' },
  ]

  for (const secret of secrets) {
    const secretValue = (c.env as any)[secret.envKey]
    if (secretValue) {
      const result = await setRepoSecret(
        octokit,
        owner,
        name,
        secret.name,
        secretValue
      )
      secretResults.push({
        name: secret.name,
        status: result.status,
        message: result.message,
      })
      console.log(`[flows/create-new-repo] Secret ${secret.name}: ${result.status}`)
    } else {
      secretResults.push({
        name: secret.name,
        status: 'skipped',
        message: 'Environment variable not set',
      })
      console.log(`[flows/create-new-repo] Secret ${secret.name}: skipped (env var not set)`)
    }
  }

  // 4. Log the operation
  await logRetrofitOperation(
    c.env.CORE_GITHUB_API,
    repo.full_name,
    'create_new_repo',
    'success',
    {
      workflows: workflowResults,
      secrets: secretResults,
    }
  )

  return c.json({
    repo: {
      id: repo.id,
      name: repo.name,
      full_name: repo.full_name,
      html_url: repo.html_url,
      private: repo.private,
    },
    workflows: workflowResults,
    secrets: secretResults,
  })
})

// --- Handler: Retrofit Workflows ---

flows.openapi(retrofitWorkflowsRoute, async (c) => {
  const { owner, repos, date_active_gt, date_active_lt, date_added_gt, date_added_lt, force } = c.req.valid('json')
  const octokit = getOctokit(c.env)

  console.log(`[flows/retrofit-workflows] Starting retrofit for owner: ${owner}`)

  let targetRepos: any[] = []

  // 1. Get list of repositories to process
  if (repos && repos.length > 0) {
    // Process specific repos
    console.log(`[flows/retrofit-workflows] Processing specific repos: ${repos.join(', ')}`)
    for (const repoName of repos) {
      try {
        const { data } = await octokit.repos.get({ owner, repo: repoName })
        targetRepos.push(data)
      } catch (error: any) {
        console.error(`[flows/retrofit-workflows] Failed to get repo ${repoName}:`, error.message)
      }
    }
  } else {
    // Get all repos with filters
    console.log(`[flows/retrofit-workflows] Fetching all repos for owner with filters`)
    const { data: allRepos } = await octokit.repos.listForOrg({
      org: owner,
      type: 'all',
      per_page: 100,
    })

    targetRepos = allRepos.filter((repo: any) => {
      // Apply date filters
      if (date_active_gt && new Date(repo.pushed_at) <= new Date(date_active_gt)) {
        return false
      }
      if (date_active_lt && new Date(repo.pushed_at) >= new Date(date_active_lt)) {
        return false
      }
      if (date_added_gt && new Date(repo.created_at) <= new Date(date_added_gt)) {
        return false
      }
      if (date_added_lt && new Date(repo.created_at) >= new Date(date_added_lt)) {
        return false
      }
      return true
    })
  }

  console.log(`[flows/retrofit-workflows] Processing ${targetRepos.length} repositories`)

  // 2. Process each repository
  const results: Array<{
    repo_name: string
    status: 'success' | 'skipped' | 'failure'
    workflows_added: string[]
    message?: string
  }> = []
  let successCount = 0
  let skippedCount = 0
  let failedCount = 0

  for (const repo of targetRepos) {
    console.log(`[flows/retrofit-workflows] Processing ${repo.full_name}`)
    
    try {
      // Check existing workflows
      const existingWorkflows = await getExistingWorkflows(octokit, owner, repo.name)
      console.log(`[flows/retrofit-workflows] Existing workflows in ${repo.name}:`, existingWorkflows)

      // Get root files to check for wrangler config
      const rootFiles = await getRepoRootFiles(octokit, owner, repo.name)
      const hasWranglerConfig = shouldIncludeCloudflareWorkflow(rootFiles)
      console.log(`[flows/retrofit-workflows] ${repo.name} has wrangler config: ${hasWranglerConfig}`)

      const workflowsAdded: string[] = []
      let repoStatus: 'success' | 'skipped' | 'failure' = 'success'
      let statusMessage = ''

      // Determine which workflows to add
      const workflowsToAdd = DEFAULT_WORKFLOWS.filter(workflow => {
        // Skip Cloudflare workflow if no wrangler config
        if (workflow.path.includes('deploy-worker') && !hasWranglerConfig) {
          return false
        }
        return true
      })

      // Check if all workflows already exist
      const allWorkflowsExist = workflowsToAdd.every(workflow =>
        existingWorkflows.some(existing => existing.includes(workflow.path.split('/').pop() || ''))
      )

      if (allWorkflowsExist && !force) {
        repoStatus = 'skipped'
        statusMessage = 'All workflows already exist'
        skippedCount++
        console.log(`[flows/retrofit-workflows] ${repo.name}: skipped (all workflows exist)`)
      } else {
        // Add workflows
        for (const workflow of workflowsToAdd) {
          const result = await upsertWorkflowFile(
            octokit,
            owner,
            repo.name,
            workflow.path,
            workflow.content,
            force
          )

          if (result.status === 'success') {
            workflowsAdded.push(workflow.path)
          } else if (result.status === 'failure') {
            repoStatus = 'failure'
            statusMessage = result.message || 'Failed to add workflow'
          }
          console.log(`[flows/retrofit-workflows] ${repo.name} - ${workflow.path}: ${result.status}`)
        }

        if (repoStatus === 'success' && workflowsAdded.length > 0) {
          successCount++
          statusMessage = `Added ${workflowsAdded.length} workflow(s)`
        } else if (workflowsAdded.length === 0 && repoStatus !== 'failure') {
          repoStatus = 'skipped'
          statusMessage = 'No workflows needed'
          skippedCount++
        } else if (repoStatus === 'failure') {
          failedCount++
        }
      }

      // Log the operation
      await logRetrofitOperation(
        c.env.CORE_GITHUB_API,
        repo.full_name,
        'retrofit_workflows',
        repoStatus,
        {
          workflows_added: workflowsAdded,
          message: statusMessage,
          force,
        }
      )

      results.push({
        repo_name: repo.full_name,
        status: repoStatus,
        workflows_added: workflowsAdded,
        message: statusMessage,
      })

    } catch (error: any) {
      const errorMessage = error.message || 'Unknown error'
      console.error(`[flows/retrofit-workflows] Error processing ${repo.full_name}:`, errorMessage)
      
      failedCount++
      await logRetrofitOperation(
        c.env.CORE_GITHUB_API,
        repo.full_name,
        'retrofit_workflows',
        'failure',
        {
          error: errorMessage,
          force,
        }
      )

      results.push({
        repo_name: repo.full_name,
        status: 'failure',
        workflows_added: [],
        message: errorMessage,
      })
    }
  }

  console.log(`[flows/retrofit-workflows] Complete. Success: ${successCount}, Skipped: ${skippedCount}, Failed: ${failedCount}`)

  return c.json({
    summary: {
      total_repos_processed: targetRepos.length,
      successful: successCount,
      skipped: skippedCount,
      failed: failedCount,
    },
    results,
  })
})

export default flows

/**
 * @extension_point
 * This is a good place to add other flow-related endpoints,
 * such as bulk repository management operations.
 */
EOF

# Workflow templates (including PR comment extractor)
cat <<'EOF' > "$SRC_DIR/flows/workflowTemplates.ts"
/**
 * @file src/flows/workflowTemplates.ts
 * @description GitHub Actions workflow templates for automated repository setup
 * @owner AI-Builder
 */

/**
 * GitHub Action workflow for extracting and summarizing PR comments
 * This helps AI bots fix all comments in one pass
 */
export const PR_COMMENT_EXTRACTOR_WORKFLOW = `name: Extract and Summarize PR Comments

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

permissions:
  pull-requests: write
  issues: read
  contents: read

concurrency:
  group: pr-comment-\${{ github.event.issue.number || github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  summarize-comments:
    if: >
      github.event.comment.user.login != 'jmbish04' &&
      github.event.issue.pull_request != null
    runs-on: ubuntu-latest

    steps:
      - name: Wait 30 seconds to batch comments
        run: sleep 30

      - name: Checkout
        uses: actions/checkout@v4

      - name: Install jq and gh
        run: sudo apt-get update && sudo apt-get install -y jq gh

      - name: Extract and sanitize PR comments
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          REPO: \${{ github.repository }}
          PR_NUMBER: \${{ github.event.issue.number || github.event.pull_request.number }}
        run: |
          echo "# Extracting comments for PR #$PR_NUMBER"

          # Fetch PR discussion comments (excluding you)
          gh api -H "Accept: application/vnd.github.v3+json" \\
            "/repos/$REPO/issues/$PR_NUMBER/comments" --paginate |
          jq -r '
            .[]
            | select(.user.login != "jmbish04")
            | .body
          ' > all_comments_raw.txt

          # Fetch inline code review comments
          gh api -H "Accept: application/vnd.github.v3+json" \\
            "/repos/$REPO/pulls/$PR_NUMBER/comments" --paginate |
          jq -r '
            .[]
            | select(.user.login != "jmbish04")
            | "### File: \\(.path)\\nLine: \\(.line // "N/A")\\n\\n" + (.body // "")
          ' >> all_comments_raw.txt

          # Clean text: remove badges, slash commands, bot names, etc.
          sed -E -i \\
            -e 's|!\\[[^]]*\\]\\([^)]*\\)||g' \\
            -e 's|@[A-Za-z0-9._-]+\\[bot\\]||g' \\
            -e 's|/gemini[^\\n]*||gi' \\
            -e 's|/colby[^\\n]*||gi' \\
            -e 's|@jules||gi' \\
            -e '/^$/N;/^\\n$/D' \\
            all_comments_raw.txt

          # Add a header
          {
            echo "# 🧠 Cleaned PR Feedback Summary"
            echo ""
            cat all_comments_raw.txt
          } > cleaned_comments.md

          echo "---- Cleaned Comments Preview ----"
          head -n 40 cleaned_comments.md || true

      - name: Post cleaned summary as PR comment
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          REPO: \${{ github.repository }}
          PR_NUMBER: \${{ github.event.issue.number || github.event.pull_request.number }}
        run: |
          gh pr comment "$PR_NUMBER" --repo "$REPO" --body-file cleaned_comments.md
`

/**
 * GitHub Action workflow for deploying Cloudflare Workers
 * Only runs if wrangler.toml or wrangler.jsonc exists
 */
export const CLOUDFLARE_DEPLOY_WORKFLOW = `name: Deploy Worker
on:
  push:
    branches:
      - main
jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
      
      - name: Build & Deploy Worker
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
`

/**
 * GitHub Action workflow for auto-applying Gemini code suggestions
 * Automatically applies code suggestions from gemini-code-assist bot
 */
export const AUTO_APPLY_GEMINI_WORKFLOW = `name: Auto-Apply Gemini Suggestions

on:
  pull_request_review_comment:
    types: [created]

permissions:
  contents: write
  pull-requests: write

jobs:
  auto-apply:
    if: github.event.comment.user.login == 'gemini-code-assist[bot]'
    runs-on: ubuntu-latest

    steps:
      - name: Wait 10 seconds to batch Gemini comments
        run: sleep 10

      - name: Checkout PR branch
        uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.head.ref }}
          repository: \${{ github.repository }}
          token: \${{ secrets.GITHUB_TOKEN }}

      - name: Fetch and process comment
        id: process
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          COMMENT_ID: \${{ github.event.comment.id }}
          REPO: \${{ github.repository }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
        run: |
          echo "🔍 Checking comment $COMMENT_ID from Gemini..."
          BODY=$(gh api /repos/$REPO/pulls/comments/$COMMENT_ID --jq '.body')
          FILE=$(gh api /repos/$REPO/pulls/comments/$COMMENT_ID --jq '.path')
          LINE=$(gh api /repos/$REPO/pulls/comments/$COMMENT_ID --jq '.line')

          echo "📄 File: $FILE (line $LINE)"
          echo "$BODY" | awk '/\\\`\\\`\\\`suggestion/,/\\\`\\\`\\\`/' | sed '/\\\`\\\`\\\`/d' > suggestion.patch

          if [ ! -s suggestion.patch ]; then
            echo "no_suggestion=true" >> $GITHUB_OUTPUT
            exit 0
          fi

          echo "no_suggestion=false" >> $GITHUB_OUTPUT
          echo "✅ Suggestion found:"
          cat suggestion.patch

          # Dry-run apply
          echo "🧪 Dry-run applying suggestion..."
          git apply --check suggestion.patch && echo "patch_valid=true" >> $GITHUB_OUTPUT || echo "patch_valid=false" >> $GITHUB_OUTPUT

      - name: Comment result on PR
        if: always()
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          REPO: \${{ github.repository }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
          COMMENT_ID: \${{ github.event.comment.id }}
          NO_SUGGESTION: \${{ steps.process.outputs.no_suggestion }}
          PATCH_VALID: \${{ steps.process.outputs.patch_valid }}
        run: |
          if [ "$NO_SUGGESTION" = "true" ]; then
            gh pr comment "$PR_NUMBER" --repo "$REPO" --body "✅ Action ran successfully but no \\\`\\\`\\\`suggestion\\\`\\\`\\\` code blocks were detected in Gemini's comment."
            exit 0
          fi

          if [ "$PATCH_VALID" = "false" ]; then
            gh pr comment "$PR_NUMBER" --repo "$REPO" --body "⚠️ Gemini suggestion found but could not apply cleanly. Please review the patch manually from comment $COMMENT_ID."
            exit 0
          fi

          # Apply, commit, and push the patch
          echo "🚀 Applying patch..."
          git apply suggestion.patch
          git add .
          git config user.name "auto-gemini-applier"
          git config user.email "bot@users.noreply.github.com"
          git commit -m "chore: apply Gemini suggestion from comment $COMMENT_ID"
          git push origin HEAD

          # Post confirmation with guidance
          cat <<EOF | gh pr comment "$PR_NUMBER" --repo "$REPO" --body-file -
          ✅ **Gemini suggestion applied automatically!**

          Applied suggestion from comment $COMMENT_ID and pushed to this PR.

          **Next Steps:**
          - Review the auto-applied changes
          - If the suggestion was incorrect, you can revert this commit
          - To disable auto-apply for future suggestions, add \\\`[skip-auto-apply]\\\` to your PR description

          ---
          _Automated by auto-gemini-applier workflow_
          EOF
`

/**
 * Workflow file definitions with their paths
 */
export interface WorkflowTemplate {
  path: string
  content: string
  description: string
}

export const DEFAULT_WORKFLOWS: WorkflowTemplate[] = [
  {
    path: '.github/workflows/pr-comment-extractor.yml',
    content: PR_COMMENT_EXTRACTOR_WORKFLOW,
    description: 'Extracts and summarizes PR comments for AI bot consumption'
  },
  {
    path: '.github/workflows/deploy-worker.yml',
    content: CLOUDFLARE_DEPLOY_WORKFLOW,
    description: 'Deploys Cloudflare Worker on push to main branch'
  },
  {
    path: '.github/workflows/auto-apply-gemini.yml',
    content: AUTO_APPLY_GEMINI_WORKFLOW,
    description: 'Automatically applies code suggestions from Gemini bot'
  }
]

/**
 * Checks if a repository likely needs the Cloudflare deploy workflow
 * by checking for wrangler configuration files
 */
export function shouldIncludeCloudflareWorkflow(files: string[]): boolean {
  return files.some(file => 
    file === 'wrangler.toml' || 
    file === 'wrangler.jsonc' ||
    file === 'wrangler.json'
  )
}
EOF

# --- Create Documentation Files ---

# Main README
cat <<'EOF' > "$OUTPUT_DIR/README.md"
# Cloudflare Worker GitHub Proxy

This is a modular, extensible Cloudflare Worker that proxies the GitHub API, built with Hono and TypeScript. It's designed to be used by AI agents to interact with GitHub.

## 噫 Usage

The worker exposes four main sets of endpoints:

-   `/api/flows`: High-level flows for repository setup and bulk operations.
-   `/api/tools`: High-level tools for common agent workflows, such as creating files and opening pull requests.
-   `/api/octokit/rest`: A generic proxy for the GitHub REST API.
-   `/api/octokit/graphql`: A proxy for the GitHub GraphQL API.

### Flows API

The Flows API provides high-level operations for managing GitHub repositories at scale.

-   `POST /api/flows/create-new-repo`: Create a new repository with default workflows.
-   `POST /api/flows/retrofit-workflows`: Add workflows to existing repositories.

当 **[Full Flows API Documentation](./docs/FLOWS.md)**

### Tools API

The Tools API is the recommended way for agents to interact with this worker. It provides a simplified interface for common tasks.

-   `POST /api/tools/files/upsert`: Create or update a file.
-   `POST /api/tools/prs/open`: Open a new pull request.
-   `POST /api/tools/issues/create`: Create a new issue.

### REST API Proxy

The REST API proxy allows you to call any method in the [Octokit REST API](https://octokit.github.io/rest.js/v20).

-   `POST /api/octokit/rest/:namespace/:method`: Call a REST API method.

For example, to get a repository's details, you would make a `POST` request to `/api/octokit/rest/repos/get` with the following body:

```json
{
  "owner": "octocat",
  "repo": "Hello-World"
}



GraphQL API Proxy

The GraphQL API proxy allows you to make queries to the GitHub GraphQL API.
POST /api/octokit/graphql: Execute a GraphQL query.

deploying

To deploy this worker, you'll need to have the Wrangler CLI installed and configured.
Clone the repository
Install dependencies: npm install
Set your GitHub token: wrangler secret put GITHUB_TOKEN
Deploy: npm run deploy

統 API Documentation

API documentation is available via OpenAPI at the following endpoints:
/openapi.json
/openapi.yaml
You can also view the documentation using Swagger UI at /doc.

､Agentic Orchestration

This worker includes a powerful agentic orchestration layer that can interpret natural language queries and take autonomous actions through the GitHub API.

Workflow

Start a Session: Send a POST request to /api/agents/session with a natural language prompt (e.g., "find repos using Cloudflare Agents SDK with active commits").
Orchestration: The OrchestratorAgent creates a new session, generates a series of search queries from your prompt, and triggers a GithubSearchWorkflow for each query.
Execution: Each workflow enqueues a task to a Cloudflare Queue. A queue consumer in the main worker processes these tasks, executing the GitHub search, analyzing the results with an LLM, and persisting the analysis to a D1 database.
Get Results: Send a GET request to /api/agents/session/:id to retrieve the aggregated results for your session.

API Endpoints

POST /api/agents/session: Start a new orchestration session.
GET /api/agents/session/:id: Get the status and results of a session.
This project was built by an AI agent.
EOF



cat <<'EOF' > "$OUTPUT_DIR/docs/FLOWS.md"

Flows API Documentation

The Flows API provides high-level operations for managing GitHub repositories and workflows at scale.

Overview

The Flows API is designed to automate the setup and maintenance of GitHub repositories with standard configurations, particularly for Cloudflare Worker projects.

Endpoints


POST /api/flows/create-new-repo

Creates a new GitHub repository with default GitHub Actions workflows pre-configured.
Request Body:

JSON


{
  "owner": "string",           // Required: Organization or user name
  "name": "string",            // Required: Repository name
  "description": "string",     // Optional: Repository description
  "private": boolean,          // Optional: Whether repo is private (default: false)
  "auto_init": boolean         // Optional: Initialize with README (default: true)
}


Response:

JSON


{
  "repo": {
    "id": 123456,
    "name": "my-worker",
    "full_name": "my-org/my-worker",
    "html_url": "[https://github.com/my-org/my-worker](https://github.com/my-org/my-worker)",
    "private": false
  },
  "workflows": [
    {
      "path": ".github/workflows/pr-comment-extractor.yml",
      "status": "success",
      "message": "Created"
    },
    {
      "path": ".github/workflows/deploy-worker.yml",
      "status": "success",
      "message": "Created"
    }
  ],
  "secrets": [
    {
      "name": "CLOUDFLARE_API_TOKEN",
      "status": "skipped",
      "message": "Secret encryption not implemented - use GitHub CLI or manual setup"
    },
    {
      "name": "CLOUDFLARE_ACCOUNT_ID",
      "status": "skipped",
      "message": "Secret encryption not implemented - use GitHub CLI or manual setup"
    }
  ]
}


Default Workflows:
PR Comment Extractor (.github/workflows/pr-comment-extractor.yml)
Automatically extracts and summarizes all PR comments
Cleans and formats feedback for AI bot consumption
Posts consolidated summary as a PR comment
Triggers on: issue_comment, pull_request_review_comment
Cloudflare Worker Deployment (.github/workflows/deploy-worker.yml)
Automatically deploys to Cloudflare Workers on push to main
Uses cloudflare/wrangler-action@v3
Requires: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID secrets
Triggers on: push to main branch
Auto-Apply Gemini Suggestions (.github/workflows/auto-apply-gemini.yml)
Automatically applies code suggestions from Gemini bot
Extracts code from ```suggestion blocks in PR review comments
Validates patch before applying
Auto-commits and pushes changes to the PR branch
Posts confirmation or error messages
Triggers on: pull_request_review_comment from gemini-code-assist[bot]
Example:

Bash


curl -X POST https://your-worker.workers.dev/api/flows/create-new-repo \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "owner": "my-org",
    "name": "my-new-worker",
    "description": "A new Cloudflare Worker project",
    "private": false,
    "auto_init": true
  }'



POST /api/flows/retrofit-workflows

Adds or updates default workflows in existing repositories based on filters.
Request Body:

JSON


{
  "owner": "string",              // Required: Organization name to filter by
  "repos": ["string"],            // Optional: Specific repo names (if empty, uses date filters)
  "date_active_gt": "string",     // Optional: Filter by last activity > date (ISO 8601)
  "date_active_lt": "string",     // Optional: Filter by last activity < date (ISO 8601)
  "date_added_gt": "string",      // Optional: Filter by creation date > date (ISO 8601)
  "date_added_lt": "string",      // Optional: Filter by creation date < date (ISO 8601)
  "force": boolean                // Optional: Overwrite existing files (default: false)
}


Response:

JSON


{
  "summary": {
    "total_repos_processed": 10,
    "successful": 7,
    "skipped": 2,
    "failed": 1
  },
  "results": [
    {
      "repo_name": "my-org/repo1",
      "status": "success",
      "workflows_added": [
        ".github/workflows/pr-comment-extractor.yml",
        ".github/workflows/deploy-worker.yml"
      ],
      "message": "Added 2 workflow(s)"
    },
    {
      "repo_name": "my-org/repo2",
      "status": "skipped",
      "workflows_added": [],
      "message": "All workflows already exist"
    }
  ]
}


Filtering Logic:
If repos array is provided, only those repositories are processed
If repos is empty, all repositories in the organization are fetched
Date filters are applied using AND logic:
date_active_gt: Repositories with last push after this date
date_active_lt: Repositories with last push before this date
date_added_gt: Repositories created after this date
date_added_lt: Repositories created before this date
Cloudflare deployment workflow is only added if wrangler.toml, wrangler.jsonc, or wrangler.json exists
If force is false, existing workflow files are not overwritten (status: skipped)
If force is true, existing workflow files are updated
Example: Retrofit specific repos

Bash


curl -X POST https://your-worker.workers.dev/api/flows/retrofit-workflows \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "owner": "my-org",
    "repos": ["repo1", "repo2", "repo3"],
    "force": false
  }'


Example: Retrofit all active repos from 2024

Bash


curl -X POST https://your-worker.workers.dev/api/flows/retrofit-workflows \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "owner": "my-org",
    "date_active_gt": "2024-01-01",
    "date_added_gt": "2024-01-01",
    "force": false
  }'



Audit Logging

All flow operations are logged to the gh_management_config D1 table for tracking and auditing:
Table Schema:

SQL


CREATE TABLE gh_management_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp DATETIME NOT NULL,
  repo_name TEXT NOT NULL,
  action TEXT NOT NULL,           -- e.g., 'create_new_repo', 'retrofit_workflows'
  status TEXT NOT NULL,           -- 'success', 'skipped', 'failure'
  status_details TEXT,            -- JSON with additional context
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);


Query Example:

SQL


-- Get all retrofit operations in the last 7 days
SELECT * FROM gh_management_config 
WHERE action = 'retrofit_workflows' 
  AND timestamp > datetime('now', '-7 days')
ORDER BY timestamp DESC;

-- Get failed operations
SELECT * FROM gh_management_config 
WHERE status = 'failure'
ORDER BY timestamp DESC;



Environment Variables

The Flows API requires the following environment variables to be configured:

Required (inherited from worker)

GITHUB_TOKEN: GitHub Personal Access Token with repo permissions
WORKER_API_KEY: API key for authenticating requests to the worker

Optional (for automated secret management)

CLOUDFLARE_API_TOKEN: Used to set repository secrets (not currently functional)
GITHUB_ACTION_CLOUDFLARE_ACCOUNT_ID: Used to set repository secrets (not currently functional)
Note: Secret encryption is not currently implemented due to missing libsodium library in Cloudflare Workers. Secrets must be set manually via GitHub CLI or UI:

Bash


# Set secrets manually using GitHub CLI
gh secret set CLOUDFLARE_API_TOKEN -b "your-token" -R owner/repo
gh secret set CLOUDFLARE_ACCOUNT_ID -b "your-account-id" -R owner/repo



Workflow Templates


PR Comment Extractor Workflow

Purpose: Aggregates all PR comments into a single summary for AI consumption.
Features:
Waits 30 seconds to batch comments
Fetches both issue comments and inline review comments
Filters out specific users and bot comments
Removes badges, slash commands, and other noise
Posts cleaned summary as a new PR comment
Permissions Required:
pull-requests: write
issues: read
contents: read

Cloudflare Worker Deployment Workflow

Purpose: Automatically deploys worker to Cloudflare on push to main.
Features:
Triggers on push to main branch
Uses official cloudflare/wrangler-action@v3
60-minute timeout for long builds
Requires Cloudflare secrets to be configured
Permissions Required:
None (uses repository secrets)

Auto-Apply Gemini Suggestions Workflow

Purpose: Automatically applies code suggestions from Gemini bot on pull requests.
Features:
Triggers only on comments from gemini-code-assist[bot]
Waits 10 seconds to batch multiple suggestions
Extracts code from ```suggestion blocks in PR review comments
Validates patch with dry-run before applying
Auto-commits and pushes changes to the PR branch
Posts detailed status messages:
Success: Confirms application with guidance
No suggestion: Notifies when no ```suggestion blocks found
Invalid patch: Warns when patch cannot be applied cleanly
Can be disabled by adding [skip-auto-apply] to PR description
Permissions Required:
contents: write
pull-requests: write
How It Works:
Gemini bot posts a review comment with a ```suggestion code block
Workflow extracts the suggested code changes
Validates the patch with git apply --check
If valid, applies the patch, commits, and pushes
Posts confirmation comment on the PR
Example Gemini Comment:



Consider using a more descriptive variable name:

```suggestion
const userAuthToken = generateToken()
```



Error Handling

All endpoints provide detailed error information:
Success (200):

JSON


{
  "summary": { ... },
  "results": [ ... ]
}


Validation Error (400/422):

JSON


{
  "error": "Validation failed",
  "details": { ... }
}


Authentication Error (401):

JSON


{
  "error": "Unauthorized"
}


GitHub API Error (500):

JSON


{
  "error": "Failed to create repository",
  "message": "Repository already exists"
}



Best Practices

Test with a single repo first: Use repos: ["test-repo"] to validate behavior
Use date filters carefully: Narrow down repositories before running bulk operations
Check logs: Query gh_management_config table to verify operations
Use force sparingly: Only set force: true when you need to update existing workflows
Monitor rate limits: GitHub API has rate limits; large retrofits may take time
Set secrets manually: Until encryption is implemented, configure secrets via GitHub CLI

Limitations

Secret Encryption: The API cannot currently set repository secrets due to missing libsodium library. Secrets must be configured manually.
Rate Limits: Large-scale retrofits are subject to GitHub API rate limits.
Organization Scope: Currently only supports organization repositories, not user repositories.
Pagination: Repository listing is limited to 100 repos per request.

Future Enhancements

[ ] Implement secret encryption with libsodium-wrappers
[ ] Add support for custom workflow templates
[ ] Implement pagination for large organizations
[ ] Add workflow validation before deployment
[ ] Support for user repositories (not just orgs)
[ ] Dry-run mode for testing without making changes
[ ] Webhook integration for automated workflow management
EOF



cat <<'EOF' > "$OUTPUT_DIR/RPC_USAGE.md"

RPC Usage Documentation
GitHub Worker RPC Usage Guide

This GitHub worker supports full RPC (Remote Procedure Call) capabilities, allowing it to be used as a service binding in other Cloudflare Workers.

Table of Contents

Overview
Setup
Available RPC Methods
Usage Examples
Type Definitions

Overview

The GitHub worker can be consumed in two ways:
HTTP API - Traditional REST API endpoints accessible via HTTP requests
RPC Service Binding - Direct method calls from other workers without HTTP overhead
RPC service bindings provide:
Better Performance - No HTTP serialization/deserialization overhead
Type Safety - Full TypeScript type support
Simplified Code - Direct method calls instead of HTTP requests
Lower Latency - Worker-to-worker communication without network calls

Setup


Step 1: Deploy the GitHub Worker

First, ensure the GitHub worker is deployed:

Bash


cd /path/to/github-worker
npm run deploy



Step 2: Configure Service Binding

In your consuming worker's wrangler.jsonc, add a service binding:

Code snippet


{
  "name": "my-worker",
  "main": "src/index.ts",
  "services": [
    {
      "binding": "GITHUB_WORKER",
      "service": "core-github-api"
    }
  ]
}


Note: The service value must match the name in the GitHub worker's wrangler.jsonc (currently "core-github-api").

Step 3: Add Type Definitions (Optional but Recommended)

For full type safety, copy the RPC type definitions to your project:

Bash


cp /path/to/github-worker/src/rpc/types.ts ./src/types/github-worker-rpc.ts


Or install via npm if published as a package.

Step 4: Update Environment Types

Create or update your worker's environment types:

TypeScript


// src/types/env.ts
import type { GitHubWorkerRPC } from './github-worker-rpc'

interface Env {
  GITHUB_WORKER: Service<GitHubWorkerRPC>
  // ... other bindings
}



Available RPC Methods


Health Check


TypeScript


async health(): Promise<HealthCheckResponse>


Check the health status of the GitHub worker.

File Operations


Upsert File


TypeScript


async upsertFile(request: UpsertFileRequest): Promise<UpsertFileResponse>


Create or update a file in a GitHub repository.
Parameters:
owner (string) - Repository owner
repo (string) - Repository name
path (string) - File path
content (string) - File content (plain text, will be base64 encoded automatically)
message (string) - Commit message
sha (string, optional) - SHA of the file being replaced (required for updates)

List Repository Tree


TypeScript


async listRepoTree(request: ListRepoTreeRequest): Promise<ListRepoTreeResponse>


List repository contents with a tree-style representation.
Parameters:
owner (string) - Repository owner
repo (string) - Repository name
ref (string, optional) - Git reference (branch, tag, or commit SHA). Defaults to HEAD.
path (string, optional) - Restrict listing to a specific directory
recursive (boolean, optional) - Retrieve full tree recursively. Defaults to true.

Pull Request Operations


Open Pull Request


TypeScript


async openPullRequest(request: OpenPullRequestRequest): Promise<OpenPullRequestResponse>


Create a new pull request.
Parameters:
owner (string) - Repository owner
repo (string) - Repository name
head (string) - Branch containing changes
base (string) - Target branch
title (string) - Pull request title
body (string, optional) - Pull request description

Issue Operations


Create Issue


TypeScript


async createIssue(request: CreateIssueRequest): Promise<CreateIssueResponse>


Create a new issue.
Parameters:
owner (string) - Repository owner
repo (string) - Repository name
title (string) - Issue title
body (string, optional) - Issue description
labels (string[], optional) - Array of label names

Octokit Operations


Generic REST API Call


TypeScript


async octokitRest(request: OctokitRestRequest): Promise<OctokitRestResponse>


Make any GitHub REST API call using Octokit.
Parameters:
namespace (string) - Octokit namespace (e.g., 'repos', 'issues', 'pulls')
method (string) - Method name (e.g., 'get', 'list', 'create')
params (object, optional) - Method parameters
Example namespaces and methods:
repos.get - Get repository information
repos.listBranches - List repository branches
issues.list - List repository issues
pulls.list - List pull requests

GraphQL Query


TypeScript


async octokitGraphQL(request: OctokitGraphQLRequest): Promise<OctokitGraphQLResponse>


Execute a GraphQL query against the GitHub API.
Parameters:
query (string) - GraphQL query string
variables (object, optional) - Query variables

Agent Session Operations


Create Session


TypeScript


async createSession(request: CreateSessionRequest): Promise<CreateSessionResponse>


Create a new agent session for GitHub search and AI-powered analysis.
Parameters:
prompt (string) - Natural language prompt describing what to search for

Get Session Status


TypeScript


async getSessionStatus(request: GetSessionStatusRequest): Promise<GetSessionStatusResponse>


Get the status and results of an agent session.
Parameters:
sessionId (string) - Session ID from createSession

Search Operations


Search Repositories


TypeScript


async searchRepositories(request: SearchRepositoriesRequest): Promise<SearchRepositoriesResponse>


Search for GitHub repositories.
Parameters:
query (string) - Search query
sort (string, optional) - Sort field: 'stars', 'forks', 'help-wanted-issues', 'updated'
order (string, optional) - Sort order: 'asc' or 'desc'
per_page (number, optional) - Results per page (default: 30)
page (number, optional) - Page number (default: 1)

Batch Operations


Batch Upsert Files


TypeScript


async batchUpsertFiles(requests: UpsertFileRequest[]): Promise<UpsertFileResponse[]>


Create or update multiple files in a single call.

Batch Create Issues


TypeScript


async batchCreateIssues(requests: CreateIssueRequest[]): Promise<CreateIssueResponse[]>


Create multiple issues in a single call.

Usage Examples


Example 1: Create a File


TypeScript


export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const result = await env.GITHUB_WORKER.upsertFile({
        owner: 'octocat',
        repo: 'Hello-World',
        path: 'README.md',
        content: '# Hello World\n\nThis is a test.',
        message: 'docs: update README',
      }, env)

      return Response.json(result)
    } catch (error) {
      return Response.json({ error: error.message }, 500)
    }
  }
}



Example 2: Search Repositories


TypeScript


export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const results = await env.GITHUB_WORKER.searchRepositories({
      query: 'language:typescript stars:>1000',
      sort: 'stars',
      order: 'desc',
      per_page: 10,
    }, env)

    return Response.json(results)
  }
}



Example 3: Create Pull Request


TypeScript


export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // First, create a file
    await env.GITHUB_WORKER.upsertFile({
      owner: 'my-org',
      repo: 'my-repo',
      path: 'new-feature.ts',
      content: 'export const feature = "awesome"',
      message: 'feat: add new feature',
    }, env)

    // Then, create a PR
    const pr = await env.GITHUB_WORKER.openPullRequest({
      owner: 'my-org',
      repo: 'my-repo',
      head: 'feature-branch',
      base: 'main',
      title: 'Add new feature',
      body: 'This PR adds an awesome new feature!',
    }, env)

    return Response.json(pr)
  }
}



Example 4: Use GraphQL


TypeScript


export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const result = await env.GITHUB_WORKER.octokitGraphQL({
      query: `
        query($owner: String!, $repo: String!) {
          repository(owner: $owner, name: $repo) {
            name
            stargazerCount
            forkCount
            issues(first: 5, states: OPEN) {
              nodes {
                title
                number
              }
            }
          }
        }
      `,
      variables: {
        owner: 'cloudflare',
        repo: 'workers-sdk',
      },
    }, env)

    return Response.json(result)
  }
}



Example 5: Generic Octokit REST Call


TypeScript


export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Get repository information
    const repoInfo = await env.GITHUB_WORKER.octokitRest({
      namespace: 'repos',
      method: 'get',
      params: {
        owner: 'cloudflare',
        repo: 'workers-sdk',
      },
    }, env)

    // List repository branches
    const branches = await env.GITHUB_WORKER.octokitRest({
      namespace: 'repos',
      method: 'listBranches',
      params: {
        owner: 'cloudflare',
        repo: 'workers-sdk',
      },
    }, env)

    return Response.json({ repoInfo, branches })
  }
}



Example 6: AI-Powered Repository Search


TypeScript


export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Create a search session with natural language
    const session = await env.GITHUB_WORKER.createSession({
      prompt: 'Find TypeScript libraries for building REST APIs',
    }, env)

    // Poll for results (in production, use Durable Objects or queues)
    let status
    do {
      await new Promise(resolve => setTimeout(resolve, 2000))
      status = await env.GITHUB_WORKER.getSessionStatus({
        sessionId: session.sessionId,
      }, env)
    } while (status.status === 'pending')

    return Response.json(status.results)
  }
}



Example 7: Batch Operations


TypeScript


export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Create multiple issues at once
    const issues = await env.GITHUB_WORKER.batchCreateIssues([
      {
        owner: 'my-org',
        repo: 'my-repo',
        title: 'Bug: Application crashes on startup',
        body: 'Description of the bug...',
        labels: ['bug', 'high-priority'],
      },
      {
        owner: 'my-org',
        repo: 'my-repo',
        title: 'Feature: Add dark mode',
        body: 'We should add dark mode support...',
        labels: ['enhancement'],
      },
    ], env)

    return Response.json(issues)
  }
}



Type Definitions

All RPC methods use strongly-typed request and response objects. See src/rpc/types.ts for complete type definitions.

Key Types


TypeScript


// File operations
interface UpsertFileRequest {
  owner: string
  repo: string
  path: string
  content: string
  message: string
  sha?: string
}

interface ListRepoTreeRequest {
  owner: string
  repo: string
  ref?: string
  path?: string
  recursive?: boolean
}

// Pull requests
interface OpenPullRequestRequest {
  owner: string
  repo: string
  head: string
  base: string
  title: string
  body?: string
}

// Issues
interface CreateIssueRequest {
  owner: string
  repo: string
  title: string
  body?: string
  labels?: string[]
}

// Octokit
interface OctokitRestRequest {
  namespace: string
  method: string
  params?: Record<string, any>
}

interface OctokitGraphQLRequest {
  query: string
  variables?: Record<string, any>
}

// Search
interface SearchRepositoriesRequest {
  query: string
  sort?: 'stars' | 'forks' | 'help-wanted-issues' | 'updated'
  order?: 'asc' | 'desc'
  per_page?: number
  page?: number
}

// Agent sessions
interface CreateSessionRequest {
  prompt: string
}

interface GetSessionStatusRequest {
  sessionId: string
}



Error Handling

All RPC methods can throw errors. Always wrap calls in try-catch blocks:

TypeScript


try {
  const result = await env.GITHUB_WORKER.upsertFile(request, env)
  return Response.json(result)
} catch (error) {
  console.error('GitHub Worker RPC error:', error)
  return Response.json({
    error: error.message || 'Unknown error'
  }, 500)
}



Performance Considerations

RPC vs HTTP: RPC calls are faster than HTTP requests as they avoid network overhead
Batch Operations: Use batch methods when performing multiple operations to reduce round trips
Caching: The GitHub worker implements ETag-based caching for GitHub API responses
Rate Limiting: The worker handles GitHub rate limiting automatically with intelligent throttling

Security

The GitHub worker requires a GITHUB_TOKEN environment variable
All GitHub API calls are made with the worker's credentials
Ensure your consuming worker has appropriate access controls
Never expose RPC methods directly to untrusted clients

Troubleshooting


Service Binding Not Found

If you get errors about the service binding not being found:
Ensure the GitHub worker is deployed
Check that the service name in your wrangler.jsonc matches the deployed worker name
Verify both workers are in the same Cloudflare account

Type Errors

If you get TypeScript type errors:
Ensure you've copied the type definitions
Update your environment interface to include the service binding
Use the correct parameter types for each method

Runtime Errors

If RPC calls fail at runtime:
Check the GitHub worker's logs for errors
Verify the GITHUB_TOKEN is set correctly
Ensure all required parameters are provided
Check GitHub API rate limits

Further Reading

Cloudflare Workers Service Bindings
GitHub REST API Documentation
Octokit Documentation
Cloudflare Workers AI
EOF



cat <<'EOF' > "$OUTPUT_DIR/AGENTS.md"

Agent Architecture Doc

📘 AGENTS.md


🤖 Agent Architecture — Cloudflare Worker GitHub Proxy

This document defines the modular agent framework for building, maintaining, and extending the Cloudflare Worker GitHub Proxy.
Each agent owns a distinct layer of the stack, ensuring that AI or human collaborators can work independently without stepping on one another.

🧩 System Overview

The Worker is an Octokit-backed proxy deployed on Cloudflare, using:
Hono as the routing framework
@hono/zod-openapi for dynamic OpenAPI generation and validation
Zod schemas for runtime safety and spec fidelity
TypeScript for strong typing and modular code organization
GitHub REST and GraphQL integration via Octokit clients
Tooling layer (e.g. files.ts, prs.ts, issues.ts) exposing higher-level, agent-friendly abstractions
Dynamic OpenAPI spec exposure (/openapi.json, /openapi.yaml) for agent auto-discovery

🧠 Core Agents


1. BuilderAgent

Role: Initializes and compiles the full Cloudflare Worker project from the spec.
Inputs: prompt.md, wrangler.toml, folder structure template
Outputs: Complete TypeScript codebase, validated by Zod + OpenAPI
Responsibilities:
Scaffold directories and modules (/octokit, /tools, /utils, /docs)
Integrate all REST + GraphQL routes under /api/octokit/...
Wire /api/tools/... workflows for higher-level GitHub ops
Add verbose console.log tracing in core.ts and routers
Inject environment validation and structured error handling

2. OpenAPIGeneratorAgent

Role: Uses @hono/zod-openapi to define and expose live documentation.
Outputs: /openapi.json, /openapi.yaml endpoints
Responsibilities:
Auto-generate OpenAPI from all Zod route schemas
Attach schema metadata (summary, tags, description, examples)
Ensure strong type sync between request/response and OpenAPI
Maintain consistency with AI-action contracts for external GPTs

3. DocsAgent

Role: Maintains developer- and agent-facing documentation.
Outputs: README.md, API reference tables, extension guides
Responsibilities:
Keep /docs up to date with new endpoints
Document config expectations (GITHUB_TOKEN, ETAG_KV, etc.)
Provide example curl + Postman snippets for all routes
Sync OpenAPI schema metadata with markdown docs

4. WorkflowAgent

Role: Adds high-level operations that combine multiple Octokit calls.
Outputs: New routes under /api/tools/...
Examples: - /api/tools/files/upsert → create/update repo files
/api/tools/prs/open → open PR and assign reviewers
/api/tools/issues/open → open labeled issues
Responsibilities:
Wrap low-level Octokit operations in intentful APIs
Handle encoding (base64), rate limiting, and retries
Maintain agent-safe contracts (mode: text|binary|auto)

5. LinterAgent

Role: Enforces uniform structure, docstring presence, and code clarity.
Responsibilities:
Verify each file has a top-level comment and module description
Check logging consistency (console.log context per route)
Validate proper import hierarchy and no circular deps

6. TesterAgent

Role: Ensures runtime correctness and contract fidelity.
Responsibilities:
Run integration tests via Wrangler dev
Validate OpenAPI schema responses with zod-safe parsing
Verify mode=text vs mode=binary logic in /files/upsert
Test GraphQL query + REST roundtrip parity

7. ExtenderAgent

Role: Adds new functionality post-deployment.
Responsibilities:
Register new /api/workflows/... or /api/tools/... routes
Update OpenAPI schema dynamically
Follow modular class patterns for REST or GraphQL extension

🧩 Inter-Agent Communication Model

Agents communicate via shared artifacts and logs:
prompt.md → single source of truth for BuilderAgent
openapi.json → interface map for DocsAgent and TesterAgent
wrangler.toml → deployment contract shared by all
Agents never modify each other’s code directly; instead, they open PRs via /api/tools/prs/open to request changes.

🧱 Extension Guidelines

When adding new functionality:
Create a new file under /octokit/rest or /octokit/graphql
Define Zod schemas for all inputs/outputs
Register the route with OpenAPI metadata in hono.ts
Update README.md and re-run /openapi.json generation
Use /api/tools/prs/open to push updates to GitHub

⚙️ Example Agent Chain


Code snippet


graph TD
A[BuilderAgent] --> B[OpenAPIGeneratorAgent]
B --> C[DocsAgent]
C --> D[WorkflowAgent]
D --> E[LinterAgent]
E --> F[TesterAgent]
F --> G[ExtenderAgent]


Version: 1.0
Maintainers: Colby Systems / Justin M. Bishop
License: Internal DevOps Proxy Blueprint
EOF



cat <<'EOF' > "$OUTPUT_DIR/docs/prompt.md"

Original AI Prompt

🧠 AI Builder Prompt — Cloudflare Worker GitHub Proxy

Goal:
Develop a modular, extensible Cloudflare Worker that proxies all GitHub REST and GraphQL endpoints, exposes validated Hono routes, and dynamically generates OpenAPI specs for agent discovery.

1️⃣ Core Objectives

Implement Hono + @hono/zod-openapi for routing + schema-driven validation
Use Octokit clients for REST and GraphQL operations
Generate /openapi.json and /openapi.yaml dynamically
Structure the code to be agent-friendly, modular, and self-documenting
Provide end-to-end testable routes for:
/api/octokit/rest/...
/api/octokit/graphql/...
/api/tools/files/...
/api/tools/prs/...

2️⃣ Folder Structure




/src
/octokit
core.ts
/rest
repos.ts
contents.ts
issues.ts
pulls.ts
/graphql
graphql.ts
index.ts
/tools
files.ts
prs.ts
issues.ts
/utils
base64.ts
paginate.ts
etagCache.ts
rateLimit.ts
hono.ts
index.ts
/docs
AGENTS.md
prompt.md
wrangler.toml
README.md
package.json




3️⃣ Build Requirements

✅ TypeScript + ESM modules
✅ Hono framework
✅ @hono/zod-openapi for schema validation
✅ @octokit/rest & @octokit/graphql for GitHub API
✅ Zod for runtime safety
✅ wrangler.toml configured for Cloudflare deployment

4️⃣ Functional Highlights

Proxy GitHub REST calls under /api/octokit/rest/:namespace/:method
Proxy GitHub GraphQL calls under /api/octokit/graphql
Abstract common workflows (files, PRs, issues) under /api/tools/...
Implement base64-safe file upsert logic (mode: text|binary|auto)
Add ETag KV caching and rate-limit retry handling
Log every inbound and outbound call with structured metadata

5️⃣ OpenAPI Integration

Use @hono/zod-openapi to:
Derive OpenAPI specs from Zod schemas
Serve /openapi.json (JSON) and /openapi.yaml (YAML)
Attach examples and endpoint descriptions
Mark /api/tools/* endpoints with x-agent: true metadata for GPT discovery

6️⃣ Logging & Observability

Every route should log:

TypeScript


console.log("[route]", method, path, { status, latency, payloadSize });


Add correlation IDs where possible
Include timestamps and request origins
Keep logs JSON-friendly for vector search ingestion later

7️⃣ Documentation Requirements

Each file must contain:
File-level docstring (purpose, inputs/outputs, ownership)
Inline comments for complex logic
“Extension point” comment at bottom for future AI coders

8️⃣ Agent Workflows

Agents must support:
Create/Update files via /api/tools/files/upsert
Open PRs via /api/tools/prs/open
Extend functionality by pushing new REST or GraphQL handlers

9️⃣ Output Specification

Deliver a ready-to-deploy zip containing:
/src fully implemented
/docs including AGENTS.md + prompt.md
/openapi.json + /openapi.yaml endpoints active
README.md summarizing usage
package.json with dependencies:

```JSON
{
"dependencies": {
"hono": "^4.0.0",
"@hono/zod-openapi": "^0.9.0",
"zod": "^3.23.0",
"@octokit/rest": "^20.0.0",
"@octokit/graphql": "^7.0.0"
},
"devDependencies": {
"typescript": "^5.6.0",
"wrangler": "^3.60.0"
}
}
```



🔟 Testing Criteria

wrangler dev should start without errors
/healthz returns { ok: true }
/api/tools/files/upsert correctly encodes text to base64 once
/openapi.json reflects all endpoints and Zod schema metadata

1️⃣1️⃣ Deployment Checklist

Run wrangler publish
Verify API endpoints and /openapi.* docs
Store your GitHub token securely with:



wrangler secret put GITHUB_TOKEN
EOF
echo "✅ Successfully extracted GitHub wrapper files to $OUTPUT_DIR"
echo "You can now 'cd $OUTPUT_DIR' and inspect the source code."
