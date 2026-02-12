import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const Task = z.object({
  id: z.string().uuid().openapi({ example: "123e4567-e89b-12d3-a456-426614174000" }),
  title: z.string().min(1).openapi({ example: "Complete the project report" }),
  status: z.enum(["pending", "running", "done"]).default("pending"),
  createdAt: z.string().datetime().openapi({ example: "2025-03-07T10:00:00Z" }),
});

export const CreateTaskRequest = z.object({
  title: z.string().min(1).openapi({ example: "Schedule a team meeting" }),
});

export const CreateTaskResponse = z.object({
  success: z.literal(true),
  task: Task,
});

export const ListTasksResponse = z.object({
  success: z.literal(true),
  tasks: z.array(Task),
});

export const AnalysisRequest = z.object({
  taskId: z.string().uuid().openapi({ example: "123e4567-e89b-12d3-a456-426614174000" }),
  depth: z.number().int().min(1).max(5).default(1).openapi({ example: 2 }),
});

export const AnalysisResponse = z.object({
  success: z.literal(true),
  report: z.object({
    taskId: z.string().uuid(),
    score: z.number().openapi({ example: 0.95 }),
    notes: z.string().openapi({ example: "Analysis complete, no major issues found." }),
  }),
});

export const ErrorResponse = z.object({
  success: z.literal(false),
  error: z.string(),
  details: z.any().optional(),
});

export type TCreateTaskRequest = z.infer<typeof CreateTaskRequest>;
export type TTask = z.infer<typeof Task>;
