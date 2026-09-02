// All decoding and compositing happens here so slider drags never touch the
// main thread. createImageBitmap already decodes off the calling thread, so one
// worker issuing several decodes at once gets real parallelism. A pool would
// buy nothing.
//
// IMPORTANT: this file must not import anything. Under `output: 'export'`
// Turbopack copies it into _next/static/media verbatim rather than bundling it,
// so any import would survive into the emitted file as a bare relative
// specifier and 404 at runtime. Splicing the EXIF, which is the one thing that
// wanted a shared module, happens on the main thread instead.

// Matching the CLI: node-canvas ignores ICC profiles, so decode without colour
// conversion and carry the source profile through to the export instead.
const DECODE = { imageOrientation: 'from-image', colorSpaceConversion: 'none' };

// RGBA bytes the preview cache is allowed to hold across every frame. The
// per-frame proxy size falls out of this, so a 60-frame sequence gets a large
// proxy and a 600-frame one gets a small one, both for the same memory.
//
// The bitmap is displayed at half its pixel dimensions for a 2x Retina preview.
// The memory budget can make long sequences smaller, but no frame is skipped.
const PREVIEW_BUDGET = 384 * 1024 * 1024;
const PREVIEW_MAX_SIDE = 1440;
const PREVIEW_DENSITY = 2;

// Full-res frames are huge (a 40MP frame is 160MB as RGBA), so only ever keep a
// couple in flight alongside the output canvas.
const EXPORT_LOOKAHEAD = 2;

const state = {
  files: [],
  bitmaps: [],
  natural: { width: 0, height: 0 },
  preview: { width: 0, height: 0, density: PREVIEW_DENSITY },
  canvas: null,
  ctx: null,
};

let loadSeq = 0;
let previewSeq = 0;
let exportSeq = 0;

/**
 * The opacity ramp, straight from star-trails.js. Frame 0 sits at minOpacity and
 * the last frame is always fully opaque; power bends everything between.
 */
function opacityFor(index, count, power, minOpacity) {
  const position = count > 1 ? index / (count - 1) : 1;
  return minOpacity + (1 - minOpacity) * Math.pow(position, power);
}

/**
 * Draws a range of frames onto a context with the lighten blend. Order matters:
 * lighten at globalAlpha < 1 composites against whatever is already there, so
 * the result depends on the sequence, not just the set.
 */
function drawFrame(ctx, bitmap, index, count, power, minOpacity) {
  ctx.globalAlpha = opacityFor(index, count, power, minOpacity);
  ctx.drawImage(bitmap, 0, 0);
}

/** Output dimensions once a quarter-turn is taken into account. */
function orient(width, height, rotation) {
  return rotation === 90 || rotation === 270
    ? { width: height, height: width }
    : { width, height };
}

/**
 * Positions the drawing so a w x h image lands correctly on a canvas already
 * sized for the rotation.
 */
function applyRotation(ctx, rotation, width, height) {
  if (!rotation) return;
  const out = orient(width, height, rotation);
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.translate(-width / 2, -height / 2);
}

function releaseBitmaps() {
  for (const bitmap of state.bitmaps) {
    if (bitmap) bitmap.close();
  }
  state.bitmaps = [];
}

