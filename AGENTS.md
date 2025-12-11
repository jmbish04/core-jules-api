# Agent Instructions: Architecture, Protocol, and Governance

**SYSTEM CONTEXT:** This is a hybrid **Cloudflare Worker** (Backend) and **React SPA** (Frontend) application. It uses advanced Cloudflare primitives (Workflows, Queues, Vectorize, Durable Objects) and modern Frontend tools (HeroUI, Tailwind v4).

---

## 0. Project Structure & Separation of Concerns

**CRITICAL RULE:** Strict separation between Backend and Frontend.

- **`frontend/`** → **Frontend only** (React, Vite, Tailwind).
- **`src/`** → **Backend only** (Cloudflare Worker, Hono, Drizzle).

**Directives:**

1. **Never** create `.tsx`, `.jsx`, or UI components inside `src/`.
2. **Never** create backend logic, D1 schemas, or Worker handlers inside `frontend/`.
3. If you find frontend code in `src/`, **MOVE IT** into `frontend/` immediately.

### Directory Map

```txt
/
├── AGENTS.md                   # The MASTER rules file (You are here)
├── wrangler.jsonc              # Source of truth for Bindings & Config
├── worker-configuration.d.ts   # Generated types (DO NOT EDIT MANUALLY)
│
├── src/                        # BACKEND ONLY
│   ├── index.ts                # Entry point
│   ├── db/                     # Drizzle ORM Schemas & Client
│   ├── ai/                     # AI Logic (Worker AI, Gemini)
│   ├── mcp/                    # MCP Client & Tools
│   ├── core/                   # Core Utilities (Health, Session)
│   └── workflows/              # Cloudflare Workflows
│
└── frontend/                   # FRONTEND ONLY
    ├── src/                    # React source code
    └── vite.config.ts          # Frontend Build Config


⸻

1. Type System & Env Bindings (Single Source of Truth)

CRITICAL: All Env and runtime types must come from wrangler types. Do not hand-roll Env types.

1.1 Env Type Rules
	1.	Do NOT manually define or extend an Env interface for Worker bindings anywhere in the repo.
	2.	Do NOT import Env or runtime types from @cloudflare/workers-types in the Worker entrypoint or backend code.
	    - That package is only acceptable for shared libraries outside this Worker, if ever.
	3.	The only valid Env definition is generated in worker-configuration.d.ts by wrangler types based on:
	    - wrangler.jsonc / wrangler.toml
	    - compatibility date & flags
	    - module rules
	    - service / DO bindings

There are two valid patterns for using Env:

**Pattern A – Direct reference (allowed, but less common)**

```typescript
/// <reference path="../worker-configuration.d.ts" />
export type Env = import("../worker-configuration").Env;
```

**Pattern B – Recommended pattern (tsconfig + import)**

1. Ensure tsconfig.json includes the generated types:

```json
{
  "compilerOptions": {
    "types": ["./worker-configuration.d.ts"]
  }
}
```

2. Then, in your Worker code or backend modules, import the type directly:

```typescript
import type { Env } from "../worker-configuration";
```

You must use one of these two patterns and nothing else for Env.
Do not invent separate Env-like interfaces or partial copies of bindings.

**1.2 npm run types Protocol (wrangler types + Env inspection)**

The repo defines npm run types so the agent gets two things every time:

1. wrangler types
    - Generates / updates worker-configuration.d.ts:
        - Env bindings (KV, D1, Queues, Workflows, Vectorize, secrets, vars, etc.).
        - Runtime APIs based on compatibility date & flags.
2. Env inspection script (Node)
    - Immediately after wrangler types, a Node script runs that:
	        - Reads the generated Env type.
	        - Prints the available Env bindings to the console in a human-readable list. For example:

```text
Found env variable usages:
- AI
- ASSETS
- BROWSER
- CF_AIG_TOKEN
- CHAT_AGENT
- CLOUDFLARE_ACCOUNT_ID
- DB
- DEFAULT_EMBEDDING_MODEL
- ENGINEER_WORKFLOW
- GEMINI_MODEL
- GITHUB_TOKEN
- GOVERNANCE_WORKFLOW
- INGESTION_WORKFLOW
- MAINTENANCE_WORKFLOW
- MCP_API_URL
- QUESTIONS_KV
- REPO_ANALYZER_CONTAINER
- RESEARCH_QUEUE
- RESEARCH_WORKFLOW
- SANDBOX
- VECTORIZE_INDEX
- WORKER_API_KEY
- WORKER_URL
- example
```



**You must:**

1. Run npm run types regularly and always before finishing a turn.
2. Read the printed Env list and:
    - Only use bindings that exist there (and in worker-configuration.d.ts).
    - If you need a new binding:
        - Add it to wrangler.jsonc.
        - Re-run npm run types.
        - Confirm it appears in the printed Env list before using it in code.

**1.3 TS Config & CI**

1. tsconfig.json must include:

```json
{
  "compilerOptions": {
    "types": ["./worker-configuration.d.ts"]
  }
}
```

2. If nodejs_compat is enabled, also install @types/node and add "node" to the types array.

2. Build / type-check scripts must always run wrangler types first, typically via:

```json
{
  "scripts": {
    "types": "wrangler types && node scripts/print-env-types.mjs",
    "build": "npm run types && tsc",
    "type-check": "npm run types && tsc"
  }
}
```


**3. No “shadow types”**

1. Don’t define your own interface EnvLike { ... } that mirrors bindings.
2. If you need narrower types, derive them from generated Env.

⸻

**2. Database Protocol (Drizzle ORM)**

STRICT REQUIREMENT: Drizzle ORM only.
1. No raw SQL, except rare, heavily-commented edge cases.
2. Schemas: Define tables in src/db/schema.ts (or a clearly organized schema directory).
3. Migrations:
    - Change schema → run:

```bash
npm run generate:migration
```

4. Do not hand-edit .sql migration files.

5. No ad-hoc wrangler d1 execute for core flows. Use Drizzle for reads/writes.

⸻

**3. Backend Architecture & Protocol**

**3.1 Deep Research Pattern (Queue → Workflow)**

1. API Handler
    - Validate request.
    - Generate sessionId.
    - Enqueue payload to RESEARCH_QUEUE.
    - Return 202 Accepted + sessionId.
2. Queue Consumer
    - Read from RESEARCH_QUEUE.
    - Call env.RESEARCH_WORKFLOW.create(...).
3. Workflow
    - Orchestrate multi-step logic (Brainstorm → Search → Synthesize → Persist).
    - Persist detailed status, steps, and artifacts.

3.2 AI & Vectorize
    - All Worker AI calls go through a central module (e.g. src/ai/worker-ai.ts), never directly via env.AI.run from random locations.
    - All Vectorize operations go through a shared Vectorize service module (e.g. src/data/vectorize_service.ts).

⸻

**4. Frontend Architecture & Standards**

Stack:
    - React + Vite (@cloudflare/vite-plugin)
    - HeroUI v3 / ShadCN (Kibo UI)
    - Use proper compound components (Card.Header, etc.).
    - Must be Tailwind v4-compatible.
    - Tailwind CSS v4

Build:
    - npm run build:frontend builds frontend/ and outputs to public/.
    - Root deploy script orchestrates backend + frontend builds.

⸻

**5. Frontend Synchronization Protocol**

CRITICAL: Backend and frontend must stay in sync.

For every backend or domain change, you must assess and act on frontend impact:
1. New / changed APIs (/api/...)
    - UI must expose them where appropriate:
    - Triggers (buttons/flows).
    - Result rendering (tables/cards/reports).
    - Error and loading states.
2. Async flows (Queues / Workflows / long tasks)
    - UI must show realistic lifecycle:
    - Queued → Running → Completed / Failed.
    - Use polling, SSE, or WebSockets where it makes sense.
3. Workflow visualizations
    - Use workflow visualizer or equivalent for complex flows when it improves UX.
4. No “hidden” features
    - If a feature is meant for user-facing use, it must be discoverable via UI or clearly documented as API-only by design.

⸻

**6. Health & Reliability Protocol**

Reliability is non-negotiable.
1) Every domain (src/ai, src/mcp, src/db, src/core, src/workflows, etc.) must expose health.ts with checkHealth(env).
2) Health checks must test live behavior, not just presence of bindings:
    - Vectorize → perform a small query.
    - AI → perform a small model call.
    - DB → simple query against a known table.
3) New features or changed behavior must have matching updates in health.ts.
4) Health failures should be structured; AI-assisted analysis can write root cause summaries into DB.

⸻

**7. Mandatory Validation Protocol (Before Completion)**

Before you declare any turn complete, the repo must be clean and deployable.

**7.1 Required Commands (Every Turn)**

1. **Types + Env inspection**

```bash
npm run types
```

This will:
- Run `wrangler types` to regenerate `worker-configuration.d.ts`.
   - Run the Node inspection script to print Env bindings to the console.

   You must:
   - Confirm that any Env usage in your changes exists in the printed list.
   - If a binding is missing, add it to `wrangler.jsonc` and rerun `npm run types`.

2. **Lint & Format**

```bash
npm run lint
npm run format   # if defined
```

   - Fix all lint issues introduced or touched.
   - Avoid sprinkling new `eslint-disable` comments unless truly necessary.

3. **Dry-run deploy**

```bash
npm run deploy:dry-run
```

   - Fix all configuration, binding, and build issues until dry run passes.

4. **Health checks**

   - Call the health endpoints (e.g. `GET /api/health/latest`, `POST /api/health/run`).
   - Ensure no regressions for domains you modified.

You are not allowed to mark work as complete while any of these steps are failing.

⸻

8. Per-Turn Responsibilities (Every Feature, Modification, Fix)

For every turn (feature, modification, bug fix, refactor, config change), you must do all of the following.

**8.1 Cross-Cut Impact Assessment**

For your change, explicitly decide and act on:

1) Frontend impact
- Does it change user-visible behavior, available actions, or data shapes?
- If yes, update:
- Components in frontend/src/.
- API client types and calls.
- Loading, empty, success, and error states.
- If no, be able to justify that it is backend-only.
2) Health modules
- Touching AI, Vectorize, DB, Workflows, Queues, MCP, or any critical infra → update health.ts in that domain.
3) README & docs
- If any part of usage, setup, config, or behavior changed, update README.md (and related docs) to match reality.
4) Scripts (scripts/)
- Ensure scripts still work with your changes.
- Update them if steps, flags, or env vars changed.
- Add new scripts where new recurring flows or admin operations justify it.
5) Other cross-cut items
- Tests (unit/integration): update or add where behavior changed.
- OpenAPI / API specs: keep them in sync with the actual API.
- Config and CI: keep wrangler.jsonc, package.json scripts, and CI pipelines aligned.
- AGENTS.md: update this file if you change protocols or expectations.

**8.2 Enforcement: No “Done” Until Everything is Clean**

Before marking a turn complete, you must:

1) Run:

```bash
npm run types (wrangler types + Env inspection)
npm run lint
npm run deploy:dry-run
```
2) Run relevant health checks
3) Fix all type, lint, build, config, and health issues caused by your changes.

If some issue is truly out-of-scope legacy debt:
1) Clearly mark it with a TODO / tracking comment.
2) Do not introduce new failures on top of known ones.

⸻

Bottom line:
- Env and runtime types come only from wrangler types. 
- `npm run types` both regenerates types and shows you the current Env bindings. 
- Every turn must keep backend, frontend, health checks, docs, scripts, and bindings consistent — and leave the system deployable, type-safe, and clean.

