import test from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes } from '../src/range-split.js';

test('formatBytes 人類可讀', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.00 KB');
  assert.equal(formatBytes(1536), '1.50 KB');
  assert.equal(formatBytes(1024 ** 3), '1.00 GB');
});
