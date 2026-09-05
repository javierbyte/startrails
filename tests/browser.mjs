import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';

// Exercise real browser decoders/canvases and the production static export.
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/harness') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<canvas style="width:480px;height:320px"></canvas>');
      return;
    }
    let file;
    if (/^\/src\/(lib|workers)\/[\w.]+\.js$/.test(path)) file = `.${path}`;
    else if (path === '/startrails' || path === '/startrails/')
      file = 'out/index.html';
    else if (path.startsWith('/startrails/') && !path.includes('..'))
      file = `out/${path.slice(12)}`;
    else throw new Error('Not found');
    const type = file.endsWith('.js')
      ? 'text/javascript'
      : file.endsWith('.html')
        ? 'text/html'
        : file.endsWith('.css')
          ? 'text/css'
          : file.endsWith('.json')
            ? 'application/json'
            : file.endsWith('.mp4')
              ? 'video/mp4'
              : file.endsWith('.jpg')
                ? 'image/jpeg'
                : 'application/octet-stream';
    res.setHeader('Content-Type', type);
    res.end(await readFile(file));
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
try {
  for (const [name, engine] of [
    ['chromium', chromium],
    ['webkit', webkit],
  ]) {
    const browser = await engine.launch(
      name === 'chromium' && process.env.CHROME_CHANNEL
        ? { channel: process.env.CHROME_CHANNEL }
        : {}
    );
    try {
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
      });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${url}/harness`);
      const result = await page.evaluate(async () => {
        const { createStacker } = await import('/src/lib/stackClient.js');
        const { framesFromVideoFile } = await import('/src/lib/video.js');
        const canvas = document.querySelector('canvas');
        const events = [];
        const stacker = createStacker({
          canvas,
          onEvent: (event) => events.push(event),
        });
        const until = async (predicate) => {
          const end = performance.now() + 30000;
          while (!predicate()) {
            if (performance.now() > end)
              throw new Error(
                `Timed out; events: ${events.map((e) => `${e.type}:${e.message || ''}`).join(',')}`
              );
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        };
        const frames = [];
        const input = document.createElement('canvas');
        input.width = 1200;
        input.height = 800;
        const ctx = input.getContext('2d');
        for (let i = 0; i < 40; i++) {
          ctx.fillStyle = '#030507';
          ctx.fillRect(0, 0, 1200, 800);
          for (let j = 0; j < 100; j++) {
            ctx.fillStyle = j % 2 ? '#405060' : '#b0c0d0';
            ctx.fillRect(
              20 + ((j * 113) % 1080) + i,
              20 + ((j * 79) % 740),
              1,
              1
            );
          }
          frames.push(
            new File(
              [
                await new Promise((resolve) =>
                  input.toBlob(resolve, 'image/png')
                ),
              ],
              `star-${i}.png`
            )
          );
        }
        const params = {
          power: 1,
          minOpacity: 0,
          first: 0,
          last: 39,
          rotation: 0,
        };
        stacker.cancelLoad();
        stacker.load(frames, params, 1);
        await until(() => events.some((e) => e.type === 'loaded'));
        const snapshot = () => {
          const target = document.createElement('canvas');
          target.width = 960;
          target.height = 640;
          target.getContext('2d').drawImage(canvas, 0, 0, 960, 640);
          return target.getContext('2d').getImageData(0, 0, 960, 640).data;
        };
        const fast = snapshot();
        await until(() => canvas.width === 960);
        const refined = snapshot();
        stacker.exportImage({ ...params, scale: 1 });
        await until(() => events.some((e) => e.type === 'exportDone'));
        const exported = events.find((e) => e.type === 'exportDone');
        const bitmap = await createImageBitmap(exported.blob);
        const reference = document.createElement('canvas');
        reference.width = 960;
        reference.height = 640;
        const referenceCtx = reference.getContext('2d');
        referenceCtx.drawImage(bitmap, 0, 0, 960, 640);
        bitmap.close();
        const pixels = referenceCtx.getImageData(0, 0, 960, 640).data;
        const error = (data) =>
          data.reduce(
            (sum, value, i) =>
              sum + (i % 4 === 3 ? 0 : Math.abs(value - pixels[i])),
            0
          ) /
          (960 * 640 * 3);
        const fastError = error(fast),
          refinedError = error(refined);
        // Linear falloff steps down by a fixed 1/trail per frame, so only the
        // newest four frames reach the stack. Row 20 carries exactly one star
        // per frame -- j=0, marching one pixel right each time -- so frames 36
        // to 39 land at 25/50/75/100% on columns 56 to 59 and every earlier
        // column stays at the #030507 background.
        events.length = 0;
        stacker.exportImage({ ...params, fade: 'linear', trail: 4, scale: 1 });
        await until(() => events.some((e) => e.type === 'exportDone'));
        const linear = events.find((e) => e.type === 'exportDone');
        const linearBitmap = await createImageBitmap(linear.blob);
        const linearCanvas = document.createElement('canvas');
        linearCanvas.width = 1200;
        linearCanvas.height = 800;
        const linearCtx = linearCanvas.getContext('2d');
        linearCtx.drawImage(linearBitmap, 0, 0);
        linearBitmap.close();
        const row = linearCtx.getImageData(0, 20, 1200, 1).data;
        // R+G+B rather than one channel: JPEG subsamples chroma but keeps luma
        // per pixel, so the sum survives where a single channel can drift.
        const lum = (x) => row[x * 4] + row[x * 4 + 1] + row[x * 4 + 2];
        const linearTail = [lum(56), lum(57), lum(58), lum(59)];
        const linearDropped = Math.max(
          ...Array.from({ length: 31 }, (_, i) => lum(20 + i))
        );
        const linearFrames = linear.frames;
        // Rapid changes must settle on the newest range and rotation.
        for (let i = 0; i < 12; i++)
          stacker.preview({
            ...params,
            last: i + 1,
            rotation: i === 11 ? 90 : 0,
          });
        await until(() => canvas.width === 640 && canvas.height === 960);
        events.length = 0;
        stacker.exportImage({ ...params, rotation: 90, scale: 1 });
        await until(() => events.some((e) => e.type === 'exportDone'));
        const rotated = events.find((e) => e.type === 'exportDone');
        if (rotated.width !== 800 || rotated.height !== 1200)
          throw new Error('Incorrect rotated output dimensions');
        // A replacement source invalidates even a finished export's metadata/download continuation.
        stacker.cancelLoad();
        if (rotated.isCurrent()) throw new Error('Stale export remained valid');
        events.length = 0;
        stacker.load(frames, params, 2);
        stacker.cancelLoad();
        stacker.load([frames[0]], { ...params, last: 0 }, 3);
        await until(() =>
          events.some((e) => e.type === 'loaded' && e.requestId === 3)
        );
        if (events.some((e) => e.requestId === 2))
          throw new Error('Stale load was delivered');
        events.length = 0;
        stacker.exportImage({ ...params, last: 0, scale: 1 });
        stacker.cancelExport();
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (events.some((e) => e.type === 'exportDone'))
          throw new Error('Cancelled export completed');
        // Decode failure must recover when another source opens.
        stacker.cancelLoad();
        stacker.load(
          [new File(['broken'], 'broken.jpg')],
          { ...params, last: 0 },
          4
        );
        await until(() =>
          events.some((e) => e.type === 'error' && e.requestId === 4)
        );
        const videoFile = new File(
          [await (await fetch('/startrails/example-startrail.mp4')).blob()],
          'sample.mp4',
          { type: 'video/mp4' }
        );
        const controller = new AbortController();
        const extracted = await framesFromVideoFile(videoFile, {
          signal: controller.signal,
        });
        if (
          extracted.source.file !== videoFile ||
          extracted.frames.length > 600
        )
          throw new Error('Video source retention changed');
        const proxy = await createImageBitmap(extracted.frames[0]);
        if (proxy.width >= extracted.source.width)
          throw new Error('Video retained full-size JPEGs');
        proxy.close();
        events.length = 0;
        stacker.cancelLoad();
        stacker.load(
          extracted.frames,
          { ...params, last: extracted.frames.length - 1 },
          5,
          extracted.source
        );
        await until(() => events.some((e) => e.type === 'loaded'));
        stacker.exportImage({
          ...params,
          last: extracted.frames.length - 1,
          scale: 0.5,
        });
        await until(() => events.some((e) => e.type === 'exportDone'));
        stacker.destroy();
        // A new worker can reuse the ordinary DOM canvas after teardown.
        const replacement = createStacker({ canvas, onEvent: () => {} });
        replacement.destroy();
        return {
          fastError,
          refinedError,
          linearTail,
          linearDropped,
          linearFrames,
          videoFrames: extracted.frames.length,
        };
      });
      assert.ok(result.refinedError < result.fastError, JSON.stringify(result));
      const [q, h, tq, full] = result.linearTail;
      assert.ok(
        q < h && h < tq && tq < full,
        `Linear falloff is not a descending tail: ${JSON.stringify(result.linearTail)}`
      );
      assert.ok(
        q > full * 0.15 && q < full * 0.4,
        `Oldest trail frame is not near a quarter of the newest: ${JSON.stringify(result.linearTail)}`
      );
      assert.ok(
        result.linearDropped < q / 2,
        `Frames past the trail still reached the stack: ${result.linearDropped} vs ${q}`
      );
      assert.equal(result.linearFrames, 4);
      console.log(`${name} rendering:`, result);
      // Verify the built app, including base-path worker and prebuilt sample assets.
      await page.goto(`${url}/startrails`);
      const exportButton = page.getByRole('button', {
        name: 'Export JPEG',
        exact: true,
      });
      await exportButton.click({ timeout: 30000 });
      // A source change during export must suppress the old download.
      const downloads = [];
      page.on('download', (download) => downloads.push(download));
      await page
        .locator('input[type=file]')
        .first()
        .setInputFiles({
          name: 'broken.jpg',
          mimeType: 'image/jpeg',
          buffer: Buffer.from('broken'),
        });
      await page.waitForTimeout(500);
      assert.equal(downloads.length, 0);
      await page
        .locator('input[type=file]')
        .first()
        .setInputFiles('public/example-startrail.mp4');
      const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
      await exportButton.click({ timeout: 30000 });
      const download = await downloadPromise;
      assert.ok(download.suggestedFilename().endsWith('.jpg'));
      assert.equal(await download.failure(), null);
      assert.deepEqual(errors, []);
      console.log(
        `${name} production demo, video import, source replacement and export passed`
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
