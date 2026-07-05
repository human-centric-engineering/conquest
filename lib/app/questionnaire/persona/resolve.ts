/**
 * Selectable interviewer personas — runtime resolution (DB seam).
 *
 * Resolves the persona menu a respondent surface needs: the per-version library (narrowed, filled
 * with the built-ins when empty), whether respondent selection is on for this version, the default
 * persona key, and the respondent's current choice off the session row. Mirrors the intro resolver
 * (`lib/app/questionnaire/intro/resolve.ts`): server-only (reads Prisma); the `persona/settings.ts`
 * narrowers are pure and shared with the read/write paths.
 *
 * `enabled` here means "show the picker": it does NOT consult the platform flag — the caller (route /
 * page) gates on `isPersonaSelectionEnabled()` first, exactly as the intro surface does. A library
 * with fewer than two personas can't offer a meaningful choice, so `enabled` is false then.
 */

import { prisma } from '@/lib/db/client';
import { narrowPersonas, narrowPersonaSelection } from '@/lib/app/questionnaire/persona/settings';

/**
 * One persona as the respondent sees it — name + description only. The `tone` block (which holds the
 * system-prompt prose) is deliberately stripped: it drives the interviewer server-side and is never
 * shipped to the respondent client.
 */
export interface PersonaMenuOption {
  key: string;
  label: string;
  description: string;
}

/** The client-safe persona menu a respondent surface renders (no tone / prompt prose). */
export interface ResolvedSessionPersonas {
  /** Whether the picker should be shown: per-version toggle on AND at least two personas. */
  enabled: boolean;
  /** The persona cards to choose from. Always populated (built-ins when unconfigured). */
  personas: PersonaMenuOption[];
  /** The persona this respondent has chosen, or `null` when they haven't (⇒ the default applies). */
  selectedPersonaKey: string | null;
  /** The default persona key (pre-selected card; applied when nothing is chosen). */
  defaultPersonaKey: string;
}

/**
 * Resolve the persona menu for an existing session. Returns `null` when the session id doesn't
 * resolve (caller maps that to "no picker"). When the version has selection toggled off (or too few
 * personas), returns `enabled: false` with the complete library so callers can branch uniformly
 * without a second query.
 */
export async function resolveSessionPersonas(
  sessionId: string
): Promise<ResolvedSessionPersonas | null> {
  const session = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: {
      selectedPersonaKey: true,
      version: {
        select: {
          config: { select: { personas: true, personaSelection: true } },
        },
      },
    },
  });
  if (!session) return null;

  const config = session.version.config;
  const personas = narrowPersonas(config?.personas);
  const selection = narrowPersonaSelection(config?.personaSelection);

  return {
    enabled: selection.enabled && personas.length >= 2,
    // Strip the tone/prompt prose — the respondent only ever sees name + description.
    personas: personas.map((p) => ({ key: p.key, label: p.label, description: p.description })),
    selectedPersonaKey: session.selectedPersonaKey,
    defaultPersonaKey: selection.defaultPersonaKey,
  };
}
