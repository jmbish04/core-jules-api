/**
 * @file src/octokit/core.ts
 * @description This file initializes the Octokit REST and GraphQL clients with retry and throttling plugins.
 * @owner AI-Builder
 */

import { Octokit } from '@octokit/rest'
import { graphql } from '@octokit/graphql'
import { retry } from '@octokit/plugin-retry'
import { throttling } from '@octokit/plugin-throttling'
import type { Env } from '../types'

const MyOctokit = Octokit.plugin(retry, throttling)

let octokit: Octokit
let gql: typeof graphql

/**
 * Initializes the Octokit clients.
 * @param {Env} bindings - The Cloudflare Worker bindings.
 */
const initOctokit = (bindings: Env) => {
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
export const getOctokit = (bindings: Env): Octokit => {
  initOctokit(bindings)
  return octokit
}

/**
 * Returns the Octokit GraphQL client.
 * @returns {graphql} The Octokit GraphQL client.
 */
export const getGraphql = (bindings: Env): typeof graphql => {
  initOctokit(bindings)
  return gql
}

/**
 * @extension_point
 * This is a good place to add other Octokit plugins or custom configurations.
 */
