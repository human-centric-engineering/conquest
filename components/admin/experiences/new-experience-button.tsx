'use client';

/**
 * "New experience" header action — a button that opens the create dialog.
 *
 * Renders disabled with an explanation when there are no active demo clients, rather than opening
 * a dialog whose first field cannot be filled. An experience is always scoped to a client, so
 * "create a client first" is the real next action and the button says so.
 */

import { useState } from 'react';
import { Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ExperienceForm } from '@/components/admin/experiences/experience-form';
import type { AttributedDemoClient } from '@/lib/app/questionnaire/demo-clients';

export function NewExperienceButton({
  demoClientOptions,
}: {
  demoClientOptions: AttributedDemoClient[];
}) {
  const [open, setOpen] = useState(false);

  if (demoClientOptions.length === 0) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* A disabled button swallows pointer events, so the tooltip needs a live wrapper. */}
          <span className="inline-flex">
            <Button disabled>
              <Plus className="mr-2 h-4 w-4" />
              New experience
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          Create an active demo client first — every experience belongs to one.
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button onClick={() => setOpen(true)}>
        <Plus className="mr-2 h-4 w-4" />
        New experience
      </Button>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New experience</DialogTitle>
          <DialogDescription>
            Compose a journey from questionnaires you have already authored. You will add the steps
            next.
          </DialogDescription>
        </DialogHeader>
        <ExperienceForm
          demoClientOptions={demoClientOptions}
          onSuccess={() => setOpen(false)}
          onCancel={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
