/**
 * Deterministic keyword safety net for sensitive disclosures (pure).
 *
 * The LLM detector ({@link buildSensitivityDetectPrompt}) is the primary signal, but safeguarding
 * is too important to rest on a model call that can fail, time out, or miss. This net is the
 * non-LLM floor: when the message plainly contains a first-person harm disclosure (or an
 * unambiguous self-harm phrase), it forces a `high` assessment regardless of what the LLM did.
 *
 * Tuned to avoid obvious false positives: a bare harm word ("this survey is harassment") does NOT
 * trip it — it requires a FIRST-PERSON victim marker near the harm term, OR an explicit self-harm
 * phrase that is unambiguous on its own. A false positive here costs only an unneeded gentle tone +
 * support signpost; a false negative could drop a real disclosure, so the net leans toward catching.
 */

import type { SensitivityAssessment } from '@/lib/app/questionnaire/sensitivity/types';

/** Category recorded when only the keyword net (not the LLM) flagged the disclosure. */
export const KEYWORD_NET_CATEGORY = 'safeguarding concern';
/** Careful, non-graphic summary used when only the keyword net flagged the disclosure. */
export const KEYWORD_NET_SUMMARY = 'The respondent disclosed something sensitive.';

/** Unambiguous self-harm / suicide phrases — flagged on their own (no first-person marker needed). */
const SELF_HARM_PATTERNS: RegExp[] = [
  /\bsuicid(?:e|al)\b/,
  /\bkill(?:ing)?\s+myself\b/,
  /\bend(?:ing)?\s+my\s+life\b/,
  /\b(?:harm(?:ing)?|hurt(?:ing)?|cut(?:ting)?)\s+myself\b/,
  /\bself[-\s]?harm/,
  /\bwant\s+to\s+die\b/,
];

/** First-person victim markers — the disclosure is about the respondent, not a third party/opinion. */
const FIRST_PERSON =
  /\b(?:i['’]?m|i\s*am|i\s*was|i\s*feel|i\s*felt|i['’]?ve|i\s*have\s+been|being|me|my|myself)\b/;

/** Harm terms that, paired with a first-person marker, indicate a genuine disclosure. */
const HARM_TERM =
  /\b(?:abus(?:e|ed|ive|ing)|harass(?:ed|ing|ment)?|bull(?:y|ied|ying)|assault(?:ed|ing)?|threat(?:en|ened|ening|s)?|intimidat(?:e|ed|ing)|discriminat(?:e|ed|ion|ing)|victimi[sz](?:e|ed)|grop(?:e|ed|ing)|stalk(?:ed|ing)?|unsafe|not\s+safe|in\s+danger)\b/;

/**
 * Returns a `high`-severity {@link SensitivityAssessment} when the message plainly discloses harm,
 * otherwise `undefined`. Pure and deterministic — the same string always yields the same result.
 */
export function keywordSensitivityFloor(message: string): SensitivityAssessment | undefined {
  const text = message.toLowerCase();

  const selfHarm = SELF_HARM_PATTERNS.some((re) => re.test(text));
  const firstPersonHarm = FIRST_PERSON.test(text) && HARM_TERM.test(text);

  if (!selfHarm && !firstPersonHarm) return undefined;

  return {
    detected: true,
    severity: 'high',
    category: selfHarm ? 'self-harm' : KEYWORD_NET_CATEGORY,
    summary: KEYWORD_NET_SUMMARY,
  };
}
