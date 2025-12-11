import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { streamText } from "hono/streaming";
import {
  Env,
  SimpleQuestionsSchema,
  DetailedQuestionsSchema,
  SimpleResponseSchema,
  DetailedResponseSchema,
  AutoAnalyzeRepoSchema,
  AutoAnalyzeResponseSchema,
  PRAnalyzeSchema,
  PRAnalyzeResponseSchema,
  DetailedQuestion
} from "../types";

const SessionSchema = z.object({
  id: z.number(),
  sessionId: z.string(),
  timestamp: z.string(),
  title: z.string().nullable(),
  endpointType: z.string(),
  repoUrl: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

import { queryMCP } from "../mcp/mcp-client";
import { rewriteQuestionForMCP as rewriteWorker, analyzeResponseAndGenerateFollowUps as analyzeWorker, analyzeCommentForCloudflare as analyzeCommentWorker } from "../ai/providers/worker-ai";
import { rewriteQuestionForMCP as rewriteGemini, analyzeResponseAndGenerateFollowUps as analyzeGemini } from "../ai/providers/gemini";
import { extractCodeSnippets, parsePRUrl, getPRComments, filterCommentsByAuthor } from "../mcp/tools/git/github";
import {
  parseRepoUrl,
  analyzeRepoAndGenerateQuestions,
  evaluateQuestionSufficiency,
  organizeQuestionsByPillars
} from "../mcp/tools/git/repo-analyzer";
import { createSession, addQuestion, getAllSessions, getSession, getSessionQuestions } from "../core/session-manager";
import { logAction, logError, getSessionActionLogs } from "../core/action-logger";
import { createSSEStream, getSSEHeaders, ProgressTracker } from "../ai/utils/streaming";

const app = new OpenAPIHono<{ Bindings: Env }>();

// Helper to select provider
const getProvider = (useGemini: boolean, env: any) => {
  if (useGemini) {
    if (!env.CF_AIG_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
      throw new Error("Gemini requested but CF_AIG_TOKEN or CLOUDFLARE_ACCOUNT_ID not set");
    }
    return {
      rewrite: (q: string, ctx?: any) => rewriteGemini(env, q, ctx),
      analyze: (q: string, resp: any) => analyzeGemini(env, q, resp),
      // Note: analyzeCommentForCloudflare is currently only implemented in worker-ai
      // If you implement it in gemini.ts, add it here. For now, fallback or throw.
      analyzeComment: (comment: string, ctx?: any) => analyzeCommentWorker(env.AI, comment, ctx)
    };
  }
  return {
    rewrite: (q: string, ctx?: any) => rewriteWorker(env.AI, q, ctx),
    analyze: (q: string, resp: any) => analyzeWorker(env.AI, q, resp),
    analyzeComment: (comment: string, ctx?: any) => analyzeCommentWorker(env.AI, comment, ctx)
  };
};

/**
 * Simple questions endpoint - receives array of questions
 */
const simpleQuestionsRoute = createRoute({
  method: "post",
  path: "/questions/simple",
  operationId: "processSimpleQuestions",
  tags: ["Questions"],
  summary: "Process simple array of questions",
  description: "Receives an array of questions, queries Cloudflare docs MCP, analyzes with Worker AI, and returns answers",
  request: {
    query: z.object({
      stream: z.string().optional(),
    }),
    body: {
      content: {
        "application/json": {
          schema: SimpleQuestionsSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Successful response with answers",
      content: {
        "application/json": {
          schema: SimpleResponseSchema,
        },
        "text/event-stream": { schema: z.string() }
      },
    },
    400: {
      description: "Bad request",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
    },
    500: {
      description: "Internal server error",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
    },
  },
});

app.openapi(simpleQuestionsRoute, async (c) => {
  try {
    const { questions, use_gemini = false } = c.req.valid("json");
    const streamMode = c.req.query("stream") === "true";
    const env = c.env;
    const provider = getProvider(use_gemini, env);

    // Create session
    const { sessionId, sessionDbId } = await createSession(env, 'simple-questions', {
      title: questions.length > 0 ? `Simple Q: ${questions[0].substring(0, 30)}...` : 'Simple Questions',
    });

    // --- Streaming Logic ---
    if (streamMode) {
      const sse = createSSEStream();
      c.header('Content-Type', 'text/event-stream');
      c.header('Cache-Control', 'no-cache');
      c.header('Connection', 'keep-alive');

      (async () => {
        try {
          sse.sendProgress(`🚀 Starting processing for ${questions.length} simple questions...`);
          sse.sendProgress(`🤖 Using AI Provider: ${use_gemini ? "Google Gemini 2.5 Flash" : "Cloudflare Workers AI"}`);

          const results = [];

          for (const [index, question] of questions.entries()) {
            sse.sendProgress(`\n📝 [${index + 1}/${questions.length}] Processing: "${question}"`);

            try {
              // Step 1: Rewrite question
              sse.sendProgress(`   🔄 Rewriting question...`);
              const rewrittenQuestion = await provider.rewrite(question);

              // Step 2: Query MCP
              sse.sendProgress(`   📚 Querying Cloudflare docs...`);
              const mcpResponse = await queryMCP(rewrittenQuestion, undefined, env.MCP_API_URL);

              // Step 3: Analyze and generate follow-ups
              sse.sendProgress(`   🧠 Analyzing response...`);
              const { analysis, followUpQuestions } = await provider.analyze(
                question,
                mcpResponse
              );

              // Record in DB
              await addQuestion(
                env.DB,
                sessionDbId,
                question,
                mcpResponse,
                'user_provided',
                {
                  rewritten_question: rewrittenQuestion,
                  analysis,
                  follow_up_questions: followUpQuestions
                }
              );

              // Step 4: Process follow-up questions if any
              let followUpAnswers: any[] = [];
              if (followUpQuestions.length > 0) {
                sse.sendProgress(`   🔗 Processing ${followUpQuestions.length} follow-up questions...`);
                followUpAnswers = await Promise.all(
                  followUpQuestions.map((fq) => queryMCP(fq, undefined, env.MCP_API_URL))
                );
              }

              const result = {
                original_question: question,
                rewritten_question: rewrittenQuestion,
                mcp_response: mcpResponse,
                follow_up_questions: followUpQuestions,
                follow_up_answers: followUpAnswers,
                ai_analysis: analysis,
              };
              results.push(result);

              // Send structured data event
              sse.sendData(result, `✅ Completed question ${index + 1}`);
            } catch (error) {
              console.error(`Error processing question "${question}":`, error);
              sse.sendError(error as Error);
              results.push({
                original_question: question,
                rewritten_question: undefined,
                mcp_response: { error: error instanceof Error ? error.message : "Unknown error" },
                follow_up_questions: [],
                follow_up_answers: [],
                ai_analysis: undefined,
              });
            }
          }

          sse.complete({
            sessionId,
            results,
            total_processed: questions.length,
            timestamp: new Date().toISOString(),
          });
        } catch (error) {
          console.error("Error in streaming simple questions:", error);
          sse.sendError(error as Error);
          sse.complete();
        }
      })();

      return new Response(sse.stream, {
        headers: getSSEHeaders(),
      }) as any;
    }

    // --- Standard JSON Logic (Non-Streaming) ---
    const results = await Promise.all(
      questions.map(async (question) => {
        try {
          // Step 1: Rewrite question
          const rewrittenQuestion = await provider.rewrite(question);

          // Step 2: Query MCP
          const mcpResponse = await queryMCP(rewrittenQuestion, undefined, env.MCP_API_URL);

          // Step 3: Analyze and generate follow-ups
          const { analysis, followUpQuestions } = await provider.analyze(
            question,
            mcpResponse
          );

          // Record in DB
          await addQuestion(
            env.DB,
            sessionDbId,
            question,
            mcpResponse,
            'user_provided',
            {
              rewritten_question: rewrittenQuestion,
              analysis,
              follow_up_questions: followUpQuestions
            }
          );

          // Step 4: Process follow-up questions if any
          let followUpAnswers: any[] = [];
          if (followUpQuestions.length > 0) {
            followUpAnswers = await Promise.all(
              followUpQuestions.map((fq) => queryMCP(fq, undefined, env.MCP_API_URL))
            );
          }

          return {
            original_question: question,
            rewritten_question: rewrittenQuestion,
            mcp_response: mcpResponse,
            follow_up_questions: followUpQuestions,
            follow_up_answers: followUpAnswers,
            ai_analysis: analysis,
          };
        } catch (error) {
          console.error(`Error processing question "${question}":`, error);
          return {
            original_question: question,
            rewritten_question: undefined,
            mcp_response: { error: error instanceof Error ? error.message : "Unknown error" },
            follow_up_questions: [],
            follow_up_answers: [],
            ai_analysis: undefined,
          };
        }
      })
    );

    return c.json({
      results,
      total_processed: questions.length,
      timestamp: new Date().toISOString(),
    }, 200);
  } catch (error) {
    console.error("Error in simple questions route:", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      500
    );
  }
});

/**
 * Detailed questions endpoint - replicates Python script functionality
 */
const detailedQuestionsRoute = createRoute({
  method: "post",
  path: "/questions/detailed",
  operationId: "processDetailedQuestions",
  tags: ["Questions"],
  summary: "Process detailed questions with code context",
  description: "Receives detailed questions with code context, fetches code from GitHub, queries MCP with full context",
  request: {
    query: z.object({
      stream: z.string().optional(),
    }),
    body: {
      content: {
        "application/json": {
          schema: DetailedQuestionsSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Successful response with detailed answers",
      content: {
        "application/json": {
          schema: DetailedResponseSchema,
        },
        "text/event-stream": { schema: z.string() }
      },
    },
    400: {
      description: "Bad request",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
    },
    500: {
      description: "Internal server error",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
    },
  },
});

app.openapi(detailedQuestionsRoute, async (c) => {
  try {
    const { questions, repo_owner, repo_name, use_gemini = false } = c.req.valid("json");
    const streamMode = c.req.query("stream") === "true";
    const env = c.env;
    const provider = getProvider(use_gemini, env);

    // Create session
    const { sessionId, sessionDbId } = await createSession(env, 'detailed-questions', {
      repoUrl: repo_owner && repo_name ? `https://github.com/${repo_owner}/${repo_name}` : undefined,
      titleContext: repo_owner && repo_name ? `${repo_owner}/${repo_name}` : undefined
    });

    // --- Streaming Logic ---
    if (streamMode) {
      return streamText(c, async (stream) => {
        const log = async (msg: string) => await stream.write(msg + "\n");
        await log(`🚀 Starting processing for ${questions.length} detailed questions...`);
        if (repo_owner && repo_name) {
          await log(`📂 Context: ${repo_owner}/${repo_name}`);
        }
        await log(`🤖 Using AI Provider: ${use_gemini ? "Google Gemini 2.5 Flash" : "Cloudflare Workers AI"}`);

        const results = [];

        for (const [index, question] of questions.entries()) {
          await log(`\n📝 [${index + 1}/${questions.length}] Processing: "${question.query}"`);

          try {
            // Step 1: Extract code snippets
            let codeSnippets: any[] = [];
            if (repo_owner && repo_name && question.relevant_code_files.length > 0) {
              await log(`   🔍 Extracting code snippets...`);
              codeSnippets = await extractCodeSnippets(
                env,
                repo_owner,
                repo_name,
                question.relevant_code_files as any
              );
            }

            // Step 2: Rewrite question with full context
            await log(`   🔄 Rewriting question with context...`);
            const rewrittenQuestion = await provider.rewrite(question.query, {
              bindings: question.cloudflare_bindings_involved,
              libraries: question.node_libs_involved,
              tags: question.tags,
              codeSnippets,
            });

            // Step 3: Query MCP with context
            await log(`   📚 Querying Cloudflare docs...`);
            const context = `Cloudflare Migration Context - Bindings: ${question.cloudflare_bindings_involved.join(", ")}`;
            const mcpResponse = await queryMCP(rewrittenQuestion, context, env.MCP_API_URL);

            // Step 4: Analyze and generate follow-ups
            await log(`   🧠 Analyzing response...`);
            const { analysis, followUpQuestions } = await provider.analyze(
              question.query,
              mcpResponse
            );

            // Record in DB
            await addQuestion(
              env.DB,
              sessionDbId,
              question.query,
              mcpResponse,
              'user_provided',
              {
                rewritten_question: rewrittenQuestion,
                analysis,
                follow_up_questions: followUpQuestions,
                code_snippets: codeSnippets,
                bindings: question.cloudflare_bindings_involved
              }
            );

            // Step 5: Process follow-up questions
            let followUpAnswers: any[] = [];
            if (followUpQuestions.length > 0) {
              await log(`   🔗 Processing ${followUpQuestions.length} follow-up questions...`);
              followUpAnswers = await Promise.all(
                followUpQuestions.map((fq) => queryMCP(fq, context, env.MCP_API_URL))
              );
            }

            results.push({
              original_question: question,
              code_snippets: codeSnippets,
              rewritten_question: rewrittenQuestion,
              mcp_response: mcpResponse,
              follow_up_questions: followUpQuestions,
              follow_up_answers: followUpAnswers,
              ai_analysis: analysis,
            });

            await log(`   ✅ Completed question ${index + 1}`);
          } catch (error) {
            console.error(`Error processing detailed question "${question.query}":`, error);
            await log(`   ❌ Error: ${error instanceof Error ? error.message : "Unknown error"}`);
            results.push({
              original_question: question,
              code_snippets: [],
              rewritten_question: undefined,
              mcp_response: { error: error instanceof Error ? error.message : "Unknown error" },
              follow_up_questions: [],
              follow_up_answers: [],
              ai_analysis: undefined,
            });
          }
        }

        await log(`\n🎉 All questions processed!`);
        await log(`📊 Session ID: ${sessionId}`);
      }) as any;
    }

    // --- Standard JSON Logic (Non-Streaming) ---
    const results = await Promise.all(
      questions.map(async (question) => {
        try {
          // Step 1: Extract code snippets if GitHub repo provided
          let codeSnippets: any[] = [];
          if (repo_owner && repo_name && question.relevant_code_files.length > 0) {
            codeSnippets = await extractCodeSnippets(
              env,
              repo_owner,
              repo_name,
              question.relevant_code_files as any
            );
          }

          // Step 2: Rewrite question with full context
          const rewrittenQuestion = await provider.rewrite(question.query, {
            bindings: question.cloudflare_bindings_involved,
            libraries: question.node_libs_involved,
            tags: question.tags,
            codeSnippets,
          });

          // Step 3: Query MCP with context
          const context = `Cloudflare Migration Context - Bindings: ${question.cloudflare_bindings_involved.join(", ")}`;
          const mcpResponse = await queryMCP(rewrittenQuestion, context, env.MCP_API_URL);

          // Step 4: Analyze and generate follow-ups
          const { analysis, followUpQuestions } = await provider.analyze(
            question.query,
            mcpResponse
          );

          // Record in DB
          await addQuestion(
            env.DB,
            sessionDbId,
            question.query,
            mcpResponse,
            'user_provided',
            {
              rewritten_question: rewrittenQuestion,
              analysis,
              follow_up_questions: followUpQuestions,
              code_snippets: codeSnippets,
              bindings: question.cloudflare_bindings_involved
            }
          );

          // Step 5: Process follow-up questions
          let followUpAnswers: any[] = [];
          if (followUpQuestions.length > 0) {
            followUpAnswers = await Promise.all(
              followUpQuestions.map((fq) => queryMCP(fq, context, env.MCP_API_URL))
            );
          }

          return {
            original_question: question,
            code_snippets: codeSnippets,
            rewritten_question: rewrittenQuestion,
            mcp_response: mcpResponse,
            follow_up_questions: followUpQuestions,
            follow_up_answers: followUpAnswers,
            ai_analysis: analysis,
          };
        } catch (error) {
          console.error(`Error processing detailed question "${question.query}":`, error);
          return {
            original_question: question,
            code_snippets: [],
            rewritten_question: undefined,
            mcp_response: { error: error instanceof Error ? error.message : "Unknown error" },
            follow_up_questions: [],
            follow_up_answers: [],
            ai_analysis: undefined,
          };
        }
      })
    );

    return c.json({
      results,
      total_processed: questions.length,
      timestamp: new Date().toISOString(),
    }, 200);
  } catch (error) {
    console.error("Error in detailed questions route:", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      500
    );
  }
});

/**
 * Deep Research Endpoint
 */
const researchRoute = createRoute({
  method: "post",
  path: "/research",
  operationId: "dispatchResearch",
  tags: ["Questions"],
  summary: "Dispatch a Deep Research task",
  description: "Queues a deep research task using the new Workflow architecture",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            query: z.string(),
            mode: z.enum(['feasibility', 'enrichment', 'error_fix']),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Task queued successfully",
      content: {
        "application/json": {
          schema: z.object({
            status: z.string(),
            sessionId: z.string(),
          }),
        },
      },
    },
    500: {
      description: "Internal server error",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
    },
  },
});

app.openapi(researchRoute, async (c) => {
  try {
    const { query, mode } = c.req.valid("json");
    const sessionId = crypto.randomUUID();

    // Initialize KV first to avoid race condition where polling happens before workflow starts
    await c.env.QUESTIONS_KV.put(`research:${sessionId}`, JSON.stringify({
      status: 'queued',
      timestamp: new Date().toISOString(),
      query,
      mode
    }));

    await c.env.RESEARCH_QUEUE.send({
      sessionId,
      query,
      mode
    });

    return c.json({ status: 'queued', sessionId }, 200);
  } catch (error) {
    console.error("Error dispatching research task:", error);
    return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});

const researchStatusRoute = createRoute({
  method: "get",
  path: "/research/{sessionId}",
  operationId: "getResearchStatus",
  tags: ["Questions"],
  summary: "Get Deep Research task status",
  parameters: [
    {
      name: "sessionId",
      in: "path",
      required: true,
      schema: { type: "string" },
    },
  ],
  responses: {
    200: {
      description: "Task status",
      content: {
        "application/json": {
          schema: z.object({
            status: z.string(),
            data: z.any().optional(),
            report: z.string().optional(),
            timestamp: z.string(),
          }),
        },
      },
    },
    404: {
      description: "Session not found",
    },
  },
});

app.openapi(researchStatusRoute, async (c) => {
  const sessionId = c.req.param("sessionId");
  const result = await c.env.QUESTIONS_KV.get(`research:${sessionId}`, "json");

  if (!result) {
    return c.json({ error: "Session not found" }, 404);
  }

  return c.json(result as any, 200);
});

/**
 * Engineer Endpoint - Fix Code
 */
const engineerFixRoute = createRoute({
  method: "post",
  path: "/engineer/fix",
  operationId: "dispatchEngineerFix",
  tags: ["Engineer"],
  summary: "Dispatch an Engineering code fix task",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            sessionId: z.string(),
            repoUrl: z.string(),
            filePath: z.string(),
            instruction: z.string(),
            currentCode: z.string().optional()
          })
        }
      }
    }
  },
  responses: {
    200: { description: "Task queued", content: { "application/json": { schema: z.object({ status: z.string(), id: z.string() }) } } },
    500: { description: "Error" }
  }
});

