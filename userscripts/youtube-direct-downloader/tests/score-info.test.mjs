import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreInfoCandidate } from '../src/yt-client.js';

const mk = (over = {}) => ({
  ok: true, client: 'WEB', error: null,
  hasDirectUrls: false, hasSabr: false, isLoginRequired: false, ...over,
});

test('評分：可 decipher 直連 URL > SABR > 失敗/需登入', () => {
  assert.ok(scoreInfoCandidate(mk({ hasDirectUrls: true })) > scoreInfoCandidate(mk({ hasSabr: true })));
  assert.ok(scoreInfoCandidate(mk({ hasSabr: true })) > scoreInfoCandidate(mk()));
  assert.equal(scoreInfoCandidate(mk({ ok: false })), -1);
  assert.equal(scoreInfoCandidate(mk({ isLoginRequired: true })), -1);
});

test('評分：同級時直連+可選格式多者勝出', () => {
  const a = mk({ hasDirectUrls: true, formatCount: 12 });
  const b = mk({ hasDirectUrls: true, formatCount: 5 });
  assert.ok(scoreInfoCandidate(a) > scoreInfoCandidate(b));
});
