// Encodes the sliding frame window into a looping mp4.
//
// Mediabunny is used purely as a muxer. Its own encoder wrapper waits on the
// WebCodecs `dequeue` event once a few frames are in flight, and browsers that
// never fire it leave the export stuck forever -- driving VideoEncoder directly
// and draining it with `flush` after every frame avoids that event entirely,
// and keeps Safari from wedging on a queue of raw frames.
//
// Only one cycle is ever composited and encoded. Its packets are then written
// out `loops` times with shifted timestamps, so a longer video costs a few more
// kilobytes rather than another pass over the frames.

export const FPS_OPTIONS = [5, 10, 15, 24, 30, 60];
export const DEFAULT_FPS = 15;
export const DEFAULT_MIN_SECONDS = 5;
export const MIN_MIN_SECONDS = 1;
export const MAX_MIN_SECONDS = 30;

// Nothing in the encode path may wait forever: a stuck encoder has to surface
// as an error rather than a progress bar that never moves.
const ENCODER_STALL_SECONDS = 15;
// Frame 0 is drained on its own, so an encoder that will never drain is caught
// in a second rather than after the whole clip has been fed in.
const ENCODER_PROBE_SECONDS = 6;

// Tried in order; the first one the browser accepts at the export size wins.
const CODEC_CANDIDATES = [
  ['avc', 'avc1.640028'],
  ['avc', 'avc1.4d0028'],
  ['avc', 'avc1.42e01f'],
  ['vp9', 'vp09.00.10.08'],
];

/**
 * How long the loop is and how often it repeats. The window slides from frame 0
 * to the last position that still fits, which is the same sweep the play button
 * previews, so a cycle is one position per frame.
 */
export function planVideo({ totalFrames, windowWidth, fps, minSeconds }) {
  const cycleFrames = Math.max(1, totalFrames - windowWidth);
  const cycleDuration = cycleFrames / fps;
  const loops = Math.max(1, Math.ceil(minSeconds / cycleDuration));

  return {
    cycleFrames,
    cycleDuration,
    loops,
    totalOutputFrames: cycleFrames * loops,
    duration: cycleDuration * loops,
  };
}

/** h.264 needs even dimensions, and it costs nothing to keep vp9 on the same grid. */
export function videoSize({ width, height }) {
  return {
    width: Math.max(2, Math.round(width / 2) * 2),
    height: Math.max(2, Math.round(height / 2) * 2),
  };
}

function videoBitrate(width, height, fps) {
  // ~0.4 bits per pixel per frame, which is generous for this kind of motion.
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

async function pickCodec(width, height, fps) {
  const bitrate = videoBitrate(width, height, fps);
  for (const [codec, codecString] of CODEC_CANDIDATES) {
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
export async function createVideoEncoder({ width, height, fps }) {
  if (typeof VideoEncoder === 'undefined') {
    throw new Error(
      'This browser cannot encode video. Try a recent Chrome, Edge, Safari or Firefox.'
    );
  }

  const picked = await pickCodec(width, height, fps);
  if (!picked) throw new Error('No video encoder setting this browser accepts.');

  const {
    Output,
    Mp4OutputFormat,
    WebMOutputFormat,
    BufferTarget,
    EncodedVideoPacketSource,
    EncodedPacket,
  } = await import('mediabunny');

  const isMp4 = picked.codec === 'avc';
  const output = new Output({
    format: isMp4
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
    extension: isMp4 ? 'mp4' : 'webm',

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

      // Taken from the packets that actually came out rather than the plan, so
      // each repeat starts exactly where the previous one ended.
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
        type: isMp4 ? 'video/mp4' : 'video/webm',
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
