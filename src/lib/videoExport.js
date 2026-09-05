// Encode one window sweep with WebCodecs and mux it with Mediabunny.
// Flush after each frame to avoid stalls from missing dequeue events.
// Repeat encoded packets with shifted timestamps to extend playback.

export const FPS_OPTIONS = [5, 10, 15, 24, 30, 60];
export const DEFAULT_FPS = 15;
export const DEFAULT_MIN_SECONDS = 5;
export const MIN_MIN_SECONDS = 1;
export const MAX_MIN_SECONDS = 30;

// Fail stalled encoder operations after this timeout.
const ENCODER_STALL_SECONDS = 15;
// Use a shorter timeout for the first frame to detect unsupported encoding early.
const ENCODER_PROBE_SECONDS = 6;

// Try codecs in order at the requested export size.
const CODEC_CANDIDATES = [
  ['avc', 'avc1.640028'],
  ['avc', 'avc1.4d0028'],
  ['avc', 'avc1.42e01f'],
  ['vp9', 'vp09.00.10.08'],
];

/** Calculate cycle length and repetitions for a sliding-window export.
 * maxFrames limits output by sampling the sweep. Anchor the stride on
 * stillPosition so the paired still matches an encoded frame. */
export function planVideo({
  totalFrames,
  windowWidth,
  fps,
  minSeconds,
  maxFrames = Infinity,
  stillPosition = 0,
}) {
  const positions = Math.max(1, totalFrames - windowWidth);
  const still = Math.min(Math.max(0, stillPosition), positions - 1);
  const stride = Math.max(1, Math.ceil(positions / Math.max(1, maxFrames)));
  const startPosition = still % stride;
  const cycleFrames = Math.floor((positions - 1 - startPosition) / stride) + 1;
  const cycleDuration = cycleFrames / fps;
  const loops = Math.max(1, Math.ceil(minSeconds / cycleDuration));

  return {
    cycleFrames,
    cycleDuration,
    loops,
    stride,
    startPosition,
    stillFrame: (still - startPosition) / stride,
    sampled: stride > 1,
    positions,
    totalOutputFrames: cycleFrames * loops,
    duration: cycleDuration * loops,
  };
}

/** Resolution uses the shorter side, independently of rotation, capped at 4K. */
export function videoResolutions({ width, height }) {
  const limit = Math.min(width, height, 2160);
  if (!(limit > 0)) return [];
  return [...[360, 480, 720, 1080, 2160].filter((size) => size < limit), limit];
}

/** Use even dimensions for H.264 and VP9. */
export function videoSize({ width, height }) {
  return {
    width: Math.max(2, Math.round(width / 2) * 2),
    height: Math.max(2, Math.round(height / 2) * 2),
  };
}

function videoBitrate(width, height, fps) {
  // Target 0.4 bits per pixel per frame.
  return Math.round(width * height * fps * 0.4);
}

function withTimeout(promise, message, seconds = ENCODER_STALL_SECONDS) {
  let timer = null;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), seconds * 1000);
    }),
  ]);
}

async function pickCodec(width, height, fps, livePhoto = false) {
  const bitrate = videoBitrate(width, height, fps);
  // Prefer HEVC (hvc1) for Live Photos, with H.264 as a fallback.
  const candidates = livePhoto
    ? [
        ['hevc', 'hvc1.1.6.L153.B0'], ['hevc', 'hvc1.1.6.L150.B0'],
        ['hevc', 'hvc1.1.6.L123.B0'], ['hevc', 'hvc1.1.6.L120.B0'],
        ['hevc', 'hvc1.1.6.L93.B0'],
        ['avc', 'avc1.640034'], ['avc', 'avc1.640033'], ['avc', 'avc1.64002a'],
        ['avc', 'avc1.640028'], ['avc', 'avc1.4d0028'],
      ]
    : CODEC_CANDIDATES;
  for (const [codec, codecString] of candidates) {
    const config = {
      codec: codecString,
      width,
      height,
      bitrate,
      framerate: fps,
      latencyMode: 'quality',
    };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support?.supported) return { codec, config: support.config || config };
    } catch {
      // Treat a throwing probe the same as an unsupported one.
    }
  }
  return null;
}

