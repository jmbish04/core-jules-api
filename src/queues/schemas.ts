import { z } from 'zod';

export const julesQueueMessageSchema = z.object({
  type: z.enum(['CREATE_SESSION', 'SEND_MESSAGE', 'APPROVE_PLAN']),
  sessionId: z.string(),
  julesSessionId: z.string().optional(),
  phaseId: z.string().optional(),
  prompt: z.string(),
  meta: z.object({
    retryCount: z.number().default(0),
    source: z.enum(['agent', 'cron', 'manual']),
    timestamp: z.string().datetime(),
  }),
});

export const statusQueueMessageSchema = z.object({
  type: z.enum(['UPDATE_SESSION', 'COMPLETE_PHASE', 'ERROR', 'NEW_DISCOVERY']),
  sessionId: z.string(),
  julesSessionId: z.string(),
  phaseId: z.string().optional(),
  status: z.enum(['active', 'completed', 'failed', 'paused']),
  details: z.string(),
  artifacts: z.array(
    z.object({
      type: z.enum(['pullRequest', 'plan', 'log', 'activity']),
      data: z.any(),
    })
  ),
});
