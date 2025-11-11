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
