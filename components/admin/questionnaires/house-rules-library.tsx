'use client';

/**
 * Starter-library picker for interviewer house rules.
 *
 * The library exists because the blank rule list is the real barrier — an admin who has never
 * written a prompt has no idea what belongs in one. So this dialog is deliberately weighted toward
 * *explanation*: each preset shows its rule text and a "why you'd use this" line, and the line gets
 * as much visual room as the rule itself. Picking is one click; understanding is the point.
 *
 * Presets already in the list are shown as added rather than hidden — an admin scanning a category
 * should be able to see what they have covered as easily as what they are missing.
 *
 * @see lib/app/questionnaire/house-rules/presets.ts — the library and its `why` copy
 */

import { useState } from 'react';
import { Check, Plus } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import {
  HOUSE_RULE_CATEGORIES,
  HOUSE_RULE_CATEGORY_BLURBS,
  HOUSE_RULE_CATEGORY_LABELS,
  HOUSE_RULE_PLACEHOLDER,
  presetsForCategory,
  type HouseRuleCategory,
  type HouseRulePreset,
} from '@/lib/app/questionnaire/house-rules/presets';
import { HOUSE_RULE_KIND_LABELS } from '@/lib/app/questionnaire/types';

/** Kind chip colours — the same three hues the rule cards use, so the two read as one system. */
const KIND_ACCENT: Record<HouseRulePreset['kind'], string> = {
  always: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  never: 'bg-rose-500/10 text-rose-700 dark:text-rose-400',
  if_asked: 'bg-sky-500/10 text-sky-700 dark:text-sky-400',
};

export function HouseRulesLibrary({
  open,
  onOpenChange,
  addedKeys,
  onAdd,
  disabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Preset keys already in the rule list — shown as added rather than filtered out. */
  addedKeys: ReadonlySet<string>;
  onAdd: (preset: HouseRulePreset) => void;
  disabled?: boolean;
}) {
  const [category, setCategory] = useState<HouseRuleCategory>('scope');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Rule ideas</DialogTitle>
          <DialogDescription>
            Common rules, grouped by the situation they solve. Add one and edit it to fit — these
            are starting points, not fixed wording.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={category} onValueChange={(v) => setCategory(v as HouseRuleCategory)}>
          <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1">
            {HOUSE_RULE_CATEGORIES.map((key) => (
              <TabsTrigger key={key} value={key} className="text-xs">
                {HOUSE_RULE_CATEGORY_LABELS[key]}
              </TabsTrigger>
            ))}
          </TabsList>

          {HOUSE_RULE_CATEGORIES.map((key) => (
            <TabsContent key={key} value={key} className="mt-3">
              <p className="text-muted-foreground mb-3 text-xs">
                {HOUSE_RULE_CATEGORY_BLURBS[key]}
              </p>
              <div className="max-h-[50vh] space-y-2 overflow-y-auto pr-1">
                {presetsForCategory(key).map((preset) => {
                  const added = addedKeys.has(preset.key);
                  return (
                    <div
                      key={preset.key}
                      className="bg-card flex items-start gap-3 rounded-lg border p-3"
                    >
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge
                            variant="secondary"
                            className={cn('text-[10px] font-medium', KIND_ACCENT[preset.kind])}
                          >
                            {HOUSE_RULE_KIND_LABELS[preset.kind]}
                          </Badge>
                          {preset.trigger && (
                            <span className="text-muted-foreground text-xs">
                              when they ask about {preset.trigger}
                            </span>
                          )}
                          {preset.text.includes(HOUSE_RULE_PLACEHOLDER) && (
                            <Badge variant="outline" className="text-[10px]">
                              needs filling in
                            </Badge>
                          )}
                        </div>
                        <p className="text-sm leading-relaxed">{preset.text}</p>
                        {/* The reason to use it gets equal billing with the rule — this is the
                            part that actually helps an admin decide. */}
                        <p className="text-muted-foreground text-xs leading-relaxed">
                          {preset.why}
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant={added ? 'ghost' : 'outline'}
                        className="shrink-0"
                        disabled={disabled || added}
                        onClick={() => onAdd(preset)}
                      >
                        {added ? (
                          <>
                            <Check className="mr-1 h-3.5 w-3.5" /> Added
                          </>
                        ) : (
                          <>
                            <Plus className="mr-1 h-3.5 w-3.5" /> Add
                          </>
                        )}
                      </Button>
                    </div>
                  );
                })}
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
