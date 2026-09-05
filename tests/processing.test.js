import test from 'node:test';
import assert from 'node:assert/strict';
import {
  abortable,
  isCurrent,
  PREVIEW_BUDGET,
  previewSize,
  sampleTimes,
} from '../src/lib/processing.js';
import { planVideo, videoSize, videoResolutions } from '../src/lib/videoExport.js';

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

test('a video loop repeats whole times to clear the minimum length', () => {
  // 84 frames, a 20-frame window: 64 positions, 4.27 s at 15 fps.
  const plan = planVideo({
    totalFrames: 84,
    windowWidth: 19,
    fps: 15,
    minSeconds: 5,
  });
  assert.equal(plan.cycleFrames, 65);
  assert.equal(plan.loops, 2);
  assert.equal(plan.totalOutputFrames, 130);
  assert.ok(plan.duration >= 5);

  // Do not repeat a loop that already meets the minimum duration.
  assert.equal(
    planVideo({ totalFrames: 300, windowWidth: 10, fps: 15, minSeconds: 5 })
      .loops,
    1
  );

  // A one-frame window visits every source frame.
  const whole = planVideo({
    totalFrames: 84,
    windowWidth: 0,
    fps: 30,
    minSeconds: 1,
  });
  assert.equal(whole.cycleFrames, 84);
  assert.equal(whole.loops, 1);

  for (const fps of [5, 10, 15, 24, 30, 60]) {
    for (const minSeconds of [1, 5, 30]) {
      const { duration } = planVideo({
        totalFrames: 84,
        windowWidth: 60,
        fps,
        minSeconds,
      });
      assert.ok(duration >= minSeconds, `${fps} fps, ${minSeconds}s`);
    }
  }
});

test('video dimensions are even, because h.264 requires it', () => {
  assert.deepEqual(videoSize({ width: 893, height: 1341 }), {
    width: 894,
    height: 1342,
  });
  assert.deepEqual(videoSize({ width: 1080, height: 1620 }), {
    width: 1080,
    height: 1620,
  });
  assert.deepEqual(videoSize({ width: 1, height: 1 }), { width: 2, height: 2 });
});


test('a capped clip samples the whole sweep and keeps the still on a frame', () => {
  // Sample every fifth position to fit 450 positions into 90 frames.
  const plan = planVideo({
    totalFrames: 460, windowWidth: 10, fps: 30, minSeconds: 0,
    maxFrames: 90, stillPosition: 137,
  });
  assert.equal(plan.positions, 450);
  assert.equal(plan.stride, 5);
  assert.equal(plan.cycleFrames, 90);
  assert.equal(plan.stillFrame, 27);
  assert.ok(plan.sampled);
  // The still must match a sampled output frame.
  assert.equal(plan.startPosition + plan.stillFrame * plan.stride, 137);

  // Uncapped exports include every position, starting at zero.
  const full = planVideo({ totalFrames: 460, windowWidth: 10, fps: 30, minSeconds: 0 });
  assert.equal(full.stride, 1);
  assert.equal(full.startPosition, 0);
  assert.equal(full.cycleFrames, 450);

  for (let positions = 1; positions <= 400; positions += 7) {
    for (const still of [0, 1, (positions >> 1), positions - 1]) {
      const capped = planVideo({
        totalFrames: positions + 10, windowWidth: 10, fps: 30, minSeconds: 0,
        maxFrames: 90, stillPosition: still,
      });
      const label = `${positions} positions, still ${still}`;
      // Clamp still positions to the last valid window position.
      const expected = Math.min(still, positions - 1);
      assert.ok(capped.cycleFrames <= 90, label);
      assert.ok(capped.cycleFrames >= 1, label);
      assert.ok(Number.isInteger(capped.stillFrame), label);
      assert.ok(capped.stillFrame < capped.cycleFrames, label);
      assert.equal(capped.startPosition + capped.stillFrame * capped.stride, expected, label);
      // The last sampled position must still be inside the sweep.
      assert.ok(
        capped.startPosition + (capped.cycleFrames - 1) * capped.stride < positions,
        label
      );
    }
  }
});

test('video resolutions stop at the source or 4K in either orientation', () => {
  for (const [width, height, expected] of [
    [1800, 1050, [360, 480, 720, 1050]],
    [1920, 1080, [360, 480, 720, 1080]],
    [3840, 2160, [360, 480, 720, 1080, 2160]],
    [7680, 4320, [360, 480, 720, 1080, 2160]],
    [480, 270, [270]],
    [0, 0, []],
  ]) {
    assert.deepEqual(videoResolutions({ width, height }), expected);
    assert.deepEqual(videoResolutions({ width: height, height: width }), expected);
  }
});
