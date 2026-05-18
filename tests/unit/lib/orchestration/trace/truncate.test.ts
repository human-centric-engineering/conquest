/**
 * Tests for `lib/orchestration/trace/truncate.ts`.
 *
 * Pure utility — head/middle/tail string sampling + safe JSON serialise.
 * Shared by the supervisor's prompt builder and the deterministic
 * Markdown renderer. Direct tests so a regression in either consumer
 * doesn't mask a bug here.
 */

import { describe, it, expect } from 'vitest';

import {
  DEFAULT_PER_STEP_CAP_BYTES,
  TERMINAL_HEAD_CAP_BYTES,
  sampleString,
  serialiseStepOutput,
} from '@/lib/orchestration/trace/truncate';

describe('sampleString', () => {
  it('returns the original string when bytes <= capBytes', () => {
    expect(sampleString('hello', 100)).toBe('hello');
  });

  it('returns the original string at the exact cap boundary', () => {
    const exact = 'A'.repeat(60);
    expect(sampleString(exact, 60)).toBe(exact);
  });

  it('samples head + middle + tail with elision markers when over the cap', () => {
    const input = 'A'.repeat(100) + 'M'.repeat(100) + 'Z'.repeat(100);
    const out = sampleString(input, 60);
    expect(out).toContain('A');
    expect(out).toContain('M');
    expect(out).toContain('Z');
    expect(out).toContain('truncated');
    expect(out.length).toBeLessThan(input.length);
  });

  it('includes byte-count elision marker reflecting the elided slice', () => {
    const input = 'X'.repeat(10_000);
    const out = sampleString(input, 600);
    // Three slices of ~200 bytes each = ~600 bytes shown; ~9400 elided.
    expect(out).toMatch(/9\d{3} bytes elided/);
  });

  it('handles multibyte UTF-8 correctly via Buffer.byteLength', () => {
    // emoji is 4 bytes in utf-8 but 2 JS char-units; the function checks
    // byte length, not character length, before truncating.
    const input = '😀'.repeat(1000); // 4000 bytes
    const out = sampleString(input, 200);
    expect(out.length).toBeLessThan(input.length);
    expect(out).toContain('truncated');
  });

  it('exports default cap constants that are positive integers', () => {
    expect(DEFAULT_PER_STEP_CAP_BYTES).toBeGreaterThan(0);
    expect(TERMINAL_HEAD_CAP_BYTES).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_PER_STEP_CAP_BYTES)).toBe(true);
    expect(Number.isInteger(TERMINAL_HEAD_CAP_BYTES)).toBe(true);
  });
});

describe('serialiseStepOutput', () => {
  it('returns the input verbatim when given a string', () => {
    expect(serialiseStepOutput('hello world')).toBe('hello world');
  });

  it('JSON-stringifies object inputs with 2-space indent', () => {
    expect(serialiseStepOutput({ a: 1, b: 'x' })).toBe('{\n  "a": 1,\n  "b": "x"\n}');
  });

  it('handles numbers, booleans, null', () => {
    expect(serialiseStepOutput(42)).toBe('42');
    expect(serialiseStepOutput(true)).toBe('true');
    expect(serialiseStepOutput(null)).toBe('null');
  });

  it('falls back to an explanatory placeholder when JSON.stringify throws (circular reference)', () => {
    // Construct a circular object — JSON.stringify will throw a TypeError.
    const cycle: Record<string, unknown> = { name: 'parent' };
    cycle.self = cycle;
    const out = serialiseStepOutput(cycle);
    expect(out).toContain('could not serialize step output');
    expect(out).toMatch(/circular|cycle|JSON\.stringify/i);
  });

  it('falls back to placeholder for non-Error throws (defensive branch)', () => {
    // BigInt is the simplest way to make JSON.stringify throw a TypeError
    // that isn't a circular reference — same failure mode, different cause.
    const out = serialiseStepOutput({ big: 10n });
    expect(out).toContain('could not serialize step output');
  });
});
