/**
 * Experience-wide synthesis — read (P15.8).
 *
 * GET /api/v1/app/experiences/:id/synthesis
 *   Admin-only. Returns the stored synthesis for this experience, or an empty view when it has
 *   never been generated. Never 404s on a missing synthesis — only on a missing experience — so the
 *   panel can render "not generated yet" without special-casing an error.
 */

import { successResponse } from '@/lib/api/responses';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { getExperienceSynthesisView } from '@/lib/app/questionnaire/experiences/synthesis/persist';

type Params = { id: string };

const handleGet = withAdminAuth<Params>(async (_request, _session, { params }) => {
  const { id } = await params;

  const experience = await prisma.appExperience.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!experience) throw new NotFoundError('Experience not found');

  const view = await getExperienceSynthesisView(id);
  return successResponse(view);
});

export { handleGet as GET };
