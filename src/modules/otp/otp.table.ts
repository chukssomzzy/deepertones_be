import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const otpChallenges = sqliteTable(
  'otp_challenges',
  {
    id: text('id').primaryKey(),
    channel: text('channel', { enum: ['whatsapp', 'email'] }).notNull(),
    address: text('address').notNull(),
    codeHash: text('code_hash').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    consumedAt: integer('consumed_at', { mode: 'timestamp_ms' }),
    deliveryStatus: text('delivery_status', { enum: ['queued', 'delivered', 'failed'] })
      .notNull()
      .default('queued'),
    failureReason: text('failure_reason', { enum: ['recipient-rejected', 'unavailable'] }),
    deliveredAt: integer('delivered_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('otp_challenges_recipient_created_at_idx').on(t.channel, t.address, t.createdAt)],
)
