/**
 * Query contract for the F8.2 result-export endpoint.
 *
 * Extends the shared F8.1 analytics filter (date window + tag filter) with a `format`
 * selector, so a single GET route serves both CSV and JSON and an export mirrors exactly
 * the analytics view the admin is filtering. `resolveAnalyticsScope` (reused as-is)
 * turns the validated query into the concrete window the loader takes.
 */

import { z } from 'zod';

import { questionnaireAnalyticsQuerySchema } from '@/lib/app/questionnaire/analytics';

/** Export output formats. */
export const RESULTS_EXPORT_FORMATS = ['csv', 'json'] as const;
export type ResultsExportFormat = (typeof RESULTS_EXPORT_FORMATS)[number];

/** Analytics filter + a `format` selector (defaults to JSON). */
export const resultsExportQuerySchema = questionnaireAnalyticsQuerySchema.extend({
  format: z.enum(RESULTS_EXPORT_FORMATS).default('json'),
});

export type ResultsExportQuery = z.infer<typeof resultsExportQuerySchema>;
