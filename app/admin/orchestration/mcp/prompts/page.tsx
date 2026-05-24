import type { Metadata } from 'next';
import Link from 'next/link';

import { McpPromptsList } from '@/components/admin/orchestration/mcp/mcp-prompts-list';
import { McpInfoModal } from '@/components/admin/orchestration/mcp/mcp-info-modal';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { promptRowSchema, type PromptRow } from '@/lib/validations/mcp';

export const metadata: Metadata = {
  title: 'MCP Prompts · AI Orchestration',
  description: 'Manage prompt templates exposed to MCP clients as slash commands.',
};

interface PromptRecord {
  id: string;
  name: string;
  description: string;
  template: string;
  argumentsSpec: unknown;
  isEnabled: boolean;
  createdAt: string;
}

async function getPrompts(): Promise<PromptRow[]> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.MCP_PROMPTS}?page=1&limit=100`);
    if (!res.ok) return [];
    const body = await parseApiResponse<PromptRecord[]>(res);
    if (!body.success) return [];
    // Coerce server payload through the validation schema so the client
    // component receives a stable, typed shape regardless of any backend
    // serialisation quirks.
    return body.data
      .map((row): PromptRow | null => {
        const parsed = promptRowSchema.safeParse(row);
        return parsed.success ? parsed.data : null;
      })
      .filter((r): r is PromptRow => r !== null);
  } catch (err) {
    logger.error('MCP prompts page: fetch failed', err);
    return [];
  }
}

export default async function McpPromptsPage() {
  const prompts = await getPrompts();

  return (
    <div className="space-y-6">
      <nav className="text-muted-foreground -mb-5 text-xs">
        <Link href="/admin/orchestration" className="hover:underline">
          AI Orchestration
        </Link>
        {' / '}
        <Link href="/admin/orchestration/mcp" className="hover:underline">
          MCP Server
        </Link>
        {' / '}
        <span>Prompts</span>
      </nav>

      <header className="bg-background sticky top-0 z-30 -mx-6 border-b px-6 pt-3 pb-3">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          Prompts
          <McpInfoModal title="MCP Prompts">
            <p>
              Prompts are <strong className="text-foreground">slash-command templates</strong> that
              MCP clients surface to end users — e.g. typing <code>/analyze-pattern</code> in Claude
              Desktop. They are <strong className="text-foreground">not auto-invoked</strong> by the
              model; a human chooses to run them.
            </p>
            <p className="text-foreground mt-2 font-medium">Prompts vs Tools vs Resources</p>
            <p>
              <strong className="text-foreground">Prompts</strong> are templates a user picks from a
              menu. <strong className="text-foreground">Tools</strong> are functions the model
              decides to call. <strong className="text-foreground">Resources</strong> are read-only
              data the model can browse for context.
            </p>
            <p className="text-foreground mt-2 font-medium">Template syntax</p>
            <p>
              Use <code className="text-xs">{'{{argument_name}}'}</code> to insert values declared
              in the arguments list. Only declared argument names are interpolated — stray
              placeholders like <code>{'{{database_url}}'}</code> render literally, not evaluated.
            </p>
            <p className="text-foreground mt-2 font-medium">Backward compatibility</p>
            <p>
              The prompt <strong className="text-foreground">name is immutable</strong> after
              creation because changing it silently breaks every client that has bookmarked it.
              Removing a required argument is safe; adding one breaks existing invocations until
              clients update.
            </p>
          </McpInfoModal>
        </h1>
        <p className="text-muted-foreground text-sm">
          Slash-command templates clients show to end users. Each prompt has a template with{' '}
          <code>{'{{var}}'}</code> placeholders and a list of named arguments.
        </p>
      </header>

      <McpPromptsList initialPrompts={prompts} />
    </div>
  );
}
