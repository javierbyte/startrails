# [Star Trails](https://javier.xyz/startrails)

Stack timelapse frames into a star trail photo in your browser.

[![Star Trails](public/javier-xyz-startrails.jpg)](https://javier.xyz/startrails)

## How it works

Frames are composited with `lighten` blending, which keeps the brightest pixel
at each position. Increasing opacity through the sequence produces faded trails
with bright heads. **Min opacity** sets the minimum contribution of each frame.

**Curve** uses `position^power`, with position running from 0 to 1 across the
selected range. A wider range produces longer trails.

**Linear** reduces opacity by `1/trail` per frame. With a trail of 4, the newest
four frames contribute 100%, 75%, 50%, and 25%. The browser uses the selection
length as the trail. The CLI accepts a shorter `--trail` and skips older frames,
reducing decoding and export time. A positive min opacity includes those frames.

| Parameter     | Default | What it does                                                         |
| ------------- | ------- | -------------------------------------------------------------------- |
| `power`       | `2`     | Curve falloff. 1 is a straight ramp; higher sharpens the trail head. |
| `trail`       | range   | Linear falloff length, in frames. The browser uses the whole range.  |
| `min opacity` | `0`     | Floor for the opacity curve, as a percentage.                        |
| frame range   | all     | First and last frame of the sequence to stack.                       |

For best results use 20 to 40 second exposures and keep the interval between
shots as short as the camera allows.

## Frame order

The browser sorts filenames numerically: `shot2.jpg` precedes `shot10.jpg`.
Frame order determines opacity. The CLI sorts alphabetically, so use zero-padded
filenames for consistent results in both versions.

## Video input

Drop a single `.mp4`, `.mov`, `.m4v`, or `.webm` instead of photos. The app
keeps the original clip and samples up to 600 evenly spaced timestamps. Frame
rate is estimated from playback, with a 30 fps fallback. Variable-rate clips and
browser seeking can produce uneven or repeated frames.

Import creates reduced JPEG previews. Refinement and export decode and composite
one frame at a time from the original video. Video exports have no source EXIF.
Processing uses the browser's SDR canvas output and does not preserve HDR.

## The sample clip

Startup displays a poster and loads prepared JPEG previews from
`public/sample/`, then animates the frame range from the first frame to the full
stack. Selecting a source cancels sample loading.

The original `public/example-startrail.mp4` loads only for refinement or export.
To regenerate previews and the timestamp manifest, install FFmpeg and ffprobe,
then run `pnpm generate:sample`.

## Everything runs locally

Frames are processed locally in a Web Worker, without uploads.

The decoded preview cache is limited to **64 MiB**, excluding the displayed
composite, decoder surfaces, temporary frame, and render canvas. Longer
sequences use smaller previews without dropping photo frames. Replacing a source
releases the cache and retains the displayed composite until the new source is
ready.

Slider changes use the cache immediately. After 300 ms idle, refinement reads
the selected source frames at display size × device pixel ratio, capped at
source resolution and a 1440-pixel longest side. Completed refinement replaces
the preview; newer changes cancel it. Window resizing applies on the next
refinement.

Export decodes one frame at a time and applies rotation directly to the output
canvas. Cancellation releases temporary resources. Source generations and job
IDs prevent stale results or downloads. Large inputs can still exceed device
memory.

## EXIF

JPEG export copies the first frame's EXIF, XMP, and ICC metadata, including
camera, lens, date, and shooting settings. It resets orientation to 1, updates
pixel dimensions, and removes the embedded thumbnail reference. Exposure tags
describe the first frame.

## Opening a folder

Chromium directory handles support reopening folders between visits and manual
updates through **Rescan**. The app does not watch for file changes.

Safari and Firefox use folder selection or drag-and-drop without rescanning.

## Development

```sh
pnpm install
pnpm dev
```

Then open http://localhost:3009/startrails.

`pnpm build` produces the static export in `out/`, which the Deploy workflow
publishes to the `gh-pages` branch.

Checks:

```sh
pnpm test
pnpm exec playwright install chromium webkit
pnpm build
pnpm test:browser
```

The browser suite serves `out/` under `/startrails`, exercises Chromium and
WebKit, and compares faint-star refinement with a resized full-resolution
export. It also covers video import, rotated export, cancellation, source
replacement, decode errors, and worker teardown. Set `CHROME_CHANNEL=chrome` to
use an installed Chrome instead of Playwright's Chromium. Verify iPhone reload
fixes on the affected phone with the original clip.

Keep `src/workers/stack.worker.js` import-free. With `output: 'export'`,
Turbopack copies it verbatim into `_next/static/media`; bare imports cause
runtime 404s.

## Command line version

The CLI processes a local folder using node-canvas, with optional metadata
copying through exiftool. Its dependencies are installed separately:

```sh
cd cli
pnpm install
node star-trails.js --src=/path/to/frames
```

| Parameter       | Default                                       | What it does                                                  |
| --------------- | --------------------------------------------- | ------------------------------------------------------------- |
| `--src`         | required                                      | Folder of frames.                                             |
| `--power`       | `2`                                           | Curve falloff. Higher sharpens the trail head.                |
| `--trail`       | off                                           | Linear falloff length in frames. Overrides `--power`.         |
| `--min-opacity` | `0`                                           | Floor for the opacity curve, 0-100.                           |
| `--first`       | first frame                                   | Start from this filename, inclusive.                          |
| `--last`        | last frame                                    | Stop at this filename, inclusive.                             |
| `--out`         | `./out/[first]-[last]-p[power][-mo[min]].jpg` | Output path. Linear mode writes `l[trail]` for the `p` token. |
| `--exif`        | off                                           | Copy metadata from the first frame. Needs `exiftool` on PATH. |

CLI `--exif` copies source tags verbatim through `exiftool -TagsFromFile`. It
retains orientation despite already-rotated pixels, which can rotate the output
incorrectly. It also retains source dimensions and the source thumbnail. The
browser export corrects these fields.

## Open source

| Dependency                                                             | License |
| ---------------------------------------------------------------------- | ------- |
| [React and React DOM](https://github.com/react/react)                  | MIT     |
| [Next.js and `@next/third-parties`](https://github.com/vercel/next.js) | MIT     |
| [Mediabunny](https://github.com/Vanilagy/mediabunny)                   | MPL-2.0 |

Mediabunny muxes MP4, WebM, and Live Photo MOV exports. It is used unmodified;
`pnpm-lock.yaml` pins the version.
[Source](https://github.com/Vanilagy/mediabunny) and
[license](https://github.com/Vanilagy/mediabunny/blob/main/LICENSE) are
available upstream; the installed license is at
`node_modules/mediabunny/LICENSE`.

## License

BSD-3-Clause, in [LICENSE](LICENSE).
