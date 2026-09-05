// Copy APP1 (Exif, XMP) and APP2 (ICC) metadata from the first frame
// into the canvas-encoded JPEG.

const SOI = 0xd8;
const SOS = 0xda;
const EOI = 0xd9;
const APP0 = 0xe0;
const APP1 = 0xe1;
const APP2 = 0xe2;

const EXIF_ID = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
const XMP_ID = 'http://ns.adobe.com/xap/1.0/\0';
const ICC_ID = 'ICC_PROFILE\0';

// Read progressively larger headers for files with large ICC profiles or XMP.
const READ_STEPS = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024];

function startsWith(bytes, offset, ascii) {
  for (let idx = 0; idx < ascii.length; idx++) {
    if (bytes[offset + idx] !== ascii.charCodeAt(idx)) return false;
  }
  return true;
}

function startsWithBytes(bytes, offset, expected) {
  for (let idx = 0; idx < expected.length; idx++) {
    if (bytes[offset + idx] !== expected[idx]) return false;
  }
  return true;
}

// Return done:false for incomplete segments so the caller can read more bytes.
function collectSegments(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== SOI) return { done: true, segments: null };

  const found = { exif: null, xmp: null, icc: [] };
  let offset = 2;

  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) return { done: true, segments: found };

    let marker = bytes[offset + 1];
    // Fill bytes: any number of 0xFF may pad the gap before a marker.
    while (marker === 0xff && offset + 2 < bytes.length) {
      offset++;
      marker = bytes[offset + 1];
    }

    // Standalone markers carry no length field.
    if (marker === SOI || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // Image data starts here; there is no metadata past this point.
    if (marker === SOS || marker === EOI) return { done: true, segments: found };

    if (offset + 4 > bytes.length) return { done: false, segments: found };
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    const segmentEnd = offset + 2 + length;
    if (segmentEnd > bytes.length) return { done: false, segments: found };

    const payload = offset + 4;
    if (marker === APP1 && !found.exif && startsWithBytes(bytes, payload, EXIF_ID)) {
      found.exif = bytes.slice(offset, segmentEnd);
    } else if (marker === APP1 && !found.xmp && startsWith(bytes, payload, XMP_ID)) {
      found.xmp = bytes.slice(offset, segmentEnd);
    } else if (marker === APP2 && startsWith(bytes, payload, ICC_ID)) {
      // Preserve the order of ICC chunks across APP2 segments.
      found.icc.push(bytes.slice(offset, segmentEnd));
    }

    offset = segmentEnd;
  }

  return { done: false, segments: found };
}

/** Read JPEG metadata with progressively larger reads, up to READ_STEPS.
 * Return null for non-JPEG files or missing metadata. */
export async function readSourceMetadata(file) {
  let result = null;

  for (const step of READ_STEPS) {
    const size = Math.min(step, file.size);
    const bytes = new Uint8Array(await file.slice(0, size).arrayBuffer());
    result = collectSegments(bytes);
    if (result.done || size >= file.size) break;
  }

  const segments = result && result.segments;
  if (!segments) return null;
  if (!segments.exif && !segments.xmp && !segments.icc.length) return null;
  return segments;
}

// Patch existing TIFF values without resizing entries or changing offsets.

const TAG_ORIENTATION = 0x0112;
const TAG_EXIF_IFD_POINTER = 0x8769;
const TAG_PIXEL_X = 0xa002;
const TAG_PIXEL_Y = 0xa003;

const TYPE_SHORT = 3;
const TYPE_LONG = 4;

function makeTiffView(segment) {
  // segment: FF E1 <len:2> "Exif\0\0" <tiff...>
  const tiff = 10;
  if (segment.length < tiff + 8) return null;

  const little = segment[tiff] === 0x49 && segment[tiff + 1] === 0x49;
  const big = segment[tiff] === 0x4d && segment[tiff + 1] === 0x4d;
  if (!little && !big) return null;

  const view = new DataView(segment.buffer, segment.byteOffset, segment.byteLength);
  if (view.getUint16(tiff + 2, little) !== 42) return null;

  return {
    view,
    little,
    tiff,
    u16: (at) => view.getUint16(tiff + at, little),
    u32: (at) => view.getUint32(tiff + at, little),
    setU16: (at, value) => view.setUint16(tiff + at, value, little),
    setU32: (at, value) => view.setUint32(tiff + at, value, little),
  };
}

