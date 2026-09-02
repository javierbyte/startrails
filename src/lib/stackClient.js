/**
 * Thin wrapper over the stacking worker: owns the worker, hands it the preview
 * canvas once, and turns its messages into callbacks.
 *
 * The canvas can only be transferred a single time, so a stacker instance is
 * tied to one <canvas> element for its whole life.
 */
export function createStacker({ canvas, onEvent }) {
  // Turbopack turns this into a hashed asset URL under the configured basePath,
  // which is why the worker is referenced this way rather than by a hand-built
  // path. It copies the file through untouched, so the worker has to be plain
  // import-free JS -- see the note at the top of stack.worker.js.
  const worker = new Worker(new URL('../workers/stack.worker.js', import.meta.url), {
    type: 'module',
  });

  worker.onmessage = (event) => onEvent(event.data);
  worker.onerror = (event) =>
    onEvent({ type: 'error', phase: 'worker', message: event.message || 'Worker failed' });

  const offscreen = canvas.transferControlToOffscreen();
  worker.postMessage({ type: 'init', canvas: offscreen }, [offscreen]);

  return {
    load(files, initialPreview, requestId) {
      worker.postMessage({ type: 'load', files, initialPreview, requestId });
    },
    cancelLoad() {
      worker.postMessage({ type: 'cancelLoad' });
    },
    preview(params) {
      worker.postMessage({ type: 'preview', ...params });
    },
    exportImage(params) {
      worker.postMessage({ type: 'export', ...params });
    },
    cancelExport() {
      worker.postMessage({ type: 'cancelExport' });
    },
    destroy() {
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
