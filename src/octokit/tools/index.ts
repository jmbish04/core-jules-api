/**
 * @file src/octokit/tools/index.ts
 * @description GitHub API tool routes - file, issue, and PR operations.
 * @owner AI-Builder
 */

import { OpenAPIHono } from '@hono/zod-openapi'
import files from './files'
import prs from './prs'
import issues from './issues'

const toolsApi = new OpenAPIHono<{ Bindings: Env }>()

toolsApi.route('/', files)
toolsApi.route('/', prs)
toolsApi.route('/', issues)

export default toolsApi

/**
 * @extension_point
 * This is a good place to add new tool routes.
 * Just import the new tool and add a new `route` call.
 */