async function handleLoad({ files, initialPreview, requestId }) {
  const seq = ++loadSeq;
  previewSeq++;
  releaseBitmaps();
  const bitmaps = new Array(files.length);
  let probe = null;

  try {
    // One full-size decode to learn the real dimensions, which the UI shows and
    // the export pass sizes its canvas from.
    probe = await createImageBitmap(files[0], DECODE);
    if (seq !== loadSeq) return;

    const natural = { width: probe.width, height: probe.height };
    const probeWidth = probe.width;
    const aspect = probe.width / probe.height;
    probe.close();
    probe = null;

    const pxPerFrame = PREVIEW_BUDGET / 4 / files.length;
    const maxWidthForSide = Math.floor(PREVIEW_MAX_SIDE * Math.min(1, aspect));
    const requestedPreviewWidth = Math.max(
      1,
      Math.min(
        // Never upscale: a short sequence of small frames would otherwise get a
        // preview bigger than the source, costing memory for no extra detail.
        probeWidth,
        // Cap the longest side, including portrait sequences, at 1440 backing
        // pixels. At 2x density this occupies at most 720 CSS pixels.
        maxWidthForSide,
        // There is deliberately no minimum. Every photo matters to a continuous
        // trail, so long sequences get smaller proxies instead of exceeding the
        // cache budget or sampling frames out of the sequence.
        Math.floor(Math.sqrt(pxPerFrame * aspect))
      )
    );

    // The omitted resizeHeight is derived by the browser. Its integer rounding
    // is not guaranteed to match Math.round(requestedPreviewWidth / aspect), so
    // use the first resized bitmap as the authority for the preview dimensions.
    // Otherwise frame 0 can appear to disagree with itself by a single pixel.
    const firstBitmap = await createImageBitmap(files[0], {
      ...DECODE,
      resizeWidth: requestedPreviewWidth,
      resizeQuality: 'high',
    });
    if (seq !== loadSeq) {
      firstBitmap.close();
      return;
    }

    const preview = {
      width: firstBitmap.width,
      height: firstBitmap.height,
      density: PREVIEW_DENSITY,
    };
    const previewWidth = preview.width;
    const previewHeight = preview.height;

    self.postMessage({ type: 'loadStarted', requestId, total: files.length });
    self.postMessage({
      type: 'progress',
      phase: 'load',
      requestId,
      done: 1,
      total: files.length,
    });

    bitmaps[0] = firstBitmap;
    for (let idx = 1; idx < files.length; idx++) {
      // Supplying just the width makes the decoder preserve the source aspect
      // ratio. Checking the resulting height catches mismatched or differently
      // oriented frames before they can be stretched or cropped into the stack.
      const bitmap = await createImageBitmap(files[idx], {
        ...DECODE,
        resizeWidth: previewWidth,
        resizeQuality: 'high',
      });

      if (seq !== loadSeq) {
        bitmap.close();
        return;
      }

      if (bitmap.width !== previewWidth || bitmap.height !== previewHeight) {
        bitmap.close();
        throw new Error(
          `Frame ${idx + 1}, “${files[idx].name}”, does not have the same aspect ratio as frame 1, “${files[0].name}”.`
        );
      }

      bitmaps[idx] = bitmap;
      if ((idx + 1) % 4 === 0 || idx === files.length - 1) {
        self.postMessage({
          type: 'progress',
          phase: 'load',
          requestId,
          done: idx + 1,
          total: files.length,
        });
      }
    }

    const params = {
      power: 2,
      minOpacity: 0,
      first: 0,
      last: files.length - 1,
      rotation: 0,
      ...initialPreview,
    };
    params.first = Math.max(0, Math.min(params.first, files.length - 1));
    params.last = Math.max(params.first, Math.min(params.last, files.length - 1));

    // Compose away from the transferred canvas. The old pixels stay visible
    // throughout decoding, and resizing the visible canvas plus copying this
    // finished bitmap happens in one worker task, before the browser can paint
    // an empty intermediate frame.
    const view = orient(preview.width, preview.height, params.rotation);
    const nextCanvas = new OffscreenCanvas(view.width, view.height);
    const nextCtx = nextCanvas.getContext('2d');
    drawPreview(nextCanvas, nextCtx, bitmaps, preview, params);
    if (seq !== loadSeq) return;

    state.files = files;
    state.bitmaps = bitmaps;
    state.natural = natural;
    state.preview = preview;

    state.canvas.width = view.width;
    state.canvas.height = view.height;
    state.ctx.setTransform(1, 0, 0, 1, 0, 0);
    state.ctx.globalCompositeOperation = 'source-over';
    state.ctx.globalAlpha = 1;
    state.ctx.drawImage(nextCanvas, 0, 0);

    self.postMessage({
      type: 'loaded',
      requestId,
      total: files.length,
      natural,
      preview,
    });
  } catch (err) {
    if (seq !== loadSeq) return;
    throw err;
  } finally {
    if (probe) probe.close();
    if (state.bitmaps !== bitmaps) {
      for (const bitmap of bitmaps) if (bitmap) bitmap.close();
    }
  }
}

function drawPreview(canvas, ctx, bitmaps, preview, params, isCancelled) {
  const { power, minOpacity, first, last, rotation = 0 } = params;
  const { width: frameWidth, height: frameHeight } = preview;
  const view = orient(frameWidth, frameHeight, rotation);
  if (canvas.width !== view.width) canvas.width = view.width;
  if (canvas.height !== view.height) canvas.height = view.height;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, view.width, view.height);

  // Rotating the composite would need a second full buffer; at proxy size it is
  // cheaper to let each frame land pre-rotated.
  applyRotation(ctx, rotation, frameWidth, frameHeight);
  ctx.globalCompositeOperation = 'lighten';

  const count = last - first + 1;
  for (let idx = 0; idx < count; idx++) {
    // A drag can queue several restacks; abandon this one the moment a newer
    // set of parameters arrives.
    if (idx % 64 === 0 && isCancelled && isCancelled()) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      return idx;
    }
    drawFrame(ctx, bitmaps[first + idx], idx, count, power, minOpacity);
  }

  ctx.globalAlpha = 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return count;
}

