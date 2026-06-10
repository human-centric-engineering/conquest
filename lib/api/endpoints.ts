/**
 * Centralized API Endpoint Constants
 *
 * All API paths used by client components and server component fetches.
 * Import from here instead of hardcoding paths in components.
 *
 * @example
 * ```typescript
 * import { API } from '@/lib/api/endpoints';
 *
 * // Client component
 * const user = await apiClient.get<User>(API.USERS.ME);
 *
 * // Server component
 * const res = await serverFetch(API.ADMIN.STATS);
 * ```
 */

export const API = {
  /** Auth endpoints (better-auth) */
  AUTH: {
    /** better-auth catch-all */
    BASE: '/api/auth',
    SIGN_OUT: '/api/auth/sign-out',
  },

  /** Current user endpoints */
  USERS: {
    ME: '/api/v1/users/me',
    ME_PREFERENCES: '/api/v1/users/me/preferences',
    ME_AVATAR: '/api/v1/users/me/avatar',
    /** User by ID (admin) */
    byId: (id: string): string => `/api/v1/users/${id}`,
    /** User list (admin) */
    LIST: '/api/v1/users',
    /** Send invitation (admin) */
    INVITE: '/api/v1/users/invite',
  },

  /** Invitation endpoints (public, token-gated) */
  INVITATIONS: {
    METADATA: '/api/v1/invitations/metadata',
  },

  /** Admin endpoints */
  ADMIN: {
    STATS: '/api/v1/admin/stats',
    LOGS: '/api/v1/admin/logs',
    INVITATIONS: '/api/v1/admin/invitations',
    /** Delete invitation by email */
    invitationByEmail: (email: string): string =>
      `/api/v1/admin/invitations/${encodeURIComponent(email)}`,
    FEATURE_FLAGS: '/api/v1/admin/feature-flags',
    /** Feature flag by ID */
    featureFlag: (id: string): string => `/api/v1/admin/feature-flags/${id}`,

    /** AI Orchestration admin endpoints (Phase 3 / Phase 4) */
    ORCHESTRATION: {
      AGENTS: '/api/v1/admin/orchestration/agents',
      AGENTS_BULK: '/api/v1/admin/orchestration/agents/bulk',
      AGENTS_COMPARE: '/api/v1/admin/orchestration/agents/compare',
      AGENTS_EXPORT: '/api/v1/admin/orchestration/agents/export',
      AGENTS_IMPORT: '/api/v1/admin/orchestration/agents/import',
      agentById: (id: string): string => `/api/v1/admin/orchestration/agents/${id}`,
      agentClone: (id: string): string => `/api/v1/admin/orchestration/agents/${id}/clone`,
      agentBudget: (id: string): string => `/api/v1/admin/orchestration/agents/${id}/budget`,
      agentCapabilities: (id: string): string =>
        `/api/v1/admin/orchestration/agents/${id}/capabilities`,
      agentCapabilityById: (id: string, capId: string): string =>
        `/api/v1/admin/orchestration/agents/${id}/capabilities/${capId}`,
      agentCapabilitiesUsage: (id: string): string =>
        `/api/v1/admin/orchestration/agents/${id}/capabilities/usage`,
      agentInstructionsHistory: (id: string): string =>
        `/api/v1/admin/orchestration/agents/${id}/instructions-history`,
      agentInstructionsRevert: (id: string): string =>
        `/api/v1/admin/orchestration/agents/${id}/instructions-revert`,
      agentInviteTokens: (id: string): string =>
        `/api/v1/admin/orchestration/agents/${id}/invite-tokens`,
      agentInviteTokenById: (id: string, tokenId: string): string =>
        `/api/v1/admin/orchestration/agents/${id}/invite-tokens/${tokenId}`,
      agentVersions: (id: string): string => `/api/v1/admin/orchestration/agents/${id}/versions`,
      agentVersionById: (id: string, versionId: string): string =>
        `/api/v1/admin/orchestration/agents/${id}/versions/${versionId}`,
      agentVersionRestore: (id: string, versionId: string): string =>
        `/api/v1/admin/orchestration/agents/${id}/versions/${versionId}/restore`,
      agentEmbedTokens: (id: string): string =>
        `/api/v1/admin/orchestration/agents/${id}/embed-tokens`,
      agentEmbedTokenById: (id: string, tokenId: string): string =>
        `/api/v1/admin/orchestration/agents/${id}/embed-tokens/${tokenId}`,
      agentWidgetConfig: (id: string): string =>
        `/api/v1/admin/orchestration/agents/${id}/widget-config`,
      CAPABILITIES: '/api/v1/admin/orchestration/capabilities',
      capabilityById: (id: string): string => `/api/v1/admin/orchestration/capabilities/${id}`,
      capabilityAgents: (id: string): string =>
        `/api/v1/admin/orchestration/capabilities/${id}/agents`,
      capabilityStats: (id: string): string =>
        `/api/v1/admin/orchestration/capabilities/${id}/stats`,
      capabilityQuarantine: (id: string): string =>
        `/api/v1/admin/orchestration/capabilities/${id}/quarantine`,
      capabilityUnquarantine: (id: string): string =>
        `/api/v1/admin/orchestration/capabilities/${id}/unquarantine`,
      capabilityQuarantineAttribution: (id: string): string =>
        `/api/v1/admin/orchestration/capabilities/${id}/quarantine-attribution`,
      PROVIDER_MODELS: '/api/v1/admin/orchestration/provider-models',
      providerModelById: (id: string): string =>
        `/api/v1/admin/orchestration/provider-models/${id}`,
      PROVIDER_MODELS_BULK: '/api/v1/admin/orchestration/provider-models/bulk',
      PROVIDER_MODEL_RECOMMEND: '/api/v1/admin/orchestration/provider-models/recommend',
      DISCOVERY_MODELS: '/api/v1/admin/orchestration/discovery/models',
      AGENT_PROFILES: '/api/v1/admin/orchestration/agent-profiles',
      agentProfileById: (id: string): string => `/api/v1/admin/orchestration/agent-profiles/${id}`,
      PROVIDERS: '/api/v1/admin/orchestration/providers',
      PROVIDERS_DETECT: '/api/v1/admin/orchestration/providers/detect',
      PROVIDERS_TEST_BULK: '/api/v1/admin/orchestration/providers/test-bulk',
      providerById: (id: string): string => `/api/v1/admin/orchestration/providers/${id}`,
      providerTest: (id: string): string => `/api/v1/admin/orchestration/providers/${id}/test`,
      providerTestModel: (id: string): string =>
        `/api/v1/admin/orchestration/providers/${id}/test-model`,
      providerModels: (id: string): string => `/api/v1/admin/orchestration/providers/${id}/models`,
      providerHealth: (id: string): string => `/api/v1/admin/orchestration/providers/${id}/health`,
      MODELS: '/api/v1/admin/orchestration/models',
      WORKFLOWS: '/api/v1/admin/orchestration/workflows',
      workflowById: (id: string): string => `/api/v1/admin/orchestration/workflows/${id}`,
      workflowSchedules: (id: string): string =>
        `/api/v1/admin/orchestration/workflows/${id}/schedules`,
      workflowScheduleById: (workflowId: string, scheduleId: string): string =>
        `/api/v1/admin/orchestration/workflows/${workflowId}/schedules/${scheduleId}`,
      workflowValidate: (id: string): string =>
        `/api/v1/admin/orchestration/workflows/${id}/validate`,
      workflowDryRun: (id: string): string => `/api/v1/admin/orchestration/workflows/${id}/dry-run`,
      workflowExecute: (id: string): string =>
        `/api/v1/admin/orchestration/workflows/${id}/execute`,
      workflowExecuteStream: (id: string): string =>
        `/api/v1/admin/orchestration/workflows/${id}/execute-stream`,
      workflowCostEstimate: (id: string): string =>
        `/api/v1/admin/orchestration/workflows/${id}/cost-estimate`,
      workflowSaveAsTemplate: (id: string): string =>
        `/api/v1/admin/orchestration/workflows/${id}/save-as-template`,
      EXECUTIONS: '/api/v1/admin/orchestration/executions',
      // Status-count aggregate (groupBy). Used by the admin sidebar to
      // drive approval / in-progress badges with a single request instead
      // of N list queries.
      EXECUTION_COUNTS: '/api/v1/admin/orchestration/executions/counts',
      // Live-engine dashboard snapshot (collection-scoped — running /
      // queued / orphaned counts + per-provider in-flight). NOT the
      // per-execution SSE stream below (`executionLive(id)`).
      EXECUTIONS_LIVE_SNAPSHOT: '/api/v1/admin/orchestration/executions/live',
      executionForceFail: (id: string): string =>
        `/api/v1/admin/orchestration/executions/${id}/force-fail`,
      executionLease: (id: string): string => `/api/v1/admin/orchestration/executions/${id}/lease`,
      executionById: (id: string): string => `/api/v1/admin/orchestration/executions/${id}`,
      executionStatus: (id: string): string =>
        `/api/v1/admin/orchestration/executions/${id}/status`,
      executionLive: (id: string): string => `/api/v1/admin/orchestration/executions/${id}/live`,
      executionApprove: (id: string): string =>
        `/api/v1/admin/orchestration/executions/${id}/approve`,
      executionReject: (id: string): string =>
        `/api/v1/admin/orchestration/executions/${id}/reject`,
      executionCancel: (id: string): string =>
        `/api/v1/admin/orchestration/executions/${id}/cancel`,
      executionRetryStep: (id: string): string =>
        `/api/v1/admin/orchestration/executions/${id}/retry-step`,
      executionReview: (id: string): string =>
        `/api/v1/admin/orchestration/executions/${id}/review`,
      executionRerun: (id: string): string => `/api/v1/admin/orchestration/executions/${id}/rerun`,
      executionReportMarkdown: (id: string): string =>
        `/api/v1/admin/orchestration/executions/${id}/report.md`,
      APPROVALS_HISTORY: '/api/v1/admin/orchestration/approvals/history',
      workflowVersions: (id: string): string =>
        `/api/v1/admin/orchestration/workflows/${id}/versions`,
      workflowVersionById: (id: string, version: number): string =>
        `/api/v1/admin/orchestration/workflows/${id}/versions/${version}`,
      workflowPublish: (id: string): string =>
        `/api/v1/admin/orchestration/workflows/${id}/publish`,
      workflowDiscardDraft: (id: string): string =>
        `/api/v1/admin/orchestration/workflows/${id}/discard-draft`,
      workflowRollback: (id: string): string =>
        `/api/v1/admin/orchestration/workflows/${id}/rollback`,
      CHAT_STREAM: '/api/v1/admin/orchestration/chat/stream',
      CONVERSATIONS: '/api/v1/admin/orchestration/conversations',
      conversationById: (id: string): string => `/api/v1/admin/orchestration/conversations/${id}`,
      conversationMessages: (id: string): string =>
        `/api/v1/admin/orchestration/conversations/${id}/messages`,
      conversationProvenance: (id: string): string =>
        `/api/v1/admin/orchestration/conversations/${id}/provenance`,
      conversationProvenanceMarkdown: (id: string): string =>
        `/api/v1/admin/orchestration/conversations/${id}/provenance.md`,
      CONVERSATIONS_CLEAR: '/api/v1/admin/orchestration/conversations/clear',
      CONVERSATIONS_EXPORT: '/api/v1/admin/orchestration/conversations/export',
      CONVERSATIONS_SEARCH: '/api/v1/admin/orchestration/conversations/search',
      KNOWLEDGE_DOCUMENTS: '/api/v1/admin/orchestration/knowledge/documents',
      knowledgeDocumentById: (id: string): string =>
        `/api/v1/admin/orchestration/knowledge/documents/${id}`,
      knowledgeDocumentRechunk: (id: string): string =>
        `/api/v1/admin/orchestration/knowledge/documents/${id}/rechunk`,
      knowledgeDocumentEnrichKeywords: (id: string): string =>
        `/api/v1/admin/orchestration/knowledge/documents/${id}/enrich-keywords`,
      knowledgeDocumentRetry: (id: string): string =>
        `/api/v1/admin/orchestration/knowledge/documents/${id}/retry`,
      knowledgeDocumentConfirm: (id: string): string =>
        `/api/v1/admin/orchestration/knowledge/documents/${id}/confirm`,
      knowledgeDocumentChunks: (id: string): string =>
        `/api/v1/admin/orchestration/knowledge/documents/${id}/chunks`,
      knowledgeDocumentAgents: (id: string): string =>
        `/api/v1/admin/orchestration/knowledge/documents/${id}/agents`,
      KNOWLEDGE_SEARCH: '/api/v1/admin/orchestration/knowledge/search',
      KNOWLEDGE_GRAPH: '/api/v1/admin/orchestration/knowledge/graph',
      KNOWLEDGE_EMBEDDINGS: '/api/v1/admin/orchestration/knowledge/embeddings',
      KNOWLEDGE_PATTERNS: '/api/v1/admin/orchestration/knowledge/patterns',
      knowledgePatternByNumber: (num: number): string =>
        `/api/v1/admin/orchestration/knowledge/patterns/${num}`,
      KNOWLEDGE_SEED: '/api/v1/admin/orchestration/knowledge/seed',
      EMBEDDING_MODELS: '/api/v1/admin/orchestration/embedding-models',
      KNOWLEDGE_EMBED: '/api/v1/admin/orchestration/knowledge/embed',
      KNOWLEDGE_EMBEDDING_STATUS: '/api/v1/admin/orchestration/knowledge/embedding-status',
      KNOWLEDGE_TAGS: '/api/v1/admin/orchestration/knowledge/tags',
      knowledgeTagById: (id: string): string => `/api/v1/admin/orchestration/knowledge/tags/${id}`,
      TRIGGERS: '/api/v1/admin/orchestration/triggers',
      triggerById: (id: string): string => `/api/v1/admin/orchestration/triggers/${id}`,
      WEBHOOKS: '/api/v1/admin/orchestration/webhooks',
      webhookById: (id: string): string => `/api/v1/admin/orchestration/webhooks/${id}`,
      webhookDeliveries: (id: string): string =>
        `/api/v1/admin/orchestration/webhooks/${id}/deliveries`,
      webhookTest: (id: string): string => `/api/v1/admin/orchestration/webhooks/${id}/test`,
      retryDelivery: (id: string): string =>
        `/api/v1/admin/orchestration/webhooks/deliveries/${id}/retry`,
      deliveryById: (id: string): string => `/api/v1/admin/orchestration/webhooks/deliveries/${id}`,
      WEBHOOK_DLQ: '/api/v1/admin/orchestration/webhooks/dlq',
      WEBHOOK_DLQ_STATS: '/api/v1/admin/orchestration/webhooks/dlq/stats',
      WEBHOOK_DLQ_REPLAY: '/api/v1/admin/orchestration/webhooks/dlq/replay',
      COSTS: '/api/v1/admin/orchestration/costs',
      COSTS_SUMMARY: '/api/v1/admin/orchestration/costs/summary',
      COSTS_ALERTS: '/api/v1/admin/orchestration/costs/alerts',
      ANALYTICS_TOPICS: '/api/v1/admin/orchestration/analytics/topics',
      ANALYTICS_UNANSWERED: '/api/v1/admin/orchestration/analytics/unanswered',
      ANALYTICS_ENGAGEMENT: '/api/v1/admin/orchestration/analytics/engagement',
      ANALYTICS_CONTENT_GAPS: '/api/v1/admin/orchestration/analytics/content-gaps',
      ANALYTICS_FEEDBACK: '/api/v1/admin/orchestration/analytics/feedback',
      MAINTENANCE_TICK: '/api/v1/admin/orchestration/maintenance/tick',
      SETTINGS: '/api/v1/admin/orchestration/settings',
      EVALUATIONS: '/api/v1/admin/orchestration/evaluations',
      evaluationById: (id: string): string => `/api/v1/admin/orchestration/evaluations/${id}`,
      evaluationComplete: (id: string): string =>
        `/api/v1/admin/orchestration/evaluations/${id}/complete`,
      evaluationRescore: (id: string): string =>
        `/api/v1/admin/orchestration/evaluations/${id}/rescore`,
      evaluationLogs: (id: string): string => `/api/v1/admin/orchestration/evaluations/${id}/logs`,
      // Phase 1 dataset-driven evaluations
      EVAL_DATASETS: '/api/v1/admin/orchestration/evaluations/datasets',
      evalDatasetById: (id: string): string =>
        `/api/v1/admin/orchestration/evaluations/datasets/${id}`,
      evalDatasetCases: (id: string): string =>
        `/api/v1/admin/orchestration/evaluations/datasets/${id}/cases`,
      evalDatasetCaseByPosition: (id: string, position: number): string =>
        `/api/v1/admin/orchestration/evaluations/datasets/${id}/cases/${position}`,
      evalDatasetCapture: (id: string): string =>
        `/api/v1/admin/orchestration/evaluations/datasets/${id}/capture`,
      evalDatasetGenerateCases: (id: string): string =>
        `/api/v1/admin/orchestration/evaluations/datasets/${id}/generate-cases`,
      evalDatasetGenerateCasesCommit: (id: string): string =>
        `/api/v1/admin/orchestration/evaluations/datasets/${id}/generate-cases/commit`,
      // Phase 3.6 — cold-start dataset creation (no existing dataset)
      EVAL_DATASETS_GENERATE_FROM_DESCRIPTION:
        '/api/v1/admin/orchestration/evaluations/datasets/generate-from-description',
      EVAL_DATASETS_GENERATE_FROM_DESCRIPTION_COMMIT:
        '/api/v1/admin/orchestration/evaluations/datasets/generate-from-description/commit',
      experimentCompareById: (id: string): string =>
        `/api/v1/admin/orchestration/experiments/${id}/compare`,
      experimentVerdictsById: (id: string): string =>
        `/api/v1/admin/orchestration/experiments/${id}/verdicts`,
      EVAL_RUNS: '/api/v1/admin/orchestration/evaluations/runs',
      EVAL_RUN_ESTIMATE: '/api/v1/admin/orchestration/evaluations/runs/estimate',
      evalRunById: (id: string): string => `/api/v1/admin/orchestration/evaluations/runs/${id}`,
      evalRunCases: (id: string): string =>
        `/api/v1/admin/orchestration/evaluations/runs/${id}/cases`,
      evalRunCancel: (id: string): string =>
        `/api/v1/admin/orchestration/evaluations/runs/${id}/cancel`,
      EVAL_GRADERS: '/api/v1/admin/orchestration/evaluations/graders',
      agentEvaluationTrend: (id: string): string =>
        `/api/v1/admin/orchestration/agents/${id}/evaluation-trend`,
      agentQuarantinedCapabilities: (id: string): string =>
        `/api/v1/admin/orchestration/agents/${id}/quarantined-capabilities`,
      OBSERVABILITY_DASHBOARD_STATS: '/api/v1/admin/orchestration/observability/dashboard-stats',
      OBSERVABILITY_ACTIVE_QUARANTINES:
        '/api/v1/admin/orchestration/observability/active-quarantines',
      QUIZ_SCORES: '/api/v1/admin/orchestration/quiz-scores',

      /** MCP Server admin endpoints */
      MCP_SETTINGS: '/api/v1/admin/orchestration/mcp/settings',
      MCP_TOOLS: '/api/v1/admin/orchestration/mcp/tools',
      mcpToolById: (id: string): string => `/api/v1/admin/orchestration/mcp/tools/${id}`,
      MCP_RESOURCES: '/api/v1/admin/orchestration/mcp/resources',
      mcpResourceById: (id: string): string => `/api/v1/admin/orchestration/mcp/resources/${id}`,
      MCP_PROMPTS: '/api/v1/admin/orchestration/mcp/prompts',
      mcpPromptById: (id: string): string => `/api/v1/admin/orchestration/mcp/prompts/${id}`,
      MCP_KEYS: '/api/v1/admin/orchestration/mcp/keys',
      mcpKeyById: (id: string): string => `/api/v1/admin/orchestration/mcp/keys/${id}`,
      mcpKeyRotate: (id: string): string => `/api/v1/admin/orchestration/mcp/keys/${id}/rotate`,
      MCP_AUDIT: '/api/v1/admin/orchestration/mcp/audit',
      MCP_SESSIONS: '/api/v1/admin/orchestration/mcp/sessions',
      mcpSessionById: (id: string): string => `/api/v1/admin/orchestration/mcp/sessions/${id}`,

      /** Admin audit log */
      AUDIT_LOG: '/api/v1/admin/orchestration/audit-log',
    },
  },

  /** Consumer chat endpoints */
  CHAT: {
    AGENTS: '/api/v1/chat/agents',
    STREAM: '/api/v1/chat/stream',
    CONVERSATIONS: '/api/v1/chat/conversations',
    CONVERSATIONS_SEARCH: '/api/v1/chat/conversations/search',
    conversationById: (id: string): string => `/api/v1/chat/conversations/${id}`,
    conversationMessages: (id: string): string => `/api/v1/chat/conversations/${id}/messages`,
    conversationShare: (id: string): string => `/api/v1/chat/conversations/${id}/share`,
    validateToken: (slug: string): string => `/api/v1/chat/agents/${slug}/validate-token`,
  },

  /** Webhook trigger (API-key authenticated, not admin) */
  WEBHOOKS: {
    trigger: (slug: string): string => `/api/v1/webhooks/trigger/${slug}`,
  },

  /** Public endpoints */
  /** Public orchestration endpoints (token-authenticated, no session) */
  ORCHESTRATION: {
    approvalApprove: (id: string): string => `/api/v1/orchestration/approvals/${id}/approve`,
    approvalReject: (id: string): string => `/api/v1/orchestration/approvals/${id}/reject`,
    /** Chat-channel approval routes — server pins `actorLabel: 'token:chat'` and enforces same-origin CORS. */
    approvalApproveChat: (id: string): string =>
      `/api/v1/orchestration/approvals/${id}/approve/chat`,
    approvalRejectChat: (id: string): string => `/api/v1/orchestration/approvals/${id}/reject/chat`,
    /** Embed-channel approval routes — server pins `actorLabel: 'token:embed'` and enforces a configured origin allowlist. */
    approvalApproveEmbed: (id: string): string =>
      `/api/v1/orchestration/approvals/${id}/approve/embed`,
    approvalRejectEmbed: (id: string): string =>
      `/api/v1/orchestration/approvals/${id}/reject/embed`,
    /** Token-authenticated execution status read — used by chat-rendered approval cards to poll. */
    approvalStatus: (id: string): string => `/api/v1/orchestration/approvals/${id}/status`,
  },
  PUBLIC: {
    HEALTH: '/api/health',
    CONTACT: '/api/v1/contact',
    CSP_REPORT: '/api/csp-report',
  },

  /** App (ConQuest questionnaire) endpoints — flag-gated, admin-only. */
  APP: {
    QUESTIONNAIRES: {
      /** List + ingest (GET list, POST multipart ingest). */
      ROOT: '/api/v1/app/questionnaires',
      /** Questionnaire detail (questionnaire + version summaries). */
      byId: (id: string): string => `/api/v1/app/questionnaires/${id}`,
      /** One version's full section/question graph (GET); version-meta edit (PATCH). */
      versionGraph: (id: string, versionId: string): string =>
        `/api/v1/app/questionnaires/${id}/versions/${versionId}`,
      /** Version status transition (PATCH launch/archive/un-launch). */
      versionStatus: (id: string, versionId: string): string =>
        `/api/v1/app/questionnaires/${id}/versions/${versionId}/status`,
      /** Re-ingest a replacement source doc into a draft version (POST multipart). */
      versionReingest: (id: string, versionId: string): string =>
        `/api/v1/app/questionnaires/${id}/versions/${versionId}/reingest`,
      /** Clone the questionnaire's current version into a new questionnaire for a demo client (POST — DEMO-ONLY). */
      cloneForClient: (id: string): string => `/api/v1/app/questionnaires/${id}/clone-for-client`,
      /** Version run-time configuration (PATCH partial config — F3.1). */
      versionConfig: (id: string, versionId: string): string =>
        `/api/v1/app/questionnaires/${id}/versions/${versionId}/config`,
      /** Pre-launch cost estimate (GET `?respondents=N` — F3.3). */
      versionCostEstimate: (id: string, versionId: string): string =>
        `/api/v1/app/questionnaires/${id}/versions/${versionId}/cost-estimate`,
      /** Next-question preview against a supplied answer state (POST — F4.1). */
      versionNextQuestion: (id: string, versionId: string): string =>
        `/api/v1/app/questionnaires/${id}/versions/${versionId}/next-question`,
      /** Generate/backfill slot embeddings for adaptive selection (POST `{ force? }` — F4.1). */
      versionEmbedQuestions: (id: string, versionId: string): string =>
        `/api/v1/app/questionnaires/${id}/versions/${versionId}/embed-questions`,
      /** Section collection (POST create). */
      versionSections: (id: string, versionId: string): string =>
        `/api/v1/app/questionnaires/${id}/versions/${versionId}/sections`,
      /** Section reorder (PATCH `{ order }`). */
      versionSectionsReorder: (id: string, versionId: string): string =>
        `/api/v1/app/questionnaires/${id}/versions/${versionId}/sections/reorder`,
      /** Single section (PATCH edit, DELETE). */
      versionSectionById: (id: string, versionId: string, sectionId: string): string =>
        `/api/v1/app/questionnaires/${id}/versions/${versionId}/sections/${sectionId}`,
      /** Question collection under a section (POST create). */
      versionSectionQuestions: (id: string, versionId: string, sectionId: string): string =>
        `/api/v1/app/questionnaires/${id}/versions/${versionId}/sections/${sectionId}/questions`,
      /** Question reorder within a section (PATCH `{ order }`). */
      versionSectionQuestionsReorder: (id: string, versionId: string, sectionId: string): string =>
        `/api/v1/app/questionnaires/${id}/versions/${versionId}/sections/${sectionId}/questions/reorder`,
      /** Single question by flat id (PATCH edit/move, DELETE). */
      versionQuestionById: (id: string, versionId: string, questionId: string): string =>
        `/api/v1/app/questionnaires/${id}/versions/${versionId}/questions/${questionId}`,
      /** Tag vocabulary collection (POST create). */
      versionTags: (id: string, versionId: string): string =>
        `/api/v1/app/questionnaires/${id}/versions/${versionId}/tags`,
      /** Single tag (PATCH rename/recolour, DELETE). */
      versionTagById: (id: string, versionId: string, tagId: string): string =>
        `/api/v1/app/questionnaires/${id}/versions/${versionId}/tags/${tagId}`,
      /** A question's tag set (PUT replace-set `{ tagIds }`). */
      versionQuestionTags: (id: string, versionId: string, questionId: string): string =>
        `/api/v1/app/questionnaires/${id}/versions/${versionId}/questions/${questionId}/tags`,
      /** Extraction-change log for a version (GET list, filter by status/type). */
      versionChanges: (id: string, versionId: string): string =>
        `/api/v1/app/questionnaires/${id}/versions/${versionId}/changes`,
      /** Revert one extraction change (POST). */
      versionChangeRevert: (id: string, versionId: string, changeId: string): string =>
        `/api/v1/app/questionnaires/${id}/versions/${versionId}/changes/${changeId}/revert`,
      /** Design-evaluation runs for a version (GET list newest-first, POST run + persist — F5.2). */
      versionEvaluations: (id: string, versionId: string): string =>
        `/api/v1/app/questionnaires/${id}/versions/${versionId}/evaluations`,
      /** One persisted evaluation run with its findings (GET — F5.2). */
      versionEvaluationById: (id: string, versionId: string, runId: string): string =>
        `/api/v1/app/questionnaires/${id}/versions/${versionId}/evaluations/${runId}`,
      /** Review one finding (PATCH accept/decline/edit — F5.3). */
      versionEvaluationFinding: (
        id: string,
        versionId: string,
        runId: string,
        findingId: string
      ): string =>
        `/api/v1/app/questionnaires/${id}/versions/${versionId}/evaluations/${runId}/findings/${findingId}`,
      /** Apply one finding's structured edit to the draft (POST — F5.3). */
      versionEvaluationFindingApply: (
        id: string,
        versionId: string,
        runId: string,
        findingId: string
      ): string =>
        `/api/v1/app/questionnaires/${id}/versions/${versionId}/evaluations/${runId}/findings/${findingId}/apply`,
      /** Per-question answer distributions for a version (GET — F8.1). */
      versionAnalyticsDistributions: (id: string, versionId: string): string =>
        `/api/v1/app/questionnaires/${id}/versions/${versionId}/analytics/distributions`,
      /** Completion funnel (invited → opened → started → completed) for a version (GET — F8.1). */
      versionAnalyticsFunnel: (id: string, versionId: string): string =>
        `/api/v1/app/questionnaires/${id}/versions/${versionId}/analytics/funnel`,
      /** Per-version cost actuals from `AiCostLog` (GET — F8.1). */
      versionAnalyticsCost: (id: string, versionId: string): string =>
        `/api/v1/app/questionnaires/${id}/versions/${versionId}/analytics/cost`,
      /** Completed-session results export, CSV or JSON via `?format=` (GET — F8.2). */
      versionExport: (id: string, versionId: string): string =>
        `/api/v1/app/questionnaires/${id}/versions/${versionId}/export`,
      /** Invitations for a questionnaire (GET list, POST send single/bulk — F3.2). */
      invitations: (id: string): string => `/api/v1/app/questionnaires/${id}/invitations`,
      /** Single invitation (PATCH revoke — F3.2). */
      invitationById: (id: string, invitationId: string): string =>
        `/api/v1/app/questionnaires/${id}/invitations/${invitationId}`,
      /** Resend one invitation, regenerating its token (POST — F3.2). */
      invitationResend: (id: string, invitationId: string): string =>
        `/api/v1/app/questionnaires/${id}/invitations/${invitationId}/resend`,
      /** Admin download of one session's results as a branded PDF (GET — F7.4). */
      sessionExportPdf: (id: string, sessionId: string): string =>
        `/api/v1/app/questionnaires/${id}/sessions/${sessionId}/export.pdf`,
    },
    /** Respondent live-session endpoints (F6.1/F6.2) — consumed by the F7.1 chat surface. */
    QUESTIONNAIRE_SESSIONS: {
      /** Create/resume an authenticated session (POST `{ invitationToken }` or `{ versionId }`). */
      ROOT: '/api/v1/app/questionnaire-sessions',
      /** Create a no-login anonymous session (POST `{ versionId }` → `{ session, accessToken }`). */
      ANONYMOUS: '/api/v1/app/questionnaire-sessions/anonymous',
      /** Admin "Preview as respondent" session (POST `{ versionId }` → `{ session, accessToken }`); bypasses the anonymous-mode gate, `isPreview`. */
      PREVIEW: '/api/v1/app/questionnaire-sessions/preview',
      /** Respondent turn — SSE stream (POST `{ message }`). */
      messages: (id: string): string => `/api/v1/app/questionnaire-sessions/${id}/messages`,
      /** Voice transcription (POST multipart `{ audio, language? }`). */
      transcribe: (id: string): string => `/api/v1/app/questionnaire-sessions/${id}/transcribe`,
      /** Answer-slot panel state — live read for the respondent panel (GET) (F7.2). */
      answers: (id: string): string => `/api/v1/app/questionnaire-sessions/${id}/answers`,
      /** Session lifecycle/status — completion-offer + cost tier + anon (GET) (F7.3). */
      status: (id: string): string => `/api/v1/app/questionnaire-sessions/${id}/status`,
      /** Pause/resume a session (POST `{ action }`) — signed-in respondents only (F7.3). */
      lifecycle: (id: string): string => `/api/v1/app/questionnaire-sessions/${id}/lifecycle`,
      /** Submit (complete) a session (POST) — the respondent accept→completed path (F7.3). */
      submit: (id: string): string => `/api/v1/app/questionnaire-sessions/${id}/submit`,
      /** Download the session's results as a branded PDF (GET — F7.4). */
      exportPdf: (id: string): string => `/api/v1/app/questionnaire-sessions/${id}/export.pdf`,
    },
    /** Public (token-gated) respondent invitation endpoints (F3.2 PR2). */
    INVITATIONS: {
      /** Validate a token + mark opened (GET ?token=). */
      METADATA: '/api/v1/app/invitations/metadata',
      /** Accept an invitation: register + bind the account (POST). */
      ACCEPT: '/api/v1/app/invitations/accept',
    },
    /** DEMO-ONLY (F2.5.1): demo-client identity + attribution. A fork strips this. */
    DEMO_CLIENTS: {
      /** List (GET) + create (POST). */
      ROOT: '/api/v1/app/demo-clients',
      /** Detail (GET), edit (PATCH), delete (DELETE). */
      byId: (id: string): string => `/api/v1/app/demo-clients/${id}`,
    },
  },
} as const;
