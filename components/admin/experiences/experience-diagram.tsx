'use client';

/**
 * Client island wrapping the read-only canvas for one experience diagram.
 *
 * Exists only to hold the selected-node state and give the server page something it can render
 * without becoming a client component itself. The canvas it wraps is the Behind-the-Scenes
 * `ReadOnlyCanvas`, imported unchanged — reusing it rather than mirroring it is what keeps a
 * second, drifting copy of the React Flow wiring out of the codebase.
 *
 * Node selection shows that node's description beneath the canvas rather than in a side panel: the
 * experience workspace is already a narrow column under a sub-nav, and a 320px panel alongside a
 * canvas would leave neither enough room.
 */

import { useMemo, useState } from 'react';

import { ReadOnlyCanvas } from '@/components/app/questionnaire/behind-the-scenes/read-only-canvas';
import type { WorkflowDefinition } from '@/types/orchestration';

interface ExperienceDiagramProps {
  definition: WorkflowDefinition;
  /** Rendered above the canvas — what this particular diagram is showing. */
  caption?: string;
}

export function ExperienceDiagram({ definition, caption }: ExperienceDiagramProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = useMemo(
    () => definition.steps.find((step) => step.id === selectedId) ?? null,
    [definition.steps, selectedId]
  );

  return (
    <div className="space-y-3">
      {caption ? <p className="text-muted-foreground text-sm">{caption}</p> : null}

      <div className="bg-card h-[460px] w-full overflow-hidden rounded-lg border">
        <ReadOnlyCanvas definition={definition} onSelectNode={setSelectedId} />
      </div>

      <div
        className="bg-muted/40 rounded-md border p-3 text-sm"
        aria-live="polite"
        data-testid="experience-diagram-detail"
      >
        {selected ? (
          <>
            <p className="font-medium">{selected.name}</p>
            {selected.description ? (
              <p className="text-muted-foreground mt-1">{selected.description}</p>
            ) : null}
          </>
        ) : (
          <p className="text-muted-foreground">Select a step in the diagram to see what it does.</p>
        )}
      </div>
    </div>
  );
}
