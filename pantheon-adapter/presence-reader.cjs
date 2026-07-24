// presence-reader.cjs — VENDORED reader half of the ever529 human-presence donor (WS2 port).
//
// DONOR: agent-room-mac src/human-presence.cjs @ branch ever529-r2, commit
// 45de68e (reader functions copied verbatim — logic, thresholds, reason strings
// and UNKNOWN-on-every-failure posture unchanged). Reader-ONLY on purpose: the
// WRITER stays in agent-room's supervisor (the seat's PTY owner is the only
// process that can observe keystrokes); this adapter only ever READS the file
// that writer maintains. The two repos share the FILE CONTRACT, not code:
//   <memRoot>/runtime/human-presence.json
//   { seat, last_human_input_at: ISO, observed_at: ISO, writer_pid }
// Drift guard: any change to the donor's reader semantics must re-land here by
// hand — the contract test in presence-reader.test.cjs pins the semantics
// (observer-staleness-before-occupancy, tri-state, never-throw), so a silent
// re-vendor that alters behavior fails loudly.
//
// TWO DIFFERENT FACTS — never conflate them (donor doctrine, verbatim):
//   last_human_input_at — WHEN a human last produced a real keystroke. Frozen while idle.
//   observed_at         — WHEN the writer last confirmed "I am alive and I looked".
// THE CENTRAL TRAP: a dead/frozen writer's last_human_input_at can read as
// "idle for a long time" though nobody confirmed anyone left. The reader checks
// observer staleness FIRST, before it will say IDLE — or even OCCUPIED.
'use strict';

const fs = require('fs');
const path = require('path');

const WRITE_INTERVAL_MS = Number(process.env.ROOM_HUMAN_PRESENCE_INTERVAL_MS || 5000);
const OCCUPANCY_THRESHOLD_MS = Number(process.env.ROOM_HUMAN_PRESENCE_OCCUPANCY_MS || 5 * 60 * 1000);
const OBSERVER_STALE_THRESHOLD_MS = Number(process.env.ROOM_HUMAN_PRESENCE_STALE_MS || 6 * WRITE_INTERVAL_MS);

function presencePath(memRoot) {
  return path.join(String(memRoot), 'runtime', 'human-presence.json');
}

// readHumanPresence({ memRoot, seat, now }) -> { state, reason, ...ages, ... }
// THREE states, never a bare boolean:
//   OCCUPIED — now - last_human_input_at < OCCUPANCY_THRESHOLD_MS
//   IDLE     — observer confirmed fresh AND past the occupancy threshold
//   UNKNOWN  — file missing/unparseable/malformed, OR observed_at itself is stale
// Never throws — every failure mode (missing file, bad JSON, wrong shape, unparseable
// timestamps, a seat-id mismatch against the file's own `seat` field) resolves to
// UNKNOWN rather than an exception.
function readHumanPresence({ memRoot, seat, now = Date.now() }) {
  const file = presencePath(memRoot);
  const base = { path: file, seat, last_human_input_at: null, observed_at: null, last_human_input_age_ms: null, observed_age_ms: null };

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { state: 'UNKNOWN', reason: 'missing-file', ...base };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'UNKNOWN', reason: 'malformed-json', ...base };
  }

  if (!parsed || typeof parsed !== 'object' ||
      typeof parsed.last_human_input_at !== 'string' ||
      typeof parsed.observed_at !== 'string') {
    return {
      state: 'UNKNOWN', reason: 'malformed-shape', ...base,
      last_human_input_at: (parsed && typeof parsed.last_human_input_at === 'string') ? parsed.last_human_input_at : null,
      observed_at: (parsed && typeof parsed.observed_at === 'string') ? parsed.observed_at : null,
    };
  }

  const lastMs = Date.parse(parsed.last_human_input_at);
  const obsMs = Date.parse(parsed.observed_at);
  if (!Number.isFinite(lastMs) || !Number.isFinite(obsMs)) {
    return { state: 'UNKNOWN', reason: 'malformed-timestamp', ...base, last_human_input_at: parsed.last_human_input_at, observed_at: parsed.observed_at };
  }

  // Defensive: a file resolved for the wrong seat (memRoot mixup, stale copy) must never be
  // trusted as this seat's occupancy. Only checked when both sides actually carry a seat id.
  if (seat && parsed.seat && parsed.seat !== seat) {
    return {
      state: 'UNKNOWN', reason: 'seat-mismatch', ...base,
      last_human_input_at: parsed.last_human_input_at, observed_at: parsed.observed_at,
      last_human_input_age_ms: now - lastMs, observed_age_ms: now - obsMs, file_seat: parsed.seat,
    };
  }

  const lastAge = now - lastMs;
  const obsAge = now - obsMs;
  const common = {
    path: file, seat,
    last_human_input_at: parsed.last_human_input_at, observed_at: parsed.observed_at,
    last_human_input_age_ms: lastAge, observed_age_ms: obsAge, writer_pid: parsed.writer_pid,
  };

  // THE CENTRAL TRAP (header): observer freshness gates BEFORE last_human_input_at gets to say
  // anything — a dead writer's frozen snapshot must never read as "confirmed idle".
  if (obsAge > OBSERVER_STALE_THRESHOLD_MS) {
    return { state: 'UNKNOWN', reason: 'observer-stale', ...common };
  }
  if (lastAge < OCCUPANCY_THRESHOLD_MS) {
    return { state: 'OCCUPIED', reason: 'recent-human-input', ...common };
  }
  return { state: 'IDLE', reason: 'observer-fresh-no-recent-input', ...common };
}

// makePresenceDep({ memRoot, seat, now }) — the concrete wiring this port exists
// for: returns a zero-arg closure matching gatherSeatStatus's deps.readHumanPresence
// slot. `now` is injectable for tests only; production callers pass memRoot+seat
// and the clock is real per call (never captured at factory time — a status read
// minutes later must judge freshness against ITS now, not the factory's).
function makePresenceDep({ memRoot, seat, now }) {
  return () => readHumanPresence({ memRoot, seat, ...(now !== undefined ? { now: typeof now === 'function' ? now() : now } : {}) });
}

module.exports = {
  readHumanPresence,
  makePresenceDep,
  presencePath,
  OCCUPANCY_THRESHOLD_MS,
  OBSERVER_STALE_THRESHOLD_MS,
  WRITE_INTERVAL_MS,
};
