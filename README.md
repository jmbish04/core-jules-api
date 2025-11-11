# Cloudflare Worker GitHub Proxy

This is a modular, extensible Cloudflare Worker that proxies the GitHub API, built with Hono and TypeScript. It's designed to be used by AI agents to interact with GitHub.

## 噫 Usage

The worker exposes four main sets of endpoints:

-   `/api/flows`: High-level flows for repository setup and bulk operations.
-   `/api/tools`: High-level tools for common agent workflows, such as creating files and opening pull requests.
-   `/api/octokit/rest`: A generic proxy for the GitHub REST API.
-   `/api/octokit/graphql`: A proxy for the GitHub GraphQL API.

### Flows API

The Flows API provides high-level operations for managing GitHub repositories at scale.

-   `POST /api/flows/create-new-repo`: Create a new repository with default workflows.
-   `POST /api/flows/retrofit-workflows`: Add workflows to existing repositories.

当 **[Full Flows API Documentation](./docs/FLOWS.md)**

### Tools API

The Tools API is the recommended way for agents to interact with this worker. It provides a simplified interface for common tasks.

-   `POST /api/tools/files/upsert`: Create or update a file.
-   `POST /api/tools/prs/open`: Open a new pull request.
-   `POST /api/tools/issues/create`: Create a new issue.

### REST API Proxy

The REST API proxy allows you to call any method in the [Octokit REST API](https://octokit.github.io/rest.js/v20).

-   `POST /api/octokit/rest/:namespace/:method`: Call a REST API method.

For example, to get a repository's details, you would make a `POST` request to `/api/octokit/rest/repos/get` with the following body:

```json
{
  "owner": "octocat",
  "repo": "Hello-World"
}



GraphQL API Proxy

The GraphQL API proxy allows you to make queries to the GitHub GraphQL API.
POST /api/octokit/graphql: Execute a GraphQL query.

deploying

To deploy this worker, you'll need to have the Wrangler CLI installed and configured.
Clone the repository
Install dependencies: npm install
Set your GitHub token: wrangler secret put GITHUB_TOKEN
Deploy: npm run deploy

統 API Documentation

API documentation is available via OpenAPI at the following endpoints:
/openapi.json
/openapi.yaml
You can also view the documentation using Swagger UI at /doc.

､Agentic Orchestration

This worker includes a powerful agentic orchestration layer that can interpret natural language queries and take autonomous actions through the GitHub API.

Workflow

Start a Session: Send a POST request to /api/agents/session with a natural language prompt (e.g., "find repos using Cloudflare Agents SDK with active commits").
Orchestration: The OrchestratorAgent creates a new session, generates a series of search queries from your prompt, and triggers a GithubSearchWorkflow for each query.
Execution: Each workflow enqueues a task to a Cloudflare Queue. A queue consumer in the main worker processes these tasks, executing the GitHub search, analyzing the results with an LLM, and persisting the analysis to a D1 database.
Get Results: Send a GET request to /api/agents/session/:id to retrieve the aggregated results for your session.

API Endpoints

POST /api/agents/session: Start a new orchestration session.
GET /api/agents/session/:id: Get the status and results of a session.
This project was built by an AI agent.
