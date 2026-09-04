import test from 'node:test';
import assert from 'node:assert/strict';
import {
  abortable,
  isCurrent,
  PREVIEW_BUDGET,
  previewSize,
  sampleTimes,
} from '../src/lib/processing.js';

test('timestamps land halfway inside frames, including clip boundaries', () => {
  const { times, total, step } = sampleTimes(2.8, 30);
  assert.equal(total, 84);
  assert.equal(step, 1);
  assert.equal(times.length, 84);
  assert.equal(times[0], 1 / 60);
  assert.ok(Math.abs(times.at(-1) - 83.5 / 30) < 1e-12);
  for (let i = 0; i < times.length; i++)
    assert.equal(Math.floor(times[i] * 30), i);
  assert.deepEqual(sampleTimes(0.001, 30).times, [0]);
});

test('long and fractional-rate videos remain bounded and ordered', () => {
  for (const fps of [23.976, 29.97, 30, 59.94, 120]) {
    const { times } = sampleTimes(3600, fps);
    assert.ok(times.length <= 600);
    assert.ok(
      times.every(
        (time, i) => time >= 0 && time < 3600 && (!i || time > times[i - 1])
      )
    );
  }
  for (const duration of [0, -1, Infinity, NaN])
    assert.throws(() => sampleTimes(duration, 30));
});

test('preview allocation stays within 64 MiB without upscaling', () => {
  for (const [width, height] of [
    [3840, 2160],
    [2160, 3840],
    [1080, 1620],
    [32, 20],
  ]) {
    for (const count of [1, 84, 600, 10000]) {
      const size = previewSize(width, height, count);
      assert.ok(size.width * size.height * 4 * count <= PREVIEW_BUDGET);
      assert.ok(size.width <= width && size.height <= height);
      assert.ok(Math.max(size.width, size.height) <= 720);
    }
  }
});

test('abort interrupts stalled work and safely consumes late failures', async () => {
  const controller = new AbortController();
  let reject;
  const pending = abortable(
    new Promise((_, fail) => {
      reject = fail;
    }),
    controller.signal
  );
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  reject(new Error('late encoder failure'));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(abortable(Promise.resolve(), controller.signal), {
    name: 'AbortError',
  });
});

test('stale source generations and stale jobs are rejected independently', () => {
  assert.equal(isCurrent({ generation: 2, requestId: 4 }, 2, 4), true);
  assert.equal(isCurrent({ generation: 1, requestId: 4 }, 2, 4), false);
  assert.equal(isCurrent({ generation: 2, requestId: 3 }, 2, 4), false);
});
