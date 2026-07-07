import assert from 'node:assert/strict';

import {
  delta,
  fmtHrs,
  fmtTok,
  renderSvg,
  stats,
} from './generate-card.mjs';

assert.equal(fmtTok(5600000000), '5.6B');
assert.equal(fmtTok(47400000), '47.4M');
assert.equal(fmtTok(1200), '1.2K');
assert.equal(fmtHrs(4005), '1h 7m');
assert.equal(delta(125, 100), '+25.0%');
assert.equal(delta(75, 100), '-25.0%');
assert.equal(delta(75, 0), '');

const buckets = [
  {
    estimatedCost: 12.34,
    totalTokens: 1000,
    inputTokens: 300,
    outputTokens: 200,
    cachedInputTokens: 500,
    bucketStart: '2026-07-06T16:00:00.000Z',
  },
];
const sessions = [
  {
    activeSeconds: 4005,
    durationSeconds: 7200,
    messageCount: 12,
    userMessageCount: 5,
    firstMessageAt: '2026-07-06T16:30:00.000Z',
    userPromptHours: Array.from({ length: 24 }, (_, i) => (i === 8 ? 3 : 0)),
  },
];

const totals = stats(buckets, sessions);
assert.equal(totals.cost, 12.34);
assert.equal(totals.total, 1500);
assert.equal(totals.cached, 500);
assert.equal(totals.sessions, 1);
assert.equal(totals.msgs, 12);
assert.equal(totals.userMsgs, 5);

const svg = renderSvg({ buckets, sessions, nowMs: Date.UTC(2026, 6, 7, 12, 0, 0) });
assert.match(svg, /Vibe Usage 7-day dashboard/);
assert.match(svg, /总 Token/);
assert.match(svg, /1\.5K/);
assert.match(svg, /更新于 2026\/07\/07 20:00 UTC\+8/);
