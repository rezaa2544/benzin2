import type {
  MessageKind,
  NotificationChannel,
  NotificationKind,
  ReputationEventKind,
} from '@benzin/shared';
import type {
  Conversation,
  Message,
  NotificationRecord,
  ReputationEvent,
  TradeRating,
} from '../../../domain/entities.js';
import type {
  ConversationRepository,
  MessageRepository,
  NewMessage,
  NewNotification,
  NewReputationEvent,
  NewTradeRating,
  NotificationRepository,
  ReputationRepository,
} from '../../../ports.js';
import { query, queryOne, scalar, type Db } from './pg-common.js';

/** Chat, trust and notifications on Postgres (task G-01). */

type ConversationRow = { id: string; order_id: string; created_at: Date; closed_at: Date | null };

const CONVERSATION_COLUMNS = `id, order_id, created_at, closed_at`;

const toConversation = (row: ConversationRow): Conversation => ({
  id: row.id,
  orderId: row.order_id,
  createdAt: row.created_at,
  closedAt: row.closed_at,
});

export class PgConversationRepository implements ConversationRepository {
  constructor(private readonly db: Db) {}

  async findById(id: string): Promise<Conversation | null> {
    const row = await queryOne<ConversationRow>(
      this.db,
      `SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE id = $1`,
      [id],
    );
    return row ? toConversation(row) : null;
  }

  async findByOrder(orderId: string): Promise<Conversation | null> {
    const row = await queryOne<ConversationRow>(
      this.db,
      `SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE order_id = $1`,
      [orderId],
    );
    return row ? toConversation(row) : null;
  }

  /** One thread per order: the unique index `conversations_one_per_order` makes this idempotent. */
  async ensureForOrder(orderId: string, at: Date): Promise<Conversation> {
    const inserted = await queryOne<ConversationRow>(
      this.db,
      `INSERT INTO conversations (order_id, created_at) VALUES ($1, $2)
       ON CONFLICT (order_id) DO NOTHING RETURNING ${CONVERSATION_COLUMNS}`,
      [orderId, at],
    );
    if (inserted) return toConversation(inserted);
    const existing = await this.findByOrder(orderId);
    if (!existing) throw new Error(`conversation for order ${orderId} vanished`);
    return existing;
  }

  async close(id: string, at: Date): Promise<Conversation | null> {
    const row = await queryOne<ConversationRow>(
      this.db,
      `UPDATE conversations SET closed_at = $2 WHERE id = $1 AND closed_at IS NULL RETURNING ${CONVERSATION_COLUMNS}`,
      [id, at],
    );
    if (row) return toConversation(row);
    return this.findById(id);
  }

  async listByParticipant(userId: string, limit: number): Promise<Conversation[]> {
    const rows = await query<ConversationRow>(
      this.db,
      `SELECT c.id, c.order_id, c.created_at, c.closed_at
         FROM conversations c
         JOIN orders o ON o.id = c.order_id
        WHERE o.owner_id = $1
           OR EXISTS (SELECT 1 FROM reservations r WHERE r.order_id = c.order_id AND r.taker_id = $1)
        ORDER BY COALESCE((SELECT max(m.created_at) FROM messages m WHERE m.conversation_id = c.id), c.created_at) DESC
        LIMIT $2`,
      [userId, limit],
    );
    return rows.map(toConversation);
  }
}

type MessageRow = {
  id: string;
  conversation_id: string;
  sender_id: string;
  kind: MessageKind;
  body: string;
  client_message_id: string | null;
  read_at: Date | null;
  created_at: Date;
};

const MESSAGE_COLUMNS = `id, conversation_id, sender_id, kind, body, client_message_id, read_at, created_at`;

const toMessage = (row: MessageRow): Message => ({
  id: row.id,
  conversationId: row.conversation_id,
  senderId: row.sender_id,
  kind: row.kind,
  body: row.body,
  clientMessageId: row.client_message_id,
  readAt: row.read_at,
  createdAt: row.created_at,
});

export class PgMessageRepository implements MessageRepository {
  constructor(private readonly db: Db) {}

  /** Retries with the same `clientMessageId` are dropped by the unique index instead of doubling. */
  async append(input: NewMessage, at: Date): Promise<Message | null> {
    const row = await queryOne<MessageRow>(
      this.db,
      `INSERT INTO messages (conversation_id, sender_id, kind, body, client_message_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (conversation_id, client_message_id) DO NOTHING
       RETURNING ${MESSAGE_COLUMNS}`,
      [input.conversationId, input.senderId, input.kind, input.body, input.clientMessageId, at],
    );
    return row ? toMessage(row) : null;
  }

