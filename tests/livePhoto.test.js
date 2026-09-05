import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  Input, BufferSource, ALL_FORMATS, Output, MovOutputFormat, BufferTarget,
  EncodedVideoPacketSource, EncodedPacketSink,
} from 'mediabunny';
import { livePhotoSize, livePhotoJpeg, livePhotoMov } from '../src/lib/livePhoto.js';

const identifier = '12345678-1234-1234-1234-123456789abc';
const buffer = async (blob) => Buffer.from(await blob.arrayBuffer());

function children(bytes, start = 0, end = bytes.length) {
  const list = [];
  for (let at = start; at < end;) {
    let size = bytes.readUInt32BE(at);
    if (size === 1) size = Number(bytes.readBigUInt64BE(at + 8));
    assert.ok(size >= 8 && at + size <= end);
    list.push({ type: bytes.toString('latin1', at + 4, at + 8), at, end: at + size });
    at += size;
  }
  return list;
}
function child(bytes, parent, type) {
  const result = children(bytes, parent.at + 8, parent.end).find((box) => box.type === type);
  assert.ok(result, `Missing ${type}`);
  return result;
}

test('the movie fits 1440 on the long side, preserves orientation and never upscales', () => {
  assert.deepEqual(livePhotoSize({ width: 6000, height: 4000 }), { width: 1440, height: 960, scale: 0.24 });
  assert.deepEqual(livePhotoSize({ width: 4000, height: 6000 }), { width: 960, height: 1440, scale: 0.24 });
  assert.deepEqual(livePhotoSize({ width: 1051, height: 1201 }), { width: 1050, height: 1200, scale: 1 });
  for (const [width, height] of [[6000, 4000], [1801, 1051], [4001, 3999], [1440, 1440], [100, 80]]) {
    const size = livePhotoSize({ width, height });
    assert.ok(Math.max(size.width, size.height) <= 1440, `${width}x${height}`);
    assert.equal(size.width % 2, 0);
    assert.equal(size.height % 2, 0);
    assert.ok(size.scale <= 1);
  }
});

/** Walks the APP1 the exporter writes, resolving every out-of-line offset. */
function exifTags(jpeg) {
  const app1 = jpeg.indexOf(Buffer.from([0xff, 0xe1]));
  assert.ok(app1 > 0);
  const base = app1 + 4 + 6; // marker, segment length, "Exif\0\0"
  assert.equal(jpeg.toString('ascii', base, base + 2), 'MM');
  const directory = (at) => {
    const tags = {};
    for (let i = 0; i < jpeg.readUInt16BE(at); i++) {
      const entry = at + 2 + i * 12;
      const type = jpeg.readUInt16BE(entry + 2);
      const count = jpeg.readUInt32BE(entry + 4);
      const value = jpeg.readUInt32BE(entry + 8);
      tags[jpeg.readUInt16BE(entry)] = type === 2
        ? jpeg.toString('ascii', base + value, base + value + count - 1)
        : value;
    }
    return tags;
  };
  const ifd0 = directory(base + jpeg.readUInt32BE(base + 4));
  return { base, ifd0, exif: directory(base + ifd0[0x8769]) };
}

test('JPEG pairs through Apple MakerNote 17 without recompressing the image', async () => {
  const original = await readFile(new URL('../public/example-startrail-preview.jpg', import.meta.url));
  const jpeg = await buffer(await livePhotoJpeg(new Blob([original]), identifier, 893, 1340));
  const maker = jpeg.indexOf(Buffer.from('Apple iOS\0'));
  assert.ok(maker > 0);
  assert.equal(jpeg.readUInt16BE(maker + 16), 17);
  assert.equal(jpeg.readUInt16BE(maker + 18), 2);
  const valueOffset = jpeg.readUInt32BE(maker + 24);
  assert.equal(jpeg.toString('ascii', maker + valueOffset, maker + valueOffset + 36), identifier);
  const sos = Buffer.from([0xff, 0xda]);
  assert.deepEqual(jpeg.subarray(jpeg.indexOf(sos)), original.subarray(original.indexOf(sos)));
  await assert.rejects(livePhotoJpeg(new Blob([original]), 'invalid', 1, 1), /identifier/);
});

