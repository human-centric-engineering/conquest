# ConQuest

**CON**versational **QUEST**ionnaire — a conversational questionnaire platform built on the [Sunrise](https://github.com/human-centric-engineering/sunrise) application platform.

An admin uploads a questionnaire document (PDF / DOCX / MD); an agent extracts its sections and questions; end users complete the questionnaire through a streaming conversation rather than form-filling. The LLM extracts, infers, and synthesises answers with confidence scores and provenance; admins review the structure, evaluate it against goal and audience, manage versions, and export results. It is **provider-agnostic** — every model call resolves through Sunrise's provider registry at runtime.

> **Project status:** `planning`. The phased build is tracked in [`.context/application/development-plan.md`](./.context/application/development-plan.md) (Project → Phase → Feature → Task). Nothing user-facing has shipped yet — P0 (foundations) is the first work.

## Built on Sunrise

ConQuest is an **application fork** of Sunrise. The repository is two tiers of code:

| Tier         | What it is                                                                            | How we treat it                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Platform** | Sunrise — auth, API conventions, `lib/` utilities, orchestration, security middleware | An upgradable dependency. Extend through its seams; don't fork-and-edit.                                                          |
| **This app** | ConQuest — questionnaire models, capabilities, admin/user surfaces, business logic    | Ours. Lives in new files (`lib/app/questionnaire/**`, `app/api/v1/app/**`, `app/admin/questionnaires/**`) alongside the platform. |

Sunrise is tracked as the `upstream` git remote (read-only); `origin` is this private repo. Platform fixes are made **upstream in Sunrise and pulled down**, not patched here, so upgrades stay clean merges. The rules:

- [**CUSTOMIZATION.md**](./CUSTOMIZATION.md) — Building on Sunrise: the extension model, package.json policy, staying in sync with upstream
- [**VERSIONING.md**](./VERSIONING.md) — The two-version split: this app's version (`package.json` → `APP_VERSION`) vs the platform version (`SUNRISE_VERSION`, currently `0.0.1`)
- [**CONTRIBUTING.md**](./CONTRIBUTING.md) — Contributing platform changes back to Sunrise itself

## Tech Stack

Inherited from the Sunrise platform:

| Layer            | Technology                                              |
| ---------------- | ------------------------------------------------------- |
| Framework        | Next.js 16 (App Router) + TypeScript                    |
| Database         | PostgreSQL + Prisma 7 (pgvector for semantic search)    |
| Authentication   | better-auth                                             |
| Styling          | Tailwind CSS 4 + shadcn/ui                              |
| Email            | Resend + React Email                                    |
| Validation       | Zod throughout                                          |
| Deployment       | Docker-ready                                            |
| AI Orchestration | Multi-LLM agents, workflows, RAG, MCP server            |
| LLM Providers    | Anthropic, OpenAI (extensible via provider abstraction) |

## Platform capabilities ConQuest builds on

The Sunrise platform ships a complete AI agent orchestration layer that ConQuest consumes rather than reinvents — the questionnaire extractor, the design-time judge agents, the conversational session engine, and cost/audit/eval tracking are all built on these primitives:

- **Agents** — Configured AI personas with system instructions, model selection, temperature, budgets, and attached capabilities
- **Capabilities (tools)** — Function-calling tools that agents invoke; built-ins plus a 4-step pipeline for adding custom tools
- **Workflows (DAGs)** — Multi-step pipelines: routing, chaining, parallel branches, RAG retrieval, human approval gates, error strategies
- **Knowledge bases (RAG)** — Document ingestion (MD, PDF, EPUB, DOCX), chunking, embeddings, and pgvector semantic search scoped per agent
- **Multi-LLM providers** — Provider abstraction with fallback chains, model registry, and cost tracking
- **MCP server** — Model Context Protocol integration for Claude Code or any MCP client
- **Evaluations & A/B experiments** — Named-metric scoring (faithfulness, groundedness, relevance) and variant lifecycle
- **Observability** — Execution tracing (OTEL plug-in), conversation export, audit log, approval queue, dashboard analytics

Platform docs:

- [`.context/orchestration/meta/functional-specification.md`](./.context/orchestration/meta/functional-specification.md) — What the orchestration layer does (canonical)
- [`.context/admin/orchestration.md`](./.context/admin/orchestration.md) — Admin operator landing, quick start

## Quick Start

### Prerequisites

- Node.js 20.19+ (or 22.12+, 24+)
- PostgreSQL 15+ (local, Docker, or hosted)

### Setup

```bash
# Clone and install
git clone git@github.com:human-centric-engineering/conquest.git
cd conquest

# Create environment file
cp .env.example .env.local

## Generate BETTER_AUTH_SECRET
openssl rand -base64 32

# Edit .env.local with:
#  - your DATABASE_URL
#  - your BETTER_AUTH_SECRET

# Install dependencies (postinstall runs `prisma generate`)
npm install

# Set up database (applies migrations, then seeds)
npm run db:migrate:deploy
npm run db:seed

# Start development
npm run dev
```

Open http://localhost:3000 to see the app.

### Using Docker

```bash
docker-compose up                                    # Start app + database
docker-compose exec web npx prisma migrate dev       # Run migrations (first time)
```

### Logging in for the first time

The seed creates an `admin@example.com` user but **does not set a password** (it creates no better-auth credential). To get an admin login on a fresh DB:

1. Sign up through the app with your own email + password.
2. Open `npm run db:studio`, find your row in `User`, set `role` to `ADMIN`.

> A proper fix (first-user-becomes-admin, plus optional dev-only seeded credentials) is tracked upstream in Sunrise — [human-centric-engineering/sunrise#278](https://github.com/human-centric-engineering/sunrise/issues/278) — and will arrive here on the next platform sync.

## Essential Commands

```bash
npm run dev              # Start dev server
npm run validate         # Type-check + lint + format + tests
npm run db:studio        # Open Prisma Studio
npm test                 # Run tests
```

Full command reference: [`.context/commands.md`](./.context/commands.md)

## Optional Features

These platform features work without configuration in development and can be enabled for production:

- **Email** — Console logging in dev; configure Resend for production. See [`.context/email/`](./.context/email/)
- **Analytics** — Console provider in dev; configure PostHog/GA4/Plausible for production. See [`.context/analytics/`](./.context/analytics/)
- **File Storage** — Local filesystem in dev; configure S3/R2/Vercel Blob for production. See [`.context/storage/`](./.context/storage/)

## Documentation

- [**.context/application/development-plan.md**](./.context/application/development-plan.md) — ConQuest's phased build plan (the app's source of truth)
- [**CUSTOMIZATION.md**](./CUSTOMIZATION.md) — Building on Sunrise: extension model, syncing with upstream
- [**.context/substrate.md**](./.context/substrate.md) — Full platform architecture and reference docs
- [**.context/orchestration/meta/functional-specification.md**](./.context/orchestration/meta/functional-specification.md) — Orchestration: full system inventory and capability spec

## Just Ask Claude

The `.context/` docs are written specifically as AI context. Instead of reading through them, just ask Claude:

- _"Let's plan F0.1 — foundation scaffolding."_
- _"How does document ingestion work in the orchestration layer?"_
- _"Add a capability so the extractor agent can parse a new question type."_
- _"How do I pull the latest platform fixes down from Sunrise?"_

Start Claude Code in the repo and start building — it already knows how both ConQuest and the Sunrise platform work.

### Enhanced Capabilities

Install the Next.js DevTools MCP server for real-time diagnostics and browser automation:

```bash
claude mcp add next-devtools npx next-devtools-mcp@latest
```

## Acknowledgements

Built on the [Sunrise](https://github.com/human-centric-engineering/sunrise) platform. The 21 agentic design patterns referenced throughout the orchestration learning area are adapted from _Agentic Design Patterns_ by Antonio Gullí.

## License

MIT

---

Built with ☕ and ⚡ on Sunrise.
