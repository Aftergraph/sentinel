// Audit log — ENGINE S1 append-only in-memory event log.
//
// Every finding mutation (create, verification_state transition,
// ai-confidence set) appends one AuditEvent:
//   { seq, ts, type, findingId, from, to, actor, reason }
// seq is strictly monotonic within the process. The log is append-only:
// callers can list it but never rewrite or remove entries (tests may
// reset it via clear() for isolation).

let seq = 0;
const events = [];

export function append(type, { findingId = null, from = null, to = null, actor = null, reason = null } = {}) {
  seq += 1;
  const event = {
    seq,
    ts: new Date().toISOString(),
    type,
    findingId,
    from,
    to,
    actor,
    reason: reason ?? null,
  };
  events.push(event);
  return event;
}

// Aliases with explicit names; same backing store.
export const appendEvent = append;
export const appendAudit = append;

export function list() {
  return [...events];
}

export const listEvents = list;
export const listAudit = list;

export function clear() {
  seq = 0;
  events.length = 0;
}

export const reset = clear;
export const clearEvents = clear;
export const clearAudit = clear;
