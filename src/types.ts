// src/types.ts
import { SessionActor } from './session-actor';

export type Env = {
  DB: D1Database;
  JULES_QUEUE: Queue;
  STATUS_QUEUE: Queue;
  JULES_API_KEY: string;
  SESSION_ACTOR: DurableObjectNamespace<SessionActor>;
};
