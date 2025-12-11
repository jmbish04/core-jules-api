import { JulesClient } from '../integrations/jules/index';
import { SessionState } from '../integrations/jules/types';

// The best-practice system prompt for Cloudflare Workers
const CLOUDFLARE_WORKERS_PROMPT = `
<system_context>
You are an advanced assistant specialized in generating Cloudflare Workers code. You have deep knowledge of Cloudflare's platform, APIs, and best practices.
</system_context>

<behavior_guidelines>
- Respond in a friendly and concise manner
- Focus exclusively on Cloudflare Workers solutions
- Provide complete, self-contained solutions
- Default to current best practices
- Ask clarifying questions when requirements are ambiguous
</behavior_guidelines>

<code_standards>
- Generate code in TypeScript by default unless JavaScript is specifically requested
- Add appropriate TypeScript types and interfaces
- You MUST import all methods, classes and types used in the code you generate.
- Use ES modules format exclusively (NEVER use Service Worker format)
- You SHALL keep all code in a single file unless otherwise specified
- If there is an official SDK or library for the service you are integrating with, then use it to simplify the implementation.
- Minimize other external dependencies
- Do NOT use libraries that have FFI/native/C bindings.
- Follow Cloudflare Workers security best practices
- Never bake in secrets into the code
- Include proper error handling and logging
- Include comments explaining complex logic
</code_standards>

<output_format>
- Use Markdown code blocks to separate code from explanations
- Provide separate blocks for:
  1. Main worker code (index.ts/index.js)
  2. Configuration (wrangler.jsonc)
  3. Type definitions (if applicable)
  4. Example usage/tests
- Always output complete files, never partial updates or diffs
- Format code consistently using standard TypeScript/JavaScript conventions
</output_format>

<cloudflare_integrations>
- When data storage is needed, integrate with appropriate Cloudflare services:
  - Workers KV for key-value storage
  - Durable Objects for strongly consistent state management and agents
  - D1 for relational data and SQL
  - R2 for object storage
  - Hyperdrive to connect to existing (PostgreSQL) databases
  - Queues for asynchronous processing
  - Vectorize for storing embeddings
  - Workers Analytics Engine for high-cardinality analytics
  - Workers AI as the default AI API for inference
  - Browser Rendering for headless browser capabilities
- Include all necessary bindings in both code and wrangler.jsonc
- Add appropriate environment variable definitions
</cloudflare_integrations>

<configuration_requirements>
- Always provide a wrangler.jsonc (not wrangler.toml)
- Set compatibility_date = "2025-03-07"
- Set compatibility_flags = ["nodejs_compat"]
- Set observability.enabled = true
</configuration_requirements>

<agents>
- Strongly prefer the 'agents' SDK to build AI Agents when asked.
- Use streaming responses from AI SDKs.
- Prefer this.setState API to manage and store state within an Agent.
- Include valid Durable Object bindings in the wrangler.jsonc configuration.
- Set migrations[].new_sqlite_classes to the name of the Agent class.
</agents>
`;

export const getJulesTools = (apiKey: string) => {
    const client = new JulesClient(apiKey);

    return {
        /**
         * Returns sessions that are currently blocked and need intervention.
         */
        listBlockedSessions: async () => {
            const response = await client.listSessions(50);
            const sessions = response.sessions || [];

            return sessions.filter(s =>
                s.state === SessionState.AWAITING_PLAN_APPROVAL ||
                s.state === SessionState.AWAITING_USER_FEEDBACK
            );
        },

        /**
         * Retrieves the last message from the agent to understand context/errors.
         */
        getLastAgentMessage: async ({ sessionId }: { sessionId: string }) => {
            const activities = await client.listActivities(sessionId, 5);
            return activities.activities.find(a => a.agentMessaged || a.sessionFailed || a.progressUpdated);
        },

        /**
         * Approves the current plan for a session.
         */
        approvePlan: async ({ sessionId }: { sessionId: string }) => {
            await client.approvePlan(sessionId);
            return `Plan approved for session ${sessionId}`;
        },

        /**
         * Sends a standard message to Jules. 
         * Optionally injects the Workers System Prompt if `includeContext` is true.
         */
        sendMessage: async ({ sessionId, message, includeContext = false }: { sessionId: string, message: string, includeContext?: boolean }) => {
            let finalMessage = message;

            if (includeContext) {
                finalMessage = `${message}\n\nHere are the coding standards and best practices you must follow:\n${CLOUDFLARE_WORKERS_PROMPT}`;
            }

            await client.sendMessage(sessionId, finalMessage);
            return `Message sent to session ${sessionId}`;
        },

        /**
         * Explicitly injects the Cloudflare Workers Best Practices prompt into the session.
         * Use this when Jules is hallucinating or writing outdated code.
         */
        injectWorkersPrompt: async ({ sessionId }: { sessionId: string }) => {
            const message = `Please align your next steps with the following Cloudflare Workers Best Practices and System Context:\n${CLOUDFLARE_WORKERS_PROMPT}`;
            await client.sendMessage(sessionId, message);
            return `Injected Cloudflare Workers best practices prompt into session ${sessionId}`;
        }
    };
};