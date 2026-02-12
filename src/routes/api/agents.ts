/**
 * @file src/routes/api/agents.ts
 * @description Agent management routes (stub implementation)
 * @owner AI-Builder
 */

import { OpenAPIHono, createRoute } from '@hono/zod-openapi'
import { z } from 'zod'

const app = new OpenAPIHono()

// Stub implementation - agents functionality to be implemented
const listAgentsRoute = createRoute({
  method: 'get',
  path: '/',
  summary: 'List available agents',
  responses: {
    200: {
      description: 'List of agents',
      content: {
        'application/json': {
          schema: z.object({
            agents: z.array(z.object({
              id: z.string(),
              name: z.string(),
              description: z.string(),
            }))
          })
        }
      }
    }
  }
})

app.openapi(listAgentsRoute, (c) => {
  return c.json({
    agents: [
      {
        id: 'github-worker',
        name: 'GitHub Worker Agent',
        description: 'Handles GitHub API operations'
      }
    ]
  })
})

export default app
