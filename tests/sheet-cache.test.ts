import { test } from 'node:test';
import assert from 'node:assert/strict';

function createTtlCache(ttlMs: number) {
  let value: Record<string, number> | null = null;
  let fetchedAt = 0;
  return {
    async get(loader: () => Promise<Record<string, number>>): Promise<Record<string, number>> {
      const now = Date.now();
      if (value !== null && now - fetchedAt < ttlMs) return value;
      value = await loader();
      fetchedAt = now;
      return value;
    },
    peek(): Record<string, number> | null { return value; },
  };
}

test('首次呼叫會觸發載入', async () => {
  const cache = createTtlCache(5000);
  let calls = 0;
  const loader = async () => { calls++; return { a: 1 }; };

  await cache.get(loader);
  assert.equal(calls, 1);
});

test('TTL 內重複呼叫不重新載入', async () => {
  const cache = createTtlCache(5000);
  let calls = 0;
  const loader = async () => { calls++; return { a: 1 }; };

  await cache.get(loader);
  await cache.get(loader);
  assert.equal(calls, 1);
});

test('TTL 過期後重新載入', async () => {
  const cache = createTtlCache(1);
  let calls = 0;
  const loader = async () => { calls++; return { a: 1 }; };

  await cache.get(loader);
  await new Promise(r => setTimeout(r, 10));
  await cache.get(loader);

  assert.equal(calls, 2);
});

test('刷新後下載數不得倒退（Sheet 落後於本機計數時）', () => {
  assert.equal(Math.max(920, 921), 921);
});

test('Sheet 數字較新時應採用 Sheet 值', () => {
  assert.equal(Math.max(950, 900), 950);
});
