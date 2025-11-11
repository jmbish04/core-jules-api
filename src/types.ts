// Additional type definitions for Cloudflare Workers
// These types are used throughout the application

// Workers AI binding type
export interface Ai {
  run(model: string, options: { prompt?: string; messages?: any[]; stream?: boolean }): Promise<any>;
}

// Re-export the global Env interface for explicit imports
export type { Env };

// Worker environment type (alias for Env)
export type WorkerEnv = Env;

// Re-export common types for convenience
export type {
  ExecutionContext,
  MessageBatch,
  ExportedHandler
} from "@cloudflare/workers-types";
