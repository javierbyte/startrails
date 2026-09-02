// Getting a timelapse video into the page. Plenty of night-sky material is
// already a rendered clip rather than a folder of stills, so the video is
// stepped here, frame by frame, and turned into the same array of JPEG files a
// folder would have produced. Everything downstream -- the worker's preview
// cache, the full-resolution export pass, the range sliders -- then works on a
// video exactly as it does on a folder, with no second code path.
//
// Decoding happens on the main thread because a <video> element is the only
// decoder available without a dependency, and it does not exist in a worker.
// The element does the demuxing and the seeking; canvas does the encoding.

const VIDEO_NAME = /\.(mp4|m4v|mov|webm)$/i;

// Videos rarely say what their frame rate is, so it is measured. Where it
// cannot be, this is the assumption: an over- or under-estimate only costs a
// slightly uneven sample, never a failed extraction.
const FALLBACK_FPS = 30;

// Measured rates come back a hair off (29.9704...), and the drift compounds
// over a long clip, so a near miss snaps to the real broadcast rate.
const STANDARD_FPS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
const FPS_TOLERANCE = 0.05;

// Every extracted frame is held as an encoded JPEG for the life of the session:
// the preview decodes them once into proxies, and the export decodes them again
// at full size. So the cap is really a memory budget, spent in megapixels of
// source video. A 1080p or 4K clip hits the frame ceiling first; only 6K and up
// gets fewer frames than that.
const MAX_FRAMES = 600;
const MIN_FRAMES = 60;
const FRAME_BUDGET_MP = 5000;

// Matching the export encoder in stack.worker.js.
const JPEG_QUALITY = 0.95;

// A video that never fires loadedmetadata or seeked is a decoder that has given
// up quietly; neither event has a matching error in every browser.
const METADATA_TIMEOUT = 30000;
const SEEK_TIMEOUT = 30000;
const FPS_PROBE_TIMEOUT = 1500;

export function isVideo(file) {
  return VIDEO_NAME.test(file.name) || /^video\//.test(file.type || '');
}

function abortError() {
  const err = new Error('Extraction cancelled');
  err.name = 'AbortError';
  return err;
}

/** Resolves on `event`, rejects on the element's own error or on a timeout. */
function once(video, event, timeout, message) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener(event, onDone);
      video.removeEventListener('error', onError);
    };
    const onDone = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(message));
    };
    const timer = setTimeout(onError, timeout);
    video.addEventListener(event, onDone, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}

function seek(video, time) {
  // Seeking to where we already are fires no event at all.
  if (video.currentTime === time) return Promise.resolve();
  const settled = once(
    video,
    'seeked',
    SEEK_TIMEOUT,
    'That video could not be read past this point.'
  );
  video.currentTime = time;
  return settled;
}

function toJpeg(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode a frame.'))),
      'image/jpeg',
      JPEG_QUALITY
    );
  });
}

function snapFps(fps) {
  if (!Number.isFinite(fps) || fps <= 0) return FALLBACK_FPS;
  // The nearest candidate, not the first near enough: 29.97 and 30 are well
  // inside each other's tolerance, so first-match would read a 30fps clip as
  // 29.97 forever.
  let best = fps;
  let bestError = FPS_TOLERANCE;
  for (const standard of STANDARD_FPS) {
    const error = Math.abs(fps - standard) / standard;
    if (error <= bestError) {
      best = standard;
      bestError = error;
    }
  }
  return best;
}

/**
 * Frame rate, measured by playing muted for a moment and asking two frame
 * callbacks how many frames went by. requestVideoFrameCallback is the only way
 * to see individual frames from script; Firefox does not have it, and that path
 * takes the fallback.
 */
function estimateFps(video) {
  if (typeof video.requestVideoFrameCallback !== 'function') {
    return Promise.resolve(FALLBACK_FPS);
  }

  return new Promise((resolve) => {
    let first = null;
    let done = false;

    const finish = (fps) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.pause();
      resolve(snapFps(fps));
    };

    const timer = setTimeout(() => finish(FALLBACK_FPS), FPS_PROBE_TIMEOUT);

    const tick = (now, metadata) => {
      if (done) return;
      if (!first) {
        first = metadata;
        video.requestVideoFrameCallback(tick);
        return;
      }
      const frames = metadata.presentedFrames - first.presentedFrames;
      const seconds = metadata.mediaTime - first.mediaTime;
      // Too short a window and the measurement is mostly rounding error.
      if (seconds < 0.2 || frames <= 0) {
        video.requestVideoFrameCallback(tick);
        return;
      }
      finish(frames / seconds);
    };

    video.requestVideoFrameCallback(tick);
    video.play().catch(() => finish(FALLBACK_FPS));
  });
}

