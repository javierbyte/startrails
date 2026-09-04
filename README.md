# [Star Trails](https://javier.xyz/startrails)

Stack a folder of timelapse frames into a single star trail photo, in the
browser.

[![Star Trails](public/javier-xyz-startrails.jpg)](https://javier.xyz/startrails)

## How it works

Every frame is composited onto the same canvas with a `lighten` blend, which
keeps the brightest pixel it has seen at each position. Stars move between
exposures, so each one paints a line while the landscape underneath stays put.

Stacking at full opacity gives every star an even streak that starts and stops
abruptly, so each frame is instead drawn at `position^power` of full opacity,
where position runs from 0 at the first frame to 1 at the last. Early frames
land faint and later ones land solid, which fades every trail in behind a bright
head. **Min opacity** puts a floor under that curve so the oldest frames still
register.

| Parameter     | Default | What it does                                                     |
| ------------- | ------- | ---------------------------------------------------------------- |
| `power`       | `2`     | Falloff curve. 1 is linear; higher values sharpen the trail head. |
| `min opacity` | `0`     | Floor for the opacity curve, as a percentage.                     |
| frame range   | all     | First and last frame of the sequence to stack.                    |

For best results use 20 to 40 second exposures and keep the interval between
shots as short as the camera allows.

## Frame order

Frames are stacked in filename order, the way the folder reads in Finder: digit
runs compare as numbers, so `shot2.jpg` lands before `shot10.jpg` rather than
after `shot12.jpg`. This matters because opacity is applied by position in the
sequence, so a scrambled order produces a scrambled stack.

Zero-padded camera filenames (`DSCF1888.jpg`, `IMG_0123.jpg`) sort identically
either way. Unpadded ones do not, which is where the command line version, using
a plain `readdirSync().sort()`, would disagree.

## Video input

A single `.mp4`, `.mov`, `.m4v` or `.webm` can be dropped in instead of photos.
The app retains the original clip and up to 600 evenly spaced sample timestamps.
Its frame rate is estimated from playback, with a 30 fps fallback; variable-rate
clips and browser seeking can produce uneven or repeated decoded frames. The UI
labels this estimate rather than promising frame-exact extraction.

Import encodes only reduced preview JPEGs. Full-resolution frames are never
collected in memory: refinement and export seek the original video sequentially,
transfer one frame to the worker, composite it, and release it before requesting
the next. Video exports carry no EXIF. Video processing uses the browser's SDR
canvas output; this is not an HDR-preserving workflow.

## The sample clip

The page first displays a poster, then loads prepared JPEG previews from
`public/sample/`. These are generated from every frame of the bundled sample and
require no video seeking or encoding at startup. Once loaded, the frame range
sweeps from the first frame to the complete stack. Selecting a source cancels
sample loading.

The original `public/example-startrail.mp4` is fetched only when a refinement or
export needs it. To regenerate the previews and timestamp manifest, install
FFmpeg (including ffprobe) and run `pnpm generate:sample`.

## Everything runs locally

There is no server processing and no upload. A Web Worker composites the frames.
The decoded interaction cache is limited to **64 MiB**, separate from the visible
composite, decoder surfaces, temporary frame and render canvas. Long sequences
receive smaller proxies without dropping photo frames. Replacing a source
releases the cache while retaining the last displayed composite.

Slider changes use the fast cache immediately. After 300 ms without another
change, a refinement pass reads every selected source frame at the displayed
size multiplied by device pixel ratio, capped at source resolution and a longest
side of 1440 pixels. It swaps in only after completion; newer changes cancel it.
The displayed size is independent of cache resolution and remains capped by the
viewport. Resizing the window is reflected on the next refinement.

Export decodes one frame at a time at the requested resolution. Rotation is
applied directly into the output canvas, avoiding a second full-size rotation
buffer. Cancellation releases video sessions, temporary canvases, and bitmaps;
source generations and job IDs prevent stale results from changing the UI or
starting a download. These limits reduce memory pressure but are not a guarantee
against browser process termination on every device or input size.

## EXIF

Canvas encoders drop all metadata, so the export lifts the APP segments out of
the first frame's bytes and splices them into the finished JPEG: camera, lens,
date, shooting settings, XMP and the ICC profile all carry over, and the result
files alongside the frames it came from.

Three things are corrected on the way through. Orientation is reset to 1,
because the frames were already rotated when they were decoded. The pixel
dimensions are updated to the real output size. The embedded thumbnail is
dropped, so no viewer previews a single unstacked frame. As with the command
line version, the exposure tags describe the first frame, not the stack.

## Opening a folder

Chromium browsers get a real directory handle: the folder is remembered between
visits, and **Rescan** re-reads it so frames shot since show up. Browsers cannot
watch a folder for changes on their own yet. The File System Observer origin
trial ended at Chrome 134, so refreshing is a button rather than automatic.

Safari and Firefox fall back to a folder upload or drag-and-drop, which reads
the same frames but cannot be rescanned.

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
WebKit, and compares faint-star refinement with a resized full-resolution export.
It also covers video import, rotated export, cancellation, source replacement,
decode errors, and worker teardown. Set `CHROME_CHANNEL=chrome` to use an
installed Chrome instead of Playwright's Chromium. Testing on the physical
phone with the original failing clip remains necessary to confirm the reported
iPhone reload is resolved.

One constraint worth knowing: `src/workers/stack.worker.js` must not import
anything. Under `output: 'export'` Turbopack copies it into `_next/static/media`
verbatim instead of bundling it, so an import would survive into the emitted
file as a bare specifier and 404 at runtime.

## Command line version

`cli/` holds the original command line tool, which does the same thing over a
folder on disk using node-canvas and exiftool. It keeps its own `package.json`
so the web app's install never pulls a native module:

```sh
cd cli
pnpm install
node star-trails.js --src=/path/to/frames
```

| Parameter       | Default                                       | What it does                                                  |
| --------------- | --------------------------------------------- | ------------------------------------------------------------- |
| `--src`         | required                                      | Folder of frames.                                             |
| `--power`       | `2`                                           | Falloff curve. Higher sharpens the trail head.                 |
| `--min-opacity` | `0`                                           | Floor for the opacity curve, 0-100.                            |
| `--first`       | first frame                                   | Start from this filename, inclusive.                           |
| `--last`        | last frame                                    | Stop at this filename, inclusive.                              |
| `--out`         | `./out/[first]-[last]-p[power][-mo[min]].jpg` | Output path.                                                   |
| `--exif`        | off                                           | Copy metadata from the first frame. Needs `exiftool` on PATH. |

Two differences from the web tool, both in `--exif`, which shells out to
`exiftool -TagsFromFile` and copies the source tags verbatim. The output keeps
the source's `Orientation`, even though node-canvas already rotated the pixels,
so an oriented sequence exports sideways; and it keeps the source's pixel
dimensions and embedded thumbnail, which describe one unstacked frame. The web
tool corrects all three.

## License

BSD-3-Clause
