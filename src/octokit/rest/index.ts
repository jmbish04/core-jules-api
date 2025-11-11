/**
 * @file src/octokit/rest/index.ts
 * @description This file contains the implementation of the generic GitHub REST API proxy.
 * @owner AI-Builder
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { getOctokit } from '../core'
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

const rest = new OpenAPIHono<{ Bindings: Env }>()

rest.use('*', etagCache())

const handler = async (c: Context<{ Bindings: Env }>) => {
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
