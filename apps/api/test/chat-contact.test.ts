import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auth,
  buyPlan,
  createTestContext,
  startTrade,
  type TestContext,
  type TradeSetup,
} from './helpers.js';

const json = <T>(response: { json: () => unknown }): T => response.json() as T;

const post = (ctx: TestContext, trade: TradeSetup, token: string, body: string) =>
  ctx.app.inject({
    method: 'POST',
    url: `/v1/conversations/${trade.conversationId}/messages`,
    headers: auth(token),
    payload: { body },
  });

describe('chat contact sharing', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('masks phone numbers while the owner has not accepted yet', async () => {
    const trade = await startTrade(ctx, { confirm: false });

    const response = await post(ctx, trade, trade.taker.token, 'شماره من 09121234567 است');
    expect(response.statusCode).toBe(201);
    const message = json<{ body: string; contactMasked: boolean }>(response);
    expect(message.contactMasked).toBe(true);
    expect(message.body).not.toContain('09121234567');
    expect(message.body).toContain('۰۹۱۲');
    expect(message.body).toContain('۶۷');
    expect(message.body).toMatch(/•+/);

    // The raw number is nowhere in the stored thread, so the owner cannot read it.
    const listed = await ctx.app.inject({
      method: 'GET',
      url: `/v1/conversations/${trade.conversationId}/messages`,
      headers: auth(trade.owner.token),
    });
    expect(listed.body).not.toContain('09121234567');
    expect(listed.body).not.toContain('۰۹۱۲۱۲۳۴۵۶۷');

    const audit = await ctx.repos.audit.list(20);
    const entry = audit.find((row) => row.action === 'chat.message_sent');
    expect(entry?.metadata.contactMasked).toBe(1);
  });

  it('masks country codes, separators and Persian digits too', async () => {
    const trade = await startTrade(ctx, { confirm: false });

    for (const raw of ['+98 912 123 4567', '0098-912-123-4567', '۰۹۱۲۱۲۳۴۵۶۷', '912 123 4567']) {
      const response = await post(ctx, trade, trade.taker.token, `تماس: ${raw}`);
      expect(response.statusCode).toBe(201);
      const message = json<{ body: string; contactMasked: boolean }>(response);
      expect(message.contactMasked).toBe(true);
      expect(message.body).not.toMatch(/[\d۰-۹]{7,}/);
    }
  });

  it('keeps masking after confirmation when the reader has no plan (G-27)', async () => {
    // Before G-27 the acceptance alone unlocked digits, so a free buyer could ask the seller to
    // type the number and skip the subscription the plans page sells.
    const trade = await startTrade(ctx);

    const response = await post(ctx, trade, trade.taker.token, 'شماره من 09121234567 است');
    expect(response.statusCode).toBe(201);
    const message = json<{ body: string; contactMasked: boolean }>(response);
    expect(message.contactMasked).toBe(true);
    expect(message.body).not.toContain('09121234567');

    const listed = await ctx.app.inject({
      method: 'GET',
      url: `/v1/conversations/${trade.conversationId}/messages`,
      headers: auth(trade.owner.token),
    });
    expect(listed.body).not.toContain('09121234567');
  });

  it('shows the digits once the reader has a plan (G-27)', async () => {
    const trade = await startTrade(ctx);
    // The owner reads the taker's message, so the owner's plan is the one that has to include
    // numbers — the same rule the contact card applies.
    await buyPlan(ctx, trade.owner.userId, 'monthly');

    const response = await post(ctx, trade, trade.taker.token, 'شماره من 09121234567 است');
    expect(response.statusCode).toBe(201);
    const message = json<{ body: string; contactMasked: boolean }>(response);
    expect(message.contactMasked).toBe(false);
    expect(message.body).toBe('شماره من 09121234567 است');
  });

  it('still masks before acceptance even when the reader pays (G-27)', async () => {
    const trade = await startTrade(ctx, { confirm: false });
    await buyPlan(ctx, trade.owner.userId, 'monthly');

    const response = await post(ctx, trade, trade.taker.token, 'شماره من 09121234567 است');
    expect(response.statusCode).toBe(201);
    const message = json<{ body: string; contactMasked: boolean }>(response);
    expect(message.contactMasked).toBe(true);
    expect(message.body).not.toContain('09121234567');
  });

  it('refuses a contact card before the owner accepts', async () => {
    const trade = await startTrade(ctx, { confirm: false });

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/v1/conversations/${trade.conversationId}/contact`,
      headers: auth(trade.taker.token),
    });
    expect(response.statusCode).toBe(409);
    const error = json<{ error: { code: string; details: { orderStatus: string } } }>(
      response,
    ).error;
    expect(error.code).toBe('CONTACT_SHARING_BLOCKED');
    expect(error.details.orderStatus).toBe('RESERVED');
  });

  it('sends a contact card with the sender phone number to a paying reader', async () => {
    const trade = await startTrade(ctx);
    // The owner receives the card, so the owner is the reader who has to have the plan.
    await buyPlan(ctx, trade.owner.userId, 'monthly');

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/v1/conversations/${trade.conversationId}/contact`,
      headers: auth(trade.taker.token),
    });
    expect(response.statusCode).toBe(201);
    const card = json<{ kind: string; body: string; senderId: string }>(response);
    expect(card.kind).toBe('CONTACT');
    expect(card.body).toBe(trade.taker.phone);
    expect(card.senderId).toBe(trade.taker.userId);

    // The peer is told a number arrived, without the number itself in the notification.
    const inbox = await ctx.app.inject({
      method: 'GET',
      url: '/v1/notifications',
      headers: auth(trade.owner.token),
    });
    const items = json<{ items: { kind: string; bodyFa: string }[] }>(inbox).items;
    const shared = items.find((item) => item.kind === 'CONTACT_SHARED');
    expect(shared).toBeTruthy();
    expect(shared?.bodyFa).toContain('شماره تماس');
    expect(shared?.bodyFa).not.toContain(trade.taker.phone);
  });

  it('refuses a contact card when the reader has no plan (G-27)', async () => {
    const trade = await startTrade(ctx);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/v1/conversations/${trade.conversationId}/contact`,
      headers: auth(trade.taker.token),
    });
    expect(response.statusCode).toBe(402);
    const error = json<{ error: { code: string; details: { chatOnly: boolean; reason: string } } }>(
      response,
    ).error;
    expect(error.code).toBe('PHONE_REQUIRES_SUBSCRIPTION');
    expect(error.details.chatOnly).toBe(true);
    expect(error.details.reason).toBe('SUBSCRIPTION_REQUIRED');

    // Nothing was written: the raw number is not sitting in the thread for later.
    const listed = await ctx.app.inject({
      method: 'GET',
      url: `/v1/conversations/${trade.conversationId}/messages`,
      headers: auth(trade.owner.token),
    });
    expect(listed.body).not.toContain(trade.taker.phone);
  });

  it('blocks a stranger from sharing a contact card', async () => {
    const trade = await startTrade(ctx);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/v1/conversations/${trade.conversationId}/contact`,
      headers: auth('not-a-real-token'),
    });
    expect(response.statusCode).toBe(401);

    const third = await startTrade(ctx);
    const crossThread = await ctx.app.inject({
      method: 'POST',
      url: `/v1/conversations/${trade.conversationId}/contact`,
      headers: auth(third.taker.token),
    });
    expect(crossThread.statusCode).toBe(403);
    expect(json<{ error: { code: string } }>(crossThread).error.code).toBe(
      'NOT_CONVERSATION_PARTY',
    );
  });
});
