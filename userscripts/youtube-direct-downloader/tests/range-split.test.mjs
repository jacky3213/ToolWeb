import test from 'node:test';
import assert from 'node:assert/strict';
import { splitRanges, formatBytes } from '../src/range-split.js';

test('splitRanges 均勻切分', () => {
  assert.deepEqual(splitRanges(100, 40), [
    { start: 0, end: 39 }, { start: 40, end: 79 }, { start: 80, end: 99 },
  ]);
});

test('splitRanges 邊界：剛好整除、單片、無效輸入', () => {
  assert.deepEqual(splitRanges(80, 40), [{ start: 0, end: 39 }, { start: 40, end: 79 }]);
  assert.deepEqual(splitRanges(10, 40), [{ start: 0, end: 9 }]);
  assert.deepEqual(splitRanges(0, 40), []);
  assert.deepEqual(splitRanges(-5, 40), []);
  assert.deepEqual(splitRanges(NaN, 40), []);
});

test('formatBytes 人類可讀', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.00 MB');
  assert.equal(formatBytes(1536), '1.50 MB');
  assert.equal(formatBytes(1024 ** 3), '1.00 GB');
});
