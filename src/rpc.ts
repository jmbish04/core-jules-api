import { z } from "zod";
import * as S from "./schemas/apiSchemas";
import type { Env } from "./types";
import type { ExecutionContext } from "@cloudflare/workers-types";

// A simple in-memory store for tasks, for demonstration purposes.
// In a real application, you would use a database like D1.
const tasks: S.TTask[] = [];

/**
 * Creates a new task and adds it to the in-memory store.
 * @param params - The parameters for creating the task.
 * @returns The created task.
 */
const createTask = async (params: unknown, _env: Env, _ctx: ExecutionContext): Promise<z.infer<typeof S.CreateTaskResponse>> => {
  const input = S.CreateTaskRequest.parse(params);
  const task: S.TTask = {
    id: crypto.randomUUID(),
    title: input.title,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  tasks.push(task);
  return { success: true, task };
};

/**
 * Lists all tasks from the in-memory store.
 * @returns A list of tasks.
 */
const listTasks = async (_params: unknown, _env: Env, _ctx: ExecutionContext): Promise<z.infer<typeof S.ListTasksResponse>> => {
  return { success: true, tasks };
};

/**
 * Runs a mock analysis on a given task.
 * @param params - The parameters for the analysis.
 * @returns An analysis report.
 */
const runAnalysis = async (params: unknown, _env: Env, _ctx: ExecutionContext): Promise<z.infer<typeof S.AnalysisResponse>> => {
  const input = S.AnalysisRequest.parse(params);
  // In a real app, you might fetch the task and perform a real analysis.
  return {
    success: true,
    report: {
      taskId: input.taskId,
      score: Math.random(),
      notes: `Analysis for task ${input.taskId} at depth ${input.depth} completed successfully.`,
    },
  };
};

/**
 * A registry of all available RPC methods.
 * This allows us to dispatch calls dynamically.
 */
export const rpcRegistry = {
  createTask,
  listTasks,
  runAnalysis,
};

// Define the type for the registry keys to ensure type safety.
export type RpcMethodName = keyof typeof rpcRegistry;

/**
 * Dispatches an RPC call to the appropriate handler in the registry.
 * @param method - The name of the method to call.
 * @param params - The parameters for the method.
 * @param env - The Cloudflare environment bindings.
 * @param ctx - The execution context.
 * @returns The result of the RPC call.
 * @throws An error if the method is not found in the registry.
 */
export async function dispatchRPC(
  method: string,
  params: unknown,
  env: Env,
  ctx: ExecutionContext
) {
  if (!(method in rpcRegistry)) {
    throw new Error(`Unknown method: ${method}`);
  }
  // We perform a runtime check, so we can safely cast the method name.
  const handler = rpcRegistry[method as RpcMethodName];
  return await handler(params, env, ctx);
}