function handlePreview({ power, minOpacity, first, last, rotation = 0 }) {
  const seq = ++previewSeq;
  // Every path out of here has to post previewDone: the client only keeps one
  // restack in flight, so a silent return would latch that gate closed.
  if (!state.ctx || !state.bitmaps.length) {
    self.postMessage({ type: 'previewDone', frames: 0 });
    return;
  }

  const frames = drawPreview(
    state.canvas,
    state.ctx,
    state.bitmaps,
    state.preview,
    { power, minOpacity, first, last, rotation },
    () => seq !== previewSeq
  );
  self.postMessage({ type: 'previewDone', frames });
}

async function handleExport({
  power,
  minOpacity,
  first,
  last,
  scale,
  rotation = 0,
}) {
  const seq = ++exportSeq;
  const files = state.files.slice(first, last + 1);
  const count = files.length;

  const width = Math.max(1, Math.round(state.natural.width * scale));
  const height = Math.max(1, Math.round(state.natural.height * scale));
  const resize =
    scale === 1 ? {} : { resizeWidth: width, resizeQuality: 'high' };

  let canvas;
  try {
    canvas = new OffscreenCanvas(width, height);
  } catch (err) {
    self.postMessage({
      type: 'error',
      phase: 'export',
      message: `Could not create a ${width}x${height} canvas. Try a smaller output size.`,
    });
    return;
  }

  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = 'lighten';

  const pending = new Map();
  const decode = (index) =>
    createImageBitmap(files[index], { ...DECODE, ...resize });

  let nextToStart = 0;
  let nextToDraw = 0;

  try {
    while (nextToDraw < count) {
      while (nextToStart < count && pending.size < EXPORT_LOOKAHEAD) {
        pending.set(nextToStart, decode(nextToStart));
        nextToStart++;
      }

      const bitmap = await pending.get(nextToDraw);
      pending.delete(nextToDraw);

      if (seq !== exportSeq) {
        bitmap.close();
        for (const promise of pending.values()) {
          promise.then((extra) => extra.close()).catch(() => {});
        }
        self.postMessage({ type: 'exportCancelled' });
        return;
      }

      drawFrame(ctx, bitmap, nextToDraw, count, power, minOpacity);
      // Released straight away, so peak memory is the canvas plus the frames
      // still in flight rather than the whole sequence.
      bitmap.close();
      nextToDraw++;

      self.postMessage({
        type: 'progress',
        phase: 'export',
        done: nextToDraw,
        total: count,
      });
    }
  } catch (err) {
    for (const promise of pending.values())
      promise.then((extra) => extra.close()).catch(() => {});
    self.postMessage({ type: 'error', phase: 'export', message: err.message });
    return;
  }

  ctx.globalAlpha = 1;

  // Turned once at the end rather than per frame: one extra full-size buffer
  // costs far less than re-blitting every frame through a rotation.
  let output = canvas;
  const view = orient(width, height, rotation);
  if (rotation) {
    output = new OffscreenCanvas(view.width, view.height);
    const outCtx = output.getContext('2d');
    applyRotation(outCtx, rotation, width, height);
    outCtx.drawImage(canvas, 0, 0);
  }

  const blob = await output.convertToBlob({
    type: 'image/jpeg',
    quality: 0.95,
  });

  self.postMessage({
    type: 'exportDone',
    blob,
    width: view.width,
    height: view.height,
    frames: count,
  });
}

self.onmessage = async (event) => {
  const message = event.data;

  try {
    switch (message.type) {
      case 'init':
        state.canvas = message.canvas;
        state.ctx = message.canvas.getContext('2d');
        break;
      case 'load':
        await handleLoad(message);
        break;
      case 'cancelLoad':
        loadSeq++;
        previewSeq++;
        break;
      case 'preview':
        handlePreview(message);
        break;
      case 'export':
        await handleExport(message);
        break;
      case 'cancelExport':
        exportSeq++;
        break;
      default:
        break;
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      phase: message.type,
      requestId: message.requestId,
      message: err.message,
    });
  }
};
