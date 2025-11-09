// src/utils/julesApi.ts
import { Env } from '../types';

export const julesApi = {
  async createSession(env: Env, prompt: string) {
    const res = await fetch(`${JULES_API_BASE_URL}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': env.JULES_API_KEY,
      },
      body: JSON.stringify({
        prompt,
        automationMode: 'AUTO_CREATE_PR',
        title: prompt.slice(0, 40),
      }),
    });
    if (!res.ok) throw new Error(`Jules API error ${res.status}`);
    return await res.json();
  },

  async sendMessage(env: Env, sessionId: string, prompt: string) {
    const url = `https://jules.googleapis.com/v1alpha/sessions/${sessionId}:sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': env.JULES_API_KEY,
      },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) throw new Error(`SendMessage failed: ${res.status}`);
    return await res.json();
  },

  async approvePlan(env: Env, sessionId: string) {
    const url = `https://jules.googleapis.com/v1alpha/sessions/${sessionId}:approvePlan`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Goog-Api-Key': env.JULES_API_KEY,
      },
    });
    if (!res.ok) throw new Error(`ApprovePlan failed: ${res.status}`);
    return await res.json();
  },

  async getSession(env: Env, sessionId: string) {
    const url = `https://jules.googleapis.com/v1alpha/sessions/${sessionId}`;
    const res = await fetch(url, {
      headers: {
        'X-Goog-Api-Key': env.JULES_API_KEY,
      },
    });
    if (!res.ok) throw new Error(`GetSession failed: ${res.status}`);
    return await res.json();
  },
};
