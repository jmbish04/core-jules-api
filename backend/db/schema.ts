import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql, relations } from 'drizzle-orm';

/**
 * Monitored Sessions table - tracks sessions watched by the Supervisor
 * Used for "Rooted" Context Tracking to prevent drift.
 */
export const monitoredSessions = sqliteTable(
  "monitored_sessions",
  {
    // Primary Key (Internal ID)
    id: integer('id').primaryKey({ autoIncrement: true }),

    // The External Jules Session ID (Unique)
    julesSessionId: text("jules_session_id").notNull().unique(),

    // The "Root" Context
    originalPrompt: text("original_prompt").notNull(),
    title: text("title"),

    // Tracking
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    lastUpdatedAt: integer("last_updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),

    // Current Status Cache
    currentStatus: text("current_status"),
  }
);

// --------------------------------------------------------
// 2. Supervisor Logs (The "Actions" taken)
// --------------------------------------------------------
export const supervisorLogs = sqliteTable(
  "supervisor_logs",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),

    // Foreign Key to Monitored Session (References the unique Jules ID)
    sessionId: text("session_id")
      .notNull()
      .references(() => monitoredSessions.julesSessionId), // FIXED: Points to julesSessionId

    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),

    // Input Context
    julesState: text("jules_state").notNull(),
    julesContext: text("jules_context"),

    // Output Decision
    actionType: text("action_type").notNull(),
    toolUsed: text("tool_used"),
    responseContent: text("response_content"),

    // Metrics
    processingMs: integer("processing_ms"),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, any>>(),
  },
  (table) => ({
    sessionIdIdx: index("idx_logs_session_id").on(table.sessionId),
    actionTimeIdx: index("idx_logs_action_created").on(table.actionType, table.createdAt),
  })
);

/**
 * Sessions table - tracks each request session
 */
export const sessions = sqliteTable('sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull().unique(),
  timestamp: text('timestamp').default(sql`CURRENT_TIMESTAMP`).notNull(),
  title: text('title'),
  endpointType: text('endpoint_type', {
    enum: ['simple-questions', 'detailed-questions', 'auto-analyze', 'pr-analyze']
  }).notNull(),
  repoUrl: text('repo_url'),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
});

/**
 * Action logs table - comprehensive logging for all actions
 */
export const actionLogs = sqliteTable('action_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: integer('session_id').references(() => sessions.id, { onDelete: 'set null' }),
  timestamp: text('timestamp').default(sql`CURRENT_TIMESTAMP`).notNull(),
  actionType: text('action_type').notNull(),
  actionDescription: text('action_description').notNull(),
  metadataJson: text('metadata_json'),
  hasError: integer('has_error', { mode: 'boolean' }).default(false).notNull(),
  errorMessage: text('error_message'),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
});

/**
 * Health checks table - tracks periodic system health checks
 */
export const healthChecks = sqliteTable('health_checks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  timestamp: text('timestamp').default(sql`CURRENT_TIMESTAMP`).notNull(),
  checkType: text('check_type').notNull(),
  status: text('status').notNull(),
  durationMs: integer('duration_ms').notNull(),
  stepsJson: text('steps_json').notNull(),
  triggerSource: text('trigger_source'),
  aiAnalysis: text('ai_analysis'),
  aiAnalysisJson: text('ai_analysis_json'),
  error: text('error'),
});

/**
 * Chats table - stores individual chat messages for analytics
 */
export const chats = sqliteTable('chats', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  agentId: text('agent_id').notNull(),
  role: text('role').notNull(),
  content: text('content').notNull(),
  timestamp: text('timestamp').default(sql`CURRENT_TIMESTAMP`).notNull(),
  metadataJson: text('metadata_json')
});

/**
 * Knowledge Base table - stores ingested content
 */
export const knowledgeBase = sqliteTable('knowledge_base', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  url: text('url').notNull().unique(),
  title: text('title'),
  content: text('content').notNull(),
  description: text('description'),
  tags: text('tags'),
  metadataJson: text('metadata_json'),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// --------------------------------------------------------
// RELATIONS
// --------------------------------------------------------

export const sessionRelations = relations(monitoredSessions, ({ many }) => ({
  logs: many(supervisorLogs),
}));

export const logRelations = relations(supervisorLogs, ({ one }) => ({
  session: one(monitoredSessions, {
    fields: [supervisorLogs.sessionId],
    references: [monitoredSessions.julesSessionId], // FIXED: Points to julesSessionId
  }),
}));

// --------------------------------------------------------
// TYPE EXPORTS
// --------------------------------------------------------

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export type ActionLog = typeof actionLogs.$inferSelect;
export type NewActionLog = typeof actionLogs.$inferInsert;

export type HealthCheck = typeof healthChecks.$inferSelect;
export type NewHealthCheck = typeof healthChecks.$inferInsert;

export type Chat = typeof chats.$inferSelect;
export type NewChat = typeof chats.$inferInsert;

export type KnowledgeBaseItem = typeof knowledgeBase.$inferSelect;
export type NewKnowledgeBaseItem = typeof knowledgeBase.$inferInsert;

export type MonitoredSession = typeof monitoredSessions.$inferSelect;
export type NewMonitoredSession = typeof monitoredSessions.$inferInsert;
export type SupervisorLog = typeof supervisorLogs.$inferSelect;
export type NewSupervisorLog = typeof supervisorLogs.$inferInsert;