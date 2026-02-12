// src/queues/julesQueue.ts
import { Env } from '../types';
import { julesApi } from '../utils/julesApi';
import { updateSessionStatus, logEvent } from '../utils/dbUtils';
import { julesQueueMessageSchema } from './schemas';

export default {
  // Queue consumer for JULES_QUEUE
  async queue(batch: MessageBatch<any>, env: Env, ctx: ExecutionContext) {
    for (const msg of batch.messages) {
      try {
        const payload = julesQueueMessageSchema.parse(msg.body);
        const { type, sessionId, julesSessionId, phaseId, prompt, meta } = payload;

        switch (type) {
          case 'CREATE_SESSION': {
            const result = await julesApi.createSession(env, prompt);
            await updateSessionStatus(env.DB, sessionId, 'active', result.id);
            await logEvent(env.DB, 'info', `Created Jules session`, { sessionId, julesSessionId: result.id });
            // forward to STATUS_QUEUE for orchestration
            await env.STATUS_QUEUE.send({
              type: 'UPDATE_SESSION',
              sessionId,
              julesSessionId: result.id,
              status: 'active',
              details: 'Session created successfully',
            });
            break;
          }

          case 'SEND_MESSAGE': {
            if (!julesSessionId) {
              throw new Error('julesSessionId is required for SEND_MESSAGE');
            }
            await julesApi.sendMessage(env, julesSessionId, prompt);
            await logEvent(env.DB, 'info', `Sent message to Jules`, { sessionId, phaseId });
            break;
          }

          case 'APPROVE_PLAN': {
            if (!julesSessionId) {
              throw new Error('julesSessionId is required for APPROVE_PLAN');
            }
            await julesApi.approvePlan(env, julesSessionId);
            await logEvent(env.DB, 'info', `Approved plan for Jules session`, { sessionId, julesSessionId });
            break;
          }

          default:
            await logEvent(env.DB, 'warn', `Unknown message type in JULES_QUEUE`, payload);
            break;
        }
      } catch (err: any) {
        console.error('JULES_QUEUE error:', err);
        await logEvent(env.DB, 'error', 'Failed to process JULES_QUEUE message', { error: err.message });
        // push to STATUS_QUEUE for error tracking
        await env.STATUS_QUEUE.send({
          type: 'ERROR',
          status: 'failed',
          details: err.message,
        });
      }
    }
  },
};