test('EXIF carries make, software and capture date at correctly computed offsets', async () => {
  const original = await readFile(new URL('../public/example-startrail-preview.jpg', import.meta.url));
  const jpeg = await buffer(
    await livePhotoJpeg(new Blob([original]), identifier, 893, 1340, new Date(2026, 8, 6, 12, 34, 56))
  );
  const { base, ifd0, exif } = exifTags(jpeg);
  assert.equal(ifd0[0x010f], 'Star Trails');
  assert.equal(ifd0[0x0131], 'Star Trails (javier.xyz/startrails)');
  assert.equal(exif[0x9003], '2026:09:06 12:34:56');
  assert.equal(exif[0xa002], 893);
  assert.equal(exif[0xa003], 1340);
  assert.equal(exif[0xa001], 1 << 16); // ColorSpace is a SHORT in the high half.
  // Verify the pairing pointer after other tag offsets change.
  const maker = base + exif[0x927c];
  assert.equal(jpeg.toString('ascii', maker, maker + 9), 'Apple iOS');
});

test('MOV keeps all encoded frames and places the timed still marker at the selected position', async () => {
  const input = new Input({ source: new BufferSource(await readFile(new URL('../public/example-startrail.mp4', import.meta.url))), formats: ALL_FORMATS });
  try {
    const video = await input.getPrimaryVideoTrack();
    const decoderConfig = await video.getDecoderConfig();
    const target = new BufferTarget();
    const output = new Output({ target, format: new MovOutputFormat({ fastStart: false }) });
    const source = new EncodedVideoPacketSource(video.codec);
    output.addVideoTrack(source);
    await output.start();
    const originals = [];
    for await (const packet of new EncodedPacketSink(video).packets()) {
      originals.push(packet);
      await source.add(packet, { decoderConfig });
    }
    await output.finalize();
    const movie = await buffer(
      await livePhotoMov(new Blob([target.buffer]), identifier, 1, 30, new Date(2026, 8, 6, 12, 34, 56))
    );
    const moov = children(movie).find((box) => box.type === 'moov');
    const tracks = children(movie, moov.at + 8, moov.end).filter((box) => box.type === 'trak');
    assert.equal(tracks.length, 2);
    const mdia = child(movie, tracks[1], 'mdia');
    const stbl = child(movie, child(movie, mdia, 'minf'), 'stbl');
    const stco = child(movie, stbl, 'stco');
    const markerOffset = movie.readUInt32BE(stco.at + 16);
    assert.deepEqual(movie.subarray(markerOffset, markerOffset + 9), Buffer.from([0, 0, 0, 9, 0, 0, 0, 1, 0]));
    const mvhd = child(movie, moov, 'mvhd');
    const timescale = movie.readUInt32BE(mvhd.at + 20);
    const edit = child(movie, child(movie, tracks[1], 'edts'), 'elst');
    assert.equal(movie.readUInt32BE(edit.at + 16), timescale);
    assert.ok(movie.includes(Buffer.from(identifier)));
    // Verify all four ilst indices match the shared key table.
    const meta = child(movie, moov, 'meta');
    const keys = child(movie, meta, 'keys');
    assert.equal(movie.readUInt32BE(keys.at + 12), 4);
    for (const key of ['content.identifier', 'make', 'software', 'creationdate'])
      assert.ok(movie.includes(Buffer.from(`com.apple.quicktime.${key}`)), key);
    const items = children(movie, child(movie, meta, 'ilst').at + 8, child(movie, meta, 'ilst').end);
    assert.deepEqual(items.map((item) => movie.readUInt32BE(item.at + 4)), [1, 2, 3, 4]);
    assert.ok(movie.includes(Buffer.from('2026-09-06T12:34:56')));
    assert.ok(movie.includes(Buffer.from('Star Trails')));
    const paired = new Input({ source: new BufferSource(movie), formats: ALL_FORMATS });
    try {
      const packets = [];
      for await (const packet of new EncodedPacketSink(await paired.getPrimaryVideoTrack()).packets()) packets.push(packet);
      assert.equal(packets.length, originals.length);
      packets.forEach((packet, i) => {
        assert.deepEqual(packet.data, originals[i].data);
        assert.ok(Math.abs(packet.timestamp - originals[i].timestamp) < 0.0001);
      });
    } finally { paired.dispose(); }
    await assert.rejects(livePhotoMov(new Blob([target.buffer]), identifier, 100, 30), /outside/);
    await assert.rejects(livePhotoMov(new Blob(['invalid']), identifier, 0, 30));
  } finally { input.dispose(); }
});
