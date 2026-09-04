import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { previewSize, sampleTimes } from '../src/lib/processing.js';

const input = 'public/example-startrail.mp4';
const metadata = JSON.parse(
  execFileSync('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,r_frame_rate',
    '-show_entries',
    'format=duration',
    '-of',
    'json',
    input,
  ])
);
const { width, height, r_frame_rate } = metadata.streams[0];
const [numerator, denominator] = r_frame_rate.split('/').map(Number);
const fps = numerator / denominator;
const duration = Number(metadata.format.duration);
const { times, total, step } = sampleTimes(duration, fps);
const size = previewSize(width, height, times.length);
mkdirSync('public/sample', { recursive: true });
const frames = [];
for (let i = 0; i < times.length; i++) {
  const name = `example-startrail-${String(i).padStart(5, '0')}.jpg`;
  // Select by decoded frame index: -ss with a midpoint can select the next frame.
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-i',
    input,
    '-vf',
    `select=eq(n\\,${i * step}),scale=${size.width}:${size.height}:flags=lanczos`,
    '-frames:v',
    '1',
    '-q:v',
    '2',
    '-y',
    `public/sample/${name}`,
  ]);
  frames.push(name);
}
writeFileSync(
  'public/sample/manifest.json',
  JSON.stringify(
    {
      frames,
      times,
      summary: {
        fps,
        estimated: false,
        total,
        step,
        count: times.length,
        width,
        height,
        duration,
      },
    },
    null,
    2
  ) + '\n'
);
console.log(
  `Generated ${frames.length} previews at ${size.width} × ${size.height}`
);
