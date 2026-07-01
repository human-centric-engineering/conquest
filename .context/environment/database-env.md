# Database Environment Variables

Configuration for PostgreSQL database connection via Prisma ORM.

## `DATABASE_URL`

- **Purpose:** PostgreSQL database connection string for Prisma ORM
- **Required:** ✅ Yes
- **Type:** URL (PostgreSQL format)
- **Format:** `postgresql://[user]:[password]@[host]:[port]/[database]?[params]`
- **Validation:** Must be a valid PostgreSQL connection string URL
- **Used By:**
  - `lib/db/client.ts` - Prisma client initialization
  - `prisma/schema/` - Database migrations

## Examples

### Local Development

```bash
DATABASE_URL="postgresql://postgres:password@localhost:5432/sunrise_db"
```

### Docker Compose

Use the service name instead of localhost:

```bash
DATABASE_URL="postgresql://postgres:password@db:5432/sunrise_db"
```

### Production (with SSL)

```bash
DATABASE_URL="postgresql://user:pass@prod-db.example.com:5432/sunrise?sslmode=require"
```

## Common Parameters

| Parameter             | Description             | When to Use              |
| --------------------- | ----------------------- | ------------------------ |
| `sslmode=require`     | Enforce SSL connection  | Production (recommended) |
| `sslmode=disable`     | Disable SSL             | Local development only   |
| `schema=public`       | Use specific schema     | Multi-tenant setups      |
| `connection_limit=10` | Max connections in pool | High-traffic apps        |

## Environment-Specific Values

| Environment | Host                | SSL | Example                                                              |
| ----------- | ------------------- | --- | -------------------------------------------------------------------- |
| Local       | `localhost`         | No  | `postgresql://postgres:pass@localhost:5432/sunrise`                  |
| Docker      | `db` (service name) | No  | `postgresql://postgres:pass@db:5432/sunrise`                         |
| Production  | Cloud hostname      | Yes | `postgresql://user:pass@db.example.com:5432/sunrise?sslmode=require` |

## Connection pooling (serverless vs long-running)

`lib/db/client.ts` builds a `pg` `Pool` per process. The per-instance pool size is:

```
DATABASE_POOL_MAX ?? (production ? 1 : 10)
```

- **Serverless (Vercel):** each warm instance holds its own pool and many instances run at once, so
  an unbounded `max` × N instances exhausts Postgres. The safe default is **`max: 1` per instance
  behind a transaction pooler** — point `DATABASE_URL` at the **pooled** endpoint:
  - Neon: the `-pooler` host (e.g. `ep-xxx-pooler.<region>.aws.neon.tech`, `?sslmode=require`)
  - Supabase: the transaction pooler on port **6543** (`...pooler.supabase.com:6543?pgbouncer=true`)
  - Vercel Postgres: `POSTGRES_PRISMA_URL` (already pooled, `?pgbouncer=true`)
    A bare `:5432` direct connection with `max: 1` throttles throughput and still risks exhaustion —
    use the pooled endpoint.
- **Long-running server (Docker/Render/Railway):** one persistent process — raise the pool with
  `DATABASE_POOL_MAX` (e.g. `10`) against a direct connection.

### `DATABASE_POOL_MAX` (optional)

- **Type:** positive integer
- **Default:** `1` in production, `10` in development
- **Used by:** `lib/db/client.ts` (`new Pool({ max })`)
- Set it to override the per-instance pool size in either environment.

## Troubleshooting

**Connection fails:**

- Ensure PostgreSQL is running: `pg_isready`
- Test connection: `psql $DATABASE_URL`
- Verify database exists: `psql -l`
- Check firewall rules if connecting to remote database

**"SSL required" error:**

- Add `?sslmode=require` to connection string
- Or for local dev: `?sslmode=disable`

**Docker connection fails:**

- Use service name (`db`) not `localhost`
- Ensure database service is running: `docker-compose ps`

## Related Documentation

- [Environment Overview](./overview.md) - Quick setup guide
- [Environment Reference](./reference.md) - All environment variables
- [Database Schema](../database/schema.md) - Prisma schema and migrations
