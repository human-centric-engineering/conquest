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
DATABASE_POOL_MAX=1
BETTER_AUTH_SECRET=<generate with: openssl rand -base64 32>
BETTER_AUTH_URL=https://your-project.vercel.app
NEXT_PUBLIC_APP_URL=https://your-project.vercel.app
CRON_SECRET=<generate with: openssl rand -base64 32>   # drives the maintenance cron (see Background jobs)
```

`DATABASE_POOL_MAX=1` is not optional on Vercel in practice. It defaults to 10,
which is right for one long-running server but wrong here: every warm function
instance holds its own pool, so a few dozen instances exhaust the database's
connection limit. Set it to 1 **and** point `DATABASE_URL` at a pooled endpoint
(see Database Setup below) — the pooler multiplexes, so one connection per
instance is plenty. See
[database-env.md](../../environment/database-env.md#database_pool_max).

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
2. Copy the **pooled** connection string to `DATABASE_URL` — Neon's `-pooler`
   host, Supabase's port `:6543`, or your own PgBouncer in transaction mode.
   The direct endpoint will run out of connections under load.
3. Ensure SSL is enabled for production

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

### Node.js Version (handled by `engines`, no dashboard change needed)

Vercel is the one deployment target that does not build from this repo's
`Dockerfile`, so it never sees `node:24-alpine` and does not read `.nvmrc`.

It does read `engines.node`, and that **overrides** the dashboard:

> "You can define the major Node.js version in the `engines#node` section of the
> `package.json` to override the one you have selected in the Project Settings"
> — [Vercel: supported Node.js versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)

`package.json` declares `>=24`, which Vercel resolves to the **latest 24.x**.
So a project whose dashboard still says 20.x deploys on 24 anyway, and there is
nothing to change after syncing this repo.

The corollary is the part worth knowing: **the dashboard value is not the truth
on this platform.** Pinning 20.x under Settings → Build and Deployment →
Node.js Version will not give you 20.x while `engines.node` says `>=24` — it
will quietly keep deploying 24, and the setting will read back as though it took
effect. If you genuinely need a different major, change `engines.node`; the
version-consistency check (`npm run check:node-version`) will then require the
Dockerfiles, `.nvmrc` and the `@types/node` devDependency to move with it — five
declarations in four files, all of which must agree. `@types/node` is in that
set because it is what `tsc` type-checks against: ahead of the runtime it
accepts APIs that throw in production and reports nothing (#584). Moving it also
means updating its Dependabot `ignore` entry.

To confirm what a deployment actually ran, log `process.version` or run
`node -v` in the build command.

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
- Check for slow dependencies
- **Do not enable `output: 'standalone'` for Vercel.** Vercel builds its own
  serverless output and does not use it; `next.config.js` deliberately switches
  it off when `process.env.VERCEL` is set (see below)

### Build Fails With `ENOENT: .next/next-server.js.nft.json`

Caused by `output: 'standalone'` being active on Vercel. From Next 16.3.0,
Turbopack stops emitting `next-server.js.nft.json` when a deployment adapter is
driving the build, on the grounds that adapters do not read it
([vercel/next.js#93684](https://github.com/vercel/next.js/pull/93684)).
Standalone output _does_ read it, so the combination fails at
`onBuildComplete` ([#93915](https://github.com/vercel/next.js/pull/93915)).

The build succeeds locally, which makes this confusing to diagnose: with no
adapter present, Next still generates the file, so `npm run build` on a laptop
never reproduces it.

`next.config.js` already handles this by setting `output` to `undefined` when
`VERCEL` is set. If you fork and hardcode `output: 'standalone'` back, expect
this error on Vercel while Docker keeps working.

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
