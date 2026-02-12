
Flows API Documentation

The Flows API provides high-level operations for managing GitHub repositories and workflows at scale.

Overview

The Flows API is designed to automate the setup and maintenance of GitHub repositories with standard configurations, particularly for Cloudflare Worker projects.

Endpoints


POST /api/flows/create-new-repo

Creates a new GitHub repository with default GitHub Actions workflows pre-configured.
Request Body:

JSON


{
  "owner": "string",           // Required: Organization or user name
  "name": "string",            // Required: Repository name
  "description": "string",     // Optional: Repository description
  "private": boolean,          // Optional: Whether repo is private (default: false)
  "auto_init": boolean         // Optional: Initialize with README (default: true)
}


Response:

JSON


{
  "repo": {
    "id": 123456,
    "name": "my-worker",
    "full_name": "my-org/my-worker",
    "html_url": "[https://github.com/my-org/my-worker](https://github.com/my-org/my-worker)",
    "private": false
  },
  "workflows": [
    {
      "path": ".github/workflows/pr-comment-extractor.yml",
      "status": "success",
      "message": "Created"
    },
    {
      "path": ".github/workflows/deploy-worker.yml",
      "status": "success",
      "message": "Created"
    }
  ],
  "secrets": [
    {
      "name": "CLOUDFLARE_API_TOKEN",
      "status": "skipped",
      "message": "Secret encryption not implemented - use GitHub CLI or manual setup"
    },
    {
      "name": "CLOUDFLARE_ACCOUNT_ID",
      "status": "skipped",
      "message": "Secret encryption not implemented - use GitHub CLI or manual setup"
    }
  ]
}


