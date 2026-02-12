/**
 * @file src/routes/webhook-handler.ts
 * @description Webhook handler for GitHub webhooks (stub implementation)
 * @owner AI-Builder
 */

import { Hono } from 'hono'

const app = new Hono()

export const webhookHandler = app.post('/webhook', async (c) => {
  // Stub implementation - GitHub webhook signature verification would go here
  const body = await c.req.json()

  console.log('Received webhook:', body)

  return c.json({ status: 'ok', message: 'Webhook received' })
})
