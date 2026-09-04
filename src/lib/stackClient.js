import { fetchVideoFile, openVideo } from './video.js';
import { checkAbort, isCurrent } from './processing.js';

/** Owns source generations, worker jobs, and the one active video decoder. */
export function createStacker({ canvas, onEvent }) {
  const makeWorker = () =>
    new Worker(new URL('../workers/stack.worker.js', import.meta.url), {
      type: 'module',
    });
  let worker = makeWorker();
  let generation = 0;
  let sequence = 0;
  let source;
  let loadId;
  let previewId;
  let renderId;
  let timer;
  let controller;
  let readerPromise;
  let destroyed = false;
  let latestParams;

  function stopRender() {
    clearTimeout(timer);
    controller?.abort();
    controller = null;
    readerPromise = null;
    renderId = undefined;
    worker.postMessage({ type: 'cancelRender', generation });
  }
  function startRender(type, params) {
    stopRender();
    if (type === 'export') previewId = undefined;
    renderId = ++sequence;
    controller = new AbortController();
    const rect = canvas.getBoundingClientRect();
    const maxSide = Math.min(
      1440,
      Math.max(
        1,
        Math.ceil(
          Math.max(rect.width, rect.height) * (window.devicePixelRatio || 1)
        )
      )
    );
    worker.postMessage({
      type,
      ...params,
      maxSide,
      generation,
      requestId: renderId,
    });
  }
  function scheduleRefinement(params) {
    clearTimeout(timer);
    timer = setTimeout(() => startRender('refine', params), 300);
  }
  async function provideFrame(message) {
    const signal = controller.signal;
    const activeSource = source;
    try {
      if (!readerPromise) {
        readerPromise = (async () => {
          const file =
            activeSource.file ||
            (await fetchVideoFile(activeSource.url, activeSource.name, {
              signal,
            }));
          checkAbort(signal);
          // Cache the compressed original, never decoded full-resolution frames.
          activeSource.file = file;
          return openVideo(file, signal);
        })();
      }
      const reader = await readerPromise;
      checkAbort(signal);
      const frame = await reader.draw(
        activeSource.times[message.index],
        message
      );
      const bitmap = await createImageBitmap(frame);
      if (signal.aborted || !isCurrent(message, generation, renderId)) {
        bitmap.close();
        return;
      }
      worker.postMessage(
        { type: 'frame', generation, requestId: renderId, bitmap },
        [bitmap]
      );
    } catch (err) {
      if (!signal.aborted && isCurrent(message, generation, renderId)) {
        worker.postMessage({
          type: 'frame',
          generation,
          requestId: renderId,
          error: err.message,
        });
      }
    }
  }
  const handleMessage = ({ data: message }) => {
    const id =
      message.phase === 'load'
        ? loadId
        : message.phase === 'preview'
          ? previewId
          : renderId;
    if (destroyed || !isCurrent(message, generation, id)) {
      message.bitmap?.close();
      return;
    }
    if (message.type === 'frameNeeded') {
      provideFrame(message);
      return;
    }
    if (message.type === 'renderFinished') {
      controller?.abort();
      controller = null;
      readerPromise = null;
      return;
    }
    if (message.type === 'image') {
      try {
        canvas.width = message.bitmap.width;
        canvas.height = message.bitmap.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Could not display the preview.');
        ctx.drawImage(message.bitmap, 0, 0);
      } finally {
        message.bitmap.close();
      }
      return;
    }
    // Refinement is optional; keep the usable cached preview on failure.
    if (message.phase === 'refine') return;
    if (message.type === 'exportDone') {
      const completedGeneration = generation;
      const completedId = renderId;
      message.isCurrent = () =>
        !destroyed &&
        generation === completedGeneration &&
        renderId === completedId;
    }
    onEvent(message);
    if (message.type === 'loaded' && latestParams)
      scheduleRefinement(latestParams);
  };
  const handleError = (event) => {
    stopRender();
    worker.terminate();
    generation++;
    source = null;
    worker = makeWorker();
    worker.onmessage = handleMessage;
    worker.onerror = handleError;
    onEvent({
      type: 'error',
      phase: 'worker',
      message:
        event.message || 'Worker failed. Open the source again to retry.',
    });
  };
  worker.onmessage = handleMessage;
  worker.onerror = handleError;

  return {
    load(files, initialPreview, requestId, descriptor) {
      stopRender();
      loadId = requestId;
      source = descriptor || { kind: 'photos' };
      latestParams = initialPreview;
      worker.postMessage({
        type: 'load',
        files,
        initialPreview,
        requestId,
        generation,
        source: {
          kind: source.kind,
          width: source.width,
          height: source.height,
        },
      });
    },
    cancelLoad() {
      stopRender();
      generation++;
      source = null;
      latestParams = null;
      worker.postMessage({ type: 'reset', generation });
    },
    preview(params) {
      stopRender();
      latestParams = params;
      previewId = ++sequence;
      worker.postMessage({
        type: 'preview',
        ...params,
        generation,
        requestId: previewId,
      });
      scheduleRefinement(params);
    },
    exportImage(params) {
      startRender('export', params);
    },
    cancelExport() {
      stopRender();
      onEvent({ type: 'exportCancelled' });
    },
    destroy() {
      destroyed = true;
      stopRender();
      worker.terminate();
    },
  };
}

/** Default output name, echoing the CLI's `[first]-[last]-p[power][-mo[min]].jpg`. */
export function exportFileName({ firstName, lastName, power, minOpacity }) {
  const stem = (name) => name.replace(/\.[^.]+$/, '');
  const mo = minOpacity > 0 ? `-mo${Math.round(minOpacity * 100)}` : '';
  return `${stem(firstName)}-${stem(lastName)}-p${power}${mo}.jpg`;
}

export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on the next tick so the click has taken the URL.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
