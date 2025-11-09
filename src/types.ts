// src/types.ts
import { SessionActor } from './session-actor';
import { RoomDO } from './do/RoomDO'; // Assuming this is the correct path

export type Env = {
  // Bindings from main
  DB: D1Database;
  JULES_QUEUE: Queue;
  STATUS_QUEUE: Queue;
  JULES_API_KEY: string;
  SESSION_ACTOR: DurableObjectNamespace<SessionActor>;
  
  // Bindings from feat-multi-protocol-worker
  ROOM_DO: DurableObjectNamespace<RoomDO>; // Merged RoomDO, using RoomDO type
};

// Preserved from feat-multi-protocol-worker
export type RPCMethod = "createTask" | "listTasks" | "runAnalysis";