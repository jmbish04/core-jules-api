/**
 * @file src/octokit/tools/issues.ts
 * @description GitHub issue operations - create repository issues.
 * @owner AI-Builder
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { getOctokit } from '../core'

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

const issues = new OpenAPIHono<{ Bindings: Env }>()

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
    id: data?.id || 0,
    number: data?.number || 0,
    html_url: data?.html_url || '',
    state: data?.state || '',
    title: data?.title || '',
    body: data?.body || '',
  }

  return c.json(response)
})

export default issues

/**
 * @extension_point
 * This is a good place to add other issue-related tools,
 * such as listing, updating, or commenting on issues.
 */
