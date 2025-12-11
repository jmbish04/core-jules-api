import { Env, WSMessage, MCPRequest, MCPResponse } from "../types";
import { createMCPResponse, queryMCP } from "../mcp/mcp-client";
import { rewriteQuestionForMCP } from "../ai/providers/worker-ai";
import { runHealthCheck } from "../core/health-check";

/**
 * Handle WebSocket connections for real-time MCP and API communication
 */
export async function handleWebSocket(request: Request, env: Env): Promise<Response> {
  const upgradeHeader = request.headers.get("Upgrade");
  if (!upgradeHeader || upgradeHeader !== "websocket") {
    return new Response("Expected Upgrade: websocket", { status: 426 });
  }

  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);

  // Accept the WebSocket connection
  server.accept();

  // Handle incoming messages
  server.addEventListener("message", async (event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data as string);

      // Check if this is an MCP JSON-RPC request
      if (data.jsonrpc === "2.0") {
        await handleMCPRequest(server, data as MCPRequest, env);
      } else if (data.type === "terminal_init" || data.type === "terminal_input") {
        await handleTerminalMessage(server, data, env);
      } else {
        // Handle as API message
        await handleAPIMessage(server, data as WSMessage, env);
      }
    } catch (error) {
      console.error("WebSocket message error:", error);
      const errorMsg: WSMessage = {
        type: "error",
        data: {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        timestamp: new Date().toISOString(),
      };
      // Only send if open
      if (server.readyState === WebSocket.OPEN) {
        server.send(JSON.stringify(errorMsg));
      }
    }
  });

  server.addEventListener("close", () => {
    console.log("WebSocket connection closed");
  });

  server.addEventListener("error", (error) => {
    console.error("WebSocket error:", error);
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

/**
 * Handle MCP JSON-RPC requests
 */
async function handleMCPRequest(
  ws: WebSocket,
  request: MCPRequest,
  env: Env
): Promise<void> {
  try {
    switch (request.method) {
      case "tools/list":
        // List available tools
        const response: MCPResponse = createMCPResponse(
          {
            tools: [
              {
                name: "query_cloudflare_docs",
                description: "Query Cloudflare documentation",
                inputSchema: {
                  type: "object",
                  properties: {
                    query: {
                      type: "string",
                      description: "The question to ask",
                    },
                    context: {
                      type: "string",
                      description: "Additional context for the query",
                    },
                  },
                  required: ["query"],
                },
              },
              {
                name: "analyze_github_pr",
                description: "Analyze GitHub Pull Request comments for Cloudflare-specific solutions. Extracts code comments (optionally filtered by author like 'gemini-code-assist'), identifies Cloudflare-related comments using Worker AI, generates relevant questions, and queries Cloudflare documentation for answers.",
                inputSchema: {
                  type: "object",
                  properties: {
                    pr_url: {
                      type: "string",
                      description: "GitHub Pull Request URL (e.g., https://github.com/owner/repo/pull/123)",
                    },
                    comment_filter: {
                      type: "string",
                      description: "Optional filter to only include comments from specific author (e.g., 'gemini-code-assist', 'copilot')",
                    },
                  },
                  required: ["pr_url"],
                },
              },
            ],
          },
          undefined,
          request.id
        );
        ws.send(JSON.stringify(response));
        break;

      case "tools/call":
        // Execute tool call
        if (request.params?.name === "query_cloudflare_docs") {
          const { query, context } = request.params.arguments || {};

          // Send status update
          const statusMsg: WSMessage = {
            type: "status",
            data: { status: "processing", query },
            timestamp: new Date().toISOString(),
          };
          ws.send(JSON.stringify(statusMsg));

          // Rewrite question with AI
          const rewrittenQuestion = await rewriteQuestionForMCP(env.AI, query);

          // Query MCP
          const mcpResponse = await queryMCP(rewrittenQuestion, context, env.MCP_API_URL);

          // Send result
          const resultResponse: MCPResponse = createMCPResponse(
            {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(mcpResponse, null, 2),
                },
              ],
            },
            undefined,
            request.id
          );
          ws.send(JSON.stringify(resultResponse));
        } else if (request.params?.name === "analyze_github_pr") {
          const { pr_url, comment_filter } = request.params.arguments || {};

          // Send status update
          const statusMsg: WSMessage = {
            type: "status",
            data: { status: "processing", action: "analyzing PR" },
            timestamp: new Date().toISOString(),
          };
          ws.send(JSON.stringify(statusMsg));

          // Call the PR analyze endpoint internally
          const apiResponse = await fetch(new URL("/api/questions/pr-analyze", env.MCP_API_URL).toString(), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ pr_url, comment_filter }),
          }).then((r) => r.json()).catch((error) => ({
            error: error.message,
          }));

          // Send result
          const resultResponse: MCPResponse = createMCPResponse(
            {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(apiResponse, null, 2),
                },
              ],
            },
            undefined,
            request.id
          );
          ws.send(JSON.stringify(resultResponse));
        } else {
          const errorResponse: MCPResponse = createMCPResponse(
            undefined,
            {
              code: -32601,
              message: `Unknown tool: ${request.params?.name}`,
            },
            request.id
          );
          ws.send(JSON.stringify(errorResponse));
        }
        break;

      case "initialize":
        // Initialize MCP session
        const initResponse: MCPResponse = createMCPResponse(
          {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: "ask-cloudflare-mcp",
              version: "1.0.0",
            },
          },
          undefined,
          request.id
        );
        ws.send(JSON.stringify(initResponse));
        break;

      default:
        const unknownResponse: MCPResponse = createMCPResponse(
          undefined,
          {
            code: -32601,
            message: `Method not found: ${request.method}`,
          },
          request.id
        );
        ws.send(JSON.stringify(unknownResponse));
    }
  } catch (error) {
    console.error("MCP request error:", error);
    const errorResponse: MCPResponse = createMCPResponse(
      undefined,
      {
        code: -32603,
        message: error instanceof Error ? error.message : "Internal error",
      },
      request.id
    );
    ws.send(JSON.stringify(errorResponse));
  }
}

