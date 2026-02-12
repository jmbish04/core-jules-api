import { DurableObject } from 'cloudflare:workers';
import { Env } from './types';
import { CodingAgent } from './agents/CodingAgent';

export class SessionActor extends DurableObject {
  env: Env;
  agent: CodingAgent | undefined;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const { prompt } = await request.json();

    if (!this.agent) {
      this.agent = new CodingAgent(this.ctx.storage, this.env);
      await this.agent.init();
    }

    const toolCallResult = await this.agent.server.tools['search'].handler({ query: prompt });
    const optimizedPrompt = JSON.stringify(toolCallResult.content);

    const localSessionId = crypto.randomUUID();

    await this.env.DB.prepare(
      'INSERT INTO sessions (id, prompt, status) VALUES (?, ?, ?)'
    )
      .bind(localSessionId, prompt, 'pending')
      .run();

    await this.env.JULES_QUEUE.send({
      type: 'CREATE_SESSION',
      sessionId: localSessionId,
      prompt: optimizedPrompt,
      meta: {
        source: 'agent',
        timestamp: new Date().toISOString(),
      },
    });

    return new Response(JSON.stringify({ sessionId: localSessionId }));
  }
}
