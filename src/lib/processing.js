// The cache excludes the displayed composite, decoder surfaces and one frame in flight.
export const PREVIEW_BUDGET = 64 * 1024 * 1024;
export const PREVIEW_MAX_SIDE = 1440;

export function previewSize(width, height, count, maxSide = 720) {
  const factor = Math.min(
    1,
    maxSide / Math.max(width, height),
    Math.sqrt(PREVIEW_BUDGET / (4 * Math.max(1, count) * width * height))
  );
  return {
    width: Math.max(1, Math.floor(width * factor)),
    height: Math.max(1, Math.floor(height * factor)),
  };
}

export function sampleTimes(duration, fps, cap = 600) {
  if (
    !(duration > 0) ||
    !Number.isFinite(duration) ||
    !(fps > 0) ||
    !Number.isFinite(fps)
  ) {
    throw new Error(
      'That video does not report a usable duration or frame rate.'
    );
  }
  const total = Math.max(1, Math.round(duration * fps));
  const step = Math.max(1, Math.ceil(total / cap));
  const half = 0.5 / fps;
  const times = Array.from({ length: Math.ceil(total / step) }, (_, i) =>
    Math.min(Math.max(0, duration - half), (i * step) / fps + half)
  );
  return { total, step, times };
}

export function abortError() {
  return new DOMException('Processing cancelled', 'AbortError');
}

export function checkAbort(signal) {
  if (signal?.aborted) throw abortError();
}

// Encoders cannot be stopped, but their callers can stop waiting immediately.
export function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

export function isCurrent(message, generation, requestId) {
  return message.generation === generation && message.requestId === requestId;
}
