import type { DurableObjectState, WebSocket } from "@cloudflare/workers-types";

/**
 * Broadcasts a message to all connected WebSocket clients in a room,
 * optionally excluding the sender.
 * @param room - The Durable Object's context (`this.ctx`).
 * @param message - The message to broadcast.
 * @param sender - The WebSocket of the sender, to be excluded from the broadcast.
 */
export function broadcast(
  room: DurableObjectState,
  message: string | object,
  sender?: WebSocket
) {
  const payload = typeof message === "string" ? message : JSON.stringify(message);

  // Get all connected WebSockets.
  const clients = room.getWebSockets();

  // Iterate over the clients and send the message.
  for (const client of clients) {
    // Exclude the sender if specified.
    if (sender && client === sender) {
      continue;
    }
    try {
      client.send(payload);
    } catch (error) {
      console.error("Failed to send message to a WebSocket client:", error);
      // You might want to handle client cleanup here if a send fails.
    }
  }
}

/**
 * Creates a standardized event payload for WebSocket messages.
 * @param type - The type of the event.
 * @param payload - The data associated with the event.
 * @param meta - Optional metadata.
 * @returns A JSON string representing the event.
 */
export function createEvent(
  type: string,
  payload: unknown,
  meta?: Record<string, unknown>
): string {
  return JSON.stringify({
    type,
    payload,
    meta: {
      timestamp: new Date().toISOString(),
      ...meta,
    },
  });
}