/**
 * Downloads a video into a File, reporting bytes as they arrive. Only the sample
 * clip needs this -- a dropped or picked file is already local -- but it is a
 * few megabytes, so it reads the body as a stream rather than leaving the page
 * with an unexplained pause before extraction starts.
 */
export async function fetchVideoFile(url, name, { onProgress, signal } = {}) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error('The sample video could not be loaded.');

  const total = Number(response.headers.get('content-length')) || 0;
  // No length header, or a browser without streaming bodies: still works, just
  // without a bar.
  if (!total || !response.body) {
    return new File([await response.blob()], name, { type: 'video/mp4' });
  }

  const reader = response.body.getReader();
  const chunks = [];
  let done = 0;

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    chunks.push(chunk.value);
    done += chunk.value.length;
    if (onProgress) onProgress(done, total);
  }

  return new File(chunks, name, { type: 'video/mp4' });
}

/**
 * Decodes a video into an array of JPEG Files, evenly sampled across the whole
 * clip. Returns the files alongside a summary of what was sampled, which the UI
 * reports rather than offering as a control.
 */
export async function framesFromVideoFile(file, { onProgress, signal } = {}) {
  const video = document.createElement('video');
  const url = URL.createObjectURL(file);
  // Declared out here so the cleanup below can defuse it if the run throws
  // while an encode is still in flight.
  let pending = null;

  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;

  try {
    await once(
      video,
      'loadedmetadata',
      METADATA_TIMEOUT,
      'That video could not be decoded in this browser.'
    );

    const { duration, videoWidth: width, videoHeight: height } = video;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('That video does not report a duration, so it cannot be sampled.');
    }
    if (!width || !height) {
      throw new Error('That video has no picture track.');
    }
    if (signal && signal.aborted) throw abortError();

    const fps = await estimateFps(video);
    if (signal && signal.aborted) throw abortError();

    const megapixels = (width * height) / 1e6;
    const cap = Math.max(
      MIN_FRAMES,
      Math.min(MAX_FRAMES, Math.floor(FRAME_BUDGET_MP / megapixels))
    );
    const total = Math.max(1, Math.round(duration * fps));
    const step = Math.max(1, Math.ceil(total / cap));
    const count = Math.ceil(total / step);

    // Two canvases, used alternately, so a frame can be encoding while the next
    // one is being seeked to. Seeking and JPEG encoding are the whole cost of
    // this loop and they overlap almost perfectly, which nearly halves it. One
    // canvas would not do: the next drawImage would land on the same bitmap the
    // encoder is still reading.
    const panes = [0, 1].map(() => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      return { canvas, ctx: canvas.getContext('2d') };
    });
    let slot = 0;

    const stem = file.name.replace(/\.[^.]+$/, '');
    // Half a frame in, so a timestamp lands inside a frame rather than on the
    // boundary between two, where browsers disagree about which one is current.
    const half = 1 / (2 * fps);
    const lastTime = Math.max(0, duration - half);

    const frames = [];
    let previous = -1;

    const collect = async (blob) => {
      frames.push(
        new File([blob], `${stem}-${String(frames.length).padStart(5, '0')}.jpg`, {
          type: 'image/jpeg',
        })
      );
    };

    for (let i = 0; i < count; i++) {
      if (signal && signal.aborted) throw abortError();

      await seek(video, Math.min(lastTime, (i * step + half) / fps));

      // An over-estimated frame rate asks for two timestamps inside the same
      // frame. Dropping the repeat matters: duplicates would sit at different
      // points on the opacity ramp and brighten that part of the trail.
      if (video.currentTime > previous) {
        previous = video.currentTime;

        const pane = panes[slot];
        slot ^= 1;
        pane.ctx.drawImage(video, 0, 0, width, height);
        const encoding = toJpeg(pane.canvas);

        // Only now collect the frame started last time round. It has had this
        // whole iteration's seek to encode in, and its canvas is the one the
        // next iteration will draw into, so it has to be finished by then.
        if (pending) await collect(await pending);
        pending = encoding;
      }

      if (onProgress) onProgress(i + 1, count);
    }

    if (pending) {
      await collect(await pending);
      pending = null;
    }

    return {
      frames,
      summary: { fps, total, step, count: frames.length, width, height, duration },
    };
  } finally {
    // A run that threw mid-loop leaves one encode unclaimed.
    if (pending) pending.catch(() => {});
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}