app.openapi(engineerFixRoute, async (c) => {
  try {
    const params = c.req.valid("json");
    const id = await c.env.ENGINEER_WORKFLOW.create({
      id: crypto.randomUUID(),
      params
    });
    return c.json({ status: "queued", id: id.id }, 200);
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

/**
 * Governance Endpoint - Sync Docs
 */
const governanceSyncRoute = createRoute({
  method: "post",
  path: "/governance/sync",
  operationId: "dispatchGovernanceSync",
  tags: ["Governance"],
  summary: "Dispatch a Governance documentation sync",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            repoUrl: z.string()
          })
        }
      }
    }
  },
  responses: {
    200: { description: "Task queued", content: { "application/json": { schema: z.object({ status: z.string(), id: z.string() }) } } },
    500: { description: "Error" }
  }
});

app.openapi(governanceSyncRoute, async (c) => {
  try {
    const { repoUrl } = c.req.valid("json");
    const id = await c.env.GOVERNANCE_WORKFLOW.create({
      id: crypto.randomUUID(),
      params: { repoUrl }
    });
    return c.json({ status: "queued", id: id.id }, 200);
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

/**
 * Chat Agent Endpoint
 */
const chatAgentRoute = createRoute({
  method: "post",
  path: "/agent/chat",
  operationId: "chatWithAgent",
  tags: ["Agent"],
  summary: "Chat with the stateful AI Agent",
  request: {
    query: z.object({
      sessionId: z.string().optional().default("default")
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            prompt: z.string()
          })
        }
      }
    }
  },
  responses: {
    200: { description: "Agent response", content: { "application/json": { schema: z.object({ response: z.string() }) } } },
    500: { description: "Error" }
  }
});

