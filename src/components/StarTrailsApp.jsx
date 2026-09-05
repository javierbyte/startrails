'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  Box,
  Button,
  Checkbox,
  HeaderH4,
  Inline,
  Range,
  SmallText,
  Space,
  Tab,
  Tabs,
  Text,
} from 'jbx';

import { BASE_PATH } from '../lib/constants.js';
import { applySourceMetadata } from '../lib/exif.js';
import { createStacker, downloadBlob, exportFileName } from '../lib/stackClient.js';
import {
  ensureReadPermission,
  folderNameFromFileList,
  framesFromDataTransfer,
  framesFromFileList,
  forgetHandle,
  pickDirectory,
  readHandleFrames,
  recallHandle,
  supportsDirectoryPicker,
} from '../lib/folder.js';
import { loadSampleFrames, framesFromVideoFile, isVideo } from '../lib/video.js';
import {
  createVideoEncoder,
  planVideo,
  videoSize,
  FPS_OPTIONS,
  DEFAULT_FPS,
  DEFAULT_MIN_SECONDS,
  MIN_MIN_SECONDS,
  MAX_MIN_SECONDS,
} from '../lib/videoExport.js';

// The page loads this by itself so the controls have something real under them
// from the start: a still gallery could only show finished stacks, where the
// whole point is the power and range handles moving. It is a short clip, and it
// is cancelled the moment anyone opens their own footage.
//
// The page is served at /startrails with no trailing slash, so a relative URL
// would resolve against the site root.
const SAMPLE = {
  poster: `${BASE_PATH}/example-startrail-preview.jpg`,
  name: 'example-startrail.mp4',
  frames: 84,
  natural: { width: 1080, height: 1620 },
  preview: { width: 893, height: 1340, density: 2 },
};

const DEFAULTS = { fade: 'linear', power: 1, minOpacity: 0 };
const INTRO_DURATION = 1000;
const PLAYBACK_INTERVAL = 1000 / 15;
const POWER_MIN = 0.1;
const POWER_MAX = 10;
const POWER_SLIDER_STEPS = 1000;

const SOURCE_LABEL = { video: 'Video', photos: 'Photos', folder: 'Folder' };

// A jbx link that runs an action instead of navigating: the class carries the
// look, the element stays a button so it focuses and Enter works.
const LINK_STYLE = { border: 0, background: 'none', padding: 0, font: 'inherit' };

/** "every 3rd frame" reads better than "every 3 frames" for the sampling note. */
function ordinal(value) {
  const teens = value % 100;
  if (teens >= 11 && teens <= 13) return `${value}th`;
  return `${value}${['th', 'st', 'nd', 'rd'][value % 10] || 'th'}`;
}

/** Loose photos have no folder to be named after, so they say what they are. */
function describePicks(picks) {
  if (!picks.length) return 'Selected files';
  if (picks.length === 1) return picks[0].name;
  return `${picks[0].name} – ${picks[picks.length - 1].name}`;
}

function formatFps(fps) {
  return fps.toFixed(2).replace(/\.?0+$/, '');
}

// Keep the useful low-power end physically wide while still offering the much
// stronger values at the end of the control. The input itself stays linear;
// only the value exposed to the stacker follows a quadratic curve.
function powerFromSlider(value) {
  const position = value / POWER_SLIDER_STEPS;
  const power = POWER_MIN + (POWER_MAX - POWER_MIN) * position ** 2;
  return Math.round(power * 10) / 10;
}

function sliderFromPower(power) {
  const position = Math.sqrt((power - POWER_MIN) / (POWER_MAX - POWER_MIN));
  return Math.round(position * POWER_SLIDER_STEPS);
}

function Card({ children, disabled = false }) {
  return (
    <div
      className={`jbx-card${disabled ? ' -disabled' : ''}`}
      inert={disabled ? true : undefined}
      aria-disabled={disabled || undefined}
    >
      <Box padding={1}>{children}</Box>
    </div>
  );
}

/** A named group of choices: the label on the left, the choices beside it, so
    two adjacent groups read as two rows rather than one long list. */
function OptionRow({ label, children }) {
  return (
    <div className="option-row">
      <Text className="option-label">{label}</Text>
      {children}
    </div>
  );
}

