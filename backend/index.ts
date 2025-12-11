import { routeAgentRequest } from "@cloudflare/agents";
import { JulesSupervisor } from "./ai/agents/JulesSupervisorAgent";

// Re-export Agent for Durable Objects
export { JulesSupervisor };

export interface Env {
  JULES_API_KEY: string;
  AI: any; // Cloudflare Workers AI binding
  DB: D1Database;
  AGENT_MEMORY: KVNamespace;
  OPENAI_API_KEY: string;
  GEMINI_API_KEY: string;
}

export default {
  async fetch(request, env, ctx) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not Found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;