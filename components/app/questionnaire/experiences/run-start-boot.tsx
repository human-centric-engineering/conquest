'use client';

/**
 * Start an experience run and land on its stable address (P15.3).
 *
 * The respondent entry point for a journey — the counterpart of `/q/<versionId>` for a single
 * questionnaire. It POSTs the run-create endpoint, which mints the run, its entry-leg session and
 * (for a no-login respondent) the httpOnly run cookie, then REPLACES the URL with
 * `/x/<publicRef>`.
 *
 * `router.replace`, never `push`: the start URL creates a run every time it is loaded. Leaving it
 * in history means a Back press mints a second journey and silently abandons the first, which is
 * both confusing and billable. Replacing it makes Back leave the journey, which is what someone
 * pressing Back actually means.
 *
 * The credential is NOT carried in the redirect. It went out as a cookie on the POST response, so
 * it is already in the browser by the time the replace happens — which is the entire reason the
 * address can be clean.
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { z } from 'zod';

import { API } from '@/lib/api/endpoints';

export interface RunStartBootProps {
  experienceId: string;
}

const startResponseSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      runId: z.string(),
      publicRef: z.string().nullable(),
    })
    .optional(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional(),
});

const GENERIC_ERROR = 'We could not start this right now. Please try again in a moment.';

export function RunStartBoot({ experienceId }: RunStartBootProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  // Dedup across React 19 StrictMode's double-invoke, which would otherwise mint two runs in
  // development. Deliberately not cancelled on cleanup: StrictMode's synchronous fake-unmount
  // fires that cleanup while the component is still mounted, so a cancel-guard would swallow the
  // only state update and leave the page spinning forever.
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    void (async () => {
      try {
        const res = await fetch(API.APP.EXPERIENCES.runs(experienceId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const parsed = startResponseSchema.safeParse(await res.json());
        const body = parsed.success ? parsed.data : null;

        if (!res.ok || !body?.success || !body.data) {
          setError(body?.error?.message ?? GENERIC_ERROR);
          return;
        }
        // No publicRef means a run we cannot address. Surfacing the generic error is the honest
        // outcome — the alternative is dropping the respondent somewhere they cannot return to.
        if (!body.data.publicRef) {
          setError(GENERIC_ERROR);
          return;
        }
        router.replace(`/x/${body.data.publicRef}`);
      } catch {
        setError(GENERIC_ERROR);
      }
    })();
  }, [experienceId, router]);

  if (error) {
    return (
      <main className="mx-auto flex min-h-[60vh] max-w-md items-center px-4">
        <div className="bg-card w-full rounded-xl border p-6 text-center">
          <p className="font-medium">We couldn&apos;t get started</p>
          <p className="text-muted-foreground mt-2 text-sm">{error}</p>
        </div>
      </main>
    );
  }

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
      <span className="sr-only">Getting things ready</span>
    </div>
  );
}
