'use client';

/**
 * "Routing map" — the Adaptive scope tab's picture of itself.
 *
 * A near-full-screen dialog rather than another card or another workspace tab, for two reasons. The tab
 * is already a stack of seven cards and a canvas needs room to be panned; and the map is a **view of**
 * this tab rather than a peer of it — a sixteenth entry in a workspace bar that already carries fifteen
 * would say the opposite.
 *
 * Everything it draws comes from the `TopicsPayload` the panel already holds. There is no fetch, no
 * stored layout and no second copy of the routing to keep in step: the map is a pure function of the
 * settings above it, so "always synced" is a property of the construction rather than something anyone
 * has to remember to do.
 *
 * It is deliberately read-only. `buildScopeGraph` cannot evaluate a rule (that needs a session's fills)
 * so the map is structural, and authoring on a canvas would put a second editor beside the topic list
 * that could disagree with it. The one affordance back into authoring is "Edit this topic", which closes
 * the map and expands the matching row in the list — one surface, reached faster.
 */

import { useMemo, useState } from 'react';
import { Network } from 'lucide-react';

import { RoutingMapCanvas } from '@/components/admin/questionnaires/topics/routing-map-canvas';
import { RoutingMapDetail } from '@/components/admin/questionnaires/topics/routing-map-detail';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { buildScopeGraph } from '@/lib/app/questionnaire/scope/graph';
import type { TopicsPayload } from '@/lib/app/questionnaire/scope/views';

export interface RoutingMapDialogProps {
  payload: TopicsPayload;
  /**
   * Ask the tab to open a topic for editing. The dialog closes itself first — the row it lands on is
   * behind the overlay, so leaving the map open would look like nothing happened.
   */
  onEditTopic: (topicKey: string) => void;
  disabled?: boolean;
}

export function RoutingMapDialog({ payload, onEditTopic, disabled }: RoutingMapDialogProps) {
  const [open, setOpen] = useState(false);
  // On by default. The band used to be drawn as a wrapped row, where fifteen expanded topics crowded
  // out the conditional band the map exists to explain; laid out as a column clear of every other
  // stage it costs the picture nothing, and the first sight of the map should be the whole interview
  // rather than a summary of a third of it. The toggle stays, to put the band away again.
  const [expandAlways, setExpandAlways] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const graph = useMemo(
    () =>
      buildScopeGraph({
        topics: payload.topics,
        settings: payload.settings,
        costs: payload.costs,
        dataSlots: payload.inventory.dataSlots,
        // Priced, so the detail panel can show the arithmetic behind a topic's duration rather than
        // the bare figure — see `routing-map-detail.tsx`.
        questions: payload.inventory.questions,
        expandAlways,
      }),
    [
      payload.topics,
      payload.settings,
      payload.costs,
      payload.inventory.dataSlots,
      payload.inventory.questions,
      expandAlways,
    ]
  );

  const selected = useMemo(
    () => graph.nodes.find((n) => n.id === selectedId) ?? null,
    [graph.nodes, selectedId]
  );

  const conditionalCount = payload.topics.filter((t) => t.phase === 'conditional').length;
  const alwaysCount = payload.topics.filter(
    (t) => t.phase !== 'opening' && t.phase !== 'conditional'
  ).length;

  const handleEdit = (topicKey: string) => {
    setOpen(false);
    onEditTopic(topicKey);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled}>
          <Network className="mr-2 h-4 w-4" />
          Decision flow
        </Button>
      </DialogTrigger>

      <DialogContent
        className="flex h-[calc(100dvh-3rem)] w-[calc(100vw-2rem)] max-w-[1500px] flex-col gap-0 overflow-hidden p-0 sm:rounded-xl"
        // The canvas owns the arrow keys and the scroll wheel; letting Radix move focus into it on open
        // would scroll the graph to whichever node happened to be first in the DOM.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="flex items-start justify-between gap-4 border-b px-5 py-3">
          <div className="min-w-0">
            <DialogTitle className="text-base">Decision flow</DialogTitle>
            <DialogDescription className="mt-0.5 text-xs">
              What this version <em>can</em> do, drawn from the settings on this tab. It is the
              structure, not a prediction — nothing here knows what a respondent will say. Use{' '}
              <strong>Try it</strong> for that.
            </DialogDescription>
          </div>
          <div className="flex shrink-0 items-center gap-2 pr-8">
            <Switch
              id="routing-map-expand-always"
              checked={expandAlways}
              onCheckedChange={setExpandAlways}
              disabled={alwaysCount === 0}
            />
            {/* Deliberately no count in the label. A control names what it DOES; the number of
                always-asked topics is a fact about this version, and it is already stated on the band
                node the toggle acts on. Putting it here made a general affordance read as a hardcoded
                property of whichever questionnaire happened to be open. */}
            <Label htmlFor="routing-map-expand-always" className="text-xs font-normal">
              Show always-asked topics
            </Label>
          </div>
        </div>

        {!payload.settings.enabled ? (
          <div
            className="border-b border-amber-300 bg-amber-50 px-5 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
            data-testid="routing-map-off-banner"
          >
            Adaptive scope is <strong>off</strong>, so every respondent is asked everything today.
            This is what would happen if you switched it on.
          </div>
        ) : null}

        {conditionalCount === 0 ? (
          <div
            className="text-muted-foreground border-b px-5 py-2 text-xs"
            data-testid="routing-map-nothing-conditional"
          >
            No topic is conditional, so there is nothing to decide — every respondent gets the same
            interview. Mark a topic “Ask when it fits” to give the routing something to choose
            between.
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1">
          <div className="bg-muted/20 min-w-0 flex-1">
            <RoutingMapCanvas graph={graph} onSelectNode={setSelectedId} />
          </div>

          <aside
            className="hidden w-[320px] shrink-0 overflow-y-auto border-l px-4 py-4 md:block"
            aria-live="polite"
            data-testid="routing-map-detail"
          >
            <RoutingMapDetail node={selected} onEditTopic={handleEdit} />
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  );
}
