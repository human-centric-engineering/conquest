import { Prisma } from '@prisma/client';
import type { SeedUnit } from '@/prisma/runner';
import {
  REPORT_RESEARCHER_AGENT_SLUG,
  WEB_SEARCH_CAPABILITY_SLUG,
  WEB_SEARCH_FUNCTION_DEFINITION,
  WEB_SEARCH_HANDLER,
} from '@/lib/app/questionnaire/constants';

/**
 * Seed the `web_search` `AiCapability` row and bind it to the Report Research agent.
 *
 * `executionType: 'internal'` + `executionHandler` points the dispatcher at the in-memory
 * `AppWebSearchCapability` registered via `initAppCapabilities()`. App capability (`category: 'app'`,
 * `isSystem: false`): editable/deletable, included in config backup/export. `rateLimit: null` at the
 * capability layer (the outbound HTTP rate limiter caps Brave per-host); exposed to the research
 * agent's tool loop. Runs after `070-report-researcher-agent`, so the agent exists to bind.
 *
 * App seed: `SeedHistory` key `app-questionnaire/071-web-search-capability`. Idempotent — `update`
 * re-asserts `isSystem: false` and refreshes the function definition; the binding upsert is a no-op
 * on re-seed.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/071-web-search-capability',
  async run({ prisma, logger }) {
    logger.info('🧩 Seeding web_search capability...');

    const capability = await prisma.aiCapability.upsert({
      where: { slug: WEB_SEARCH_CAPABILITY_SLUG },
      update: {
        isSystem: false,
        functionDefinition: WEB_SEARCH_FUNCTION_DEFINITION as unknown as Prisma.InputJsonValue,
      },
      create: {
        slug: WEB_SEARCH_CAPABILITY_SLUG,
        name: 'Web Search',
        description:
          'Searches the public web (Brave backend) and returns ranked results (title, url, snippet). ' +
          'Provider-agnostic; requires BRAVE_SEARCH_API_KEY and an allowlisted host. Used by the report ' +
          'research agent to gather external context.',
        category: 'app',
        executionType: 'internal',
        executionHandler: WEB_SEARCH_HANDLER,
        functionDefinition: WEB_SEARCH_FUNCTION_DEFINITION as unknown as Prisma.InputJsonValue,
        rateLimit: null,
        isActive: true,
        isSystem: false,
      },
    });

    const agent = await prisma.aiAgent.findUnique({
      where: { slug: REPORT_RESEARCHER_AGENT_SLUG },
      select: { id: true },
    });
    if (!agent) {
      logger.warn(
        `⚠️ ${REPORT_RESEARCHER_AGENT_SLUG} agent not found — skipping capability binding (ensure 070-report-researcher-agent runs first).`
      );
    } else {
      await prisma.aiAgentCapability.upsert({
        where: { agentId_capabilityId: { agentId: agent.id, capabilityId: capability.id } },
        update: {},
        create: { agentId: agent.id, capabilityId: capability.id, isEnabled: true },
      });
    }

    logger.info(
      `✅ Seeded ${WEB_SEARCH_CAPABILITY_SLUG} capability${agent ? ' (bound to report-researcher agent)' : ''}`
    );
  },
};

export default unit;
