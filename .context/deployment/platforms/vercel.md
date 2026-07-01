# Vercel Deployment Guide

**Platform:** Vercel
**Best For:** Fastest deployment, zero configuration, automatic preview deployments
**Estimated Setup Time:** 5-10 minutes

## Prerequisites

- Vercel account ([vercel.com](https://vercel.com))
- GitHub, GitLab, or Bitbucket repository with your Sunrise project
- PostgreSQL database (Vercel Postgres or external provider)

## Deployment Steps

### 1. Import Project

1. Go to [vercel.com/new](https://vercel.com/new)
2. Click "Import Git Repository"
3. Select your Sunrise repository
4. Vercel auto-detects Next.js and configures everything

### 2. Configure Environment Variables

In Vercel dashboard > Project Settings > Environment Variables, add:

**Required:**

```
DATABASE_URL=postgresql://user:password@host:5432/dbname
BETTER_AUTH_SECRET=<generate with: openssl rand -base64 32>
BETTER_AUTH_URL=https://your-project.vercel.app
NEXT_PUBLIC_APP_URL=https://your-project.vercel.app
CRON_SECRET=<generate with: openssl rand -base64 32>   # drives the maintenance cron (see Background jobs)
```

> **`DATABASE_URL` must be a POOLED endpoint on serverless** (Neon `-pooler` host, Supabase `:6543` transaction pooler, or Vercel's `POSTGRES_PRISMA_URL`). A direct `:5432` connection exhausts under serverless fan-out. See [Database Setup](#3-database-setup).

**Optional (for email):**

```
RESEND_API_KEY=re_...
EMAIL_FROM=noreply@yourdomain.com
```

**Optional (for OAuth):**

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

**Optional (for file uploads):**

```
STORAGE_PROVIDER=vercel-blob  # Options: s3, vercel-blob, local
# See .env.example for full S3/Vercel Blob configuration
```

### 3. Database Setup

**Option A: Vercel Postgres (Recommended)**

1. In Vercel dashboard, go to Storage
2. Create a new Postgres database
3. Connect to your project
4. Environment variables are auto-populated

**Option B: External Database (Supabase, Neon, Railway)**

1. Create database on your provider
2. Copy the **pooled** connection string to `DATABASE_URL` (Neon `-pooler` host, Supabase transaction
   pooler on `:6543` with `?pgbouncer=true`) — serverless fans out across many instances, so a direct
   `:5432` connection exhausts the DB. `lib/db/client.ts` uses `max: 1` per instance in production
   (override with `DATABASE_POOL_MAX`), which relies on a transaction pooler in front.
3. Ensure SSL is enabled for production (`?sslmode=require`)

See [`.context/environment/database-env.md`](../../environment/database-env.md#connection-pooling-serverless-vs-long-running) for the full pooling rationale.

### 4. Configure Migrations

In Vercel dashboard > Project Settings > General > **Build Command**, override the default with:

```
npm run build && npm run db:migrate:deploy
```

This runs `prisma migrate deploy` after `next build` succeeds but before the deployment is promoted — so the DB schema is always ahead of (or equal to) the code serving traffic. Write backward-compatible migrations so a partial failure between build and promotion is safe.

**Why not `postbuild`?** `postbuild` fires inside `npm run build`, which also runs in CI and Docker builds — neither has a real production `DATABASE_URL`. Using Vercel's build command keeps the migration scoped to actual deployments.

### 5. Deploy

Push to your connected branch (usually `main`):

```bash
git push origin main
```

Vercel automatically builds and deploys.

## Vercel-Specific Configuration

### Build Settings (Auto-Detected)

- **Framework Preset:** Next.js
- **Build Command:** `npm run build`
- **Output Directory:** `.next`
- **Install Command:** `npm install`

### Function Configuration (vercel.json)

ConQuest ships a `vercel.json` in the project root (Sunrise's own starter does not — Vercel auto-detects Next.js otherwise). It is required here for the **maintenance cron** (see below) and the report `maxDuration`.

See [Vercel Project Configuration](https://vercel.com/docs/projects/project-configuration) for the full schema reference.

```jsonc
{
  "crons": [{ "path": "/api/v1/cron/maintenance", "schedule": "* * * * *" }],
  "functions": {
    "app/api/v1/cron/maintenance/route.ts": { "maxDuration": 300 },
    "app/api/v1/app/questionnaire-sessions/[id]/submit/route.ts": { "maxDuration": 60 },
  },
}
```

### Background jobs — maintenance cron (REQUIRED)

Async work (queued respondent reports, evaluation runs, scheduled workflows, webhook/hook retries, retention, embedding backfill) is drained by a maintenance tick. On serverless there is **no persistent process** to run it (`instrumentation.ts`'s in-process ticker is dev-only) — so **without a cron, none of it ever runs** and, e.g., respondent reports stay stuck "taking a little longer than usual" forever.

1. Set `CRON_SECRET` in the Vercel dashboard (Environment Variables). Vercel auto-attaches it as `Authorization: Bearer $CRON_SECRET` to cron requests; the endpoint fails closed (`503`) if it is unset.
2. The `crons` block above calls `GET /api/v1/cron/maintenance` every minute. That endpoint runs the tick in **awaited** mode so the work completes within the invocation (unlike the admin tick, which returns 202 and would be frozen mid-chain on serverless).

**Plan tier:** per-minute cron + `maxDuration > 60s` require **Vercel Pro**. On **Hobby**, cron is daily-only and `maxDuration` caps at 60s → drive it with an external cron instead (GitHub Actions scheduled workflow or cron-job.org) hitting the same URL with the bearer header, and lower the `maxDuration` values to 60.

See [`.context/orchestration/scheduling.md`](../../orchestration/scheduling.md) for the tick internals.

### Preview Deployments

Every pull request gets a unique preview URL automatically.

### Health Monitoring

Vercel handles infrastructure health monitoring automatically. The `/api/health` endpoint can be used with external monitoring services (UptimeRobot, Pingdom, Better Uptime) for application-level health checks and alerting.

## Verifying Deployment

1. Check deployment status in Vercel dashboard
2. Visit `https://your-project.vercel.app/api/health`
3. Expected response:
   ```json
   {
     "status": "ok",
     "version": "1.0.0",
     "services": {
       "database": { "status": "operational", "connected": true }
     }
   }
   ```
   **Note:** `services.database.status` is `operational`, `degraded`, or `outage`. Returns HTTP 503 on database failure.

## Common Issues

### Database Connection Fails

- Ensure `DATABASE_URL` uses SSL (`?sslmode=require`)
- Verify database allows connections from Vercel IPs
- Check connection string format

### Build Timeout

- Free tier has 45s timeout; Pro has 5 minutes
- Optimize build by ensuring `output: 'standalone'` in `next.config.js`
- Check for slow dependencies

### Environment Variables Not Loading

- `NEXT_PUBLIC_*` vars are embedded at build time - redeploy after changes
- Verify variables are set for correct environment (Production/Preview/Development)

### Migrations Not Running

- Verify Build Command in Vercel is `npm run build && npm run db:migrate:deploy`
- Or run manually: `vercel env pull .env.local && npx prisma migrate deploy`

## Cost Considerations

| Tier   | Price     | Includes                           |
| ------ | --------- | ---------------------------------- |
| Hobby  | Free      | Personal projects, 100GB bandwidth |
| Pro    | $20/month | Team features, 1TB bandwidth       |
| Vercel | Custom    | Postgres from $0.10/GB             |

## Related Documentation

- [Vercel Next.js Docs](https://vercel.com/docs/frameworks/nextjs)
- [Vercel Postgres](https://vercel.com/docs/storage/vercel-postgres)
- [Environment Variables](https://vercel.com/docs/environment-variables)
