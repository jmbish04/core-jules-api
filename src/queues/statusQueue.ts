// src/queues/statusQueue.ts
import { Env } from '../types';
import { updateSessionStatus, updatePhaseStatus, logEvent, getNextPendingPhase } from '../utils/dbUtils';
import { julesApi } from '../utils/julesApi';
import { statusQueueMessageSchema } from './schemas';

export default {
  // Queue consumer for STATUS_QUEUE
  async queue(batch: MessageBatch<any>, env: Env, ctx: ExecutionContext) {
    for (const msg of batch.messages) {
      try {
        const { type, sessionId, julesSessionId, phaseId, status, details, artifacts } = statusQueueMessageSchema.parse(msg.body);

        switch (type) {
          case 'UPDATE_SESSION': {
            await updateSessionStatus(env.DB, sessionId, status, julesSessionId);
            await logEvent(env.DB, 'info', `Session ${status}`, { sessionId, details });
            break;
          }

          case 'COMPLETE_PHASE': {
            if (!phaseId) {
              throw new Error('phaseId is required for COMPLETE_PHASE');
            }
            await updatePhaseStatus(env.DB, phaseId, 'completed');
            await logEvent(env.DB, 'info', `Phase completed`, { phaseId });

            const nextPhase = await getNextPendingPhase(env.DB, sessionId);
            if (nextPhase) {
              await env.JULES_QUEUE.send({
                type: 'SEND_MESSAGE',
                sessionId,
                julesSessionId,
                phaseId: nextPhase.id,
                prompt: nextPhase.prompt,
                meta: {
                  source: 'agent',
                  timestamp: new Date().toISOString(),
                },
              });
              await updatePhaseStatus(env.DB, nextPhase.id, 'active');
            } else {
              await updateSessionStatus(env.DB, sessionId, 'completed', julesSessionId);
              await logEvent(env.DB, 'info', 'All phases complete — marking session done', { sessionId });
            }
            break;
          }

          case 'ERROR': {
            await logEvent(env.DB, 'error', 'Session failed', { sessionId, details });
            await updateSessionStatus(env.DB, sessionId, 'failed', julesSessionId);
            break;
          }

          case 'NEW_DISCOVERY': {
            await logEvent(env.DB, 'info', 'Discovered active Jules session', { julesSessionId });

            const { results } = await env.DB.prepare(
              'SELECT * FROM sessions WHERE julesSessionId = ?'
            ).bind(julesSessionId).all();

            if (results.length === 0) {
              const localSessionId = crypto.randomUUID();
              await env.DB.prepare(
                'INSERT INTO sessions (id, julesSessionId, status) VALUES (?, ?, ?)'
              ).bind(localSessionId, julesSessionId, 'active').run();
            }
            break;
          }

          default:
            await logEvent(env.DB, 'warn', 'Unknown STATUS_QUEUE message', msg.body);
            break;
        }
      } catch (err: any) {
        console.error('STATUS_QUEUE error:', err);
        await logEvent(env.DB, 'error', 'Failed to process STATUS_QUEUE message', { error: err.message });
      }
    }
  },
};
