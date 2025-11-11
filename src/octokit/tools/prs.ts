/**
 * @file src/octokit/tools/prs.ts
 * @description GitHub pull request operations - create repository PRs.
 * @owner AI-Builder
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { getOctokit } from '../core'

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

const prs = new OpenAPIHono<{ Bindings: Env }>()

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
