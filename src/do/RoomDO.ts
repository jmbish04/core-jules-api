import { broadcast, createEvent } from "./ws";
import type { DurableObject, DurableObjectState, WebSocket, Request } from "@cloudflare/workers-types";
declare const WebSocketPair: { new(): { 0: WebSocket; 1: WebSocket } };

/**
 * A Durable Object that manages a WebSocket chat room.
 * It uses the hibernatable WebSocket API for scalability and efficiency.
 */
export class RoomDO {
  ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  /**
   * The main entry point for the Durable Object.
   * It handles HTTP requests, specifically WebSocket upgrade requests.
   * @param request - The incoming HTTP request.
   * @returns A Response object.
   */
  fetch(request: Request): Response | Promise<Response> {
    // Only accept WebSocket upgrade requests.
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade request", { status: 426 });
    }

    // Create a new WebSocket pair.
    const pair = new WebSocketPair() as { 0: WebSocket; 1: WebSocket };
    const client = pair[0];
    const server = pair[1];

    // Accept the server WebSocket into the Durable Object.
    // This allows the DO to handle messages, closes, and errors.
    this.ctx.acceptWebSocket(server);

    // Return the client WebSocket to the user.
    return new Response(null, {
      status: 101, // Switching Protocols
      webSocket: client,
    } as ResponseInit & { webSocket: WebSocket });
  }

  /**
   * Handles incoming WebSocket messages.
   * It parses the message, logs it, and broadcasts it to all other clients.
   * @param ws - The WebSocket that received the message.
   * @param message - The message content (string or ArrayBuffer).
   */
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void> {
    const messageText = typeof message === "string" ? message : new TextDecoder().decode(message);

    // For this example, we'll just broadcast the raw message.
    // In a real app, you would parse the message and handle different event types.
    const event = createEvent("message", { content: messageText }, { from: "user" });

    // Broadcast the message to all clients in the room, excluding the sender.
    broadcast(this.ctx, event, ws);
  }

  /**
   * Handles WebSocket close events.
   * @param ws - The WebSocket that closed.
   * @param code - The close code.
   * @param reason - The close reason.
   * @param wasClean - Whether the connection closed cleanly.
   */
  webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): void | Promise<void> {
    console.log(`WebSocket closed: code=${code}, reason=${reason}, wasClean=${wasClean}`);
    // You can broadcast a "user left" message here if you track users.
  }

  /**
   * Handles WebSocket error events.
   * @param ws - The WebSocket that encountered an error.
   * @param error - The error object.
   */
  webSocketError(ws: WebSocket, error: unknown): void | Promise<void> {
    console.error("WebSocket error:", error);
    // You can decide whether to close the connection on error.
  }
}
