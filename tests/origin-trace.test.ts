import { describe, expect, it } from 'vitest';
import { isTraceId } from '../src/index.js';

// SyncEvent.origin_trace (sync.proto, 0.7.0) is a W3C trace-id. The client that mints it and the
// server that logs it check the form with this one function, so they agree on what is malformed.
describe('isTraceId', () => {
  it('accepts 32 lowercase hex characters, not all zero', () => {
    expect(isTraceId('4bf92f3577b34da6a3ce929d0e0e4736')).toBe(true);
    expect(isTraceId('00000000000000000000000000000001')).toBe(true);
    expect(isTraceId('ffffffffffffffffffffffffffffffff')).toBe(true);
  });

  it('refuses the all-zero id, which W3C reserves as invalid', () => {
    expect(isTraceId('00000000000000000000000000000000')).toBe(false);
  });

  it('refuses every other length, so an over-long value is malformed, not truncated', () => {
    expect(isTraceId('')).toBe(false);
    expect(isTraceId('4bf92f3577b34da6a3ce929d0e0e473')).toBe(false);
    expect(isTraceId('4bf92f3577b34da6a3ce929d0e0e47360')).toBe(false);
    expect(isTraceId('4bf92f3577b34da6a3ce929d0e0e4736'.repeat(64))).toBe(false);
  });

  it('refuses uppercase, non-hex, a dashed uuid, padding and a trailing newline', () => {
    expect(isTraceId('4BF92F3577B34DA6A3CE929D0E0E4736')).toBe(false);
    expect(isTraceId('4bf92f3577b34da6a3ce929d0e0e473g')).toBe(false);
    expect(isTraceId('4bf92f35-77b3-4da6-a3ce-929d0e0e4736')).toBe(false);
    expect(isTraceId(' 4bf92f3577b34da6a3ce929d0e0e4736')).toBe(false);
    expect(isTraceId('4bf92f3577b34da6a3ce929d0e0e4736\n')).toBe(false);
  });

  it('refuses a value that is not a string, absent included', () => {
    expect(isTraceId(undefined)).toBe(false);
    expect(isTraceId(null)).toBe(false);
    expect(isTraceId(0x4bf92f35)).toBe(false);
    expect(isTraceId(['4bf92f3577b34da6a3ce929d0e0e4736'])).toBe(false);
  });
});
