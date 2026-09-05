import { spliceMetadata } from './exif.js';

export const LIVE_PHOTO_FPS = 30;
// Cap Live Photo duration; sample longer sweeps across the full range.
export const LIVE_PHOTO_SECONDS = 3;
export const LIVE_PHOTO_MAX_FRAMES = LIVE_PHOTO_FPS * LIVE_PHOTO_SECONDS;

// Limit movie resolution. Render the paired still at full resolution.
const LIVE_PHOTO_LONG_SIDE = 1440;

const MAKE = 'Star Trails';
const SOFTWARE = 'Star Trails (javier.xyz/startrails)';

export function livePhotoSize({ width, height }) {
  const scale = Math.min(1, LIVE_PHOTO_LONG_SIDE / Math.max(width, height));
  return {
    width: Math.max(2, Math.floor(width * scale / 2) * 2),
    height: Math.max(2, Math.floor(height * scale / 2) * 2),
    scale,
  };
}

const pad = (value) => String(value).padStart(2, '0');
/** EXIF date format: YYYY:MM:DD HH:MM:SS. */
function exifDate(date) {
  return `${date.getFullYear()}:${pad(date.getMonth() + 1)}:${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
/** QuickTime creation date: ISO 8601 with a numeric offset. */
function quickTimeDate(date) {
  const offset = -date.getTimezoneOffset();
  const minutes = Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${offset < 0 ? '-' : '+'}${pad(Math.floor(minutes / 60))}${pad(minutes % 60)}`;
}

const utf8 = (text) => new TextEncoder().encode(text);
const zeros = (length) => new Uint8Array(length);
function join(...parts) {
  const result = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function u32(...values) {
  const bytes = zeros(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, i) => view.setUint32(i * 4, value));
  return bytes;
}
function u16(...values) {
  const bytes = zeros(values.length * 2);
  const view = new DataView(bytes.buffer);
  values.forEach((value, i) => view.setUint16(i * 2, value));
  return bytes;
}
const box = (type, ...parts) => {
  const payload = join(...parts);
  return join(u32(payload.length + 8), typeof type === 'number' ? u32(type) : utf8(type), payload);
};
const fullBox = (type, ...parts) => box(type, u32(0), ...parts);
const matrix = () => u32(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000);
function checkIdentifier(identifier) {
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(identifier))
    throw new Error('Invalid Live Photo identifier.');
}

/** Apple MakerNote tag 17 pairs the full-resolution JPEG with its MOV. */
export async function livePhotoJpeg(blob, identifier, width, height, date = new Date()) {
  checkIdentifier(identifier);
  const value = utf8(identifier + '\0');
  const maker = join(utf8('Apple iOS\0'), u16(1), utf8('MM'), u16(1),
    u16(17, 2), u32(value.length, 32), u32(0), value);
  const entry = (tag, type, count, value) => join(u16(tag, type), u32(count, value));

  // Calculate value offsets from directory sizes so added tags shift them correctly.
  const ascii = (text) => utf8(text + '\0');
  const ifd0Tags = 3, exifTags = 5;
  const exifStart = 8 + 2 + ifd0Tags * 12 + 4;
  const values = [];
  let at = exifStart + 2 + exifTags * 12 + 4;
  // These values exceed the four-byte inline field and require offsets.
  const place = (bytes) => {
    const offset = at;
    values.push(bytes);
    if (bytes.length % 2) values.push(zeros(1)); // TIFF values start on even offsets.
    at += bytes.length + (bytes.length % 2);
    return offset;
  };
  const make = ascii(MAKE), software = ascii(SOFTWARE), shot = ascii(exifDate(date));
  const makeAt = place(make), softwareAt = place(software);
  const shotAt = place(shot), makerAt = place(maker);

  const tiff = join(utf8('MM'), u16(42), u32(8),
    u16(ifd0Tags),
    entry(0x010f, 2, make.length, makeAt),
    entry(0x0131, 2, software.length, softwareAt),
    entry(0x8769, 4, 1, exifStart),
    u32(0),
    u16(exifTags),
    entry(0x9003, 2, shot.length, shotAt),
    entry(0x927c, 7, maker.length, makerAt),
    entry(0xa001, 3, 1, 0x10000), entry(0xa002, 4, 1, width),
    entry(0xa003, 4, 1, height), u32(0), ...values);
  const payload = join(utf8('Exif\0\0'), tiff);
  const exif = join(new Uint8Array([0xff, 0xe1]), u16(payload.length + 2), payload);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Live Photo still must be a JPEG.');
  return new Blob([spliceMetadata(bytes, { exif, xmp: null, icc: [] })], { type: 'image/jpeg' });
}

