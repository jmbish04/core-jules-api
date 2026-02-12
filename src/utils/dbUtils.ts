// src/utils/dbUtils.ts
export async function updateSessionStatus(db: D1Database, id: string, status: string, julesSessionId?: string) {
  await db.prepare(
    `UPDATE sessions SET status = ?, julesSessionId = ? WHERE id = ?`
  ).bind(status, julesSessionId || null, id).run();
}

export async function updatePhaseStatus(db: D1Database, id: string, status: string) {
  await db.prepare(`UPDATE phases SET status = ? WHERE id = ?`).bind(status, id).run();
}

export async function getNextPendingPhase(db: D1Database, sessionId: string) {
  const res = await db.prepare(
    `SELECT * FROM phases WHERE sessionId = ? AND status = 'pending' ORDER BY rowid ASC LIMIT 1`
  ).bind(sessionId).first();
  return res || null;
}

export async function logEvent(db: D1Database, level: string, message: string, meta?: any) {
  await db.prepare(
    `INSERT INTO logs (level, message, meta) VALUES (?, ?, ?)`
  ).bind(level, message, JSON.stringify(meta || {})).run();
}
