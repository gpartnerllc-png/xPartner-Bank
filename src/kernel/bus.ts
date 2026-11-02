import type { Db } from './db.ts';
import { nowIso } from './db.ts';
import { newId } from './ids.ts';
import { log } from './logger.ts';

export interface Envelope<T = Record<string, unknown>> {
  id: string;
  topic: string;
  type: string;
  key?: string;
  payload: T;
  occurredAt: string;
}

export type EventHandler = (envelope: Envelope) => Promise<void> | void;

export interface EventBus {
  publish(envelope: Envelope): Promise<void>;
  subscribe(topic: string, group: string, handler: EventHandler): void;
}

interface Subscription {
  group: string;
  handler: EventHandler;
}

export class MemoryEventBus implements EventBus {
  private subscriptions = new Map<string, Subscription[]>();

  subscribe(topic: string, group: string, handler: EventHandler): void {
    const list = this.subscriptions.get(topic) ?? [];
    list.push({ group, handler });
    this.subscriptions.set(topic, list);
  }

  async publish(envelope: Envelope): Promise<void> {
    const handlers = this.subscriptions.get(envelope.topic) ?? [];
    for (const subscription of handlers) {
      try {
        await subscription.handler(envelope);
      } catch (error) {
        log.error('event.consumer_failed', {
          topic: envelope.topic,
          group: subscription.group,
          eventId: envelope.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

export interface OutboxEventInput {
  topic: string;
  type: string;
  key?: string;
  payload: unknown;
  headers?: Record<string, string>;
}

/** Grava o evento na mesma transação SQL do fato de negócio (padrão transactional outbox). */
export function enqueueEvent(db: Db, input: OutboxEventInput): string {
  const id = newId('evt');
  db.prepare(
    `INSERT INTO outbox (id, topic, event_type, partition_key, payload, headers, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.topic,
    input.type,
    input.key ?? null,
    JSON.stringify(input.payload),
    input.headers ? JSON.stringify(input.headers) : null,
    nowIso(),
  );
  return id;
}

export function alreadyProcessed(db: Db, group: string, eventId: string): boolean {
  const row = db
    .prepare('SELECT 1 AS found FROM processed_events WHERE group_id = ? AND event_id = ?')
    .get(group, eventId);
  return Boolean(row);
}

export function markProcessed(db: Db, group: string, eventId: string): void {
  db.prepare('INSERT OR IGNORE INTO processed_events (group_id, event_id, processed_at) VALUES (?, ?, ?)').run(
    group,
    eventId,
    nowIso(),
  );
}

export class OutboxRelay {
  private timer: NodeJS.Timeout | undefined;
  private draining = false;
  private readonly db: Db;
  private readonly bus: EventBus;
  private readonly intervalMs: number;
  private readonly maxAttempts: number;

  constructor(db: Db, bus: EventBus, intervalMs = 50, maxAttempts = 20) {
    this.db = db;
    this.bus = bus;
    this.intervalMs = intervalMs;
    this.maxAttempts = maxAttempts;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.drain().catch((error) => {
        log.error('outbox.drain_failed', { error: error instanceof Error ? error.message : String(error) });
      });
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async drain(limit = 100): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    let published = 0;
    try {
      const rows = this.db
        .prepare(
          `SELECT id, topic, event_type, partition_key, payload, created_at AS occurredAt, attempts
           FROM outbox WHERE published_at IS NULL ORDER BY created_at ASC LIMIT ?`,
        )
        .all(limit) as Array<{
        id: string;
        topic: string;
        event_type: string;
        partition_key: string | null;
        payload: string;
        occurredAt: string;
        attempts: number;
      }>;

      for (const row of rows) {
        const envelope: Envelope = {
          id: row.id,
          topic: row.topic,
          type: row.event_type,
          key: row.partition_key ?? undefined,
          payload: JSON.parse(row.payload) as Record<string, unknown>,
          occurredAt: row.occurredAt,
        };
        try {
          await this.bus.publish(envelope);
          this.db.prepare('UPDATE outbox SET published_at = ?, attempts = attempts + 1 WHERE id = ?').run(
            nowIso(),
            row.id,
          );
          published += 1;
        } catch (error) {
          const attempts = row.attempts + 1;
          const message = error instanceof Error ? error.message : String(error);
          this.db
            .prepare('UPDATE outbox SET attempts = ?, last_error = ? WHERE id = ?')
            .run(attempts, message, row.id);
          if (attempts >= this.maxAttempts) {
            this.db.prepare('INSERT OR REPLACE INTO dead_letters (id, topic, payload, error, created_at) VALUES (?, ?, ?, ?, ?)').run(
              newId('dlq'),
              row.topic,
              row.payload,
              message,
              nowIso(),
            );
            this.db.prepare('UPDATE outbox SET published_at = ? WHERE id = ?').run(nowIso(), row.id);
            log.error('outbox.dead_letter', { topic: row.topic, id: row.id, error: message });
          }
          log.warn('outbox.publish_failed', { id: row.id, attempts, error: message });
        }
      }
    } finally {
      this.draining = false;
    }
    return published;
  }

  pendingCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM outbox WHERE published_at IS NULL').get() as {
      count: number;
    };
    return row.count;
  }
}
