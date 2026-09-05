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

import {
  LIVE_PHOTO_FPS, LIVE_PHOTO_SECONDS, LIVE_PHOTO_MAX_FRAMES,
  livePhotoSize, livePhotoJpeg, livePhotoMov,
} from '../lib/livePhoto.js';

import { BASE_PATH } from '../lib/constants.js';
import { applySourceMetadata } from '../lib/exif.js';
import { createStacker, downloadBlob, downloadBlobs, exportFileName } from '../lib/stackClient.js';
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
  videoResolutions,
  FPS_OPTIONS,
  DEFAULT_FPS,
  DEFAULT_MIN_SECONDS,
  MIN_MIN_SECONDS,
  MAX_MIN_SECONDS,
} from '../lib/videoExport.js';

// Load the sample on startup; cancel when the user opens a source.
// Use the base path because relative URLs resolve against the site root.
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

// Use link styling with native button keyboard behavior.
const LINK_STYLE = { border: 0, background: 'none', padding: 0, font: 'inherit' };

/** Format the sampling interval as an ordinal. */
function ordinal(value) {
  const teens = value % 100;
  if (teens >= 11 && teens <= 13) return `${value}th`;
  return `${value}${['th', 'st', 'nd', 'rd'][value % 10] || 'th'}`;
}

/** Generate a source label for loose photos. */
function describePicks(picks) {
  if (!picks.length) return 'Selected files';
  if (picks.length === 1) return picks[0].name;
  return `${picks[0].name} – ${picks[picks.length - 1].name}`;
}

function formatFps(fps) {
  return fps.toFixed(2).replace(/\.?0+$/, '');
}

// Map the slider quadratically for finer control at low power values.
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

/** Labeled row of choices. */
function OptionRow({ label, children }) {
  return (
    <div className="option-row">
      <Text className="option-label">{label}</Text>
      {children}
    </div>
  );
}

/** Tooltip with hover, focus, and tap support. */
function InfoTip({ label, children }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event) => {
      if (!ref.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <span className={`info-tip${open ? ' -open' : ''}`} ref={ref}>
      <button
        type="button"
        className="info-tip-button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        i
      </button>
      <span className="info-tip-bubble" role="tooltip">
        {children}
      </span>
    </span>
  );
}

