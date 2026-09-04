// Import-free: Next's static export copies this worker verbatim.
const BUDGET = 64 * 1024 * 1024;
const DECODE = { imageOrientation: 'from-image', colorSpaceConversion: 'none' };
let generation = 0;
let files = [];
let source = null;
let bitmaps = [];
let natural;
let preview;
let loading = 0;
let rendering = null;
let frameWait = null;
let renderQueue = Promise.resolve();
let renderVersion = 0;

function emit(message, context) {
  self.postMessage({ ...message, ...context });
}
function release() {
  bitmaps.forEach((bitmap) => bitmap.close());
  bitmaps = [];
  files = [];
  source = null;
}
function cancelled() {
  return new DOMException('Processing cancelled', 'AbortError');
}
function cancelRender() {
  renderVersion++;
  if (rendering) rendering.cancelled = true;
  if (frameWait) {
    frameWait.reject(cancelled());
    frameWait = null;
  }
}
function context(canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx)
    throw new Error('Could not allocate a canvas. Try a smaller output size.');
  return ctx;
}
function outputSize(width, height, rotation) {
  return rotation === 90 || rotation === 270
    ? { width: height, height: width }
    : { width, height };
}
function setup(canvas, width, height, rotation) {
  const ctx = context(canvas);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (rotation) {
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.translate(-width / 2, -height / 2);
  }
  ctx.globalCompositeOperation = 'lighten';
  return ctx;
}
function draw(ctx, bitmap, index, count, params, width, height) {
  const position = count > 1 ? index / (count - 1) : 1;
  ctx.globalAlpha =
    params.minOpacity + (1 - params.minOpacity) * position ** params.power;
  ctx.drawImage(bitmap, 0, 0, width, height);
}
function publish(canvas, info) {
  const bitmap = canvas.transferToImageBitmap();
  self.postMessage({ type: 'image', ...info, bitmap }, [bitmap]);
}
function drawCached(params, info) {
  if (!bitmaps.length) return;
  const { width, height } = preview;
  const view = outputSize(width, height, params.rotation);
  const canvas = new OffscreenCanvas(view.width, view.height);
  try {
    const ctx = setup(canvas, width, height, params.rotation);
    const count = params.last - params.first + 1;
    for (let i = 0; i < count; i++)
      draw(ctx, bitmaps[params.first + i], i, count, params, width, height);
    publish(canvas, info);
  } finally {
    canvas.width = canvas.height = 0;
  }
}
async function load(message) {
  const token = ++loading;
  cancelRender();
  release();
  generation = message.generation;
  const info = { generation, requestId: message.requestId, phase: 'load' };
  const decoded = [];
  let probe;
  try {
    if (!message.files.length) throw new Error('No frames to load.');
    probe = await createImageBitmap(message.files[0], DECODE);
    const width = probe.width,
      height = probe.height;
    probe.close();
    probe = null;
    if (token !== loading) return;
    const factor = Math.min(
      1,
      720 / Math.max(width, height),
      Math.sqrt(BUDGET / (4 * message.files.length * width * height))
    );
    const size = {
      width: Math.max(1, Math.floor(width * factor)),
      height: Math.max(1, Math.floor(height * factor)),
    };
    for (let i = 0; i < message.files.length; i++) {
      const bitmap = await createImageBitmap(message.files[i], {
        ...DECODE,
        resizeWidth: size.width,
        resizeQuality: 'high',
      });
      if (token !== loading) {
        bitmap.close();
        return;
      }
      if (decoded.length && bitmap.height !== decoded[0].height) {
        bitmap.close();
        throw new Error(
          `Frame ${i + 1} does not have the same aspect ratio as frame 1.`
        );
      }
      decoded.push(bitmap);
      emit(
        { type: 'progress', done: i + 1, total: message.files.length },
        info
      );
    }
    files = message.files;
    source = message.source || { kind: 'photos' };
    natural =
      source.kind === 'video'
        ? { width: source.width, height: source.height }
        : { width, height };
    preview = {
      width: decoded[0].width,
      height: decoded[0].height,
      density: 2,
    };
    bitmaps = decoded;
    drawCached(message.initialPreview, info);
    emit({ type: 'loaded', natural, preview, total: files.length }, info);
  } finally {
    probe?.close();
    if (decoded !== bitmaps) decoded.forEach((bitmap) => bitmap.close());
  }
}
function requestFrame(index, width, height, job) {
  return new Promise((resolve, reject) => {
    frameWait = { resolve, reject, job };
    emit({ type: 'frameNeeded', index, width, height }, job.info);
  });
}
async function render(message) {
  cancelRender();
  const info = {
    generation,
    requestId: message.requestId,
    phase: message.type,
  };
  const job = { info, cancelled: false };
  rendering = job;
  let canvas;
  const current = () => !job.cancelled && info.generation === generation;
  try {
    if (!files.length) throw new Error('Open a source before rendering.');
    const factor =
      message.type === 'export'
        ? message.scale
        : Math.min(
            1,
            message.maxSide / Math.max(natural.width, natural.height)
          );
    const width = Math.max(1, Math.round(natural.width * factor));
    const height = Math.max(1, Math.round(natural.height * factor));
    const view = outputSize(width, height, message.rotation);
    canvas = new OffscreenCanvas(view.width, view.height);
    const ctx = setup(canvas, width, height, message.rotation);
    const count = message.last - message.first + 1;
    for (let i = 0; i < count; i++) {
      if (!current()) throw cancelled();
      const bitmap =
        source.kind === 'video'
          ? await requestFrame(message.first + i, width, height, job)
          : await createImageBitmap(files[message.first + i], {
              ...DECODE,
              resizeWidth: width,
              resizeHeight: height,
              resizeQuality: 'high',
            });
      try {
        if (!current()) throw cancelled();
        draw(ctx, bitmap, i, count, message, width, height);
      } finally {
        bitmap.close();
      }
      if (message.type === 'export')
        emit({ type: 'progress', done: i + 1, total: count }, info);
      // Yield to cancellation even when a decoder resolves immediately.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (!current()) throw cancelled();
    if (message.type === 'refine') publish(canvas, info);
    else {
      const blob = await canvas.convertToBlob({
        type: 'image/jpeg',
        quality: 0.95,
      });
      if (!current()) throw cancelled();
      emit({ type: 'exportDone', blob, ...view, frames: count }, info);
    }
  } catch (err) {
    if (current() && err.name !== 'AbortError')
      emit(
        {
          type: 'error',
          message: `${err.message} Try a smaller output size if memory is limited.`,
        },
        info
      );
  } finally {
    if (canvas) canvas.width = canvas.height = 0;
    if (rendering === job) rendering = null;
    emit({ type: 'renderFinished' }, info);
  }
}
self.onmessage = async ({ data: message }) => {
  if (message.type === 'frame') {
    const pending = frameWait;
    if (
      pending &&
      message.generation === pending.job.info.generation &&
      message.requestId === pending.job.info.requestId
    ) {
      frameWait = null;
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.bitmap);
    } else message.bitmap?.close();
    return;
  }
  try {
    if (message.type === 'load') await load(message);
    else if (message.type === 'reset') {
      generation = message.generation;
      loading++;
      cancelRender();
      release();
    } else if (message.generation !== generation) return;
    else if (message.type === 'cancelRender') cancelRender();
    else if (message.type === 'preview') {
      cancelRender();
      drawCached(message, {
        generation,
        requestId: message.requestId,
        phase: 'preview',
      });
      emit(
        { type: 'previewDone' },
        { generation, requestId: message.requestId, phase: 'preview' }
      );
    } else if (message.type === 'refine' || message.type === 'export') {
      cancelRender();
      const version = renderVersion;
      renderQueue = renderQueue.then(() => {
        if (version === renderVersion && message.generation === generation)
          return render(message);
      });
      await renderQueue;
    }
  } catch (err) {
    emit(
      { type: 'error', message: err.message },
      {
        generation: message.generation,
        requestId: message.requestId,
        phase: message.type,
      }
    );
  }
};
