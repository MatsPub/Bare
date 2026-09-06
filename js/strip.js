/**
 * strip.js — removes metadata by surgically cutting segments out of the
 * original file bytes, rather than decoding + re-encoding the image.
 *
 * Why this is better than a canvas re-encode:
 *  - No quality loss: the compressed image data is copied verbatim.
 *  - No surprises: nothing (including the browser itself) gets a chance
 *    to write anything new into the output, like a default color profile.
 *  - Thorough: removes every APPn segment (EXIF, ICC profile, XMP,
 *    Photoshop/Adobe blocks, thumbnails) and comments in one pass.
 *
 * Exposes window.MetadataStripper.strip(arrayBuffer, mimeType) -> ArrayBuffer
 */
(function (global) {
  'use strict';

  function concatChunks(chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) { out.set(c, pos); pos += c.length; }
    return out.buffer;
  }

  /**
   * Strips a JPEG by walking its marker segments and dropping every
   * APPn (0xE0–0xEF, covers Exif/APP1, ICC/APP2, XMP, Photoshop, Adobe)
   * and COM (0xFE) segment. Everything else — SOF, DHT, DQT, DRI, and
   * critically the entropy-coded scan data after SOS — is copied through
   * untouched, since that's the actual picture.
   */
  function stripJPEG(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const view = new DataView(arrayBuffer);
    if (view.getUint16(0) !== 0xFFD8) throw new Error('Not a JPEG file');

    const keep = [bytes.subarray(0, 2)]; // SOI
    let offset = 2;

    while (offset + 2 <= bytes.length) {
      if (bytes[offset] !== 0xFF) break; // corrupt stream, stop and keep what we have
      const marker = bytes[offset + 1];

      // Markers with no length field.
      if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
        keep.push(bytes.subarray(offset, offset + 2));
        offset += 2;
        continue;
      }

      if (marker === 0xD9) { // EOI
        keep.push(bytes.subarray(offset, offset + 2));
        offset += 2;
        break;
      }

      if (offset + 4 > bytes.length) break; // truncated, bail safely

      const segLength = view.getUint16(offset + 2);
      const segEnd = offset + 2 + segLength;

      if (marker === 0xDA) {
        // Start of Scan: everything from here is entropy-coded image data,
        // which can contain raw 0xFF bytes (stuffed with a following 0x00,
        // or forming restart markers 0xD0–0xD7) that are NOT segment
        // markers and must be copied through untouched. We scan byte by
        // byte to find the *true* EOI rather than assuming one exists at
        // the end of the file — anything after it is not part of the
        // image and gets dropped. This matters: appending arbitrary bytes
        // after a JPEG's real end is a known way to hide data invisibly,
        // and simply keeping "everything to end of file" (as a naive
        // implementation — including an earlier version of this one —
        // would do) misses it entirely. Even `exiftool -all=` doesn't
        // catch this; it needs a separate `-trailer:all=` pass.
        let i = offset;
        let trueEnd = bytes.length; // fallback if no EOI is found at all
        while (i + 1 < bytes.length) {
          if (bytes[i] === 0xFF) {
            const next = bytes[i + 1];
            if (next === 0x00 || (next >= 0xD0 && next <= 0xD7)) {
              i += 2; // stuffed byte or restart marker — part of scan data
              continue;
            }
            if (next === 0xD9) { // the real EOI
              trueEnd = i + 2;
              break;
            }
          }
          i += 1;
        }
        keep.push(bytes.subarray(offset, trueEnd));
        offset = bytes.length; // done — anything beyond trueEnd is discarded
        break;
      }

      const isAPPn = marker >= 0xE0 && marker <= 0xEF;
      const isComment = marker === 0xFE;
      if (!isAPPn && !isComment) {
        keep.push(bytes.subarray(offset, segEnd)); // structural segment — keep
      }
      // else: metadata segment — drop it silently

      offset = segEnd;
    }

    return concatChunks(keep);
  }

  /**
   * Strips a PNG by walking its chunk structure and keeping only the
   * chunks required to actually decode the image: header, palette,
   * transparency, pixel data, and the end marker. Everything else —
   * text fields, timestamps, physical-DPI hints, embedded ICC
   * profiles, raw EXIF chunks — is dropped.
   */
  function stripPNG(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const view = new DataView(arrayBuffer);
    const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < 8; i++) {
      if (bytes[i] !== SIGNATURE[i]) throw new Error('Not a PNG file');
    }

    const KEEP_TYPES = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
    const keep = [bytes.subarray(0, 8)];
    let offset = 8;

    while (offset + 8 <= bytes.length) {
      const length = view.getUint32(offset, false); // PNG is big-endian
      const type = String.fromCharCode(
        bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]
      );
      const chunkEnd = offset + 8 + length + 4; // length + type + data + CRC
      if (chunkEnd > bytes.length) break; // truncated, bail safely

      if (KEEP_TYPES.has(type)) {
        keep.push(bytes.subarray(offset, chunkEnd));
      }

      offset = chunkEnd;
      if (type === 'IEND') break;
    }

    return concatChunks(keep);
  }

  function strip(arrayBuffer, mimeType) {
    if (mimeType === 'image/png') return stripPNG(arrayBuffer);
    return stripJPEG(arrayBuffer); // default to JPEG handling
  }

  global.MetadataStripper = { strip, stripJPEG, stripPNG };
})(window);
