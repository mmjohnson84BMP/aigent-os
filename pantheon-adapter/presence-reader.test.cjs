// presence-reader.test.cjs — the vendored ever529 reader + the wiring into the
// status leg. REAL fs (mkdtempSync fixtures) per the donor's own test doctrine;
// only the clock is hand-authored (fixture timestamps at fixed offsets) so stale
// cases need no multi-minute sleep. Run: node pantheon-adapter/presence-reader.test.cjs
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  readHumanPresence, makePresenceDep, presencePath,
  OCCUPANCY_THRESHOLD_MS, OBSERVER_STALE_THRESHOLD_MS,
} = require('./presence-reader.cjs');
const { gatherSeatStatus, isHumanLive } = require('./seat-status.cjs');

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`ok: ${name}`); }
  catch (e) { failed++; console.log(`FAIL: ${name} — ${e.message}`); }
};

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ws2-presence-'));
const writeFixture = (memRoot, obj) => {
  fs.mkdirSync(path.join(memRoot, 'runtime'), { recursive: true });
  fs.writeFileSync(presencePath(memRoot), typeof obj === 'string' ? obj : JSON.stringify(obj));
};
const NOW = Date.parse('2026-07-24T23:00:00.000Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

// ── vendored reader: every failure mode is UNKNOWN with its donor reason ────
check('missing file → UNKNOWN/missing-file', () => {
  const r = readHumanPresence({ memRoot: root(), seat: 'metis', now: NOW });
  assert.equal(r.state, 'UNKNOWN'); assert.equal(r.reason, 'missing-file');
});

check('malformed JSON → UNKNOWN/malformed-json', () => {
  const m = root(); writeFixture(m, '{nope');
  const r = readHumanPresence({ memRoot: m, seat: 'metis', now: NOW });
  assert.equal(r.state, 'UNKNOWN'); assert.equal(r.reason, 'malformed-json');
});

check('missing fields → UNKNOWN/malformed-shape', () => {
  const m = root(); writeFixture(m, { seat: 'metis', observed_at: iso(0) });
  const r = readHumanPresence({ memRoot: m, seat: 'metis', now: NOW });
  assert.equal(r.state, 'UNKNOWN'); assert.equal(r.reason, 'malformed-shape');
});

check('unparseable timestamp → UNKNOWN/malformed-timestamp', () => {
  const m = root(); writeFixture(m, { seat: 'metis', last_human_input_at: 'not-a-time', observed_at: iso(0) });
  const r = readHumanPresence({ memRoot: m, seat: 'metis', now: NOW });
  assert.equal(r.state, 'UNKNOWN'); assert.equal(r.reason, 'malformed-timestamp');
});

check('seat mismatch → UNKNOWN/seat-mismatch, file_seat surfaced', () => {
  const m = root(); writeFixture(m, { seat: 'rev', last_human_input_at: iso(1000), observed_at: iso(0) });
  const r = readHumanPresence({ memRoot: m, seat: 'metis', now: NOW });
  assert.equal(r.state, 'UNKNOWN'); assert.equal(r.reason, 'seat-mismatch'); assert.equal(r.file_seat, 'rev');
});

check('THE CENTRAL TRAP: stale observer wins over recent keystroke — UNKNOWN, never OCCUPIED', () => {
  const m = root();
  writeFixture(m, { seat: 'metis', last_human_input_at: iso(1000), observed_at: iso(OBSERVER_STALE_THRESHOLD_MS + 1000) });
  const r = readHumanPresence({ memRoot: m, seat: 'metis', now: NOW });
  assert.equal(r.state, 'UNKNOWN'); assert.equal(r.reason, 'observer-stale');
});

check('fresh observer + recent keystroke → OCCUPIED', () => {
  const m = root(); writeFixture(m, { seat: 'metis', last_human_input_at: iso(1000), observed_at: iso(0), writer_pid: 42 });
  const r = readHumanPresence({ memRoot: m, seat: 'metis', now: NOW });
  assert.equal(r.state, 'OCCUPIED'); assert.equal(r.writer_pid, 42);
  assert.equal(r.last_human_input_age_ms, 1000);
});

check('fresh observer + old keystroke → IDLE (the only permitting state)', () => {
  const m = root(); writeFixture(m, { seat: 'metis', last_human_input_at: iso(OCCUPANCY_THRESHOLD_MS + 1), observed_at: iso(0) });
  const r = readHumanPresence({ memRoot: m, seat: 'metis', now: NOW });
  assert.equal(r.state, 'IDLE'); assert.equal(r.reason, 'observer-fresh-no-recent-input');
});

check('boundary: keystroke exactly at threshold is NOT occupied (strict <)', () => {
  const m = root(); writeFixture(m, { seat: 'metis', last_human_input_at: iso(OCCUPANCY_THRESHOLD_MS), observed_at: iso(0) });
  const r = readHumanPresence({ memRoot: m, seat: 'metis', now: NOW });
  assert.equal(r.state, 'IDLE');
});

// ── the wiring this port exists for: dep factory → status leg → guard ───────
check('makePresenceDep wires into gatherSeatStatus: IDLE flows through, guard permits', () => {
  const m = root(); writeFixture(m, { seat: 'metis', last_human_input_at: iso(OCCUPANCY_THRESHOLD_MS + 1), observed_at: iso(0) });
  const s = gatherSeatStatus({ seatId: 'metis', deps: { readHumanPresence: makePresenceDep({ memRoot: m, seat: 'metis', now: NOW }) } });
  assert.equal(s.presence.state, 'IDLE');
  assert.equal(isHumanLive(s), false);
});

check('OCCUPIED flows through, guard blocks', () => {
  const m = root(); writeFixture(m, { seat: 'metis', last_human_input_at: iso(1000), observed_at: iso(0) });
  const s = gatherSeatStatus({ seatId: 'metis', deps: { readHumanPresence: makePresenceDep({ memRoot: m, seat: 'metis', now: NOW }) } });
  assert.equal(s.presence.state, 'OCCUPIED');
  assert.equal(isHumanLive(s), true);
});

check('missing file flows through as UNKNOWN with reason, guard blocks', () => {
  const s = gatherSeatStatus({ seatId: 'metis', deps: { readHumanPresence: makePresenceDep({ memRoot: root(), seat: 'metis', now: NOW }) } });
  assert.equal(s.presence.state, 'UNKNOWN');
  assert.equal(s.presence.reason, 'missing-file');
  assert.equal(isHumanLive(s), true);
});

check('factory does not capture the clock: default-now dep judges per call', () => {
  const m = root();
  const dep = makePresenceDep({ memRoot: m, seat: 'metis' });   // no `now` — real clock
  writeFixture(m, { seat: 'metis', last_human_input_at: new Date().toISOString(), observed_at: new Date().toISOString() });
  assert.equal(dep().state, 'OCCUPIED');   // written NOW, judged NOW — must be occupied
});

console.log(failed ? `PRESENCE-READER.TEST: FAIL (${failed})` : 'PRESENCE-READER.TEST: PASS');
process.exit(failed ? 1 : 0);
