
import { z } from "zod";

export interface ToolDefinition {
    description: string;
    parameters: z.ZodType<any>;
}

export type ToolResult = any;

export interface ToolSet {
    [key: string]: ToolDefinition;
}
