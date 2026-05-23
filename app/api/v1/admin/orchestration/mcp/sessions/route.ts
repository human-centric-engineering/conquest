/**
 * Admin MCP — Sessions
 *
 * GET /api/v1/admin/orchestration/mcp/sessions — list active in-memory sessions
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { getMcpSessionManager } from '@/lib/orchestration/mcp';

export const GET = withAdminAuth(async (request) => {
  const log = await getRouteLogger(request);
  const sessions = getMcpSessionManager().getActiveSessions();

  log.info('MCP sessions listed', { count: sessions.length });
  return successResponse(sessions);
});