Default Workflows:
PR Comment Extractor (.github/workflows/pr-comment-extractor.yml)
Automatically extracts and summarizes all PR comments
Cleans and formats feedback for AI bot consumption
Posts consolidated summary as a PR comment
Triggers on: issue_comment, pull_request_review_comment
Cloudflare Worker Deployment (.github/workflows/deploy-worker.yml)
Automatically deploys to Cloudflare Workers on push to main
Uses cloudflare/wrangler-action@v3
Requires: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID secrets
Triggers on: push to main branch
Auto-Apply Gemini Suggestions (.github/workflows/auto-apply-gemini.yml)
Automatically applies code suggestions from Gemini bot
Extracts code from ```suggestion blocks in PR review comments
Validates patch before applying
Auto-commits and pushes changes to the PR branch
Posts confirmation or error messages
Triggers on: pull_request_review_comment from gemini-code-assist[bot]
Example:

Bash


curl -X POST https://your-worker.workers.dev/api/flows/create-new-repo \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "owner": "my-org",
    "name": "my-new-worker",
    "description": "A new Cloudflare Worker project",
    "private": false,
    "auto_init": true
  }'



POST /api/flows/retrofit-workflows

Adds or updates default workflows in existing repositories based on filters.
Request Body:

JSON


{
  "owner": "string",              // Required: Organization name to filter by
  "repos": ["string"],            // Optional: Specific repo names (if empty, uses date filters)
  "date_active_gt": "string",     // Optional: Filter by last activity > date (ISO 8601)
  "date_active_lt": "string",     // Optional: Filter by last activity < date (ISO 8601)
  "date_added_gt": "string",      // Optional: Filter by creation date > date (ISO 8601)
  "date_added_lt": "string",      // Optional: Filter by creation date < date (ISO 8601)
  "force": boolean                // Optional: Overwrite existing files (default: false)
}


Response:

JSON


{
  "summary": {
    "total_repos_processed": 10,
    "successful": 7,
    "skipped": 2,
    "failed": 1
  },
  "results": [
    {
      "repo_name": "my-org/repo1",
      "status": "success",
      "workflows_added": [
        ".github/workflows/pr-comment-extractor.yml",
        ".github/workflows/deploy-worker.yml"
      ],
      "message": "Added 2 workflow(s)"
    },
    {
      "repo_name": "my-org/repo2",
      "status": "skipped",
      "workflows_added": [],
      "message": "All workflows already exist"
    }
  ]
}


Filtering Logic:
If repos array is provided, only those repositories are processed
If repos is empty, all repositories in the organization are fetched
Date filters are applied using AND logic:
date_active_gt: Repositories with last push after this date
date_active_lt: Repositories with last push before this date
date_added_gt: Repositories created after this date
date_added_lt: Repositories created before this date
Cloudflare deployment workflow is only added if wrangler.toml, wrangler.jsonc, or wrangler.json exists
If force is false, existing workflow files are not overwritten (status: skipped)
If force is true, existing workflow files are updated
Example: Retrofit specific repos

Bash


curl -X POST https://your-worker.workers.dev/api/flows/retrofit-workflows \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "owner": "my-org",
    "repos": ["repo1", "repo2", "repo3"],
    "force": false
  }'


Example: Retrofit all active repos from 2024

Bash


curl -X POST https://your-worker.workers.dev/api/flows/retrofit-workflows \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "owner": "my-org",
    "date_active_gt": "2024-01-01",
    "date_added_gt": "2024-01-01",
    "force": false
  }'



Audit Logging

All flow operations are logged to the gh_management_config D1 table for tracking and auditing:
Table Schema:

SQL


CREATE TABLE gh_management_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp DATETIME NOT NULL,
  repo_name TEXT NOT NULL,
  action TEXT NOT NULL,           -- e.g., 'create_new_repo', 'retrofit_workflows'
  status TEXT NOT NULL,           -- 'success', 'skipped', 'failure'
  status_details TEXT,            -- JSON with additional context
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);


Query Example:

SQL


-- Get all retrofit operations in the last 7 days
SELECT * FROM gh_management_config 
WHERE action = 'retrofit_workflows' 
  AND timestamp > datetime('now', '-7 days')
ORDER BY timestamp DESC;

-- Get failed operations
SELECT * FROM gh_management_config 
WHERE status = 'failure'
ORDER BY timestamp DESC;



Environment Variables

The Flows API requires the following environment variables to be configured:

Required (inherited from worker)

GITHUB_TOKEN: GitHub Personal Access Token with repo permissions
WORKER_API_KEY: API key for authenticating requests to the worker

Optional (for automated secret management)

CLOUDFLARE_API_TOKEN: Used to set repository secrets (not currently functional)
GITHUB_ACTION_CLOUDFLARE_ACCOUNT_ID: Used to set repository secrets (not currently functional)
Note: Secret encryption is not currently implemented due to missing libsodium library in Cloudflare Workers. Secrets must be set manually via GitHub CLI or UI:

Bash


# Set secrets manually using GitHub CLI
gh secret set CLOUDFLARE_API_TOKEN -b "your-token" -R owner/repo
gh secret set CLOUDFLARE_ACCOUNT_ID -b "your-account-id" -R owner/repo



Workflow Templates


PR Comment Extractor Workflow

Purpose: Aggregates all PR comments into a single summary for AI consumption.
Features:
Waits 30 seconds to batch comments
Fetches both issue comments and inline review comments
Filters out specific users and bot comments
Removes badges, slash commands, and other noise
Posts cleaned summary as a new PR comment
Permissions Required:
pull-requests: write
issues: read
contents: read

Cloudflare Worker Deployment Workflow

Purpose: Automatically deploys worker to Cloudflare on push to main.
Features:
Triggers on push to main branch
Uses official cloudflare/wrangler-action@v3
60-minute timeout for long builds
Requires Cloudflare secrets to be configured
Permissions Required:
None (uses repository secrets)

Auto-Apply Gemini Suggestions Workflow

Purpose: Automatically applies code suggestions from Gemini bot on pull requests.
Features:
Triggers only on comments from gemini-code-assist[bot]
Waits 10 seconds to batch multiple suggestions
Extracts code from ```suggestion blocks in PR review comments
Validates patch with dry-run before applying
Auto-commits and pushes changes to the PR branch
Posts detailed status messages:
Success: Confirms application with guidance
No suggestion: Notifies when no ```suggestion blocks found
Invalid patch: Warns when patch cannot be applied cleanly
Can be disabled by adding [skip-auto-apply] to PR description
Permissions Required:
contents: write
pull-requests: write
How It Works:
Gemini bot posts a review comment with a ```suggestion code block
Workflow extracts the suggested code changes
Validates the patch with git apply --check
If valid, applies the patch, commits, and pushes
Posts confirmation comment on the PR
Example Gemini Comment:



Consider using a more descriptive variable name:

```suggestion
const userAuthToken = generateToken()
```



Error Handling

All endpoints provide detailed error information:
Success (200):

JSON


{
  "summary": { ... },
  "results": [ ... ]
}


Validation Error (400/422):

JSON


{
  "error": "Validation failed",
  "details": { ... }
}


Authentication Error (401):

JSON


{
  "error": "Unauthorized"
}


GitHub API Error (500):

JSON


{
  "error": "Failed to create repository",
  "message": "Repository already exists"
}



Best Practices

Test with a single repo first: Use repos: ["test-repo"] to validate behavior
Use date filters carefully: Narrow down repositories before running bulk operations
Check logs: Query gh_management_config table to verify operations
Use force sparingly: Only set force: true when you need to update existing workflows
Monitor rate limits: GitHub API has rate limits; large retrofits may take time
Set secrets manually: Until encryption is implemented, configure secrets via GitHub CLI

Limitations

Secret Encryption: The API cannot currently set repository secrets due to missing libsodium library. Secrets must be configured manually.
Rate Limits: Large-scale retrofits are subject to GitHub API rate limits.
Organization Scope: Currently only supports organization repositories, not user repositories.
Pagination: Repository listing is limited to 100 repos per request.

Future Enhancements

[ ] Implement secret encryption with libsodium-wrappers
[ ] Add support for custom workflow templates
[ ] Implement pagination for large organizations
[ ] Add workflow validation before deployment
[ ] Support for user repositories (not just orgs)
[ ] Dry-run mode for testing without making changes
[ ] Webhook integration for automated workflow management
