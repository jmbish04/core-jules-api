
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
