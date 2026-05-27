'use client';

/**
 * DatasetNewTabs — client wrapper around the two ways to create a
 * dataset on /admin/orchestration/evaluations/datasets/new:
 *
 *   - Upload file: existing DatasetUploadForm (CSV / JSONL).
 *   - Generate from description: new GenerateFromDescriptionForm —
 *     cold-start path that creates the dataset on commit.
 *
 * The anatomy-of-a-case sidebar sits outside this component, so the
 * worked example stays visible across both tabs.
 */

import * as React from 'react';
import { FileUp, Sparkles } from 'lucide-react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DatasetUploadForm } from '@/components/admin/orchestration/evaluations-foundations/dataset-upload-form';
import {
  GenerateFromDescriptionForm,
  type AgentOption,
} from '@/components/admin/orchestration/evaluations-foundations/generate-from-description-form';

interface DatasetNewTabsProps {
  agents: AgentOption[];
}

export function DatasetNewTabs({ agents }: DatasetNewTabsProps): React.ReactElement {
  return (
    <Tabs defaultValue="upload" className="space-y-6">
      <TabsList>
        <TabsTrigger value="upload">
          <FileUp className="mr-1.5 h-4 w-4" aria-hidden />
          Upload file
        </TabsTrigger>
        <TabsTrigger value="generate">
          <Sparkles className="mr-1.5 h-4 w-4" aria-hidden />
          Generate from description
        </TabsTrigger>
      </TabsList>
      <TabsContent value="upload" className="mt-0">
        <DatasetUploadForm />
      </TabsContent>
      <TabsContent value="generate" className="mt-0">
        <GenerateFromDescriptionForm agents={agents} />
      </TabsContent>
    </Tabs>
  );
}