  async findByClientId(conversationId: string, clientMessageId: string): Promise<Message | null> {
    const row = await queryOne<MessageRow>(
      this.db,
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation_id = $1 AND client_message_id = $2`,
      [conversationId, clientMessageId],
    );
    return row ? toMessage(row) : null;
  }

  async listByConversation(
    conversationId: string,
    options: { after: Date | null; limit: number },
  ): Promise<Message[]> {
    // G-12 hardening: the cursor is inclusive (>=), not strict (>). Two messages can share a
    // millisecond, and a strictly-greater cursor silently drops the second one from every
    // incremental read. Clients merge by message id, so repeating the boundary row is safe.
    const rows = await query<MessageRow>(
      this.db,
      `SELECT ${MESSAGE_COLUMNS} FROM messages
        WHERE conversation_id = $1 AND ($2::timestamptz IS NULL OR created_at >= $2)
        ORDER BY created_at ASC LIMIT $3`,
      [conversationId, options.after, options.limit],
    );
    return rows.map(toMessage);
  }

  async lastMessage(conversationId: string): Promise<Message | null> {
    const row = await queryOne<MessageRow>(
      this.db,
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [conversationId],
    );
    return row ? toMessage(row) : null;
  }

  async markRead(conversationId: string, readerId: string, at: Date): Promise<number> {
    const rows = await query<{ id: string }>(
      this.db,
      `UPDATE messages SET read_at = $3
        WHERE conversation_id = $1 AND sender_id <> $2 AND read_at IS NULL RETURNING id`,
      [conversationId, readerId, at],
    );
    return rows.length;
  }

  async countUnread(conversationId: string, readerId: string): Promise<number> {
    return scalar(
      this.db,
      `SELECT count(*)::int AS value FROM messages
        WHERE conversation_id = $1 AND sender_id <> $2 AND read_at IS NULL`,
      [conversationId, readerId],
    );
  }
}

type ReputationRow = {
  id: string;
  user_id: string;
  kind: ReputationEventKind;
  delta: number;
  order_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
};

const REPUTATION_COLUMNS = `id, user_id, kind, delta, order_id, metadata, created_at`;

const toReputation = (row: ReputationRow): ReputationEvent => ({
  id: row.id,
  userId: row.user_id,
  kind: row.kind,
  delta: Number(row.delta),
  orderId: row.order_id,
  metadata: row.metadata,
  createdAt: row.created_at,
});

type RatingRow = {
  id: string;
  reservation_id: string;
  rater_id: string;
  subject_id: string;
  stars: number;
  comment: string | null;
  created_at: Date;
};

const RATING_COLUMNS = `id, reservation_id, rater_id, subject_id, stars, comment, created_at`;

const toRating = (row: RatingRow): TradeRating => ({
  id: row.id,
  reservationId: row.reservation_id,
  raterId: row.rater_id,
  subjectId: row.subject_id,
  stars: Number(row.stars),
  comment: row.comment,
  createdAt: row.created_at,
});

export class PgReputationRepository implements ReputationRepository {
  constructor(private readonly db: Db) {}

  async append(input: NewReputationEvent, at: Date): Promise<ReputationEvent> {
    const row = await queryOne<ReputationRow>(
      this.db,
      `INSERT INTO reputation_events (user_id, kind, delta, order_id, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING ${REPUTATION_COLUMNS}`,
      [
        input.userId,
        input.kind,
        input.delta,
        input.orderId,
        JSON.stringify(input.metadata ?? {}),
        at,
      ],
    );
    if (!row) throw new Error('reputation insert returned no row');
    return toReputation(row);
  }

  async listByUser(
    userId: string,
    options: { since: Date | null; limit: number },
  ): Promise<ReputationEvent[]> {
    const rows = await query<ReputationRow>(
      this.db,
      `SELECT ${REPUTATION_COLUMNS} FROM reputation_events
        WHERE user_id = $1 AND ($2::timestamptz IS NULL OR created_at >= $2)
        ORDER BY created_at DESC LIMIT $3`,
      [userId, options.since, options.limit],
    );
    return rows.map(toReputation);
  }

  async listRatingsFor(userId: string, limit: number): Promise<TradeRating[]> {
    const rows = await query<RatingRow>(
      this.db,
      `SELECT ${RATING_COLUMNS} FROM trade_ratings WHERE subject_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, limit],
    );
    return rows.map(toRating);
  }

