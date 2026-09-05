#!/usr/bin/env node
const { createCanvas, loadImage } = require('canvas');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function parseArgs(args) {
  const result = {};
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, ...valueParts] = arg.slice(2).split('=');
      const value = valueParts.join('=') || true;
      result[key] = value;
    }
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Validate required params
  if (!args.src) {
    console.error('Error: --src is required');
    process.exit(1);
  }

  const srcDir = path.resolve(args.src);
  if (!fs.existsSync(srcDir)) {
    console.error(`Error: Source directory does not exist: ${srcDir}`);
    process.exit(1);
  }

  const powerDecay = args['power'] ? parseFloat(args['power']) : 2;
  if (isNaN(powerDecay) || powerDecay <= 0) {
    console.error('Error: --power must be a positive number');
    process.exit(1);
  }

  // --trail selects linear falloff with a fixed 1/trail opacity step.
  const trail = args['trail'] ? parseInt(args['trail'], 10) : null;
  if (trail !== null && (isNaN(trail) || trail < 1)) {
    console.error('Error: --trail must be a frame count of 1 or more');
    process.exit(1);
  }

  const minOpacityRaw = args['min-opacity'] ? parseFloat(args['min-opacity']) : 0;
  if (isNaN(minOpacityRaw) || minOpacityRaw < 0 || minOpacityRaw > 100) {
    console.error('Error: --min-opacity must be a percentage between 0 and 100');
    process.exit(1);
  }
  const minOpacity = minOpacityRaw / 100;

  // Get and filter files
  let files = fs.readdirSync(srcDir)
    .filter(f => /\.(jpg|jpeg|png)$/i.test(f))
    .sort();

  if (files.length === 0) {
    console.error('Error: No image files found in source directory');
    process.exit(1);
  }

  // Apply --first filter
  if (args.first) {
    const firstIndex = files.indexOf(args.first);
    if (firstIndex === -1) {
      console.error(`Error: --first file not found: ${args.first}`);
      process.exit(1);
    }
    files = files.slice(firstIndex);
  }

  // Apply --last filter
  if (args.last) {
    const lastIndex = files.indexOf(args.last);
    if (lastIndex === -1) {
      console.error(`Error: --last file not found: ${args.last}`);
      process.exit(1);
    }
    files = files.slice(0, lastIndex + 1);
  }

  if (files.length === 0) {
    console.error('Error: No files in specified range');
    process.exit(1);
  }

  // Determine output path
  const firstFile = path.parse(files[0]).name;
  const lastFile = path.parse(files[files.length - 1]).name;
  const moSuffix = minOpacity > 0 ? `-mo${Math.round(minOpacity * 100)}` : '';
  const falloff = trail !== null ? `l${trail}` : `p${powerDecay}`;
  const defaultOut = `out/${firstFile}-${lastFile}-${falloff}${moSuffix}.jpg`;
  const outPath = args.out ? path.resolve(args.out) : path.resolve(defaultOut);

  // Ensure output directory exists
  const outDir = path.dirname(outPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  console.error(`Processing ${files.length} images...`);
  if (trail !== null) console.error(`Linear falloff over ${trail} frames`);
  else console.error(`Power falloff: ${powerDecay}`);
  if (minOpacity > 0) console.error(`Min opacity: ${Math.round(minOpacity * 100)}%`);
  console.error(`Output: ${outPath}`);

  // Load first image to get dimensions
  const firstImage = await loadImage(path.join(srcDir, files[0]));
  const width = firstImage.width;
  const height = firstImage.height;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.globalCompositeOperation = 'lighten';

  // Skip zero-opacity frames in linear mode unless a positive floor is set.
  const start =
    trail !== null && minOpacity === 0
      ? Math.max(0, files.length - trail)
      : 0;
  const drawn = files.length - start;

  // Composite all images
  for (let i = start; i < files.length; i++) {
    const img = await loadImage(path.join(srcDir, files[i]));
    let falloffFactor;
    if (trail !== null) {
      const age = files.length - 1 - i; // 0 is the newest frame
      falloffFactor = Math.max(0, (trail - age) / trail);
    } else {
      const position = files.length > 1 ? i / (files.length - 1) : 1;
      falloffFactor = Math.pow(position, powerDecay);
    }
    const opacity = minOpacity + (1 - minOpacity) * falloffFactor;
    ctx.globalAlpha = opacity;
    ctx.drawImage(img, 0, 0);

    // Progress to stderr
    const done = i - start + 1;
    if (done % 10 === 0 || i === files.length - 1) {
      const percent = ((done / drawn) * 100).toFixed(1);
      console.error(`${done}/${drawn} (${percent}%)`);
    }
  }

  // Write output
  const buffer = canvas.toBuffer('image/jpeg', { quality: 0.95 });
  fs.writeFileSync(outPath, buffer);

  // Copy EXIF data from first image to output
  if (args.exif) {
    const firstImagePath = path.join(srcDir, files[0]);
    try {
      execSync(`exiftool -TagsFromFile "${firstImagePath}" -overwrite_original "${outPath}"`, {
        stdio: 'pipe'
      });
      console.error('EXIF data copied from first image');
    } catch (err) {
      console.error('Warning: Could not copy EXIF data (exiftool not available)');
    }
  }

  // Output the path to stdout for scripting
  console.log(outPath);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