/** Progress label and bar. */
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
  // Queue the latest slider values while the worker is busy.
  const previewRef = useRef({ busy: false, queued: null, sent: null });
  // Allow a new source to cancel video extraction.
  const extractRef = useRef(null);
  // New source details stay pending until the worker has a complete cache and
  // an initial composite ready to replace the visible preview.
  const pendingLoadRef = useRef(null);
  const loadRequestRef = useRef(0);
  const cacheReadyRef = useRef(false);
  const skipNextPreviewRef = useRef(false);
  const folderInputRef = useRef(null);
  const playbackRef = useRef(null);
  // Release the encoder on completion, cancellation, or failure.
  const videoJobRef = useRef(null);

  const [frames, setFrames] = useState([]);
  const [folder, setFolder] = useState(null);
  const [handle, setHandle] = useState(null);
  const [savedFolder, setSavedFolder] = useState(null);
  const [source, setSource] = useState('folder');
  const [videoSummary, setVideoSummary] = useState(null);
  const [isSample, setIsSample] = useState(false);
  // Defer directory-picker detection until mount to match server-rendered markup.
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
  // Shared falloff parameters. Curve uses power; linear uses the selection length as trail.
  const look = useMemo(
    () => ({ fade, power, trail: selected, minOpacity: minOpacity / 100 }),
    [fade, minOpacity, power, selected]
  );
  const [isPlaying, setIsPlaying] = useState(false);

  const [rotation, setRotation] = useState(0);
  const [videoResolution, setVideoResolution] = useState(1080);
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
  // Keep Reopen available while the sample is displayed.
  const untouched = isSample || !frames.length;

  const stopPlayback = useCallback(() => {
    if (playbackRef.current !== null) {
      clearInterval(playbackRef.current);
      playbackRef.current = null;
    }
    setIsPlaying(false);
  }, []);

  // Release encoder buffers for every export exit path.
  const discardVideoJob = useCallback(() => {
    const job = videoJobRef.current;
    videoJobRef.current = null;
    job?.encoder?.close();
  }, []);

  // Worker events.

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

  // Add metadata here because the worker must stay import-free.
  const finishExport = useCallback(
    async (message) => {
      const liveJob = videoJobRef.current;
      if (liveJob?.kind === 'live') {
        try {
          const photo = await livePhotoJpeg(message.blob, liveJob.identifier, message.width, message.height);
          if (!message.isCurrent() || videoJobRef.current !== liveJob) return;
          liveJob.photo = photo;
          liveJob.photoWidth = message.width;
          liveJob.photoHeight = message.height;
          liveJob.startSequence();
        } catch (err) {
          if (!message.isCurrent() || videoJobRef.current !== liveJob) return;
          discardVideoJob();
          setError(err.message);
          setStatus('ready');
          setProgress(null);
        }
        return;
      }
      let blob = message.blob;
      let exifApplied = false;

      // Video frames have no source metadata.
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
          // Keep the rendered image if metadata copying fails.
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
    [copyExif, first, frames, last, look, source, discardVideoJob]
  );

  const finishVideoExport = useCallback(
    async (message) => {
      const job = videoJobRef.current;
      if (!job) return;
      // Keep progress at 100% during file writing.
      setProgress({ phase: 'encode', done: 1, total: 1 });

      try {
        const blob = await job.encoder.finish(job.plan.loops);
        if (!message.isCurrent() || videoJobRef.current !== job) return;
        // Photos pairs the JPEG and MOV by their embedded identifier.
        let files = [{ blob, name: job.fileName }];
        if (job.kind === 'live') {
          const movie = await livePhotoMov(blob, job.identifier, job.stillTime, job.fps);
          if (!message.isCurrent() || videoJobRef.current !== job) return;
          files = [
            { blob: job.photo, name: job.fileName },
            { blob: movie, name: job.movieName },
          ];
        }
        setStatus('ready');
        setProgress(null);
        setResult({
          kind: job.kind,
          width: job.size.width,
          height: job.size.height,
          photoWidth: job.photoWidth,
          photoHeight: job.photoHeight,
          frames: job.plan.totalOutputFrames,
          duration: job.plan.duration,
          fps: job.fps,
          // Retain Live Photo blobs for the individual download buttons.
          files: job.kind === 'live' ? files : null,
        });
        downloadBlobs(files);
      } catch (err) {
        if (!message.isCurrent()) return;
        setError(err.message);
        setStatus('ready');
        setProgress(null);
      } finally {
        if (videoJobRef.current === job) videoJobRef.current = null;
        job.encoder.close();
      }
    },
    []
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
        // Keep controls disabled after load errors. Export errors can reuse the loaded preview.
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

  // Restack the preview when appearance settings change.
  useEffect(() => {
    if (!ready) return;
    // Skip parameters already rendered by the successful load.
    if (skipNextPreviewRef.current) {
      skipNextPreviewRef.current = false;
      return;
    }
    sendPreview({ ...look, first, last, rotation });
  }, [ready, look, first, last, rotation, sendPreview]);

  // Animate from the poster frame to the full stack. Disable controls during the sweep.
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
    videoJobRef.current?.encoder?.close();
    videoJobRef.current = null;
  }, []);

  // Stop playback when loading or export invalidates the frame indices.
  useEffect(() => {
    if (status !== 'ready' && playbackRef.current !== null) stopPlayback();
  }, [status, stopPlayback]);

  const turn = useCallback((degrees) => {
    setRotation((current) => (current + degrees + 360) % 360);
  }, []);

  // Source loading.

  // Load photo files or extracted video previews.
  const acceptFrames = useCallback(
    (nextFrames, name, nextHandle, kind = 'folder', details = {}) => {
      // Cancel video extraction when opening photos; video loading manages its own controller.
      if (kind !== 'video' && extractRef.current) {
        extractRef.current.abort();
        extractRef.current = null;
      }

      setError(null);
      setResult(null);

      // Cancel the worker load immediately to release decoded proxies.
      pendingLoadRef.current = null;
      discardVideoJob();
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
    [frames.length, look, rotation, discardVideoJob]
  );

  const acceptVideo = useCallback(
    async (file) => {
      if (extractRef.current) extractRef.current.abort();
      const controller = new AbortController();
      extractRef.current = controller;
      pendingLoadRef.current = null;
      discardVideoJob();
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
        // Ignore extraction cancelled by a newer source.
        if (controller.signal.aborted || err.name === 'AbortError') return;
        setError(err.message);
        setStatus(cacheReadyRef.current && frames.length ? 'ready' : 'idle');
        setProgress(null);
      } finally {
        if (extractRef.current === controller) extractRef.current = null;
      }
    },
    [acceptFrames, frames.length, discardVideoJob]
  );

  // Prebuilt demo previews share the source-loading cancellation controller.
  // The original video is fetched lazily by the renderer.
  const loadSample = useCallback(async () => {
    // Skip sample loading if a user source is loading or already open.
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
    // Load the sample once on mount. extractRef prevents duplicate loading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openWithPicker = useCallback(async () => {
    try {
      const picked = await pickDirectory();
      setSavedFolder(picked.handle);
      acceptFrames(picked.frames, picked.name, picked.handle);
    } catch (err) {
      // Ignore picker dismissal.
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

  // Accept one video or multiple photos.
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

  // Use a persistent directory handle when supported, otherwise a folder input.
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
  const resolutions = videoResolutions(natural);
  const wantsLivePhoto = exportKind === 'live';
  const wantsVideo = exportKind === 'video';
  const wantsMotion = wantsVideo || wantsLivePhoto;
  const resolution = resolutions.includes(videoResolution)
    ? videoResolution
    : Math.min(1080, resolutions.at(-1) ?? 1080);
  const scale = wantsVideo && hasDimensions
    ? resolution / Math.min(natural.width, natural.height)
    : 1;
  const outWidth = hasDimensions
    ? Math.max(1, Math.round((turned ? natural.height : natural.width) * scale))
    : null;
  const outHeight = hasDimensions
    ? Math.max(1, Math.round((turned ? natural.width : natural.height) * scale))
    : null;
  // One video frame per window position, matching preview playback.
  const windowWidth = last - first;
  const allSelected = selected >= totalFrames;
  const videoPlan = planVideo({ totalFrames, windowWidth, fps, minSeconds });
  // Use the export plan for the sampling label.
  const livePlan = planVideo({
    totalFrames, windowWidth, fps: LIVE_PHOTO_FPS, minSeconds: 0,
    maxFrames: LIVE_PHOTO_MAX_FRAMES, stillPosition: first,
  });
  const videoOut = hasDimensions
    ? videoSize({ width: outWidth, height: outHeight })
    : null;
  const videoDecodes =
    scale > previewScale ? videoPlan.cycleFrames * selected : 0;

  // Export.

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
      scale: 1,
      rotation,
    });
  }, [first, last, look, rotation, stopPlayback]);

  // Composite one loop; the muxer repeats its encoded packets.
  const startVideoExport = useCallback(async () => {
    // Reserve the job before codec detection to handle cancellation and concurrent clicks.
    if (videoJobRef.current) return;
    stopPlayback();
    setError(null);
    setResult(null);
    const exportFps = wantsLivePhoto ? LIVE_PHOTO_FPS : fps;
    const plan = planVideo({
      totalFrames, windowWidth, fps: exportFps,
      minSeconds: wantsLivePhoto ? 0 : minSeconds,
      ...(wantsLivePhoto
        ? { maxFrames: LIVE_PHOTO_MAX_FRAMES, stillPosition: first }
        : {}),
    });
    const size = wantsLivePhoto
      ? livePhotoSize({ width: turned ? natural.height : natural.width, height: turned ? natural.width : natural.height })
      : videoSize({ width: outWidth, height: outHeight });
    const job = {
      kind: wantsLivePhoto ? 'live' : 'video', plan, size, fps: exportFps,
      identifier: wantsLivePhoto ? crypto.randomUUID() : null,
      // Map the still to its output frame after sampling.
      stillTime: plan.stillFrame / exportFps,
      encoder: null,
    };
    videoJobRef.current = job;
    previewRef.current = { busy: false, queued: null, sent: null };
    setStatus('exporting');
    setProgress({ phase: 'encode', done: 0, total: 1 });
    try {
      const encoder = await createVideoEncoder({ ...size, fps: exportFps, livePhoto: wantsLivePhoto });
      if (videoJobRef.current !== job) { encoder.close(); return; }
      job.encoder = encoder;
      // Use a shared filename stem and avoid collisions with JPEG exports.
      job.fileName = exportFileName({
        firstName: frames[0].name, lastName: frames[frames.length - 1].name,
        ...look, suffix: wantsLivePhoto ? '-live' : '',
        extension: wantsLivePhoto ? 'jpg' : encoder.extension,
      });
      job.movieName = wantsLivePhoto ? job.fileName.replace(/\.jpg$/, '.mov') : null;
      job.startSequence = () => {
        setProgress({ phase: 'sequence', done: 0, total: plan.cycleFrames });
        stackerRef.current.exportSequence(
          { ...look, windowWidth, scale: wantsLivePhoto ? size.scale : scale, rotation,
            stride: plan.stride, startPosition: plan.startPosition },
          async (bitmap, index, total) => {
            await encoder.add(bitmap, index);
            if (videoJobRef.current === job)
              setProgress({ phase: 'sequence', done: index + 1, total });
          }
        );
      };
      if (wantsLivePhoto) {
        setProgress({ phase: 'export', done: 0, total: selected });
        stackerRef.current.exportImage({ ...look, first, last, scale: 1, rotation, quality: 1 });
      } else job.startSequence();
    } catch (err) {
      if (videoJobRef.current !== job) return;
      discardVideoJob();
      setError(err.message);
      setStatus('ready');
      setProgress(null);
    }
  }, [fps, look, minSeconds, outHeight, outWidth, rotation, scale, stopPlayback,
    totalFrames, windowWidth, discardVideoJob, wantsLivePhoto, natural, turned,
    first, last, frames, selected]);

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

      {/* The label opens the file picker. Keep the input outside the drop hit area. */}
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
        {/* Center both lines as one block. */}
        <div>
          <Text>Drop photos or a video here</Text>
          <Text>or click to select</Text>
        </div>
      </label>

      <Space h={0.5} />

      {/* Folder picker. */}
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
          // Size the preview by aspect ratio and viewport height.
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
        <OptionRow
          label={
            <>
              Fade{' '}
              <InfoTip label="About the fade methods">
                <strong>Curve</strong> fades along a curve you set with the
                decay slider: a low decay keeps older frames bright for an even
                trail, a high one drops them off fast for a bright head with a
                faint tail.
                <br />
                <br />
                <strong>Linear</strong> steps down by the same amount across the
                frames you selected, so the oldest is the faintest. Widen the
                range for longer trails.
              </InfoTip>
            </>
          }
        >
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

        {fade === 'curve' && (
          <>
            <Space h={0.25} />
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
                active={exportKind === 'image'}
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
              <Tab
                active={wantsLivePhoto}
                aria-disabled={controlsDisabled}
                onClick={() => !controlsDisabled && setExportKind('live')}
              >
                Live Photo
              </Tab>
            </Tabs>
          </OptionRow>

          {wantsVideo && (
            <OptionRow label="Size">
              <Tabs>
                {resolutions.map((option) => (
                  <Tab
                    key={option}
                    active={resolution === option}
                    aria-disabled={controlsDisabled}
                    onClick={() => {
                      if (!controlsDisabled) setVideoResolution(option);
                    }}
                  >
                    {option === 2160 ? '4K' : option}
                  </Tab>
                ))}
              </Tabs>
            </OptionRow>
          )}
          <Space h={0.5} />

          {wantsLivePhoto ? (
            <SmallText>
              Full-resolution photo, kept at the size the Image tab would export.
              The animation runs {livePlan.cycleDuration.toFixed(1)} s at {LIVE_PHOTO_FPS} fps,
              HEVC where the browser can encode it and H.264 otherwise, 1440 px on the
              long side — what iOS pairs with its own stills.
              {livePlan.sampled
                ? ` The sweep is ${livePlan.positions} positions, sampled 1 in ${livePlan.stride} to stay inside the ${LIVE_PHOTO_SECONDS}-second limit.`
                : ''}
              {' '}Saves a matching JPEG and MOV — nothing to unzip. Select both and drag
              them into Photos on Mac and they land as one Live Photo, ready to send
              on to iPhone or iPad over iCloud Photos or AirDrop.
            </SmallText>
          ) : wantsVideo ? (
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
                {outWidth} × {outHeight} JPEG, full resolution, quality 95.
                {hasDimensions && scale === 1
                  ? ' Full size is slower because every frame is decoded again.'
                  : ''}
              </SmallText>

              {/* Video frames have no source metadata. */}
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

        {/* Keep this note visible while controls are disabled. A full selection cannot slide. */}
        {wantsMotion && allSelected && (
          <>
            <Space h={1} />
            <Text style={{ color: 'var(--accent-color)' }}>
              Motion export requires selecting fewer frames
            </Text>
          </>
        )}

        <Space h={1} />
        <Inline style={{ alignItems: 'center', gap: '0.75rem' }}>
          <Button
            onClick={wantsMotion ? startVideoExport : startExport}
            disabled={controlsDisabled || (wantsMotion && allSelected)}
          >
            {exporting
              ? wantsMotion
                ? 'Rendering…'
                : 'Stacking…'
              : wantsLivePhoto
                ? 'Export Live Photo'
                : wantsVideo
                ? 'Export video'
                : 'Export JPEG'}
          </Button>
          {exporting && <Button onClick={cancelExport}>Cancel</Button>}
        </Inline>

        {/* Keep export progress beside the button so it remains visible on mobile. */}
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
              {result.kind === 'live' ? (
                <>
                  Saved a Live Photo: {result.photoWidth} × {result.photoHeight} photo
                  and {result.duration.toFixed(1)} s of {result.width} × {result.height} video.
                  Select both files and drag them into Photos on Mac together.
                </>
              ) : result.kind === 'video' ? (
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

            {/* Allow each file to be saved again if the browser blocks a download. */}
            {result.kind === 'live' && (
              <>
                <Space h={0.75} />
                <Inline style={{ alignItems: 'center', gap: '0.75rem' }}>
                  {result.files.map((file) => (
                    <Button key={file.name} onClick={() => downloadBlob(file.blob, file.name)}>
                      {file.name.endsWith('.mov') ? 'Save video again' : 'Save photo again'}
                    </Button>
                  ))}
                </Inline>
                <Space h={0.5} />
                <SmallText>
                  Saving these in an iOS browser will not create a Live Photo. Import
                  them on a Mac, then use iCloud Photos or AirDrop to get it onto the
                  phone.
                </SmallText>
              </>
            )}
          </>
        )}
      </Card>

      {hasFrames && (
        <>
          <Space h={1} />

          {/* Source details. */}
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