/**
 * Takes one composited window position at a time and returns the finished file.
 * `width` and `height` must already be even; see videoSize.
 */
export async function createVideoEncoder({ width, height, fps, livePhoto = false }) {
  if (typeof VideoEncoder === 'undefined') {
    throw new Error(
      'This browser cannot encode video. Try a recent Chrome, Edge, Safari or Firefox.'
    );
  }

  const picked = await pickCodec(width, height, fps, livePhoto);
  if (!picked) throw new Error(livePhoto
    ? 'This browser cannot encode the HEVC or high-quality H.264 video required for Live Photos. Try Safari or Chrome on Mac.'
    : 'No video encoder setting this browser accepts.');

  const {
    Output,
    Mp4OutputFormat,
    MovOutputFormat,
    WebMOutputFormat,
    BufferTarget,
    EncodedVideoPacketSource,
    EncodedPacket,
  } = await import('mediabunny');

  const isMp4 = picked.codec === 'avc';
  const output = new Output({
    format: livePhoto
      ? new MovOutputFormat({ fastStart: false })
      : isMp4
      ? new Mp4OutputFormat({ fastStart: 'in-memory' })
      : new WebMOutputFormat(),
    target: new BufferTarget(),
  });
  const source = new EncodedVideoPacketSource(picked.codec);
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not allocate the video canvas.');

  const packets = [];
  const frameDuration = Math.round(1e6 / fps);
  let failure = null;

  const encoder = new VideoEncoder({
    output: (chunk, meta) =>
      packets.push({ packet: EncodedPacket.fromEncodedChunk(chunk), meta }),
    error: (error) => {
      failure = error;
    },
  });
  encoder.configure(picked.config);

  return {
    extension: livePhoto ? 'mov' : isMp4 ? 'mp4' : 'webm',

    async add(bitmap, index) {
      if (failure) throw new Error(failure.message);
      ctx.drawImage(bitmap, 0, 0, width, height);
      const frame = new VideoFrame(canvas, {
        timestamp: Math.round((index * 1e6) / fps),
        duration: frameDuration,
      });
      try {
        // Frame 0 is the loop point, so every repeat starts on a key frame.
        encoder.encode(frame, { keyFrame: index === 0 });
      } finally {
        frame.close();
      }
      await withTimeout(
        encoder.flush(),
        'The video encoder stopped responding.',
        index === 0 ? ENCODER_PROBE_SECONDS : ENCODER_STALL_SECONDS
      );
    },

    async finish(loops) {
      await withTimeout(
        encoder.flush(),
        'The video encoder stopped responding while finishing.'
      );
      encoder.close();
      if (failure) throw new Error(failure.message);
      if (!packets.length) throw new Error('The encoder produced no frames.');

      // Calculate repeat timestamps from the encoded packet count.
      const cycleSpan = packets.length / fps;
      for (let loop = 0; loop < loops; loop++) {
        for (let i = 0; i < packets.length; i++) {
          const { packet, meta } = packets[i];
          await source.add(
            new EncodedPacket(
              packet.data,
              packet.type,
              packet.timestamp + loop * cycleSpan,
              packet.duration,
              loop * packets.length + i
            ),
            meta
          );
        }
      }

      await withTimeout(
        output.finalize(),
        'Writing the video file stopped responding.'
      );
      return new Blob([output.target.buffer], {
        type: livePhoto ? 'video/quicktime' : isMp4 ? 'video/mp4' : 'video/webm',
      });
    },

    /** Safe to call at any point, including after finish. */
    close() {
      if (encoder.state !== 'closed') encoder.close();
      if (output.state === 'started') output.cancel();
      canvas.width = canvas.height = 0;
    },
  };
}