function boxes(bytes, start = 0, end = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = [];
  for (let offset = start; offset < end;) {
    if (offset + 8 > end) throw new Error('Truncated MOV box.');
    let size = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    let header = 8;
    if (size === 1) { size = Number(view.getBigUint64(offset + 8)); header = 16; }
    if (size === 0) size = end - offset;
    if (!Number.isSafeInteger(size) || size < header || offset + size > end)
      throw new Error('Invalid MOV box size.');
    result.push({ type, start: offset, end: offset + size, header });
    offset += size;
  }
  return result;
}

function pairingMetadata(entries) {
  return box('meta',
    fullBox('hdlr', u32(0), utf8('mdta'), zeros(14)),
    fullBox('keys', u32(entries.length),
      ...entries.map(([key]) => box('mdta', utf8(key)))),
    // An ilst item is addressed by its 1-based index into the key table.
    box('ilst', ...entries.map(([, value], index) =>
      box(index + 1, box('data', u32(1, 0), utf8(value))))));
}

// QTFF boxed metadata (mebx), matching AVAssetWriter's SInt8 still-image-time
// track. The marker's timestamp, rather than its byte value, locates the still.
function markerTrack({ trackId, timescale, duration, stillTicks, sampleTicks, offset }) {
  const sampleEntry = box('mebx', zeros(6), u16(1),
    box('keys', box(1,
      box('keyd', utf8('mdtacom.apple.quicktime.still-image-time')),
      box('dtyp', u32(0, 65)))));
  const edits = stillTicks > 0
    ? u32(2, stillTicks, 0xffffffff, 0x10000, duration - stillTicks, 0, 0x10000)
    : u32(1, duration, 0, 0x10000);
  return box('trak',
    box('tkhd', u32(15, 0, 0, trackId, 0, duration), zeros(16), matrix(), zeros(8)),
    box('edts', fullBox('elst', edits)),
    box('mdia',
      fullBox('mdhd', u32(0, 0, timescale, sampleTicks), u16(0x55c4, 0)),
      fullBox('hdlr', utf8('mhlrmetaappl'), u32(1, 0), new Uint8Array([19]), utf8('Core Media Metadata')),
      box('minf',
        box('gmhd', fullBox('gmin', u16(0x40, 0x8000, 0x8000, 0x8000, 0, 0))),
        box('dinf', fullBox('dref', u32(1), box('alis', u32(1)))),
        box('stbl',
          fullBox('stsd', u32(1), sampleEntry),
          fullBox('stts', u32(1, 1, sampleTicks)),
          fullBox('stsc', u32(1, 1, 1, 1)),
          fullBox('stsz', u32(9, 1)),
          fullBox('stco', u32(1, offset))))));
}

/** Adds pairing metadata without rewriting/re-encoding any video packets. */
export async function livePhotoMov(blob, identifier, stillTime, fps, date = new Date()) {
  checkIdentifier(identifier);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const top = boxes(bytes);
  const moov = top.find((entry) => entry.type === 'moov');
  // fastStart:false places video data before moov, preserving chunk offsets when moov grows.
  if (!moov || moov.end !== bytes.length || !top.some((entry) => entry.type === 'mdat'))
    throw new Error('Live Photo requires a MOV with its movie header at the end.');
  const children = boxes(bytes, moov.start + moov.header, moov.end);
  const mvhd = children.find((entry) => entry.type === 'mvhd');
  if (!mvhd) throw new Error('MOV has no movie header.');
  const header = bytes.slice(mvhd.start, mvhd.end);
  const view = new DataView(header.buffer);
  if (header[8] !== 0) throw new Error('Unsupported MOV time format.');
  const timescale = view.getUint32(20);
  const duration = view.getUint32(24);
  const trackId = view.getUint32(header.length - 4);
  const stillTicks = Math.round(stillTime * timescale);
  if (!(fps > 0) || !Number.isFinite(stillTicks) || stillTicks < 0 || stillTicks >= duration)
    throw new Error('Live Photo still lies outside the video.');
  view.setUint32(header.length - 4, trackId + 1);
  const marker = box('mdat', box(1, new Uint8Array([0])));
  const track = markerTrack({ trackId, timescale, duration, stillTicks,
    sampleTicks: Math.max(1, Math.round(timescale / fps)), offset: moov.start + 8 });
  const updated = box('moov', ...children.map((entry) => entry === mvhd ? header : bytes.subarray(entry.start, entry.end)),
    track, pairingMetadata([
      ['com.apple.quicktime.content.identifier', identifier],
      ['com.apple.quicktime.make', MAKE],
      ['com.apple.quicktime.software', SOFTWARE],
      ['com.apple.quicktime.creationdate', quickTimeDate(date)],
    ]));
  return new Blob([bytes.subarray(0, moov.start), marker, updated], { type: 'video/quicktime' });
}