/**
 * Handle API messages (non-MCP)
 */
async function handleAPIMessage(
  ws: WebSocket,
  message: WSMessage,
  env: Env
): Promise<void> {
  try {
    if (message.type === "question") {
      const { query, context } = message.data;

      // Send status
      const statusMsg: WSMessage = {
        type: "status",
        data: { status: "processing" },
        timestamp: new Date().toISOString(),
      };
      ws.send(JSON.stringify(statusMsg));

      // Process question
      const rewrittenQuestion = await rewriteQuestionForMCP(env.AI, query, context);

      // Query MCP
      const mcpResponse = await queryMCP(rewrittenQuestion, context?.context, env.MCP_API_URL);

      // Send answer
      const answerMsg: WSMessage = {
        type: "answer",
        data: {
          original_question: query,
          rewritten_question: rewrittenQuestion,
          mcp_response: mcpResponse,
        },
        timestamp: new Date().toISOString(),
      };
      ws.send(JSON.stringify(answerMsg));
    } else if (message.type === "status" && message.data.status === "run_health_check") {
      // Handle health check request
      const log = (msg: string) => {
        const statusMsg: WSMessage = {
          type: "status",
          data: {
            status: "processing",
            action: "run_health_check",
            message: msg,
          },
          timestamp: new Date().toISOString(),
        };
        ws.send(JSON.stringify(statusMsg));
      };

      try {
        const result = await runHealthCheck(env, 'manual-ws', 'websocket', (step, status, msg) => {
          const logMsg = `[${step}] ${status.toUpperCase()}: ${msg}`;
          log(logMsg);
        });

        const resultMsg: WSMessage = {
          type: "answer",
          data: {
            type: "health_check_result",
            result
          },
          timestamp: new Date().toISOString(),
        };
        ws.send(JSON.stringify(resultMsg));
      } catch (error) {
        throw error;
      }
    } else {
      throw new Error(`Unknown message type: ${message.type}`);
    }
  } catch (error) {
    console.error("API message error:", error);
    const errorMsg: WSMessage = {
      type: "error",
      data: {
        error: error instanceof Error ? error.message : "Unknown error",
      },
      timestamp: new Date().toISOString(),
    };
    ws.send(JSON.stringify(errorMsg));
  }
}

/**
 * Handle Terminal messages
 */
async function handleTerminalMessage(
  ws: WebSocket,
  message: any,
  env: Env
): Promise<void> {
  const containerName = message.data?.container || "sandbox"; // Default to sandbox

  // Determine target DO
  let targetDO: any; // Using any to avoid importing DurableObjectNamespace if not available
  if (containerName === "sandbox") {
    targetDO = env.SANDBOX;
  } else if (containerName === "repo-analyzer") {
    targetDO = env.REPO_ANALYZER_CONTAINER;
  } else {
    ws.send(JSON.stringify({ type: "error", data: { error: "Unknown container" } }));
    return;
  }

  const id = targetDO.newUniqueId();
  const stub = targetDO.get(id);

  if (message.type === "terminal_input") {
    const input = message.data.input;

    if (input.endsWith('\r')) {
      const cmd = input.trim();
      if (cmd) {
        ws.send(JSON.stringify({ type: "terminal_output", data: `\r\n> Executing: ${cmd}\r\n` }));
        try {
          const result = await stub.execute(["/bin/sh", "-c", cmd]);
          if (result && result.stdout) {
            // Attempt to format generic output if object
            ws.send(JSON.stringify({ type: "terminal_output", data: result.stdout }));
          } else if (typeof result === 'string') {
            ws.send(JSON.stringify({ type: "terminal_output", data: result }));
          } else {
            ws.send(JSON.stringify({ type: "terminal_output", data: JSON.stringify(result) }));
          }
        } catch (e) {
          ws.send(JSON.stringify({ type: "error", data: { error: String(e) } }));
        }
      }
      ws.send(JSON.stringify({ type: "terminal_output", data: "\r\n$ " }));
    } else {
      // Echo back
      ws.send(JSON.stringify({ type: "terminal_output", data: input }));
    }
  } else if (message.type === "terminal_init") {
    ws.send(JSON.stringify({ type: "terminal_output", data: "$ " }));
  }
}