/** The label and bar for whatever is running, wherever it is being shown. */
function Progress({ progress, percent }) {
  return (
    <div role="status" aria-live="polite">
      <SmallText>{progressLabel(progress)}</SmallText>
      <div className="bar">
        <div className="bar-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function progressLabel(progress) {
  if (!progress) return '';
  switch (progress.phase) {
    case 'sample':
      return progress.total
        ? `Loading sample previews ${progress.done} / ${progress.total}`
        : 'Loading sample previews';
    case 'extract':
      return `Extracting frames ${progress.done} / ${progress.total}`;
    case 'load':
      return `Reading frames ${progress.done} / ${progress.total}`;
    case 'export':
      return `Stacking ${progress.done} / ${progress.total}`;
    case 'sequence':
      return `Rendering video ${progress.done} / ${progress.total}`;
    case 'encode':
      return 'Writing the video file';
    default:
      return '';
  }
}

function FrameRange({
  disabled,
  first,
  last,
  max,
  onFirstChange,
  onLastChange,
  onWindowChange,
}) {
  const rangeRef = useRef(null);
  const dragRef = useRef(null);
  const scale = Math.max(max, 1);
  const canMoveWindow = !disabled && last - first < max;

  const moveWindow = useCallback(
    (nextFirst) => {
      const width = last - first;
      const clampedFirst = Math.max(0, Math.min(nextFirst, max - width));
      onWindowChange(clampedFirst, clampedFirst + width);
    },
    [first, last, max, onWindowChange]
  );

  const onSelectionPointerDown = (event) => {
    if (!canMoveWindow) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      first,
      width: last - first,
    };
  };

  const onSelectionPointerMove = (event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const railWidth = rangeRef.current?.getBoundingClientRect().width || 1;
    const frameDelta = Math.round(((event.clientX - drag.startX) / railWidth) * max);
    const nextFirst = Math.max(0, Math.min(drag.first + frameDelta, max - drag.width));
    onWindowChange(nextFirst, nextFirst + drag.width);
  };

  const finishSelectionDrag = (event) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onSelectionKeyDown = (event) => {
    let nextFirst;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        nextFirst = first - 1;
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        nextFirst = first + 1;
        break;
      case 'PageDown':
        nextFirst = first - 10;
        break;
      case 'PageUp':
        nextFirst = first + 10;
        break;
      case 'Home':
        nextFirst = 0;
        break;
      case 'End':
        nextFirst = max - (last - first);
        break;
      default:
        return;
    }
    event.preventDefault();
    moveWindow(nextFirst);
  };

  return (
    <div
      ref={rangeRef}
      className={`frame-range${first === last && first > max / 2 ? ' -first-on-top' : ''}`}
      style={{
        '--frame-first': `${(first / scale) * 100}%`,
        '--frame-last': `${(last / scale) * 100}%`,
      }}
    >
      <div
        className="frame-range-selection"
        role="slider"
        tabIndex={canMoveWindow ? 0 : -1}
        aria-label="Selected frame range"
        aria-valuemin={1}
        aria-valuemax={max - (last - first) + 1}
        aria-valuenow={first + 1}
        aria-valuetext={`Frames ${first + 1} through ${last + 1}`}
        aria-disabled={!canMoveWindow}
        onPointerDown={onSelectionPointerDown}
        onPointerMove={onSelectionPointerMove}
        onPointerUp={finishSelectionDrag}
        onPointerCancel={finishSelectionDrag}
        onKeyDown={onSelectionKeyDown}
      />
      <Range
        aria-label="First frame"
        aria-valuetext={`Frame ${first + 1} of ${max + 1}`}
        min={0}
        max={max}
        step={1}
        value={first}
        disabled={disabled}
        onChange={onFirstChange}
      />
      <Range
        aria-label="Last frame"
        aria-valuetext={`Frame ${last + 1} of ${max + 1}`}
        min={0}
        max={max}
        step={1}
        value={last}
        disabled={disabled}
        onChange={onLastChange}
      />
    </div>
  );
}

