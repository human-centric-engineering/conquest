'use client';

/**
 * The Topics tab's client shell — everything Adaptive Scope needs in one place.
 *
 * Owns the one mutation runner with the workspace's fork-on-launch discipline (the same shape as
 * `version-settings-panel.tsx`): editing a launched version forks a new draft, surfaces the notice,
 * and redirects to that draft's Topics tab. A declined fork (`ForkCancelledError`) writes nothing
 * and shows no error.
 *
 * Two saves, two endpoints, deliberately: the topic set is a PUT that replaces the set, the
 * settings are a PATCH of one blob. Merging them into a single "save everything" button would mean
 * an admin fixing one typo in a topic also rewrites their rules, and a partial failure would leave
 * them unable to tell which half landed.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles } from 'lucide-react';

import {
  authoringMutate,
  ForkCancelledError,
} from '@/components/admin/questionnaires/authoring-mutate';
import { RoutingAnalystCard } from '@/components/admin/questionnaires/topics/routing-analyst-card';
import { RoutingMapDialog } from '@/components/admin/questionnaires/topics/routing-map-dialog';
import { ScopeExplainer } from '@/components/admin/questionnaires/topics/scope-explainer';
import { ScopeIssues } from '@/components/admin/questionnaires/topics/scope-issues';
import { ScopeIssueStrip } from '@/components/admin/questionnaires/topics/scope-issue-strip';
import { ScopeStatusHeader } from '@/components/admin/questionnaires/topics/scope-status-header';
import { ScopeSettingsCard } from '@/components/admin/questionnaires/topics/scope-settings-card';
import { PlanPreviewCard } from '@/components/admin/questionnaires/topics/plan-preview-card';
import { RoutingQualityCard } from '@/components/admin/questionnaires/topics/routing-quality-card';
import { ScopeEvaluationCard } from '@/components/admin/questionnaires/topics/scope-evaluation-card';
import {
  TopicListEditor,
  type DraftTopic,
} from '@/components/admin/questionnaires/topics/topic-list-editor';
import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import type { AdaptiveScopeSettings, ProposedGap } from '@/lib/app/questionnaire/scope/types';
import type { TopicsPayload } from '@/lib/app/questionnaire/scope/views';

export interface TopicsPanelProps {
  questionnaireId: string;
  versionId: string;
  payload: TopicsPayload;
}

export function TopicsPanel({ questionnaireId, versionId, payload }: TopicsPanelProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forkNotice, setForkNotice] = useState<number | null>(null);
  // The topic the routing map asked to edit. A counter rides with it so asking for the SAME topic
  // twice still moves the list — a plain key would be unchanged state on the second request and the
  // editor's effect would never re-fire.
  const [focusTopic, setFocusTopic] = useState<{ key: string; nonce: number } | null>(null);
  // A gap the Routing Analyst reported it couldn't formalize, asked to become a topic (F17.20).
  // Same nonce shape as `focusTopic`, and for the same reason — turning a second gap into a topic
  // must still add a second row.
  const [seedTopic, setSeedTopic] = useState<{
    description: string;
    criteria: string;
    nonce: number;
  } | null>(null);

  // A request from the Topics section below to run the Routing Analyst (F17.22 Phase 1). Same nonce
  // shape as the two above, and for the same reason: pressing the button twice must scroll and run
  // twice, and unchanged state would leave the card's effect silent on the second press.
  const [analystRequest, setAnalystRequest] = useState<{ nonce: number } | null>(null);

  const turnGapIntoTopic = (gap: ProposedGap) =>
    setSeedTopic((prev) => ({
      description: gap.explanation,
      criteria: gap.sourceQuote,
      nonce: (prev?.nonce ?? 0) + 1,
    }));

  // Release the busy lock when a FORK's redirect lands on the new version.
  //
  // Keyed on `versionId`, not on the payload object. `payload` is a fresh object on every RSC
  // render — a `router.refresh()` from any card on the page produces one, and so does any soft
  // navigation within this route — so keying on it released the lock at moments that have nothing
  // to do with the save completing, which is precisely the window the lock exists to close.
  //
  // A content signature was the other candidate and is worse: an admin who presses Save without
  // having changed anything produces an identical payload, the signature never changes, and the
  // page stays locked with no way out.
  //
  // The non-fork path does not wait for this — it releases in `run` itself, because `endpoint`
  // still names a version the admin is on and a second save there is merely a second save.
  useEffect(() => {
    setBusy(false);
  }, [versionId]);

  const endpoint = API.APP.QUESTIONNAIRES.versionTopics(questionnaireId, versionId);

  const run = async (method: 'PUT' | 'PATCH', body: unknown): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const { meta } = await authoringMutate(method, endpoint, body);
      if (meta?.forked) {
        setForkNotice(meta.versionNumber);
        // Carry the current query across the fork. Today that preserves nothing in particular;
        // once this tab is split into sub-tabs (`?tab=`), dropping it would silently return the
        // admin to the first sub-tab after every fork — on the version they have just been moved
        // to, which is the worst moment to lose their place.
        //
        // Read off `window.location` rather than `useSearchParams()`: this runs in an async
        // callback, so the live value is the honest one and a hook's render-time closure could be
        // a tab behind.
        const search = typeof window === 'undefined' ? '' : window.location.search;
        router.replace(
          `/admin/questionnaires/${questionnaireId}/v/${meta.versionId}/topics${search}`
        );
        router.refresh();
        // Deliberately stays busy. `endpoint` closes over the PRE-fork version id and stays wrong
        // until the redirect lands, so a second save released here would write to the version the
        // admin has just been moved off. The effect above releases it when `versionId` changes.
        return true;
      }
      router.refresh();
      setBusy(false);
      return true;
    } catch (err) {
      // The admin declined the fork confirmation → nothing was written; resync, no error banner.
      if (err instanceof ForkCancelledError) {
        router.refresh();
        setBusy(false);
        return false;
      }
      setError(err instanceof Error ? err.message : 'Something went wrong');
      router.refresh();
      setBusy(false);
      return false;
    }
  };

  /**
   * The header switch. Goes through the same runner as every other write on this tab, so it
   * inherits the busy lock, the fork confirmation and the declined-fork silent no-op — and because
   * the switch is controlled by `payload.settings.enabled`, a declined fork simply leaves it where
   * it was on the next render rather than stranding it in the clicked position.
   */
  const toggleEnabled = (next: boolean) => run('PATCH', { enabled: next });

  const saveTopics = (drafts: DraftTopic[]) =>
    run('PUT', {
      topics: drafts.map((d) => ({
        key: d.key.trim(),
        label: d.label.trim(),
        description: d.description.trim().length > 0 ? d.description.trim() : null,
        phase: d.phase,
        criteria: d.criteria.trim().length > 0 ? d.criteria.trim() : null,
        depth: d.depth,
        questionKeys: d.questionKeys,
        dataSlotKeys: d.dataSlotKeys,
      })),
    });

  // Fields are enumerated rather than spread, and that is load-bearing rather than an oversight:
  // `rules` reaches the server through this same PATCH but is edited as its own list, and a spread
  // would also push through any field the settings card does not own. The cost: every new
  // `AdaptiveScopeSettings` field is a two-place change — here and in the card.
  const saveSettings = (settings: AdaptiveScopeSettings) =>
    run('PATCH', {
      // `enabled` is deliberately ABSENT. The status header owns it, and this PATCH is a
      // read-merge-write — so including it here would let the card's draft (captured whenever it
      // last remounted) silently undo a toggle the admin made in the header seconds ago.
      maxConditionalTopics: settings.maxConditionalTopics,
      sessionBudgetSeconds: settings.sessionBudgetSeconds,
      secondsPerQuestionType: settings.secondsPerQuestionType,
      secondsPerDataSlot: settings.secondsPerDataSlot,
      includeCheckTopic: settings.includeCheckTopic,
      checkTopicPreference: settings.checkTopicPreference,
      minConfidence: settings.minConfidence,
      fallbackTopicKeys: settings.fallbackTopicKeys,
      announce: settings.announce,
      allowRespondentAmendment: settings.allowRespondentAmendment,
      plannerInstructions: settings.plannerInstructions,
      limitOpeningProbes: settings.limitOpeningProbes,
      maxOpeningProbes: settings.maxOpeningProbes,
      rules: settings.rules.map((r) => ({
        id: r.id,
        dataSlotKey: r.dataSlotKey,
        operator: r.operator,
        value: r.value,
        action: r.action,
        topicKey: r.topicKey,
      })),
    });

  const conditionalCount = payload.topics.filter((t) => t.phase === 'conditional').length;

  /**
   * Take the admin to the thing that fixes a finding.
   *
   * Reuses the topic-list focus handoff the routing map already drives — same nonce, same effect,
   * same "waits while the panel is hidden" gate. A finding about a topic and a map node about a
   * topic want the identical thing to happen, so they ask for it the identical way rather than
   * growing a second mechanism that behaves almost the same.
   */
  const goToIssue = (issue: { topicKey?: string }) => {
    if (!issue.topicKey) return;
    setFocusTopic((prev) => ({ key: issue.topicKey as string, nonce: (prev?.nonce ?? 0) + 1 }));
  };

  return (
    <div className="space-y-5">
      <ScopeExplainer />

      {/* Above everything, and always: the two questions this tab exists to answer are "is it on?"
          and "is it ready?", and both used to require scrolling past several screens of cards. */}
      <ScopeStatusHeader
        enabled={payload.settings.enabled}
        topicCount={payload.topics.length}
        conditionalCount={conditionalCount}
        uncoveredQuestions={payload.coverage.uncoveredQuestions}
        alwaysSeconds={payload.costs.alwaysSeconds}
        budgetSeconds={payload.costs.budgetSeconds}
        busy={busy}
        // Discarded deliberately: `run` reports its own outcome through `busy`, `error` and
        // `forkNotice`, and the header has nothing to do with a boolean it cannot act on.
        onToggleEnabled={(next) => void toggleEnabled(next)}
      />

      <ScopeIssueStrip issues={payload.issues} onSelectIssue={goToIssue} />

      {/* The map sits above every card rather than inside one: it is a view of the whole tab — the
          settings, the rules and the topic set together — and hanging it off any single card would
          suggest it only shows that card's half. */}
      <div className="flex justify-end">
        <RoutingMapDialog
          // Remount on the payload for the reason its neighbours do, and one this view sharpens: a
          // map is only true of the settings that produced it, so a stale graph sitting behind a
          // button after a save would be a picture of a version that no longer exists.
          key={`map-${payload.topics.map((t) => t.key).join('|')}-${payload.settings.enabled}-${payload.settings.rules.length}-${payload.settings.maxConditionalTopics}-${payload.settings.sessionBudgetSeconds}`}
          payload={payload}
          onEditTopic={(key) => setFocusTopic((prev) => ({ key, nonce: (prev?.nonce ?? 0) + 1 }))}
          disabled={busy}
        />
      </div>

      {forkNotice !== null && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          You edited a launched version — your changes were saved to a new draft (v{forkNotice}).
          You are now editing that draft.
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-3 text-sm"
        >
          {error}
        </div>
      )}

      {/* The analyst leads: on a freshly-ingested instrument its proposal IS the starting point,
          and an admin who scrolled past it to hand-author the same topics has wasted their time. */}
      <RoutingAnalystCard
        // Remount when the server payload changes so a discard or accept elsewhere in the workspace
        // cannot leave a stale proposal on screen.
        key={`analyst-${payload.draft?.generatedAt ?? 'none'}`}
        questionnaireId={questionnaireId}
        versionId={versionId}
        initialDraft={payload.draft}
        questionKeys={payload.inventory.questions.map((q) => q.key)}
        liveTopicCount={payload.topics.length}
        candidacy={payload.candidacy}
        autoTriggerPending={payload.autoTriggerPending}
        runRequest={analystRequest}
        onRunHandled={() => setAnalystRequest(null)}
        onTurnGapIntoTopic={turnGapIntoTopic}
        disabled={busy}
      />

      {/* Sits after the settings it reads and before the topic list it is a verdict on: an author
          adjusts criteria below, scrolls up, and re-runs. Hidden entirely when nothing is
          conditional — there is no decision to preview. */}
      <PlanPreviewCard
        // Remount when the server payload changes, for the same reason the two cards below do —
        // and one this card makes sharper. A verdict is only true of the settings that produced it,
        // so an author who runs the preview, edits a topic's criteria and saves would otherwise be
        // left looking at last run's plan sitting next to criteria that no longer produced it.
        key={`preview-${payload.topics.map((t) => t.key).join('|')}-${payload.settings.enabled}-${payload.settings.maxConditionalTopics}-${payload.settings.sessionBudgetSeconds}-${payload.settings.rules.length}`}
        questionnaireId={questionnaireId}
        versionId={versionId}
        form={payload.preview}
        topics={payload.topics}
        enabled={payload.settings.enabled}
        disabled={busy}
      />

      {/* Immediately after the dry-run, and deliberately: "what it would do" and "what it did" are
          the same question asked of intent and of evidence, and an author comparing them is doing
          exactly the check this tab exists for. Renders nothing until the version is switched on
          and has something to decide. */}
      <RoutingQualityCard
        questionnaireId={questionnaireId}
        versionId={versionId}
        enabled={payload.settings.enabled}
        conditionalCount={conditionalCount}
      />

      {/* A second, structural opinion — independent of the coherence checks above and of the
          behavioural evidence RoutingQualityCard reports. Sits beside its siblings on the tab
          rather than under the design-evaluation "Evaluations" tab: it judges topics/rules/
          settings, not questions, so it belongs with the surface it reviews. */}
      <ScopeEvaluationCard
        questionnaireId={questionnaireId}
        versionId={versionId}
        topics={payload.topics}
        rules={payload.settings.rules}
        dataSlots={payload.inventory.dataSlots}
        disabled={busy}
      />

      <ScopeSettingsCard
        // Remount the card when the server payload changes so a save's normalised result (clamped
        // numbers, dropped blanks, sorted rules) replaces the local draft rather than being hidden
        // behind it — the admin must see what a later read will actually produce.
        // NOT keyed on `enabled` — the header owns that now, and remounting this card when it
        // flips would discard an admin's unsaved settings edits for a change made elsewhere.
        key={`settings-${payload.settings.rules.length}`}
        settings={payload.settings}
        topics={payload.topics}
        dataSlots={payload.inventory.dataSlots}
        onSave={saveSettings}
        costs={payload.costs}
        busy={busy}
      />

      <section className="space-y-3">
        {/* The heading and the AI action share a row. The analyst has always been reachable, but
            only from its own card — above the settings, the preview, the quality card and the
            evaluation card, several screens from here. An admin who arrives at this list to decide
            which groups are conditional is at the exact point of need, and had nothing to press.
            The button does not duplicate the analyst; it asks the card above to run and scrolls
            them to it, so there is still one place a proposal is reviewed. */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h2 className="flex items-center gap-1.5 text-lg font-semibold">
              Topics
              <FieldHelp title="What a topic is">
                <p>
                  The unit adaptive scope decides about: a named group of questions and data slots,
                  with a phase saying when it runs and — if it is conditional — your criteria for
                  when it applies.
                </p>
                <p className="mt-2">
                  <strong>Every question should belong to exactly one topic.</strong> A question no
                  topic claims can never be asked once you switch on, and nothing else in the system
                  would tell you.
                </p>
                <p className="mt-2">
                  <strong>Size is not significant.</strong> A one-question topic is how you express
                  a fine-grained “only ask this if…”, so there is no second rule language to learn.
                </p>
              </FieldHelp>
            </h2>
            <p className="text-muted-foreground text-sm">
              Group the questions, then decide which groups are conditional. Uploading a document
              seeds one always-asked topic per section, so a fresh questionnaire starts with a
              complete set that changes nothing about how it runs.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={busy}
            onClick={() => setAnalystRequest((prev) => ({ nonce: (prev?.nonce ?? 0) + 1 }))}
          >
            <Sparkles className="mr-1.5 h-4 w-4" aria-hidden="true" />
            Set up conditional topics with AI
          </Button>
        </div>
        {/* The second level of the strip at the top of the tab. Both render the SAME
            `validateAdaptiveScope` output, so they cannot disagree about what is wrong — the
            difference is only how much of it each says, and where. This one sits against the rows
            it is about, and unlike the strip it also reports the all-clear. */}
        <ScopeIssues issues={payload.issues} enabled={payload.settings.enabled} />

        <TopicListEditor
          key={`topics-${payload.topics.map((t) => t.key).join('|')}`}
          topics={payload.topics}
          inventory={payload.inventory}
          onSave={saveTopics}
          busy={busy}
          enabled={payload.settings.enabled}
          focusTopic={focusTopic}
          onFocusHandled={() => setFocusTopic(null)}
          seedTopic={seedTopic}
          onSeedHandled={() => setSeedTopic(null)}
        />
      </section>
    </div>
  );
}
