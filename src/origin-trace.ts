// The form of SyncEvent.origin_trace (sync.proto, 0.7.0): a W3C trace-id. One check, so the client
// that mints the id and the server that logs it agree on which values are malformed.

const TRACE_ID = /^[0-9a-f]{32}$/;
const ZERO_TRACE_ID = '0'.repeat(32);

/**
 * Whether `value` is a well-formed origin_trace: 32 lowercase hex characters, not all zero (a W3C
 * trace-id). Every other value, of any length or type, is malformed: the server ignores it, and
 * logs only that it was malformed, never the value.
 */
export function isTraceId(value: unknown): value is string {
  return typeof value === 'string' && TRACE_ID.test(value) && value !== ZERO_TRACE_ID;
}