  async findRating(reservationId: string, raterId: string): Promise<TradeRating | null> {
    const row = await queryOne<RatingRow>(
      this.db,
      `SELECT ${RATING_COLUMNS} FROM trade_ratings WHERE reservation_id = $1 AND rater_id = $2`,
      [reservationId, raterId],
    );
    return row ? toRating(row) : null;
  }

  async createRating(input: NewTradeRating, at: Date): Promise<TradeRating | null> {
    const row = await queryOne<RatingRow>(
      this.db,
      `INSERT INTO trade_ratings (reservation_id, rater_id, subject_id, stars, comment, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (reservation_id, rater_id) DO NOTHING
       RETURNING ${RATING_COLUMNS}`,
      [input.reservationId, input.raterId, input.subjectId, input.stars, input.comment, at],
    );
    return row ? toRating(row) : null;
  }
}

type NotificationRow = {
  id: string;
  user_id: string;
  channel: NotificationChannel;
  kind: NotificationKind;
  title_fa: string;
  body_fa: string;
  payload: Record<string, unknown>;
  read_at: Date | null;
  sent_at: Date | null;
  created_at: Date;
};

const NOTIFICATION_COLUMNS = `id, user_id, channel, kind, title_fa, body_fa, payload, read_at, sent_at, created_at`;

const toNotification = (row: NotificationRow): NotificationRecord => ({
  id: row.id,
  userId: row.user_id,
  channel: row.channel,
  kind: row.kind,
  titleFa: row.title_fa,
  bodyFa: row.body_fa,
  payload: row.payload,
  readAt: row.read_at,
  sentAt: row.sent_at,
  createdAt: row.created_at,
});

export class PgNotificationRepository implements NotificationRepository {
  constructor(private readonly db: Db) {}

  async create(input: NewNotification, at: Date): Promise<NotificationRecord> {
    const row = await queryOne<NotificationRow>(
      this.db,
      `INSERT INTO notifications (user_id, channel, kind, title_fa, body_fa, payload, sent_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8) RETURNING ${NOTIFICATION_COLUMNS}`,
      [
        input.userId,
        input.channel,
        input.kind,
        input.titleFa,
        input.bodyFa,
        JSON.stringify(input.payload ?? {}),
        input.sentAt,
        at,
      ],
    );
    if (!row) throw new Error('notification insert returned no row');
    return toNotification(row);
  }

  async findById(id: string): Promise<NotificationRecord | null> {
    const row = await queryOne<NotificationRow>(
      this.db,
      `SELECT ${NOTIFICATION_COLUMNS} FROM notifications WHERE id = $1`,
      [id],
    );
    return row ? toNotification(row) : null;
  }

  async listByUser(
    userId: string,
    options: { limit: number; unreadOnly: boolean },
  ): Promise<NotificationRecord[]> {
    const rows = await query<NotificationRow>(
      this.db,
      `SELECT ${NOTIFICATION_COLUMNS} FROM notifications
        WHERE user_id = $1 AND ($2::boolean = false OR read_at IS NULL)
        ORDER BY created_at DESC LIMIT $3`,
      [userId, options.unreadOnly, options.limit],
    );
    return rows.map(toNotification);
  }

  async countUnread(userId: string): Promise<number> {
    return scalar(
      this.db,
      `SELECT count(*)::int AS value FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
      [userId],
    );
  }

  async markRead(id: string, userId: string, at: Date): Promise<NotificationRecord | null> {
    const row = await queryOne<NotificationRow>(
      this.db,
      `UPDATE notifications SET read_at = $3 WHERE id = $1 AND user_id = $2 AND read_at IS NULL
       RETURNING ${NOTIFICATION_COLUMNS}`,
      [id, userId, at],
    );
    if (row) return toNotification(row);
    return this.findById(id);
  }

  async markAllRead(userId: string, at: Date): Promise<number> {
    const rows = await query<{ id: string }>(
      this.db,
      `UPDATE notifications SET read_at = $2 WHERE user_id = $1 AND read_at IS NULL RETURNING id`,
      [userId, at],
    );
    return rows.length;
  }
}
