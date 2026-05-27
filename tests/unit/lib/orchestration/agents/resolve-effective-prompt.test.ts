/**
 * Tests for `lib/orchestration/agents/resolve-effective-prompt.ts`.
 *
 * Covers the full inheritance matrix per field:
 *   - agent text only (no profile)
 *   - profile text only (agent blank)
 *   - both set + mode='override' (agent wins)
 *   - both set + mode='append'   (joined `${profile}\n\n${agent}`)
 *   - both set + mode unspecified -> defaults to override
 *   - neither set                (null / source: 'none')
 *   - whitespace-only treated as null (re-inherit)
 *   - profile blank + mode='append' (agent text only, source: 'agent')
 *
 * Plus `composeSystemPromptString` ordering and section-header behaviour.
 */

import { describe, expect, it } from 'vitest';

import {
  composeSystemPromptString,
  resolveEffectivePrompt,
  type AgentPromptFields,
  type ProfilePromptFields,
} from '@/lib/orchestration/agents/resolve-effective-prompt';

const baseAgent: AgentPromptFields = {
  systemInstructions: 'Help users with their queries.',
};

const baseProfile: ProfilePromptFields = {
  id: 'profile_123',
  name: 'Support Family',
  persona: 'You are Sky, a calm senior support specialist.',
  brandVoiceInstructions: 'Friendly, concise, never use jargon.',
  guardrails: 'Never give medical or legal advice.',
};

describe('resolveEffectivePrompt — per-field inheritance', () => {
  describe('persona', () => {
    it('agent-only wins when no profile is attached', () => {
      const r = resolveEffectivePrompt({ ...baseAgent, persona: 'Agent persona.' }, null);
      expect(r.persona).toBe('Agent persona.');
      expect(r.sources.persona).toBe('agent');
    });

    it('inherits from profile when agent text is blank', () => {
      const r = resolveEffectivePrompt({ ...baseAgent }, baseProfile);
      expect(r.persona).toBe(baseProfile.persona);
      expect(r.sources.persona).toBe('profile');
    });

    it('override mode replaces the profile value when both are set', () => {
      const r = resolveEffectivePrompt(
        { ...baseAgent, persona: 'Agent persona.', personaMode: 'override' },
        baseProfile
      );
      expect(r.persona).toBe('Agent persona.');
      expect(r.sources.persona).toBe('agent');
    });

    it('append mode joins profile then agent with a blank line', () => {
      const r = resolveEffectivePrompt(
        { ...baseAgent, persona: 'Also: based in London.', personaMode: 'append' },
        baseProfile
      );
      expect(r.persona).toBe(`${baseProfile.persona}\n\nAlso: based in London.`);
      expect(r.sources.persona).toBe('profile+agent');
    });

    it('defaults to override when mode is unspecified', () => {
      const r = resolveEffectivePrompt({ ...baseAgent, persona: 'Agent persona.' }, baseProfile);
      expect(r.persona).toBe('Agent persona.');
      expect(r.sources.persona).toBe('agent');
    });

    it('returns null with source none when neither side is set', () => {
      const r = resolveEffectivePrompt({ ...baseAgent }, { ...baseProfile, persona: null });
      expect(r.persona).toBeNull();
      expect(r.sources.persona).toBe('none');
    });

    it('treats whitespace-only agent text as not set (re-inherits)', () => {
      const r = resolveEffectivePrompt({ ...baseAgent, persona: '   \n  ' }, baseProfile);
      expect(r.persona).toBe(baseProfile.persona);
      expect(r.sources.persona).toBe('profile');
    });

    it('append with blank profile yields agent text only, source agent', () => {
      const r = resolveEffectivePrompt(
        { ...baseAgent, persona: 'Agent persona.', personaMode: 'append' },
        { ...baseProfile, persona: null }
      );
      expect(r.persona).toBe('Agent persona.');
      expect(r.sources.persona).toBe('agent');
    });
  });

  describe('brandVoiceInstructions (voice)', () => {
    it('inherits from profile when blank', () => {
      const r = resolveEffectivePrompt({ ...baseAgent }, baseProfile);
      expect(r.brandVoiceInstructions).toBe(baseProfile.brandVoiceInstructions);
      expect(r.sources.brandVoiceInstructions).toBe('profile');
    });

    it('append mode joins profile + agent text', () => {
      const r = resolveEffectivePrompt(
        {
          ...baseAgent,
          brandVoiceInstructions: 'Greet returning users by name.',
          voiceMode: 'append',
        },
        baseProfile
      );
      expect(r.brandVoiceInstructions).toBe(
        `${baseProfile.brandVoiceInstructions}\n\nGreet returning users by name.`
      );
      expect(r.sources.brandVoiceInstructions).toBe('profile+agent');
    });

    it('override drops the profile value', () => {
      const r = resolveEffectivePrompt(
        { ...baseAgent, brandVoiceInstructions: 'Formal, technical.', voiceMode: 'override' },
        baseProfile
      );
      expect(r.brandVoiceInstructions).toBe('Formal, technical.');
      expect(r.sources.brandVoiceInstructions).toBe('agent');
    });
  });

  describe('guardrails', () => {
    it('append mode joins profile + agent', () => {
      const r = resolveEffectivePrompt(
        {
          ...baseAgent,
          guardrails: 'Also never quote internal pricing.',
          guardrailsMode: 'append',
        },
        baseProfile
      );
      expect(r.guardrails).toBe(`${baseProfile.guardrails}\n\nAlso never quote internal pricing.`);
      expect(r.sources.guardrails).toBe('profile+agent');
    });

    it('null + null = null source none', () => {
      const r = resolveEffectivePrompt({ ...baseAgent }, { ...baseProfile, guardrails: null });
      expect(r.guardrails).toBeNull();
      expect(r.sources.guardrails).toBe('none');
    });
  });

  describe('systemInstructions', () => {
    it('always comes from the agent and is marked as such', () => {
      const r = resolveEffectivePrompt(baseAgent, baseProfile);
      expect(r.systemInstructions).toBe(baseAgent.systemInstructions);
      expect(r.sources.systemInstructions).toBe('agent');
    });
  });

  describe('source map metadata', () => {
    it('records profile id + name when a profile is attached', () => {
      const r = resolveEffectivePrompt(baseAgent, baseProfile);
      expect(r.sources.profileId).toBe('profile_123');
      expect(r.sources.profileName).toBe('Support Family');
    });

    it('records nulls when no profile is attached', () => {
      const r = resolveEffectivePrompt(baseAgent, null);
      expect(r.sources.profileId).toBeNull();
      expect(r.sources.profileName).toBeNull();
    });
  });

  describe('modes are ignored when there is no profile', () => {
    it('append with no profile is a no-op (agent text only)', () => {
      const r = resolveEffectivePrompt(
        { ...baseAgent, persona: 'Only agent.', personaMode: 'append' },
        null
      );
      expect(r.persona).toBe('Only agent.');
      expect(r.sources.persona).toBe('agent');
    });
  });
});

