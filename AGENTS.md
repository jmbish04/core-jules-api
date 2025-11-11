
Agent Architecture Doc

📘 AGENTS.md


🤖 Agent Architecture — Cloudflare Worker GitHub Proxy

This document defines the modular agent framework for building, maintaining, and extending the Cloudflare Worker GitHub Proxy.
Each agent owns a distinct layer of the stack, ensuring that AI or human collaborators can work independently without stepping on one another.

🧩 System Overview

The Worker is an Octokit-backed proxy deployed on Cloudflare, using:
Hono as the routing framework
@hono/zod-openapi for dynamic OpenAPI generation and validation
Zod schemas for runtime safety and spec fidelity
TypeScript for strong typing and modular code organization
GitHub REST and GraphQL integration via Octokit clients
Tooling layer (e.g. files.ts, prs.ts, issues.ts) exposing higher-level, agent-friendly abstractions
Dynamic OpenAPI spec exposure (/openapi.json, /openapi.yaml) for agent auto-discovery

🧠 Core Agents


1. BuilderAgent

Role: Initializes and compiles the full Cloudflare Worker project from the spec.
Inputs: prompt.md, wrangler.toml, folder structure template
Outputs: Complete TypeScript codebase, validated by Zod + OpenAPI
Responsibilities:
Scaffold directories and modules (/octokit, /tools, /utils, /docs)
Integrate all REST + GraphQL routes under /api/octokit/...
Wire /api/tools/... workflows for higher-level GitHub ops
Add verbose console.log tracing in core.ts and routers
Inject environment validation and structured error handling

2. OpenAPIGeneratorAgent

Role: Uses @hono/zod-openapi to define and expose live documentation.
Outputs: /openapi.json, /openapi.yaml endpoints
Responsibilities:
Auto-generate OpenAPI from all Zod route schemas
Attach schema metadata (summary, tags, description, examples)
Ensure strong type sync between request/response and OpenAPI
Maintain consistency with AI-action contracts for external GPTs

3. DocsAgent

Role: Maintains developer- and agent-facing documentation.
Outputs: README.md, API reference tables, extension guides
Responsibilities:
Keep /docs up to date with new endpoints
Document config expectations (GITHUB_TOKEN, ETAG_KV, etc.)
Provide example curl + Postman snippets for all routes
Sync OpenAPI schema metadata with markdown docs

4. WorkflowAgent

Role: Adds high-level operations that combine multiple Octokit calls.
Outputs: New routes under /api/tools/...
Examples: - /api/tools/files/upsert → create/update repo files
/api/tools/prs/open → open PR and assign reviewers
/api/tools/issues/open → open labeled issues
Responsibilities:
Wrap low-level Octokit operations in intentful APIs
Handle encoding (base64), rate limiting, and retries
Maintain agent-safe contracts (mode: text|binary|auto)

5. LinterAgent

Role: Enforces uniform structure, docstring presence, and code clarity.
Responsibilities:
Verify each file has a top-level comment and module description
Check logging consistency (console.log context per route)
Validate proper import hierarchy and no circular deps

6. TesterAgent

Role: Ensures runtime correctness and contract fidelity.
Responsibilities:
Run integration tests via Wrangler dev
Validate OpenAPI schema responses with zod-safe parsing
Verify mode=text vs mode=binary logic in /files/upsert
Test GraphQL query + REST roundtrip parity

7. ExtenderAgent

Role: Adds new functionality post-deployment.
Responsibilities:
Register new /api/workflows/... or /api/tools/... routes
Update OpenAPI schema dynamically
Follow modular class patterns for REST or GraphQL extension

🧩 Inter-Agent Communication Model

Agents communicate via shared artifacts and logs:
prompt.md → single source of truth for BuilderAgent
openapi.json → interface map for DocsAgent and TesterAgent
wrangler.toml → deployment contract shared by all
Agents never modify each other’s code directly; instead, they open PRs via /api/tools/prs/open to request changes.

🧱 Extension Guidelines

When adding new functionality:
Create a new file under /octokit/rest or /octokit/graphql
Define Zod schemas for all inputs/outputs
Register the route with OpenAPI metadata in hono.ts
Update README.md and re-run /openapi.json generation
Use /api/tools/prs/open to push updates to GitHub

⚙️ Example Agent Chain


Code snippet


graph TD
A[BuilderAgent] --> B[OpenAPIGeneratorAgent]
B --> C[DocsAgent]
C --> D[WorkflowAgent]
D --> E[LinterAgent]
E --> F[TesterAgent]
F --> G[ExtenderAgent]


Version: 1.0
Maintainers: Colby Systems / Justin M. Bishop
License: Internal DevOps Proxy Blueprint
