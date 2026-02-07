# DB indexes

This project uses Postgres (via Prisma). This doc tracks the "hot-path" indexes we maintain for list views and message/notification feeds.

## Why these indexes exist

Most UI feeds and admin/moderation views are variations of:

- "List items for a user" ordered by `createdAt` (often with pagination)
- "Filter by status" ordered by `createdAt`
- "Fetch children for a parent" ordered by `createdAt` (e.g. messages for a job)

Without a matching composite index, Postgres will often fall back to a sequential scan or a less selective index + sort, which gets expensive as tables grow.

## Current hot-path indexes

Indexes live in [prisma/schema.prisma](../prisma/schema.prisma).

### Job

- `@@index([consumerId, createdAt])`
  - Supports: consumer job lists like `WHERE consumerId = ? ORDER BY createdAt DESC`
- `@@index([status, createdAt])`
  - Supports: status-based feeds like `WHERE status IN (...) ORDER BY createdAt DESC`

### Bid

- `@@index([jobId, createdAt])`
  - Supports: job bid list like `WHERE jobId = ? ORDER BY createdAt DESC`
- `@@index([providerId, createdAt])`
  - Supports: provider bid list like `WHERE providerId = ? ORDER BY createdAt DESC`

### Message

- `@@index([jobId, createdAt])`
  - Supports: job thread message list like `WHERE jobId = ? ORDER BY createdAt ASC|DESC`
- `@@index([senderId, createdAt])`
  - Supports: sender-based lists/moderation like `WHERE senderId = ? ORDER BY createdAt DESC`

### Notification

- `@@index([userId, createdAt])`
  - Supports: user notification list like `WHERE userId = ? ORDER BY createdAt DESC`
- `@@index([userId, read, createdAt])`
  - Supports: unread/read filters like `WHERE userId = ? AND read = false ORDER BY createdAt DESC`
- `@@index([userId, readAt])`
  - Supports: time-based read queries like `WHERE userId = ? AND readAt IS NOT NULL ORDER BY readAt DESC`

Note: `Notification` keeps `read: Boolean` for compatibility, but also tracks `readAt` (nullable) for auditability and time-based queries.

## How to validate

When tuning a specific endpoint, confirm the query shape matches the index prefix.

In Postgres, use `EXPLAIN (ANALYZE, BUFFERS)` and look for an `Index Scan` / `Bitmap Index Scan` using the expected index.

Examples (illustrative):

- Job list: `WHERE consumerId = $1 ORDER BY createdAt DESC LIMIT $2`
- Messages: `WHERE jobId = $1 ORDER BY createdAt ASC LIMIT $2`
- Unread notifications: `WHERE userId = $1 AND read = false ORDER BY createdAt DESC LIMIT $2`
