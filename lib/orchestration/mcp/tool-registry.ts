/**
 * MCP Tool Registry
 *
 * Bridge between MCP tool requests and the capability dispatcher.
 * Lists enabled tools and dispatches calls through the full 9-step
 * capability pipeline.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { capabilityFunctionDefinitionSchema } from '@/lib/validations/orchestration';
import type {
  McpToolDefinition,
  McpToolAnnotations,
  McpToolCallResult,
  McpContentBlock,
} from '@/types/mcp';
import type { CapabilityContext } from '@/lib/orchestration/capabilities/types';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes, matching dispatcher

/** Slug of the system agent used for MCP tool calls */
const MCP_SYSTEM_AGENT_SLUG = 'mcp-system';

let cachedTools: McpToolDefinition[] | null = null;
let cachedAt = 0;
let mcpSystemAgentId: string | null = null;

/**
 * List all MCP-exposed tools that are both enabled in McpExposedTool
 * and active in AiCapability.
 */
export async function listMcpTools(): Promise<McpToolDefinition[]> {
  const now = Date.now();
  if (cachedTools && now - cachedAt < CACHE_TTL_MS) {
    return cachedTools;
  }

  const rows = await prisma.mcpExposedTool.findMany({
    where: { isEnabled: true },
    include: {
      capability: true,
    },
  });

  const tools: McpToolDefinition[] = [];

  for (const row of rows) {
    if (!row.capability.isActive) continue;

    const parsed = capabilityFunctionDefinitionSchema.safeParse(row.capability.functionDefinition);
    if (!parsed.success) {
      logger.warn('MCP tool registry: malformed functionDefinition, skipping', {
        capabilitySlug: row.capability.slug,
      });
      continue;
    }

    const annotations = buildAnnotations(row, row.capability.isIdempotent);

    tools.push({
      slug: row.capability.slug,
      name: row.customName ?? parsed.data.name,
      description: row.customDescription ?? parsed.data.description,
      inputSchema: parsed.data.parameters,
      ...(annotations ? { annotations } : {}),
    });
  }

  cachedTools = tools;
  cachedAt = Date.now();
  return tools;
}

/**
 * Resolve the MCP system agent ID (created by seed).
 * Returns null if the agent doesn't exist yet.
 */
async function getMcpSystemAgentId(): Promise<string | null> {
  if (mcpSystemAgentId) return mcpSystemAgentId;

  const agent = await prisma.aiAgent.findUnique({
    where: { slug: MCP_SYSTEM_AGENT_SLUG },
    select: { id: true },
  });

  if (agent) {
    mcpSystemAgentId = agent.id;
  }
  return mcpSystemAgentId;
}

/**
 * Call an MCP tool by delegating to the capability dispatcher.
 *
 * Creates a synthetic CapabilityContext with the mcp-system agent
 * and translates the CapabilityResult to MCP content blocks.
 */
export async function callMcpTool(
  toolName: string,
  args: Record<string, unknown> | undefined,
  userId: string
): Promise<McpToolCallResult> {
  // Resolve the actual capability slug from tool name
  // (custom names are supported, so we need to look up by either)
  const tools = await listMcpTools();
  const tool = tools.find((t) => t.name === toolName);

  if (!tool) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
      isError: true,
    };
  }

  const agentId = await getMcpSystemAgentId();
  if (!agentId) {
    logger.error('MCP tool call: mcp-system agent not found — run db:seed');
    return {
      content: [{ type: 'text', text: 'MCP system agent not configured' }],
      isError: true,
    };
  }

  const context: CapabilityContext = {
    userId,
    agentId,
  };

  let result;
  try {
    result = await capabilityDispatcher.dispatch(tool.slug, args ?? {}, context);
  } catch (err) {
    logger.error('MCP tool call: dispatcher threw', {
      toolSlug: tool.slug,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      content: [{ type: 'text', text: 'Tool execution failed unexpectedly' }],
      isError: true,
    };
  }

  if (result.success) {
    const content: McpContentBlock[] = [{ type: 'text', text: JSON.stringify(result.data ?? {}) }];
    return { content };
  }

  return {
    content: [
      {
        type: 'text',
        text: result.error?.message ?? 'Tool execution failed',
      },
    ],
    isError: true,
  };
}

/** Clear the tool cache (after admin mutations) */
export function clearMcpToolCache(): void {
  cachedTools = null;
  cachedAt = 0;
  mcpSystemAgentId = null;
}

/**
 * Build the MCP tool annotations object from the McpExposedTool row.
 *
 * Per-exposure overrides win over capability-level defaults. `idempotentHint`
 * specifically: a non-null override on the row replaces `capability.isIdempotent`;
 * a null row value means "inherit the capability". This lets the same
 * capability behave differently when called via MCP vs. internally — e.g.
 * a capability that's idempotent internally but routes through an
 * external service that doesn't deduplicate on the MCP path.
 *
 * Returns `undefined` (not `{}`) when no annotations apply, so the registry
 * can use a spread-conditional to omit the key entirely.
 */
function buildAnnotations(
  row: {
    customTitle: string | null;
    readOnlyHint: boolean | null;
    destructiveHint: boolean | null;
    idempotentHint: boolean | null;
    openWorldHint: boolean | null;
  },
  capabilityIsIdempotent: boolean
): McpToolAnnotations | undefined {
  const annotations: McpToolAnnotations = {};
  if (row.customTitle) annotations.title = row.customTitle;
  if (row.readOnlyHint !== null) annotations.readOnlyHint = row.readOnlyHint;
  if (row.destructiveHint !== null) annotations.destructiveHint = row.destructiveHint;
  // Inherit capability.isIdempotent only when the override is null.
  const effectiveIdempotent =
    row.idempotentHint !== null ? row.idempotentHint : capabilityIsIdempotent;
  // Only emit if it's a meaningful signal (true) or an explicit "no" (false)
  // from the row. Don't emit a capability-inherited true unless the
  // capability actually marked itself idempotent.
  if (row.idempotentHint !== null) {
    annotations.idempotentHint = row.idempotentHint;
  } else if (effectiveIdempotent) {
    annotations.idempotentHint = true;
  }
  if (row.openWorldHint !== null) annotations.openWorldHint = row.openWorldHint;
  return Object.keys(annotations).length > 0 ? annotations : undefined;
}
