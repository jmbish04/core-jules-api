import { OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import * as S from "../routes/api/schemas";

/**
 * Builds the OpenAPI 3.1.0 document at runtime from Zod schemas.
 * @param baseUrl - The base URL of the server, used for the servers block.
 * @returns The OpenAPI document object.
 */
export function buildOpenAPIDocument(baseUrl: string) {
  const registry = new OpenAPIRegistry();

  // Register all schemas from apiSchemas.ts to be included in the components section.
  registry.register("Task", S.Task);
  registry.register("CreateTaskRequest", S.CreateTaskRequest);
  registry.register("CreateTaskResponse", S.CreateTaskResponse);
  registry.register("ListTasksResponse", S.ListTasksResponse);
  registry.register("AnalysisRequest", S.AnalysisRequest);
  registry.register("AnalysisResponse", S.AnalysisResponse);
  registry.register("ErrorResponse", S.ErrorResponse);

  // Define the REST API paths, linking schemas to requests and responses.
  registry.registerPath({
    method: "post",
    path: "/api/tasks",
    summary: "Create a new task",
    description: "Takes a title and returns the newly created task object.",
    request: {
      body: {
        content: { "application/json": { schema: S.CreateTaskRequest } },
      },
    },
    responses: {
      "200": {
        description: "Task created successfully.",
        content: { "application/json": { schema: S.CreateTaskResponse } },
      },
      "400": {
        description: "Invalid request payload.",
        content: { "application/json": { schema: S.ErrorResponse } },
      },
    },
    tags: ["Tasks"],
  });

  registry.registerPath({
    method: "get",
    path: "/api/tasks",
    summary: "List all tasks",
    description: "Returns an array of all tasks in the system.",
    responses: {
      "200": {
        description: "A list of tasks.",
        content: { "application/json": { schema: S.ListTasksResponse } },
      },
    },
    tags: ["Tasks"],
  });

  registry.registerPath({
    method: "post",
    path: "/api/analyze",
    summary: "Run an analysis on a task",
    description: "Performs a mock analysis for a given task ID.",
    request: {
      body: {
        content: { "application/json": { schema: S.AnalysisRequest } },
      },
    },
    responses: {
      "200": {
        description: "Analysis completed.",
        content: { "application/json": { schema: S.AnalysisResponse } },
      },
      "400": {
        description: "Invalid request payload.",
        content: { "application/json": { schema: S.ErrorResponse } },
      },
    },
    tags: ["Analysis"],
  });

  // Generate the final OpenAPI document.
  const generator = new OpenApiGeneratorV31(registry.definitions);
  const doc = generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Multi-Protocol Worker API",
      version: "1.0.0",
      description: "A Cloudflare Worker demonstrating a multi-protocol API (REST, WebSocket, RPC, MCP) with dynamically generated OpenAPI 3.1.0 specs.",
    },
    servers: [{ url: baseUrl, description: "Main server" }],
    // Per the OpenAPI 3.1.0 spec, this dialect is recommended.
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    tags: [
      { name: "Tasks", description: "Operations related to tasks" },
      { name: "Analysis", description: "Operations related to analysis" },
    ],
  });

  return doc;
}
