import {
  abortable,
  checkAbort,
  previewSize,
  sampleTimes,
} from './processing.js';

export function isVideo(file) {
  return (
    /\.(mp4|m4v|mov|webm)$/i.test(file.name) || /^video\//.test(file.type || '')
  );
}

function once(video, event, signal, action) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener(event, done);
      video.removeEventListener('error', fail);
      signal?.removeEventListener('abort', abort);
    };
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(
        new Error(
          'That video could not be decoded in this browser. Try an SDR H.264 copy.'
        )
      );
    };
    const abort = () => {
      cleanup();
      reject(new DOMException('Processing cancelled', 'AbortError'));
    };
    const timer = setTimeout(fail, 30000);
    video.addEventListener(event, done, { once: true });
    video.addEventListener('error', fail, { once: true });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    try {
      action?.();
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

async function estimateFps(video, signal) {
  if (!video.requestVideoFrameCallback) return 30;
  let callback;
  let timer;
  try {
    return await abortable(
      new Promise((resolve) => {
        let first;
        const finish = (fps) =>
          resolve(Number.isFinite(fps) && fps > 0 ? fps : 30);
        timer = setTimeout(() => finish(30), 1500);
        const tick = (_, metadata) => {
          if (!first) first = metadata;
          const elapsed = metadata.mediaTime - first.mediaTime;
          if (elapsed >= 0.2) {
            const measured =
              (metadata.presentedFrames - first.presentedFrames) / elapsed;
            const standards = [
              23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 100, 119.88, 120,
            ];
            const nearest = standards.reduce((a, b) =>
              Math.abs(a - measured) < Math.abs(b - measured) ? a : b
            );
            finish(
              Math.abs(nearest - measured) / measured <= 0.05
                ? nearest
                : measured
            );
          } else callback = video.requestVideoFrameCallback(tick);
        };
        callback = video.requestVideoFrameCallback(tick);
        video.play().catch(() => finish(30));
      }),
      signal
    );
  } finally {
    clearTimeout(timer);
    if (callback !== undefined) video.cancelVideoFrameCallback(callback);
    video.pause();
  }
}

// A session owns just one decoder and one canvas; all callers consume frames serially.
export async function openVideo(file, signal) {
  checkAbort(signal);
  const video = document.createElement('video');
  const url = URL.createObjectURL(file);
  const canvas = document.createElement('canvas');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', close);
    video.pause();
    video.removeAttribute('src');
    video.load();
    canvas.width = canvas.height = 0;
    URL.revokeObjectURL(url);
  };
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  try {
    await once(video, 'loadedmetadata', signal, () => {
      video.src = url;
    });
    const { videoWidth: width, videoHeight: height, duration } = video;
    if (!width || !height || !Number.isFinite(duration) || duration <= 0) {
      throw new Error('That video has no usable picture track or duration.');
    }
    signal?.addEventListener('abort', close, { once: true });
    checkAbort(signal);
    return {
      width,
      height,
      duration,
      close,
      estimateFps: () => estimateFps(video, signal),
      async draw(time, size) {
        checkAbort(signal);
        if (video.currentTime !== time || video.readyState < 2) {
          await once(video, 'seeked', signal, () => {
            video.currentTime = time;
          });
        }
        checkAbort(signal);
        if (canvas.width !== size.width) canvas.width = size.width;
        if (canvas.height !== size.height) canvas.height = size.height;
        const ctx = canvas.getContext('2d');
        if (!ctx)
          throw new Error(
            'Could not allocate a video frame. Try a smaller output size.'
          );
        ctx.drawImage(video, 0, 0, size.width, size.height);
        return canvas;
      },
    };
  } catch (err) {
    close();
    throw err;
  }
}

export async function fetchVideoFile(url, name, { signal } = {}) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error('The sample video could not be loaded.');
  return new File([await response.blob()], name, { type: 'video/mp4' });
}

export async function framesFromVideoFile(file, { onProgress, signal } = {}) {
  const reader = await openVideo(file, signal);
  try {
    const { width, height, duration } = reader;
    const fps = await reader.estimateFps();
    const { total, step, times } = sampleTimes(duration, fps);
    const size = previewSize(width, height, times.length);
    const frames = [];
    const stem = file.name.replace(/\.[^.]+$/, '');
    for (const time of times) {
      const canvas = await reader.draw(time, size);
      const blob = await abortable(
        new Promise((resolve, reject) =>
          canvas.toBlob(
            (blob) =>
              blob
                ? resolve(blob)
                : reject(new Error('Could not encode a preview frame.')),
            'image/jpeg',
            0.95
          )
        ),
        signal
      );
      checkAbort(signal);
      frames.push(
        new File(
          [blob],
          `${stem}-${String(frames.length).padStart(5, '0')}.jpg`,
          { type: 'image/jpeg' }
        )
      );
      onProgress?.(frames.length, times.length);
    }
    const summary = {
      fps,
      estimated: true,
      total,
      step,
      count: times.length,
      width,
      height,
      duration,
    };
    return {
      frames,
      summary,
      source: { kind: 'video', file, times, width, height },
    };
  } finally {
    reader.close();
  }
}

export async function loadSampleFrames(basePath, { signal, onProgress } = {}) {
  const response = await fetch(`${basePath}/sample/manifest.json`, { signal });
  if (!response.ok) throw new Error('The sample previews could not be loaded.');
  const manifest = await response.json();
  const frames = [];
  // Fetch four previews concurrently and store by index to preserve frame order.
  for (let start = 0; start < manifest.frames.length; start += 4) {
    await Promise.all(
      manifest.frames.slice(start, start + 4).map(async (name, offset) => {
        const response = await fetch(`${basePath}/sample/${name}`, { signal });
        if (!response.ok)
          throw new Error('A sample preview could not be loaded.');
        frames[start + offset] = new File([await response.blob()], name, {
          type: 'image/jpeg',
        });
      })
    );
    onProgress?.(frames.length, manifest.frames.length);
  }
  return {
    frames,
    summary: manifest.summary,
    source: {
      kind: 'video',
      url: `${basePath}/example-startrail.mp4`,
      name: 'example-startrail.mp4',
      times: manifest.times,
      width: manifest.summary.width,
      height: manifest.summary.height,
    },
  };
}
