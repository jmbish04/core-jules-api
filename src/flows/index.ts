/**
 * @file src/flows/index.ts
 * @description High-level flows for repository management and workflow setup
 * @owner AI-Builder
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { getOctokit } from '../octokit/core'
import type { Env } from '../types'

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

const flows = new OpenAPIHono<{ Bindings: Env }>()

/**
 * Helper function to log retrofit operation to D1
 */
async function logRetrofitOperation(
  db: Env['CORE_GITHUB_API'],
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