describe('composeSystemPromptString', () => {
  it('joins all four sections in canonical order with blank lines', () => {
    const composed = composeSystemPromptString({
      persona: 'You are Sky.',
      systemInstructions: 'Help with billing.',
      guardrails: 'Never quote unreleased pricing.',
      brandVoiceInstructions: 'Friendly and concise.',
      sources: {
        persona: 'profile',
        systemInstructions: 'agent',
        guardrails: 'agent',
        brandVoiceInstructions: 'profile',
        profileId: null,
        profileName: null,
      },
    });
    expect(composed).toBe(
      '[Persona]\nYou are Sky.\n\n' +
        '[Instructions]\nHelp with billing.\n\n' +
        '[Guardrails]\nNever quote unreleased pricing.\n\n' +
        '[Brand Voice]\nFriendly and concise.'
    );
  });

  it('omits null sections cleanly (no empty headers)', () => {
    const composed = composeSystemPromptString({
      persona: null,
      systemInstructions: 'Just do the task.',
      guardrails: null,
      brandVoiceInstructions: null,
      sources: {
        persona: 'none',
        systemInstructions: 'agent',
        guardrails: 'none',
        brandVoiceInstructions: 'none',
        profileId: null,
        profileName: null,
      },
    });
    expect(composed).toBe('[Instructions]\nJust do the task.');
  });

  it('handles persona + instructions without guardrails or voice', () => {
    const composed = composeSystemPromptString({
      persona: 'You are X.',
      systemInstructions: 'Do Y.',
      guardrails: null,
      brandVoiceInstructions: null,
      sources: {
        persona: 'agent',
        systemInstructions: 'agent',
        guardrails: 'none',
        brandVoiceInstructions: 'none',
        profileId: null,
        profileName: null,
      },
    });
    expect(composed).toBe('[Persona]\nYou are X.\n\n[Instructions]\nDo Y.');
  });
});
