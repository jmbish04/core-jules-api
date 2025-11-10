import { z } from "zod";
import { dispatchRPC, rpcRegistry, RpcMethodName } from "./rpc";
import type { Env } from "./types";
import type { ExecutionContext } from "@cloudflare/workers-types";
import zodToJsonSchema from "zod-to-json-schema";
import * as S from "./schemas/apiSchemas";

const mcpToolSchemas: Record<RpcMethodName, z.ZodType> = {
  createTask: S.CreateTaskRequest,
  listTasks: z.object({}), // listTasks has no parameters
  runAnalysis: S.AnalysisRequest,
};

const ExecuteBody = z.object({
  tool: z.string(),
  params: z.any(),
});

/**
 * Provides handlers for the MCP routes (/mcp/tools and /mcp/execute).
 * This acts as an adapter between the MCP protocol and the internal rpcRegistry.
 */
export function mcpRoutes() {
  return {
    /**
     * Lists all available tools in a format compliant with MCP.
     * It derives the tool list from the rpcRegistry and associated Zod schemas.
     */
    tools: async () => {
      const tools = Object.keys(rpcRegistry).map((name) => {
        const schema = zodToJsonSchema(mcpToolSchemas[name as RpcMethodName]);
        return {
          name,
          description: `Tool for ${name}`,
          schema,
        };
      });
      return { tools };
    },
    /**
     * Executes a tool based on the provided tool name and parameters.
     * It validates the request body and then dispatches the call to the rpcRegistry.
     * @param env - The Cloudflare environment bindings.
     * @param ctx - The execution context.
     * @param body - The raw request body.
     * @returns The result of the tool execution.
     */
    execute: async (env: Env, ctx: ExecutionContext, body: unknown) => {
      const { tool, params } = ExecuteBody.parse(body);
      const result = await dispatchRPC(tool, params, env, ctx);
      return { success: true, result };
    },
  };
}