// Calls visit(entryOffset, tag, type) for each entry, offsets relative to the
// TIFF header. Returns the offset of the IFD's next-IFD pointer.
function walkIfd(tiff, ifdAt, visit) {
  const count = tiff.u16(ifdAt);
  for (let idx = 0; idx < count; idx++) {
    const entry = ifdAt + 2 + idx * 12;
    visit(entry, tiff.u16(entry), tiff.u16(entry + 2));
  }
  return ifdAt + 2 + count * 12;
}

// A single SHORT or LONG value lives inline in the entry's 4-byte value field,
// left-justified, so this works for either byte order.
function writeScalar(tiff, entry, type, value) {
  if (type === TYPE_SHORT) tiff.setU16(entry + 8, Math.min(value, 0xffff));
  else if (type === TYPE_LONG) tiff.setU32(entry + 8, value);
}

/** Update export dimensions and orientation in place; unlink the source thumbnail. */
export function patchExifSegment(segment, outputWidth, outputHeight) {
  const tiff = makeTiffView(segment);
  if (!tiff) return;

  const ifd0 = tiff.u32(4);
  if (ifd0 <= 0 || ifd0 + 2 > segment.length) return;

  let exifIfd = 0;
  const ifd0End = walkIfd(tiff, ifd0, (entry, tag, type) => {
    if (tag === TAG_ORIENTATION) {
      // Reset orientation because createImageBitmap already applied it.
      writeScalar(tiff, entry, type, 1);
    } else if (tag === TAG_EXIF_IFD_POINTER) {
      exifIfd = tiff.u32(entry + 8);
    }
  });

  // Unlink IFD1 to disable the source thumbnail. Leave its bytes to preserve offsets.
  if (ifd0End + 4 <= segment.length) tiff.setU32(ifd0End, 0);

  if (exifIfd > 0 && exifIfd + 2 <= segment.length) {
    walkIfd(tiff, exifIfd, (entry, tag, type) => {
      if (tag === TAG_PIXEL_X) writeScalar(tiff, entry, type, outputWidth);
      else if (tag === TAG_PIXEL_Y) writeScalar(tiff, entry, type, outputHeight);
    });
  }
}

/** Insert source metadata into a canvas-encoded JPEG.
 * Remove replaced APP segments to avoid duplicate ICC profiles. */
export function spliceMetadata(jpegBytes, segments) {
  if (jpegBytes[0] !== 0xff || jpegBytes[1] !== SOI) return jpegBytes;

  const replacingIcc = segments.icc.length > 0;
  const kept = [];
  let at = 2;

  while (at + 3 < jpegBytes.length) {
    if (jpegBytes[at] !== 0xff) break;
    const marker = jpegBytes[at + 1];
    // Stop at the first non-APP marker.
    if (marker < 0xe0 || marker > 0xef) break;

    const end = at + 2 + ((jpegBytes[at + 2] << 8) | jpegBytes[at + 3]);
    if (end > jpegBytes.length) break;
    const payload = at + 4;

    const isIcc = marker === APP2 && startsWith(jpegBytes, payload, ICC_ID);
    const drop =
      marker === APP0 || // Replace the encoder JFIF header.
      marker === APP1 || // Replace encoder metadata with source metadata.
      (isIcc && replacingIcc);

    // Keep the encoder ICC profile if the source has none.
    if (!drop) kept.push(jpegBytes.slice(at, end));
    at = end;
  }

  const inserts = [];
  if (segments.exif) inserts.push(segments.exif);
  if (segments.xmp) inserts.push(segments.xmp);
  for (const chunk of segments.icc) inserts.push(chunk);
  for (const chunk of kept) inserts.push(chunk);

  const insertedLength = inserts.reduce((total, part) => total + part.length, 0);
  const out = new Uint8Array(2 + insertedLength + (jpegBytes.length - at));

  out[0] = 0xff;
  out[1] = SOI;
  let writeAt = 2;
  for (const part of inserts) {
    out.set(part, writeAt);
    writeAt += part.length;
  }
  out.set(jpegBytes.subarray(at), writeAt);

  return out;
}

/** Copy and update source metadata. Return the original blob if none is available. */
export async function applySourceMetadata(blob, sourceFile, width, height) {
  const segments = await readSourceMetadata(sourceFile);
  if (!segments) return { blob, applied: false };

  if (segments.exif) patchExifSegment(segments.exif, width, height);

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const spliced = spliceMetadata(bytes, segments);
  return { blob: new Blob([spliced], { type: 'image/jpeg' }), applied: true };
}
