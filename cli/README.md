# star-trails

A tool for creating star trail images from timelapse photography.

Star trails are created by combining multiple long-exposure photos, picking the brightest pixel from all images for every pixel in the output (aka "lighten" blend mode). This tool adds artistic control through a power falloff curve. Earlier images in the sequence can be dimmed by a configurable power factor, creating smoother, more distinctive tails for each star.

For best results:
- Use 20-40 second exposures
- Minimize the interval between shots

## Gallery

| | | |
|:---:|:---:|:---:|
| ![](../public/examples/trails-20-frames-p1.5-mo5.jpg) | ![](../public/examples/trails-275-frames-p10.jpg) | ![](../public/examples/trails-85-frames-p3-mo7.jpg) |
| 20 frames `--power=1.5 --min-opacity=5` | 275 frames `--power=10` | 85 frames `--power=3 --min-opacity=7` |

## Installation

Requires Node.js 18+. The only dependency is [node-canvas](https://github.com/Automattic/node-canvas).

```bash
cd cli
pnpm install
```

This folder keeps its own `package.json` so installing the web app never pulls
in a native module. There is also a browser version of this tool that needs no
install at all -- see the [project README](../README.md).

## Usage

```bash
node star-trails.js [options]
```

## Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `--src` | Yes | - | Source directory containing the original images |
| `--power` | No | `2` | Power falloff curve (1=linear, 2=quadratic, 3=cubic). Higher = sharper trail heads. |
| `--min-opacity` | No | `0` | Minimum opacity percentage (0-100). Floor for the opacity curve. |
| `--first` | No | - | Start from this filename (inclusive, alphabetically) |
| `--last` | No | - | Only process images up to and including this filename (alphabetically) |
| `--out` | No | `./out/[first]-[last]-p[power][-mo[min]].jpg` | Output file path |
| `--exif` | No | - | Copy EXIF metadata from the first source image to the output (requires exiftool) |

## Examples

Basic usage with just source directory:
```bash
node star-trails.js --src=/path/to/images
```

Custom power falloff:
```bash
node star-trails.js --src=/path/to/images --power=3
```

Process a subset of images:
```bash
node star-trails.js --src=/path/to/images --first=DSCF1000.jpg --last=DSCF1050.jpg
```

Custom output path:
```bash
node star-trails.js --src=/path/to/images --out=my-star-trail.jpg
```

With minimum opacity (ensures all images contribute at least 20%):
```bash
node star-trails.js --src=/path/to/images --min-opacity=20
```

Full example:
```bash
node star-trails.js --src=./raw-photos --first=DSCF0100.jpg --last=DSCF0200.jpg --power=2 --min-opacity=10 --out=./output/trail.jpg
```

## How It Works

1. Reads all image files (jpg, jpeg, png) from the source directory
2. Sorts them alphabetically
3. Filters to the range specified by `--first` and `--last` (if provided)
4. Composites all images using "lighten" blend mode
5. Each image's opacity is calculated as: `minOpacity + (1 - minOpacity) * position^power`
   - First image: opacity = minOpacity (or 0 if not set)
   - Last image: opacity = 1 (always full)
6. Outputs a single star trail image

## Output

- Single JPEG image at 95% quality
- Default output: `./out/[first]-[last]-p[power].jpg` (e.g., `./out/DSCF0001-DSCF0100-p2.jpg`)
- With min-opacity: `./out/[first]-[last]-p[power]-mo[min].jpg`

## Known differences from the web version

Both are the same algorithm, but `--exif` here shells out to
`exiftool -TagsFromFile`, which copies the source tags verbatim:

- The source's `Orientation` is copied even though node-canvas already rotated
  the pixels on load, so an oriented sequence exports sideways.
- `ExifImageWidth`/`ExifImageHeight` still describe a source frame, not the
  output.
- The embedded thumbnail of the first frame is carried over.

Frames are also ordered with a plain `readdirSync().sort()`, so unpadded
filenames (`shot2.jpg`, `shot10.jpg`) sort in the wrong sequence. Zero-padded
camera filenames are unaffected.

## License

BSD-3-Clause