app.openapi(chatAgentRoute, async (c) => {
  try {
    const { prompt } = c.req.valid("json");
    const sessionId = c.req.query("sessionId") || "default";

    // Get Durable Object ID
    const id = c.env.CHAT_AGENT.idFromName(sessionId);
    const stub = c.env.CHAT_AGENT.get(id);

    // Call the Agent
    const response = await stub.fetch(new Request("https://agent/chat", {
      method: "POST",
      body: JSON.stringify({ prompt }),
      headers: { "Content-Type": "application/json" }
    }));

    if (!response.ok) {
      throw new Error(`Agent error: ${await response.text()}`);
    }

    const data = await response.json();
    return c.json(data as any, 200);

  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

/**
 * Ingestion Endpoint
 */
const ingestRoute = createRoute({
  method: "post",
  path: "/ingest",
  operationId: "ingestUrl",
  tags: ["Knowledge"],
  summary: "Ingest a URL into the knowledge base",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            url: z.string().url(),
            tags: z.array(z.string()).optional()
          })
        }
      }
    }
  },
  responses: {
    200: { description: "Ingestion queued", content: { "application/json": { schema: z.object({ status: z.string(), id: z.string() }) } } },
    500: { description: "Error" }
  }
});

app.openapi(ingestRoute, async (c) => {
  try {
    const { url, tags } = c.req.valid("json");

    // Trigger Ingestion Workflow
    const id = await c.env.INGESTION_WORKFLOW.create({
      id: crypto.randomUUID(),
      params: { url, tags }
    });

    return c.json({ status: "queued", id: id.id }, 200);
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

/**
 * Auto-analyze repository endpoint - generates and processes questions automatically
 */
const autoAnalyzeRoute = createRoute({
  method: "post",
  path: "/questions/auto-analyze",
  operationId: "autoAnalyzeRepository",
  tags: ["Questions"],
  summary: "Auto-analyze GitHub repository",
  description: "Automatically analyze a GitHub repository, generate relevant questions, cache them in KV, and process through the detailed pathway. Always starts with the fundamental question: 'Can this repo be retrofitted to run on Cloudflare?'",
  request: {
    query: z.object({
      stream: z.string().optional(),
    }),
    body: {
      content: {
        "application/json": {
          schema: AutoAnalyzeRepoSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Successful analysis with generated questions and answers",
      content: {
        "application/json": {
          schema: AutoAnalyzeResponseSchema,
        },
        "text/plain": { schema: z.string() },
        "text/event-stream": { schema: z.string() }
      },
    },
    400: {
      description: "Bad request - invalid repo URL",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
    },
    500: {
      description: "Internal server error",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
    },
  },
});

app.openapi(autoAnalyzeRoute, async (c) => {
  try {
    const { repo_url, force_refresh = false, max_files = 50, use_gemini = false } = c.req.valid("json");
    const streamMode = c.req.query("stream") === "true";
    const env = c.env;

    // Parse repo URL
    const parsed = parseRepoUrl(repo_url);
    if (!parsed) {
      return c.json({ error: "Invalid GitHub repository URL" }, 400);
    }

    const { owner, repo } = parsed;
    const cacheKey = `questions:${owner}:${repo}`;

    // Select Provider
    const provider = getProvider(use_gemini, env);

    // Create session
    const { sessionId, sessionDbId } = await createSession(env, 'auto-analyze', {
      repoUrl: repo_url,
      titleContext: `${owner}/${repo}`
    });

    // --- Streaming Logic ---
    if (streamMode) {
      const sse = createSSEStream();
      c.header('Content-Type', 'text/event-stream');
      c.header('Cache-Control', 'no-cache');
      c.header('Connection', 'keep-alive');

      (async () => {
        try {
          sse.sendProgress(`🚀 Starting analysis for ${owner}/${repo}...`);
          sse.sendProgress(`🤖 Using AI Provider: ${use_gemini ? "Google Gemini 2.5 Flash" : "Cloudflare Workers AI"}`);

          let questions: DetailedQuestion[] = [];
          let cached = false;

          if (!force_refresh) {
            sse.sendProgress(`🔍 Checking cache...`);
            const cachedData = await env.QUESTIONS_KV.get(cacheKey, "json");
            if (cachedData && Array.isArray(cachedData)) {
              questions = cachedData as DetailedQuestion[];
              cached = true;
              sse.sendProgress(`✅ Found ${questions.length} cached questions.`);
            }
          }

          if (questions.length === 0) {
            sse.sendProgress(`🧠 Cache miss. Analyzing repository structure and docs...`);
            sse.sendProgress(`   (This may take 10-20 seconds...)`);

            // Pass use_gemini flag and progress callback to repo analyzer
            const generatedQuestions = await analyzeRepoAndGenerateQuestions(
              env, // Pass full env
              owner,
              repo,
              max_files,
              use_gemini, // Pass the flag
              true, // Use container
              (msg) => sse.sendProgress(msg) // Progress callback
            );

            const fundamentalQuestion: DetailedQuestion = {
              query: `Can the ${repo} repository be retrofitted to run on Cloudflare Workers?`,
              cloudflare_bindings_involved: ["env", "kv", "r2", "durable-objects"],
              node_libs_involved: [],
              tags: ["feasibility", "migration"],
              relevant_code_files: [],
            };

            questions = [fundamentalQuestion, ...generatedQuestions];
            sse.sendProgress(`✨ Generated ${questions.length} migration questions.`);
            await env.QUESTIONS_KV.put(cacheKey, JSON.stringify(questions), { expirationTtl: 86400 * 7 });
          }

          // Organize questions into migration pillars
          sse.sendProgress(`📋 Organizing questions into migration pillars...`);
          const pillars = organizeQuestionsByPillars(questions);

          // Send the migration plan
          sse.sendPlan({
            pillars: pillars.map(p => ({
              id: p.id,
              name: p.name,
              description: p.description,
              icon: p.icon,
              category: p.category,
              bindings: p.bindings,
              question_count: p.questions.length,
              status: p.status,
            })),
            repo_context: { owner, repo },
          });

          sse.sendProgress(`\n⚡ Processing ${questions.length} questions across ${pillars.filter(p => p.questions.length > 0).length} pillars...`);

          // Process questions pillar by pillar
          for (const pillar of pillars) {
            if (pillar.questions.length === 0) continue;

            sse.sendPillarStart(pillar.id, pillar.name, `Starting analysis of ${pillar.name}...`);

            const findings: string[] = [];

            for (const [qIndex, question] of pillar.questions.entries()) {
              const progress = Math.round(((qIndex + 1) / pillar.questions.length) * 100);
              sse.sendPillarProgress(
                pillar.id,
                pillar.name,
                progress,
                `[${qIndex + 1}/${pillar.questions.length}] Analyzing: "${question.query.substring(0, 60)}..."`
              );

              try {
                const rewritten = await provider.rewrite(question.query, {
                  bindings: question.cloudflare_bindings_involved,
                  libraries: question.node_libs_involved,
                  tags: question.tags
                });

                // Query MCP with Cloudflare docs
                const mcpRes = await queryMCP(rewritten, undefined, env.MCP_API_URL);

                // Analyze compatibility with Workers AI
                const { analysis } = await provider.analyze(question.query, mcpRes);

                // Extract key findings from analysis
                const findingMatch = analysis.match(/(?:finding|conclusion|compatible|migration|recommendation)[:]\s*(.+?)(?:\.|$)/i);
                if (findingMatch) {
                  findings.push(findingMatch[1].trim());
                } else if (analysis.length > 0) {
                  // Extract first sentence as finding
                  const firstSentence = analysis.split('.')[0].trim();
                  if (firstSentence.length > 20) {
                    findings.push(firstSentence);
                  }
                }

                // Record in DB
                await addQuestion(
                  env.DB,
                  sessionDbId,
                  question.query,
                  mcpRes,
                  'ai_generated',
                  {
                    rewritten_question: rewritten,
                    analysis,
                    tags: question.tags,
                    pillar_id: pillar.id
                  }
                );

                const result = {
                  pillar_id: pillar.id,
                  pillar_name: pillar.name,
                  original_question: question,
                  rewritten_question: rewritten,
                  mcp_response: mcpRes,
                  ai_analysis: analysis
                };

                sse.sendData(result, `✅ ${pillar.name}: Question analyzed`);
              } catch (err) {
                const errorMsg = err instanceof Error ? err.message : "Unknown";
                sse.sendProgress(`      -> ❌ Error in ${pillar.name}: ${errorMsg}`);
                sse.sendError(err as Error);
              }
            }

            sse.sendPillarComplete(pillar.id, pillar.name, findings, `Completed ${pillar.name} analysis`);
          }

          sse.complete({
            repo_url,
            repo_owner: owner,
            repo_name: repo,
            cached,
            questions_generated: questions.length,
            questions,
            // results are sent incrementally via data events
            total_processed: questions.length,
            timestamp: new Date().toISOString(),
          });
        } catch (err) {
          console.error("Error in auto-analyze stream:", err);
          sse.sendError(err as Error);
          sse.complete();
        }
      })();

      return new Response(sse.stream, {
        headers: getSSEHeaders(),
      }) as any;
    }

    // --- Standard JSON Logic (Non-Streaming) ---
    let questions: DetailedQuestion[] = [];
    let cached = false;

    if (!force_refresh) {
      const cachedData = await env.QUESTIONS_KV.get(cacheKey, "json");
      if (cachedData && Array.isArray(cachedData)) {
        questions = cachedData as DetailedQuestion[];
        cached = true;
      }
    }

    if (questions.length === 0) {
      const generatedQuestions = await analyzeRepoAndGenerateQuestions(
        env,
        owner,
        repo,
        max_files,
        use_gemini
      );

      const fundamentalQuestion: DetailedQuestion = {
        query: `Can the ${repo} repository be retrofitted to run on Cloudflare Workers or Cloudflare Pages?`,
        cloudflare_bindings_involved: ["env", "kv", "r2", "durable-objects", "ai"],
        node_libs_involved: [],
        tags: ["feasibility", "migration", "cloudflare", "assessment"],
        relevant_code_files: [],
      };

      questions = [fundamentalQuestion, ...generatedQuestions];
      await env.QUESTIONS_KV.put(cacheKey, JSON.stringify(questions), {
        expirationTtl: 86400 * 7,
      });
    }

    const results = await Promise.all(
      questions.map(async (question) => {
        try {
          // Extract code snippets if files are specified
          let codeSnippets: any[] = [];
          if (question.relevant_code_files.length > 0) {
            codeSnippets = await extractCodeSnippets(
              env,
              owner,
              repo,
              question.relevant_code_files as any
            );
          }

          // Rewrite question with full context
          const rewrittenQuestion = await provider.rewrite(question.query, {
            bindings: question.cloudflare_bindings_involved,
            libraries: question.node_libs_involved,
            tags: question.tags,
            codeSnippets,
          });

          // Query MCP with context
          const context = `Repository Analysis: ${owner}/${repo} - Cloudflare Migration Assessment`;
          const mcpResponse = await queryMCP(rewrittenQuestion, context, env.MCP_API_URL);

          // Analyze and generate follow-ups
          const { analysis, followUpQuestions } = await provider.analyze(
            question.query,
            mcpResponse
          );

          // Record in DB
          await addQuestion(
            env.DB,
            sessionDbId,
            question.query,
            mcpResponse,
            'ai_generated',
            {
              rewritten_question: rewrittenQuestion,
              analysis,
              follow_up_questions: followUpQuestions,
              code_snippets: codeSnippets
            }
          );

          // Process follow-up questions
          let followUpAnswers: any[] = [];
          if (followUpQuestions.length > 0) {
            followUpAnswers = await Promise.all(
              followUpQuestions.slice(0, 3).map((fq) => queryMCP(fq, context, env.MCP_API_URL))
            );
          }

          return {
            original_question: question,
            code_snippets: codeSnippets,
            rewritten_question: rewrittenQuestion,
            mcp_response: mcpResponse,
            follow_up_questions: followUpQuestions,
            follow_up_answers: followUpAnswers,
            ai_analysis: analysis,
          };
        } catch (error) {
          console.error(`Error processing question "${question.query}":`, error);
          return {
            original_question: question,
            code_snippets: [],
            rewritten_question: undefined,
            mcp_response: { error: error instanceof Error ? error.message : "Unknown error" },
            follow_up_questions: [],
            follow_up_answers: [],
            ai_analysis: undefined,
          };
        }
      })
    );

    return c.json({
      repo_url,
      repo_owner: owner,
      repo_name: repo,
      cached,
      questions_generated: questions.length,
      questions,
      results,
      total_processed: questions.length,
      timestamp: new Date().toISOString(),
    }, 200);
  } catch (error) {
    console.error("Error in auto-analyze route:", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      500
    );
  }
});

/**
 * PR Analysis endpoint - analyzes PR comments for Cloudflare-related content
 */
const prAnalyzeRoute = createRoute({
  method: "post",
  path: "/questions/pr-analyze",
  operationId: "analyzePullRequest",
  tags: ["Questions"],
  summary: "Analyze GitHub Pull Request comments",
  description: "Extracts code comments from a GitHub PR (optionally filtered by author like 'gemini-code-assist'), analyzes them for Cloudflare-specific solutions using Worker AI, generates relevant questions, and queries Cloudflare documentation for answers",
  request: {
    body: {
      content: {
        "application/json": {
          schema: PRAnalyzeSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Successful PR analysis with generated questions and answers",
      content: {
        "application/json": {
          schema: PRAnalyzeResponseSchema,
        },
        "text/event-stream": { schema: z.string() }
      },
    },
    400: {
      description: "Bad request - invalid PR URL",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
    },
    500: {
      description: "Internal server error",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
    },
  },
});

/**
 * Streaming handler for PR analysis
 */
async function handlePRAnalyzeStream(
  c: any,
  env: Env,
  pr_url: string,
  comment_filter: string | undefined,
  owner: string,
  repo: string,
  prNumber: number,
  useGemini: boolean
) {
  const sse = createSSEStream();
  const provider = getProvider(useGemini, env);

  // Start streaming response
  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');

  // Process in background and send updates
  (async () => {
    try {
      sse.sendProgress(`🚀 Starting PR analysis for ${owner}/${repo} #${prNumber}...`);

      // Create session for tracking
      sse.sendProgress(`📝 Creating analysis session...`);
      const { sessionId, sessionDbId } = await createSession(env, 'pr-analyze', {
        repoUrl: pr_url,
        titleContext: `PR #${prNumber} - ${owner}/${repo}`,
      });

      await logAction(env.DB, "pr_analysis_started", `Analyzing PR #${prNumber}`, {
        sessionId: sessionDbId,
        metadata: { owner, repo, prNumber, comment_filter },
      });

      // Get all PR comments
      sse.sendProgress(`💬 Fetching comments from PR #${prNumber}...`);
      const allComments = await getPRComments(env, owner, repo, prNumber);

      // Filter comments if requested
      const comments = filterCommentsByAuthor(allComments, comment_filter);
      sse.sendProgress(`✓ Found ${comments.length} comments ${comment_filter ? `from ${comment_filter}` : ''}`);

      await logAction(env.DB, "comments_extracted", `Extracted ${comments.length} comments`, {
        sessionId: sessionDbId,
        metadata: { total_comments: allComments.length, filtered_comments: comments.length },
      });

      const tracker = new ProgressTracker(comments.length, (msg) => sse.sendProgress(msg));
      const results = [];

      // Process each comment
      for (let i = 0; i < comments.length; i++) {
        const comment = comments[i];
        tracker.increment(`Analyzing comment from @${comment.author}...`);

        try {
          // Analyze if comment is Cloudflare-related
          sse.sendProgress(`  🔍 Checking if comment is Cloudflare-related...`);
          const analysis = await provider.analyzeComment(comment.body, {
            filePath: comment.file_path,
            line: comment.line,
          });

          if (!analysis.isCloudflareRelated) {
            sse.sendProgress(`  ⊘ Not Cloudflare-related, skipping...`);
            results.push({
              comment: {
                id: comment.id,
                author: comment.author,
                body: comment.body,
                file_path: comment.file_path,
                line: comment.line,
              },
              is_cloudflare_related: false,
            });
            continue;
          }

          sse.sendProgress(`  ✓ Cloudflare-related! Context: ${analysis.cloudflareContext}`);
          sse.sendProgress(`  💡 Generating ${analysis.questions.length} questions...`);

          // Generate questions and get answers
          const answers = [];
          for (let j = 0; j < analysis.questions.length; j++) {
            const question = analysis.questions[j];
            try {
              sse.sendProgress(`    [${j + 1}/${analysis.questions.length}] Processing: "${question.substring(0, 60)}${question.length > 60 ? '...' : ''}"`);

              // Rewrite question for MCP
              const rewrittenQuestion = await provider.rewrite(question);

              // Query MCP
              sse.sendProgress(`    📚 Querying Cloudflare docs...`);
              const context = `PR Comment Analysis - ${owner}/${repo} PR #${prNumber}`;
              const mcpResponse = await queryMCP(rewrittenQuestion, context, env.MCP_API_URL);

              // Store question in database
              await addQuestion(
                env.DB,
                sessionDbId,
                question,
                mcpResponse,
                'ai_generated',
                {
                  pr_number: prNumber,
                  comment_id: comment.id,
                  comment_author: comment.author,
                  cloudflare_context: analysis.cloudflareContext,
                }
              );

              // Send structured data event
              sse.sendData({
                question: question,
                rewritten_question: rewrittenQuestion,
                mcp_response: mcpResponse,
              }, `    ✓ Answer received and stored`);

              answers.push({
                original_question: question,
                rewritten_question: rewrittenQuestion,
                mcp_response: mcpResponse,
              });
            } catch (error) {
              console.error(`Error processing question "${question}":`, error);
              sse.sendProgress(`    ⚠️ Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
              await logError(env.DB, "question_processing_error", error as Error, {
                sessionId: sessionDbId,
                metadata: { question },
              });
              answers.push({
                original_question: question,
                error: error instanceof Error ? error.message : "Unknown error",
              });
            }
          }

          await logAction(env.DB, "comment_analyzed", `Analyzed Cloudflare-related comment`, {
            sessionId: sessionDbId,
            metadata: {
              comment_id: comment.id,
              questions_generated: analysis.questions.length,
            },
          });

          results.push({
            comment: {
              id: comment.id,
              author: comment.author,
              body: comment.body,
              file_path: comment.file_path,
              line: comment.line,
            },
            is_cloudflare_related: true,
            cloudflare_context: analysis.cloudflareContext,
            questions_generated: analysis.questions,
            answers,
          });
        } catch (error) {
          console.error(`Error processing comment ${comment.id}:`, error);
          sse.sendProgress(`  ⚠️ Error processing comment: ${error instanceof Error ? error.message : 'Unknown error'}`);
          await logError(env.DB, "comment_analysis_error", error as Error, {
            sessionId: sessionDbId,
            metadata: { comment_id: comment.id },
          });
          results.push({
            comment: {
              id: comment.id,
              author: comment.author,
              body: comment.body,
              file_path: comment.file_path,
              line: comment.line,
            },
            is_cloudflare_related: false,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }

      const cloudflareRelatedCount = results.filter(r => r.is_cloudflare_related).length;

      await logAction(env.DB, "pr_analysis_completed", `Completed PR analysis`, {
        sessionId: sessionDbId,
        metadata: {
          total_comments: comments.length,
          cloudflare_related: cloudflareRelatedCount,
        },
      });

      tracker.complete(`Analysis complete! Found ${cloudflareRelatedCount} Cloudflare-related comments`);

      // Send final data
      sse.complete({
        session_id: sessionId,
        pr_url,
        repo_owner: owner,
        repo_name: repo,
        pr_number: prNumber,
        comments_extracted: comments.length,
        cloudflare_related_comments: cloudflareRelatedCount,
        results,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("Error in streaming PR analyze:", error);
      sse.sendError(error as Error);
      sse.complete();
    }
  })();

  return new Response(sse.stream, {
    headers: getSSEHeaders(),
  });
}

app.openapi(prAnalyzeRoute, async (c) => {
  try {
    const { pr_url, comment_filter, use_gemini = false } = c.req.valid("json");
    const env = c.env;

    // Check if client wants streaming
    const wantsStream = c.req.query('stream') === 'true' ||
      c.req.header('accept')?.includes('text/event-stream');

    // Parse PR URL
    const parsed = parsePRUrl(pr_url);
    if (!parsed) {
      return c.json({ error: "Invalid GitHub Pull Request URL" }, 400);
    }

    const { owner, repo, prNumber } = parsed;
    const provider = getProvider(use_gemini, env);

    // If streaming requested, use streaming handler
    if (wantsStream) {
      return handlePRAnalyzeStream(c, env, pr_url, comment_filter, owner, repo, prNumber, use_gemini) as any;
    }

    // Create session for tracking
    const { sessionId, sessionDbId } = await createSession(env, 'pr-analyze', {
      repoUrl: pr_url,
      titleContext: `PR #${prNumber} - ${owner}/${repo}`,
    });

    await logAction(env.DB, "pr_analysis_started", `Analyzing PR #${prNumber}`, {
      sessionId: sessionDbId,
      metadata: { owner, repo, prNumber, comment_filter },
    });

    // Get all PR comments
    console.log(`Fetching comments from PR #${prNumber}...`);
    const allComments = await getPRComments(env, owner, repo, prNumber);

    // Filter comments if requested
    const comments = filterCommentsByAuthor(allComments, comment_filter);

    await logAction(env.DB, "comments_extracted", `Extracted ${comments.length} comments`, {
      sessionId: sessionDbId,
      metadata: { total_comments: allComments.length, filtered_comments: comments.length },
    });

    console.log(`Processing ${comments.length} comments...`);

    // Process each comment
    const results = await Promise.all(
      comments.map(async (comment) => {
        try {
          // Analyze if comment is Cloudflare-related
          const analysis = await provider.analyzeComment(comment.body, {
            filePath: comment.file_path,
            line: comment.line,
          });

          if (!analysis.isCloudflareRelated) {
            return {
              comment: {
                id: comment.id,
                author: comment.author,
                body: comment.body,
                file_path: comment.file_path,
                line: comment.line,
              },
              is_cloudflare_related: false,
            };
          }

          // Generate questions and get answers
          const answers = await Promise.all(
            analysis.questions.map(async (question) => {
              try {
                // Rewrite question for MCP
                const rewrittenQuestion = await provider.rewrite(question);

                // Query MCP
                const context = `PR Comment Analysis - ${owner}/${repo} PR #${prNumber}`;
                const mcpResponse = await queryMCP(rewrittenQuestion, context, env.MCP_API_URL);

                // Store question in database
                await addQuestion(
                  env.DB,
                  sessionDbId,
                  question,
                  mcpResponse,
                  'ai_generated',
                  {
                    pr_number: prNumber,
                    comment_id: comment.id,
                    comment_author: comment.author,
                    cloudflare_context: analysis.cloudflareContext,
                  }
                );

                return {
                  original_question: question,
                  rewritten_question: rewrittenQuestion,
                  mcp_response: mcpResponse,
                };
              } catch (error) {
                console.error(`Error processing question "${question}":`, error);
                await logError(env.DB, "question_processing_error", error as Error, {
                  sessionId: sessionDbId,
                  metadata: { question },
                });
                return {
                  original_question: question,
                  error: error instanceof Error ? error.message : "Unknown error",
                };
              }
            })
          );

          await logAction(env.DB, "comment_analyzed", `Analyzed Cloudflare-related comment`, {
            sessionId: sessionDbId,
            metadata: {
              comment_id: comment.id,
              questions_generated: analysis.questions.length,
            },
          });

          return {
            comment: {
              id: comment.id,
              author: comment.author,
              body: comment.body,
              file_path: comment.file_path,
              line: comment.line,
            },
            is_cloudflare_related: true,
            cloudflare_context: analysis.cloudflareContext,
            questions_generated: analysis.questions,
            answers,
          };
        } catch (error) {
          console.error(`Error processing comment ${comment.id}:`, error);
          await logError(env.DB, "comment_analysis_error", error as Error, {
            sessionId: sessionDbId,
            metadata: { comment_id: comment.id },
          });
          return {
            comment: {
              id: comment.id,
              author: comment.author,
              body: comment.body,
              file_path: comment.file_path,
              line: comment.line,
            },
            is_cloudflare_related: false,
            error: error instanceof Error ? error.message : "Unknown error",
          };
        }
      })
    );

    const cloudflareRelatedCount = results.filter(r => r.is_cloudflare_related).length;

    await logAction(env.DB, "pr_analysis_completed", `Completed PR analysis`, {
      sessionId: sessionDbId,
      metadata: {
        total_comments: comments.length,
        cloudflare_related: cloudflareRelatedCount,
      },
    });

    return c.json({
      session_id: sessionId,
      pr_url,
      repo_owner: owner,
      repo_name: repo,
      pr_number: prNumber,
      comments_extracted: comments.length,
      cloudflare_related_comments: cloudflareRelatedCount,
      results,
      timestamp: new Date().toISOString(),
    }, 200);
  } catch (error) {
    console.error("Error in PR analyze route:", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      500
    );
  }
});

/**
 * List all sessions endpoint
 */
const listSessionsRoute = createRoute({
  method: "get",
  path: "/sessions",
  operationId: "listSessions",
  tags: ["Sessions"],
  summary: "List all sessions",
  description: "Get a paginated list of all sessions",
  request: {
    query: z.object({
      limit: z.string().optional().default("100"),
      offset: z.string().optional().default("0"),
    }),
  },
  responses: {
    200: {
      description: "List of sessions",
      content: {
        "application/json": {
          schema: z.object({
            sessions: z.array(SessionSchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
    },
    500: {
      description: "Internal server error",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
    },
  },
});

app.openapi(listSessionsRoute, async (c) => {
  try {
    const { limit = "100", offset = "0" } = c.req.query();
    const sessions = await getAllSessions(
      c.env.DB,
      parseInt(limit, 10),
      parseInt(offset, 10)
    );

    return c.json({
      sessions,
      total: sessions.length,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
    }) as any;
  } catch (error) {
    console.error("Error listing sessions:", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      500
    );
  }
});

/**
 * Get session detail endpoint
 */
const getSessionRoute = createRoute({
  method: "get",
  path: "/sessions/:sessionId",
  operationId: "getSession",
  tags: ["Sessions"],
  summary: "Get session details",
  description: "Get detailed information about a specific session including all questions and responses",
  request: {
    params: z.object({
      sessionId: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Session details",
      content: {
        "application/json": {
          schema: z.object({
            session: SessionSchema,
            questions: z.array(z.any()),
            action_logs: z.array(z.any()),
          }),
        },
      },
    },
    404: {
      description: "Session not found",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
    },
    500: {
      description: "Internal server error",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
    },
  },
});

app.openapi(getSessionRoute, async (c) => {
  try {
    const { sessionId } = c.req.param();
    const session = await getSession(c.env.DB, sessionId);

    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    const questions = await getSessionQuestions(c.env.DB, session.id);
    const actionLogs = await getSessionActionLogs(c.env.DB, session.id);

    return c.json({
      session,
      questions,
      action_logs: actionLogs,
    }) as any;
  } catch (error) {
    console.error("Error getting session:", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      500
    );
  }
});

/**
 * Download session data as JSON endpoint
 */
const downloadSessionRoute = createRoute({
  method: "get",
  path: "/sessions/:sessionId/download",
  operationId: "downloadSession",
  tags: ["Sessions"],
  summary: "Download session data as JSON",
  description: "Download all session data including questions, responses, and metadata as a JSON file",
  request: {
    params: z.object({
      sessionId: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Session data JSON",
      content: {
        "application/json": {
          schema: z.any(),
        },
      },
    },
    404: {
      description: "Session not found",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
    },
    500: {
      description: "Internal server error",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
    },
  },
});

app.openapi(downloadSessionRoute, async (c) => {
  try {
    const { sessionId } = c.req.param();
    const session = await getSession(c.env.DB, sessionId);

    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    const questions = await getSessionQuestions(c.env.DB, session.id);

    // Parse questions and responses
    const parsedQuestions = questions.map((q) => ({
      id: q.id,
      question: q.question,
      metadata: q.metaJson ? JSON.parse(q.metaJson) : null,
      response: JSON.parse(q.response),
      source: q.questionSource,
      created_at: q.createdAt,
    }));

    const downloadData = {
      session: {
        id: session.sessionId,
        title: session.title,
        endpoint_type: session.endpointType,
        repo_url: session.repoUrl,
        timestamp: session.timestamp,
      },
      questions: parsedQuestions,
      exported_at: new Date().toISOString(),
    };

    // Set headers for file download
    c.header("Content-Disposition", `attachment; filename="session-${sessionId}.json"`);
    return c.json(downloadData) as any;
  } catch (error) {
    console.error("Error downloading session:", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      500
    );
  }
});

export default app;
