/**
 * @file src/octokit/index.ts
 * @description This file exports the Octokit API routes.
 * @owner AI-Builder
 */

import { OpenAPIHono } from '@hono/zod-openapi'
import restApi from './rest'
import graphqlApi from './graphql/graphql'

const octokitApi = new OpenAPIHono<{ Bindings: Env }>()

octokitApi.route('/rest', restApi)
octokitApi.route('/', graphqlApi)

export default octokitApi

/**
 * @extension_point
 * This is a good place to add new Octokit-related routes.
 */