export default function StarTrailsApp() {
  const canvasRef = useRef(null);
  const stackerRef = useRef(null);
  const eventRef = useRef(() => {});
  // The worker only ever runs one restack at a time; a drag that outruns it
  // parks its latest values here and fires them the moment it reports back.
  const previewRef = useRef({ busy: false, queued: null, sent: null });
  // Video extraction runs on the main thread and can take a while, so a second
  // drop has to be able to call off the one in progress.
  const extractRef = useRef(null);
  // New source details stay pending until the worker has a complete cache and
  // an initial composite ready to replace the visible preview.
  const pendingLoadRef = useRef(null);
  const loadRequestRef = useRef(0);
  const cacheReadyRef = useRef(false);
  const skipNextPreviewRef = useRef(false);
  const folderInputRef = useRef(null);
  const playbackRef = useRef(null);
  // A video export owns an encoder for as long as it runs, and every way out of
  // it -- finished, cancelled, failed -- has to hand it back.
  const videoJobRef = useRef(null);

  const [frames, setFrames] = useState([]);
  const [folder, setFolder] = useState(null);
  const [handle, setHandle] = useState(null);
  const [savedFolder, setSavedFolder] = useState(null);
  const [source, setSource] = useState('folder');
  const [videoSummary, setVideoSummary] = useState(null);
  const [isSample, setIsSample] = useState(false);
  // showDirectoryPicker cannot be asked about while rendering on the server, so
  // the first client render has to agree with the server and say no. Anything
  // that branches on it waits for this.
  const [mounted, setMounted] = useState(false);
  const canPickDirectory = mounted && supportsDirectoryPicker();

  const [natural, setNatural] = useState(SAMPLE.natural);
  const [preview, setPreview] = useState(SAMPLE.preview);
  const [hasPreview, setHasPreview] = useState(false);

  const [fade, setFade] = useState(DEFAULTS.fade);
  const [powerSlider, setPowerSlider] = useState(() =>
    sliderFromPower(DEFAULTS.power)
  );
  const power = powerFromSlider(powerSlider);
  const [minOpacity, setMinOpacity] = useState(DEFAULTS.minOpacity);
  const [first, setFirst] = useState(0);
  const [last, setLast] = useState(0);
  const selected = last - first + 1;
  // The falloff every render path shares. Curve mode ignores `trail` and linear
  // mode ignores `power`; sending both keeps the worker message flat. Linear's
  // fixed step per frame is sized to the selection, so the ramp always reaches
  // its faintest at the oldest selected frame -- widening the range is what
  // makes the trails longer.
  const look = useMemo(
    () => ({ fade, power, trail: selected, minOpacity: minOpacity / 100 }),
    [fade, minOpacity, power, selected]
  );
  const [isPlaying, setIsPlaying] = useState(false);

  const [rotation, setRotation] = useState(0);
  // Scale is held as a key rather than a factor: "Preview size" resolves against
  // the current source, so a stored number stops matching any tab the moment a
  // differently sized source is opened. Image and video keep separate picks --
  // a video above preview size re-decodes every frame for every output frame,
  // so it is not somewhere to arrive by accident.
  const [imageScaleKey, setImageScaleKey] = useState('full');
  const [videoScaleKey, setVideoScaleKey] = useState('preview');
  const [exportKind, setExportKind] = useState('image');
  const [fps, setFps] = useState(DEFAULT_FPS);
  const [minSeconds, setMinSeconds] = useState(DEFAULT_MIN_SECONDS);
  const [copyExif, setCopyExif] = useState(true);

  const [status, setStatus] = useState('extracting');
  const [progress, setProgress] = useState({
    phase: 'sample',
    step: 0,
    steps: 2,
    done: 0,
    total: 0,
  });
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const ready = status === 'ready' || status === 'intro' || status === 'exporting';
  const exporting = status === 'exporting';
  const controlsDisabled = status !== 'ready';
  const mediaLoading = status === 'extracting' || status === 'loading';
  // "Nothing of the viewer's own is open yet." The sample counts as nothing:
  // it loads on its own, so gating on frames.length would hide Reopen a second
  // after arrival, which is exactly when it is wanted.
  const untouched = isSample || !frames.length;

  const stopPlayback = useCallback(() => {
    if (playbackRef.current !== null) {
      clearInterval(playbackRef.current);
      playbackRef.current = null;
    }
    setIsPlaying(false);
  }, []);

  // The one place an encoder is let go of, so no path out of a video export can
  // leave one holding its buffers.
  const discardVideoJob = useCallback(() => {
    const job = videoJobRef.current;
    videoJobRef.current = null;
    job?.encoder.close();
  }, []);

  // --- worker plumbing ---------------------------------------------------

  const sendPreview = useCallback((params) => {
    const stacker = stackerRef.current;
    if (!stacker) return;
    const pending = previewRef.current;
    pending.queued = params;
    if (pending.busy) return;
    pending.busy = true;
    pending.sent = params;
    stacker.preview(params);
  }, []);

  // The worker hands back a bare canvas JPEG. Metadata is spliced on here
  // rather than in the worker, which has to stay import-free.
  const finishExport = useCallback(
    async (message) => {
      let blob = message.blob;
      let exifApplied = false;

      // Frames extracted from a video are canvas JPEGs with no APP segments of
      // their own, so there is nothing to carry over.
      if (copyExif && source !== 'video') {
        try {
          const withExif = await applySourceMetadata(
            blob,
            frames[first],
            message.width,
            message.height
          );
          blob = withExif.blob;
          exifApplied = withExif.applied;
        } catch (err) {
          // Metadata is a bonus; never lose a finished render over it.
          exifApplied = false;
        }
      }

      if (!message.isCurrent()) return;
      setStatus('ready');
      setProgress(null);
      setResult({
        kind: 'image',
        width: message.width,
        height: message.height,
        frames: message.frames,
        exifApplied,
      });
      downloadBlob(
        blob,
        exportFileName({
          firstName: frames[first].name,
          lastName: frames[last].name,
          ...look,
        })
      );
    },
    [copyExif, first, frames, last, look, source]
  );

  const finishVideoExport = useCallback(
    async (message) => {
      const job = videoJobRef.current;
      if (!job) return;
      videoJobRef.current = null;
      // Every frame is in; the bar stays full while the file is written.
      setProgress({ phase: 'encode', done: 1, total: 1 });

      try {
        const blob = await job.encoder.finish(job.plan.loops);
        if (!message.isCurrent()) return;
        setStatus('ready');
        setProgress(null);
        setResult({
          kind: 'video',
          width: job.size.width,
          height: job.size.height,
          frames: job.plan.totalOutputFrames,
          duration: job.plan.duration,
          fps,
        });
        downloadBlob(
          blob,
          exportFileName({
            firstName: frames[0].name,
            lastName: frames[frames.length - 1].name,
            ...look,
            extension: job.encoder.extension,
          })
        );
      } catch (err) {
        if (!message.isCurrent()) return;
        setError(err.message);
        setStatus('ready');
        setProgress(null);
      } finally {
        job.encoder.close();
      }
    },
    [fps, frames, look]
  );

  eventRef.current = (message) => {
    switch (message.type) {
      case 'loadStarted':
        break;

      case 'progress':
        if (
          message.phase === 'load' &&
          pendingLoadRef.current?.requestId !== message.requestId
        ) {
          break;
        }
        if (message.phase === 'load') {
          setProgress({
            ...message,
            step: pendingLoadRef.current.step,
            steps: pendingLoadRef.current.steps,
          });
        } else {
          setProgress(message);
        }
        break;

      case 'loaded': {
        const pending = pendingLoadRef.current;
        if (!pending || pending.requestId !== message.requestId) break;

        pendingLoadRef.current = null;
        cacheReadyRef.current = true;
        skipNextPreviewRef.current = true;
        setFrames(pending.frames);
        setFolder(pending.name);
        setHandle(pending.handle);
        setSource(pending.kind);
        setVideoSummary(pending.videoSummary);
        setIsSample(pending.isSample);
        setFirst(0);
        setLast(pending.isSample ? 0 : pending.frames.length - 1);
        setNatural(message.natural);
        setPreview(message.preview);
        setHasPreview(true);
        setProgress(null);
        setStatus(pending.isSample ? 'intro' : 'ready');
        break;
      }

      case 'previewDone': {
        const pending = previewRef.current;
        pending.busy = false;
        if (pending.queued && pending.queued !== pending.sent) sendPreview(pending.queued);
        break;
      }

      case 'exportDone':
        finishExport(message);
        break;

      case 'sequenceDone':
        finishVideoExport(message);
        break;

      case 'exportCancelled':
        setStatus('ready');
        setProgress(null);
        break;

      case 'error':
        if (
          message.phase === 'load' &&
          pendingLoadRef.current?.requestId !== message.requestId
        ) {
          break;
        }
        previewRef.current = { busy: false, queued: null, sent: null };
        discardVideoJob();
        setError(message.message);
        // A failed load has no complete preview cache to restack. Export errors
        // can return to the already-loaded preview, but aspect-ratio/decode
        // errors must leave the controls disabled until another folder opens.
        if (message.phase === 'load' || message.phase === 'worker') {
          pendingLoadRef.current = null;
          cacheReadyRef.current = false;
        }
        setStatus(
          (message.phase === 'load' || message.phase === 'worker')
            ? 'idle'
            : cacheReadyRef.current && frames.length
              ? 'ready'
              : 'idle'
        );
        setProgress(null);
        break;

      default:
        break;
    }
  };

  useEffect(() => {
    if (stackerRef.current || !canvasRef.current) return;
    stackerRef.current = createStacker({
      canvas: canvasRef.current,
      onEvent: (message) => eventRef.current(message),
    });
    return () => {
      extractRef.current?.abort();
      stackerRef.current?.destroy();
      stackerRef.current = null;
    };
  }, []);

  useEffect(() => {
    setMounted(true);
    if (!supportsDirectoryPicker()) return;
    recallHandle().then((saved) => saved && setSavedFolder(saved));
  }, []);

  // Any change to the look re-stacks the cached preview frames.
  useEffect(() => {
    if (!ready) return;
    // A successful load already rendered these exact values into a temporary
    // worker canvas before atomically committing them to the visible canvas.
    if (skipNextPreviewRef.current) {
      skipNextPreviewRef.current = false;
      return;
    }
    sendPreview({ ...look, first, last, rotation });
  }, [ready, look, first, last, rotation, sendPreview]);

  // The saved poster is frame 1, so the sample can hand off without a visual
  // jump and then quickly reveal the complete trail. Controls stay inert until
  // the sweep finishes, keeping the animation and range handles in lockstep.
  useEffect(() => {
    if (status !== 'intro') return;
    const finalFrame = frames.length - 1;
    if (finalFrame <= 0) {
      setStatus('ready');
      return;
    }

    let animationFrame;
    const started = performance.now();
    const tick = (now) => {
      const progress = Math.min(1, (now - started) / INTRO_DURATION);
      setLast(Math.round(finalFrame * progress));
      if (progress < 1) {
        animationFrame = requestAnimationFrame(tick);
      } else {
        setStatus('ready');
      }
    };

    animationFrame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationFrame);
  }, [frames.length, status]);

  useEffect(() => () => {
    if (playbackRef.current !== null) clearInterval(playbackRef.current);
    videoJobRef.current?.encoder.close();
    videoJobRef.current = null;
  }, []);

  // Loading a different source or starting an export invalidates the current
  // frame indices, so playback cannot be allowed to outlive the ready state.
  useEffect(() => {
    if (status !== 'ready' && playbackRef.current !== null) stopPlayback();
  }, [status, stopPlayback]);

  const turn = useCallback((degrees) => {
    setRotation((current) => (current + degrees + 360) % 360);
  }, []);

  // --- opening folders ---------------------------------------------------

  // The single funnel every input path ends at, videos included: by this point a
  // video has already become an array of frames.
  const acceptFrames = useCallback(
    (nextFrames, name, nextHandle, kind = 'folder', details = {}) => {
      // Opening photos or a folder abandons a video that is still being
      // extracted; the video path manages its own controller and must not
      // cancel itself here.
      if (kind !== 'video' && extractRef.current) {
        extractRef.current.abort();
        extractRef.current = null;
      }

      setError(null);
      setResult(null);

      // Invalidate a worker load immediately. Its messages carry a request ID
      // too, but cancellation lets it release decoded proxies without doing
      // the rest of the work.
      pendingLoadRef.current = null;
      stackerRef.current.cancelLoad();
      cacheReadyRef.current = false;

      if (!nextFrames || !nextFrames.length) {
        setError(
          kind === 'video'
            ? 'No frames could be read out of that video.'
            : kind === 'photos'
              ? 'Those files are not JPEGs or PNGs.'
              : 'No JPEG or PNG frames directly inside that folder.'
        );
        setStatus(cacheReadyRef.current && frames.length ? 'ready' : 'idle');
        setProgress(null);
        return;
      }

      const requestId = ++loadRequestRef.current;
      const intro = Boolean(details.isSample);
      const step = kind === 'video' ? 1 : 0;
      const steps = kind === 'video' ? 2 : 1;
      pendingLoadRef.current = {
        requestId,
        step,
        steps,
        frames: nextFrames,
        name,
        handle: nextHandle || null,
        kind,
        videoSummary: details.videoSummary || null,
        isSample: intro,
      };
      cacheReadyRef.current = false;
      setStatus('loading');
      setProgress({
        phase: 'load',
        requestId,
        step,
        steps,
        done: 0,
        total: nextFrames.length,
      });
      previewRef.current = { busy: false, queued: null, sent: null };
      stackerRef.current.load(
        nextFrames,
        {
          ...look,
          first: 0,
          last: intro ? 0 : nextFrames.length - 1,
          rotation,
        },
        requestId,
        details.source
      );
    },
    [frames.length, look, rotation]
  );

  const acceptVideo = useCallback(
    async (file) => {
      if (extractRef.current) extractRef.current.abort();
      const controller = new AbortController();
      extractRef.current = controller;
      pendingLoadRef.current = null;
      stackerRef.current.cancelLoad();
      cacheReadyRef.current = false;

      setError(null);
      setResult(null);
      setStatus('extracting');
      const step = 0;
      const steps = 2;
      setProgress({ phase: 'extract', step, steps, done: 0, total: 1 });

      try {
        const { frames: extracted, summary, source: descriptor } = await framesFromVideoFile(file, {
          signal: controller.signal,
          onProgress: (done, total) => {
            if (!controller.signal.aborted) {
              setProgress({ phase: 'extract', step, steps, done, total });
            }
          },
        });
        if (controller.signal.aborted) return;
        acceptFrames(extracted, file.name, null, 'video', {
          videoSummary: summary,
          source: descriptor,
        });
      } catch (err) {
        // A newer drop cancelled this one; it owns the UI now.
        if (controller.signal.aborted || err.name === 'AbortError') return;
        setError(err.message);
        setStatus(cacheReadyRef.current && frames.length ? 'ready' : 'idle');
        setProgress(null);
      } finally {
        if (extractRef.current === controller) extractRef.current = null;
      }
    },
    [acceptFrames, frames.length]
  );

  // Prebuilt demo previews share the source-loading cancellation controller.
  // The original video is fetched lazily by the renderer.
  const loadSample = useCallback(async () => {
    // A user can select a folder in the short idle window before this deferred
    // task runs. Pending or committed user frames take precedence just like an
    // in-progress video extraction does.
    if (extractRef.current || pendingLoadRef.current || cacheReadyRef.current) return;
    const controller = new AbortController();
    extractRef.current = controller;

    setStatus('extracting');
    setProgress({ phase: 'sample', step: 0, steps: 2, done: 0, total: 0 });

    try {
      const { frames: sampleFrames, summary, source: descriptor } = await loadSampleFrames(BASE_PATH, {
        signal: controller.signal,
        onProgress: (done, total) => {
          if (!controller.signal.aborted) setProgress({ phase: 'sample', step: 0, steps: 2, done, total });
        },
      });
      if (controller.signal.aborted) return;
      extractRef.current = null;
      acceptFrames(sampleFrames, SAMPLE.name, null, 'video', {
        isSample: true, videoSummary: summary, source: descriptor,
      });
    } catch (err) {
      if (!controller.signal.aborted) {
        setError('The sample previews could not be loaded. Open a folder or a video instead.');
        setProgress(null);
        setStatus('idle');
      }
    } finally {
      if (extractRef.current === controller) extractRef.current = null;
    }
  }, [acceptFrames]);

  useEffect(() => {
    // Let the poster paint before fetching the prepared sample frames.
    const start = () => loadSample();
    const idle = typeof requestIdleCallback === 'function';
    const handle = idle ? requestIdleCallback(start, { timeout: 1000 }) : setTimeout(start, 200);
    return () => (idle ? cancelIdleCallback(handle) : clearTimeout(handle));
    // Runs once; loadSample is stable enough for the mount pass and a rerun
    // would be refused by the extractRef guard anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openWithPicker = useCallback(async () => {
    try {
      const picked = await pickDirectory();
      setSavedFolder(picked.handle);
      acceptFrames(picked.frames, picked.name, picked.handle);
    } catch (err) {
      // AbortError just means the picker was dismissed.
      if (err.name !== 'AbortError') setError(err.message);
    }
  }, [acceptFrames]);

  const reopenSaved = useCallback(async () => {
    try {
      if (!(await ensureReadPermission(savedFolder))) {
        await forgetHandle();
        setSavedFolder(null);
        return;
      }
      acceptFrames(await readHandleFrames(savedFolder), savedFolder.name, savedFolder);
    } catch (err) {
      await forgetHandle();
      setSavedFolder(null);
      setError('That folder could not be opened again. Pick it once more.');
    }
  }, [acceptFrames, savedFolder]);

  const rescan = useCallback(async () => {
    if (!handle) return;
    try {
      if (!(await ensureReadPermission(handle))) return;
      acceptFrames(await readHandleFrames(handle), folder, handle);
    } catch (err) {
      setError(err.message);
    }
  }, [acceptFrames, folder, handle]);

  const onDrop = useCallback(
    async (event) => {
      event.preventDefault();
      try {
        const dropped = await framesFromDataTransfer(event.dataTransfer);
        if (!dropped) {
          setError('Drop photos, a folder of them, or a video.');
          return;
        }
        if (dropped.video) {
          acceptVideo(dropped.video);
          return;
        }
        if (dropped.handle) setSavedFolder(dropped.handle);
        acceptFrames(dropped.frames, dropped.name, dropped.handle);
      } catch (err) {
        setError(err.message);
      }
    },
    [acceptFrames, acceptVideo]
  );

  const onFileInput = useCallback(
    (event) => {
      const picked = event.target.files;
      if (!picked || !picked.length) return;
      acceptFrames(framesFromFileList(picked), folderNameFromFileList(picked), null);
    },
    [acceptFrames]
  );

  // Clicking the zone opens one picker that takes either, so it has to sort
  // out which was chosen. A video comes alone; photos come in a heap.
  const onPickInput = useCallback(
    (event) => {
      const picked = Array.from(event.target.files || []);
      // Cleared so choosing the same files again still fires a change.
      event.target.value = '';
      if (!picked.length) return;

      const video = picked.find(isVideo);
      if (video) {
        acceptVideo(video);
        return;
      }

      const picks = framesFromFileList(picked);
      acceptFrames(picks, describePicks(picks), null, 'photos');
    },
    [acceptFrames, acceptVideo]
  );

  // Chromium can hand over a re-openable handle; everywhere else falls back to
  // the plain folder upload. Either way it is the same button.
  const openFolder = useCallback(() => {
    if (canPickDirectory) {
      openWithPicker();
      return;
    }
    if (folderInputRef.current) folderInputRef.current.click();
  }, [canPickDirectory, openWithPicker]);

  const hasFrames = frames.length > 0;
  const totalFrames = hasFrames ? frames.length : SAMPLE.frames;

  const turned = rotation === 90 || rotation === 270;
  const hasDimensions = natural.width > 0 && natural.height > 0;
  const previewScale = natural.width ? preview.width / natural.width : 1;
  const scaleOptions = [
    { key: 'full', label: 'Full', factor: 1 },
    { key: 'half', label: 'Half', factor: 0.5 },
    {
      key: 'preview',
      label: 'Preview',
      factor: hasDimensions ? previewScale : null,
    },
  ];
  const wantsVideo = exportKind === 'video';
  const scaleKey = wantsVideo ? videoScaleKey : imageScaleKey;
  const setScaleKey = wantsVideo ? setVideoScaleKey : setImageScaleKey;
  const scale = scaleOptions.find((option) => option.key === scaleKey).factor ?? 1;
  const outWidth = hasDimensions
    ? Math.max(1, Math.round((turned ? natural.height : natural.width) * scale))
    : null;
  const outHeight = hasDimensions
    ? Math.max(1, Math.round((turned ? natural.width : natural.height) * scale))
    : null;
  // The window slides from frame 0 to the last position that still fits, one
  // position per video frame -- the same sweep the play button previews.
  const windowWidth = last - first;
  const allSelected = selected >= totalFrames;
  const videoPlan = planVideo({ totalFrames, windowWidth, fps, minSeconds });
  const videoOut = hasDimensions
    ? videoSize({ width: outWidth, height: outHeight })
    : null;
  const videoDecodes =
    scale > previewScale ? videoPlan.cycleFrames * selected : 0;

  // --- export ------------------------------------------------------------

  const startExport = useCallback(() => {
    stopPlayback();
    setError(null);
    setResult(null);
    previewRef.current = { busy: false, queued: null, sent: null };
    setStatus('exporting');
    setProgress({
      phase: 'export',
      done: 0,
      total: last - first + 1,
    });
    stackerRef.current.exportImage({
      ...look,
      first,
      last,
      scale,
      rotation,
    });
  }, [first, last, look, rotation, scale, stopPlayback]);

  // Only the loop is composited. Repeating it to reach the minimum length is the
  // muxer's job, so a longer video is not a longer render.
  const startVideoExport = useCallback(async () => {
    stopPlayback();
    setError(null);
    setResult(null);

    const plan = planVideo({ totalFrames, windowWidth, fps, minSeconds });
    const size = videoSize({ width: outWidth, height: outHeight });

    let encoder;
    try {
      // Probing the codecs can fail outright, and it is much friendlier to say
      // so before the progress bar appears than half way through.
      encoder = await createVideoEncoder({ ...size, fps });
    } catch (err) {
      setError(err.message);
      return;
    }

    // After the await, not before: two clicks landing during the codec probe
    // would otherwise both build an encoder and only one would be handed back.
    discardVideoJob();
    videoJobRef.current = { plan, size, encoder };
    previewRef.current = { busy: false, queued: null, sent: null };
    setStatus('exporting');
    setProgress({ phase: 'sequence', done: 0, total: plan.cycleFrames });
    stackerRef.current.exportSequence(
      {
        ...look,
        windowWidth,
        scale,
        rotation,
      },
      async (bitmap, index, total) => {
        await encoder.add(bitmap, index);
        setProgress({ phase: 'sequence', done: index + 1, total });
      }
    );
  }, [
    fps,
    look,
    minSeconds,
    outHeight,
    outWidth,
    rotation,
    scale,
    stopPlayback,
    totalFrames,
    windowWidth,
    discardVideoJob,
  ]);

  const cancelExport = useCallback(() => {
    discardVideoJob();
    stackerRef.current.cancelExport();
  }, [discardVideoJob]);

  const togglePlayback = useCallback(() => {
    if (playbackRef.current !== null) {
      stopPlayback();
      return;
    }

    const width = last - first;
    const finalFirst = totalFrames - 1 - width;
    if (finalFirst <= 0) return;

    setFirst(0);
    setLast(width);
    setIsPlaying(true);

    let nextFirst = 1;
    playbackRef.current = setInterval(() => {
      setFirst(nextFirst);
      setLast(nextFirst + width);
      nextFirst = nextFirst >= finalFirst ? 0 : nextFirst + 1;
    }, PLAYBACK_INTERVAL);
  }, [first, last, stopPlayback, totalFrames]);

  const changeFirst = useCallback(
    (value) => {
      stopPlayback();
      setFirst(Math.min(value, last));
    },
    [last, stopPlayback]
  );

  const changeLast = useCallback(
    (value) => {
      stopPlayback();
      setLast(Math.max(value, first));
    },
    [first, stopPlayback]
  );

  const changeFrameWindow = useCallback(
    (nextFirst, nextLast) => {
      stopPlayback();
      setFirst(nextFirst);
      setLast(nextLast);
    },
    [stopPlayback]
  );
  const progressPercent = progress
    ? Math.max(
        0,
        Math.min(
          100,
          (((progress.step || 0) +
            (progress.total ? progress.done / progress.total : 0)) /
            (progress.steps || 1)) *
            100
        )
      )
    : 0;

  return (
    <div className="app">
      <Space h={2} />

      {/* The zone takes either kind of source, by drop or by click -- it is a
          label rather than a jbx Dropzone (a div) so the click opens the
          picker with no handler of its own. The input is kept off the flow
          rather than stretched over the zone the way jbx does it: a file
          input under the pointer would swallow the drop. */}
      <label
        className="jbx-dropzone"
        style={{ position: 'relative' }}
        onDrop={onDrop}
        onDragOver={(event) => event.preventDefault()}
      >
        <input
          type="file"
          multiple
          accept="image/jpeg,image/png,video/*"
          style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
          onChange={onPickInput}
        />
        {/* Both lines are one block, the way img2css groups them, so the zone
            centres the pair instead of spreading them as two flex items. */}
        <div>
          <Text>Drop photos or a video here</Text>
          <Text>or click to select</Text>
        </div>
      </label>

      <Space h={0.5} />

      {/* Whole folders are the quieter case, so they sit under the zone as a
          link rather than competing with it. */}
      <SmallText>
        <button type="button" className="jbx-a" style={LINK_STYLE} onClick={openFolder}>
          Open a folder instead
        </button>
        {savedFolder && untouched && (
          <>
            <Space inline w={1} />
            <button type="button" className="jbx-a" style={LINK_STYLE} onClick={reopenSaved}>
              Reopen “{savedFolder.name}”
            </button>
          </>
        )}
      </SmallText>

      <input
        ref={folderInputRef}
        type="file"
        webkitdirectory=""
        directory=""
        multiple
        accept="image/jpeg,image/png"
        style={{ display: 'none' }}
        onChange={onFileInput}
      />

      {error && (
        <>
          <Space h={1} />
          <Text style={{ color: 'var(--accent-color)' }}>{error}</Text>
        </>
      )}

      <Space h={1} />

      <div
        className={`stage${mediaLoading ? ' -loading' : ''}`}
        aria-busy={Boolean(progress)}
        style={{
          '--preview-display-width': `${
            Math.min(640, (turned ? natural.height : natural.width) / 2)
          }px`,
          // Lets the stylesheet trade width for height against a viewport cap,
          // which is what keeps a portrait sequence from pushing the controls
          // off the bottom of the screen.
          '--preview-aspect':
            (turned ? natural.height : natural.width) /
            (turned ? natural.width : natural.height),
        }}
      >
        <img
          src={SAMPLE.poster}
          alt=""
          aria-hidden="true"
          className={`preview-poster${hasPreview ? ' -hidden' : ''}`}
        />
        <canvas
          ref={canvasRef}
          className={`preview-canvas${hasPreview ? '' : ' -hidden'}`}
        />
        {progress && !exporting && (
          <div className="stage-status">
            <Progress progress={progress} percent={progressPercent} />
          </div>
        )}
      </div>

      <Space h={1} />
      <Card disabled={controlsDisabled}>
        <HeaderH4>Look</HeaderH4>
        <Space h={0.5} />

        <Inline
          style={{
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '0.75rem',
          }}
        >
          <Text>
            Frames <strong>{selected}</strong> of {totalFrames}
          </Text>
          <Button
            className="jbx-button frame-play-button"
            disabled={controlsDisabled || selected >= totalFrames}
            onClick={togglePlayback}
            aria-label={
              isPlaying ? 'Stop frame range playback' : 'Play frame range'
            }
            title={isPlaying ? 'Stop frame range playback' : 'Play frame range'}
          >
            {isPlaying ? '■' : '▶'}
          </Button>
        </Inline>
        <Space h={0.25} />
        <FrameRange
          first={first}
          last={last}
          max={totalFrames - 1}
          disabled={controlsDisabled}
          onFirstChange={(event) => changeFirst(Number(event.target.value))}
          onLastChange={(event) => changeLast(Number(event.target.value))}
          onWindowChange={changeFrameWindow}
        />

        <Space h={0.75} />
        <OptionRow label="Fade">
          <Tabs>
            <Tab
              active={fade === 'curve'}
              aria-disabled={controlsDisabled}
              onClick={() => !controlsDisabled && setFade('curve')}
            >
              Curve
            </Tab>
            <Tab
              active={fade === 'linear'}
              aria-disabled={controlsDisabled}
              onClick={() => !controlsDisabled && setFade('linear')}
            >
              Linear
            </Tab>
          </Tabs>
        </OptionRow>
        <Space h={0.25} />

        {fade === 'curve' ? (
          <>
            <Text>
              Decay <strong>{power.toFixed(1)}</strong>
            </Text>
            <Space h={0.25} />
            <Range
              aria-label="Decay"
              aria-valuetext={power.toFixed(1)}
              min={0}
              max={POWER_SLIDER_STEPS}
              step={1}
              value={powerSlider}
              disabled={controlsDisabled}
              onChange={(event) => setPowerSlider(Number(event.target.value))}
            />
          </>
        ) : (
          <SmallText>
            The fade steps down by the same amount across the {selected} frames
            you selected, so the oldest is the faintest. Widen the range for
            longer trails.
          </SmallText>
        )}
        <Space h={0.75} />

        <Text>
          Min opacity <strong>{minOpacity}%</strong>
        </Text>
        <Space h={0.25} />
        <Range
          min={0}
          max={100}
          step={1}
          value={minOpacity}
          disabled={controlsDisabled}
          onChange={(event) => setMinOpacity(Number(event.target.value))}
        />
        <Space h={0.75} />
        <OptionRow
          label={
            <>
              Rotation <strong>{rotation}°</strong>
            </>
          }
        >
          <Inline wrap={false} style={{ flex: 'none', gap: '0.5rem' }}>
            <Button
              className="option-button"
              disabled={controlsDisabled}
              onClick={() => turn(-90)}
              aria-label="Rotate left 90 degrees"
            >
              ⟲ Left
            </Button>
            <Button
              className="option-button"
              disabled={controlsDisabled}
              onClick={() => turn(90)}
              aria-label="Rotate right 90 degrees"
            >
              ⟳ Right
            </Button>
          </Inline>
        </OptionRow>
      </Card>

      <Space h={1} />

      <Card>
        <HeaderH4>Export</HeaderH4>
        <Space h={0.5} />

        <div
          className={`control-group${controlsDisabled ? ' -disabled' : ''}`}
          inert={controlsDisabled ? true : undefined}
          aria-disabled={controlsDisabled || undefined}
        >
          <OptionRow label="Format">
            <Tabs>
              <Tab
                active={!wantsVideo}
                aria-disabled={controlsDisabled}
                onClick={() => !controlsDisabled && setExportKind('image')}
              >
                Image
              </Tab>
              <Tab
                active={wantsVideo}
                aria-disabled={controlsDisabled}
                onClick={() => !controlsDisabled && setExportKind('video')}
              >
                Video
              </Tab>
            </Tabs>
          </OptionRow>

          <OptionRow label="Size">
            <Tabs>
              {scaleOptions.map((option) => (
                <Tab
                  key={option.key}
                  active={scaleKey === option.key}
                  aria-disabled={controlsDisabled || option.factor === null}
                  onClick={() => {
                    if (!controlsDisabled && option.factor !== null)
                      setScaleKey(option.key);
                  }}
                >
                  {option.label}
                </Tab>
              ))}
            </Tabs>
          </OptionRow>
          <Space h={0.5} />

          {wantsVideo ? (
            <>
              <SmallText>
                {videoOut ? `${videoOut.width} × ${videoOut.height} ` : ''}MP4 at{' '}
                {fps} fps. The {videoPlan.cycleFrames}-frame loop repeats{' '}
                {videoPlan.loops}× for {videoPlan.duration.toFixed(1)} s.
                {videoDecodes
                  ? ` Above preview size every one of those frames decodes its ${selected} source frames again — ${videoDecodes} decodes in all.`
                  : ''}
              </SmallText>

              <Space h={0.75} />
              <Text>
                Minimum length <strong>{minSeconds}s</strong>
              </Text>
              <Space h={0.25} />
              <Range
                aria-label="Minimum video length in seconds"
                aria-valuetext={`${minSeconds} seconds`}
                min={MIN_MIN_SECONDS}
                max={MAX_MIN_SECONDS}
                step={1}
                value={minSeconds}
                disabled={controlsDisabled}
                onChange={(event) => setMinSeconds(Number(event.target.value))}
              />
              <Space h={0.25} />
              <SmallText>
                The loop repeats whole times, so the video only ever runs past
                this, never short of it.
              </SmallText>

              <Space h={0.75} />
              <OptionRow label="Frame rate">
                <Tabs>
                  {FPS_OPTIONS.map((option) => (
                    <Tab
                      key={option}
                      active={fps === option}
                      aria-disabled={controlsDisabled}
                      onClick={() => !controlsDisabled && setFps(option)}
                    >
                      {option}
                    </Tab>
                  ))}
                </Tabs>
              </OptionRow>
            </>
          ) : (
            <>
              <SmallText>
                {outWidth} × {outHeight} JPEG, quality 95.
                {hasDimensions && scale === 1
                  ? ' Full size is slower because every frame is decoded again.'
                  : ''}
              </SmallText>

              {/* Frames extracted from a video are canvas JPEGs with no metadata
                  of their own, so there is nothing to offer. */}
              {hasFrames && source !== 'video' && (
                <>
                  <Space h={1} />
                  <Checkbox
                    label="Preserve EXIF from the first frame"
                    checked={copyExif}
                    onChange={setCopyExif}
                  />
                  <Space h={0.25} />
                  <SmallText>
                    Keeps the camera, lens, date and shooting settings from the
                    first frame.
                  </SmallText>
                </>
              )}
            </>
          )}
        </div>

        {/* Outside the control group so it stays readable while the controls
            are inert. A full selection leaves the window nowhere to slide. */}
        {wantsVideo && allSelected && (
          <>
            <Space h={1} />
            <Text style={{ color: 'var(--accent-color)' }}>
              Video export requires selecting less frames
            </Text>
          </>
        )}

        <Space h={1} />
        <Inline style={{ alignItems: 'center', gap: '0.75rem' }}>
          <Button
            onClick={wantsVideo ? startVideoExport : startExport}
            disabled={controlsDisabled || (wantsVideo && allSelected)}
          >
            {exporting
              ? wantsVideo
                ? 'Rendering…'
                : 'Stacking…'
              : wantsVideo
                ? 'Export video'
                : 'Export JPEG'}
          </Button>
          {exporting && <Button onClick={cancelExport}>Cancel</Button>}
        </Inline>

        {/* Beside the button rather than over the preview: on a phone the
            preview is scrolled well off the top by the time anyone presses
            export, so progress shown up there is progress nobody sees. */}
        {progress && exporting && (
          <>
            <Space h={0.75} />
            <div className="export-progress">
              <Progress progress={progress} percent={progressPercent} />
            </div>
          </>
        )}

        {result && (
          <>
            <Space h={1} />
            <Text>
              {result.kind === 'video' ? (
                <>
                  Saved a {result.duration.toFixed(1)} s {result.width} ×{' '}
                  {result.height} video, {result.frames} frames at {result.fps}{' '}
                  fps.
                </>
              ) : (
                <>
                  Saved {result.width} × {result.height} from {result.frames}{' '}
                  frames
                  {result.exifApplied ? ', preserving the first frame EXIF' : ''}.
                </>
              )}
            </Text>
          </>
        )}
      </Card>

      {hasFrames && (
        <>
          <Space h={1} />

          {/* Everything descriptive lives down here. None of it is needed to
              work the controls, and the space above them is worth more. */}
          <Card>
            <HeaderH4>Source</HeaderH4>
            <Space h={0.5} />
            <dl className="stats">
              <dt>{SOURCE_LABEL[source]}</dt>
              <dd>
                {folder}
                {isSample ? ' (sample)' : ''}
              </dd>

              <dt>Frames</dt>
              <dd>
                {frames.length}
                {selected === frames.length ? '' : `, stacking ${selected}`}
              </dd>

              <dt>Size</dt>
              <dd>
                {natural.width} × {natural.height}
              </dd>

              {source === 'video' && videoSummary && (
                <>
                  <dt>Sampling</dt>
                  <dd>
                    {videoSummary.step > 1
                      ? `every ${ordinal(videoSummary.step)} frame of ${videoSummary.total}`
                      : videoSummary.estimated ? 'evenly spaced samples' : 'every frame'}
                    , at {videoSummary.estimated ? 'approximately ' : ''}{formatFps(videoSummary.fps)} fps
                  </dd>
                </>
              )}
            </dl>

            {handle && (
              <>
                <Space h={1} />
                <Button onClick={rescan} disabled={status !== 'ready'}>
                  Rescan
                </Button>
                <Space h={0.5} />
                <SmallText>
                  Re-reads the folder and includes any new frames.
                </SmallText>
              </>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
