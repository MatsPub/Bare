/**
 * exif.js — a small, dependency-free EXIF/GPS reader.
 *
 * Why hand-rolled instead of a CDN library: the whole point of this tool
 * is that nothing about the photo ever leaves the device. Loading a
 * third-party script from a CDN would mean a network request on every
 * visit and a piece of code the user has to trust blindly. This file is
 * the entire trust surface — it's short enough to read in five minutes.
 *
 * Exposes a single global: window.ExifReader.parse(arrayBuffer)
 */
(function (global) {
  'use strict';

  // Byte-size of each TIFF field type we support.
  const TYPE_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 9: 4, 10: 8 };

  /**
   * Reads a single tag's value out of the buffer given its TIFF type.
   */
  function readValue(view, offset, type, count, little) {
    switch (type) {
      case 1: // BYTE
        if (count === 1) return view.getUint8(offset);
        return Array.from({ length: count }, (_, i) => view.getUint8(offset + i));

      case 2: { // ASCII (null-terminated string)
        let s = '';
        for (let i = 0; i < count; i++) {
          const c = view.getUint8(offset + i);
          if (c === 0) break;
          s += String.fromCharCode(c);
        }
        return s;
      }

      case 3: // SHORT
        if (count === 1) return view.getUint16(offset, little);
        return Array.from({ length: count }, (_, i) => view.getUint16(offset + i * 2, little));

      case 4: // LONG
        if (count === 1) return view.getUint32(offset, little);
        return Array.from({ length: count }, (_, i) => view.getUint32(offset + i * 4, little));

      case 5: { // RATIONAL (unsigned num/den pairs)
        const vals = [];
        for (let i = 0; i < count; i++) {
          const num = view.getUint32(offset + i * 8, little);
          const den = view.getUint32(offset + i * 8 + 4, little);
          vals.push(den === 0 ? 0 : num / den);
        }
        return count === 1 ? vals[0] : vals;
      }

      default:
        return null; // UNDEFINED / SRATIONAL / etc. — not needed for our tags
    }
  }

  /**
   * Reads one IFD (Image File Directory) table starting at `ifdOffset`
   * (absolute byte offset into the buffer). `tiffStart` is the offset of
   * the TIFF header, since all pointer-style values inside an IFD are
   * relative to it, not to the file start.
   */
  function readIFD(view, tiffStart, ifdOffset, little) {
    const count = view.getUint16(ifdOffset, little);
    const tags = {};
    for (let i = 0; i < count; i++) {
      const entryOffset = ifdOffset + 2 + i * 12;
      const tag = view.getUint16(entryOffset, little);
      const type = view.getUint16(entryOffset + 2, little);
      const numValues = view.getUint32(entryOffset + 4, little);
      const typeSize = TYPE_SIZES[type] || 1;
      const totalSize = typeSize * numValues;
      const valueFieldOffset = entryOffset + 8;

      // If the value fits in 4 bytes it's stored inline; otherwise the
      // 4 bytes are an offset (from the TIFF header) to where it lives.
      const dataOffset = totalSize <= 4
        ? valueFieldOffset
        : tiffStart + view.getUint32(valueFieldOffset, little);

      tags[tag] = readValue(view, dataOffset, type, numValues, little);
    }
    return tags;
  }

  function dmsToDecimal(d, m, s, ref) {
    let dec = d + m / 60 + s / 3600;
    if (ref === 'S' || ref === 'W') dec = -dec;
    return dec;
  }

  function extractGPS(gpsTags) {
    const lat = gpsTags[2], lon = gpsTags[4];
    if (!Array.isArray(lat) || !Array.isArray(lon)) return null;
    const latDec = dmsToDecimal(lat[0], lat[1], lat[2], gpsTags[1]);
    const lonDec = dmsToDecimal(lon[0], lon[1], lon[2], gpsTags[3]);
    let altitude = null;
    if (typeof gpsTags[6] === 'number') {
      altitude = gpsTags[5] === 1 ? -gpsTags[6] : gpsTags[6];
    }
    return { lat: latDec, lon: lonDec, altitude };
  }

  function parseTIFF(view, tiffStart) {
    const byteOrder = view.getUint16(tiffStart);
    let little;
    if (byteOrder === 0x4949) little = true;       // "II"
    else if (byteOrder === 0x4D4D) little = false; // "MM"
    else return null;

    if (view.getUint16(tiffStart + 2, little) !== 42) return null; // TIFF magic

    const ifd0Offset = view.getUint32(tiffStart + 4, little);
    const ifd0 = readIFD(view, tiffStart, tiffStart + ifd0Offset, little);

    const result = {
      make: ifd0[271] || null,
      model: ifd0[272] || null,
      orientation: typeof ifd0[274] === 'number' ? ifd0[274] : null,
      dateTime: ifd0[306] || null,
      software: ifd0[305] || null,
      gps: null,
    };

    if (typeof ifd0[34853] === 'number') {
      const gpsIFD = readIFD(view, tiffStart, tiffStart + ifd0[34853], little);
      result.gps = extractGPS(gpsIFD);
    }

    return result;
  }

  const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

  function isPNG(view) {
    if (view.byteLength < 8) return false;
    for (let i = 0; i < 8; i++) {
      if (view.getUint8(i) !== PNG_SIGNATURE[i]) return false;
    }
    return true;
  }

  /**
   * PNG has an official mechanism for embedding the exact same EXIF data
   * a JPEG carries: the 'eXIf' chunk (added to the PNG spec in 2017),
   * which holds the identical TIFF-based binary structure — just without
   * JPEG's "Exif\0\0" signature prefix, since the chunk type itself
   * already says what it is. That means parseTIFF (below) works
   * completely unchanged; only finding the chunk differs from JPEG.
   */
  function parsePNG(view) {
    let offset = 8; // past the fixed PNG signature
    while (offset + 8 <= view.byteLength) {
      const length = view.getUint32(offset);
      const type = String.fromCharCode(
        view.getUint8(offset + 4), view.getUint8(offset + 5),
        view.getUint8(offset + 6), view.getUint8(offset + 7)
      );
      const dataStart = offset + 8;
      if (dataStart + length > view.byteLength) break; // truncated, bail safely

      if (type === 'eXIf') {
        const parsed = parseTIFF(view, dataStart);
        if (parsed) return parsed;
      }

      offset = dataStart + length + 4; // skip data + trailing CRC
      if (type === 'IEND') break;
    }
    return null;
  }

  /**
   * Walks JPEG markers looking for the APP1 "Exif" segment, or PNG chunks
   * looking for 'eXIf'. Returns null for anything else, or for a file
   * with no embedded EXIF data at all.
   */
  function parse(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    if (view.byteLength < 8) return null;

    if (isPNG(view)) return parsePNG(view);

    if (view.getUint16(0) !== 0xFFD8) return null; // not JPEG either

    let offset = 2;
    while (offset + 4 <= view.byteLength) {
      if (view.getUint8(offset) !== 0xFF) break; // corrupt / not a marker
      const marker = view.getUint8(offset + 1);

      // Markers with no length field.
      if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
        offset += 2;
        continue;
      }
      if (marker === 0xD9) break; // EOI
      if (marker === 0xDA) break; // Start of Scan — image data follows, headers are done

      const segLength = view.getUint16(offset + 2);

      if (marker === 0xE1 && offset + 10 <= view.byteLength) {
        const sig = [4, 5, 6, 7, 8, 9].map((i) => view.getUint8(offset + i));
        const isExif = sig[0] === 0x45 && sig[1] === 0x78 && sig[2] === 0x69 &&
                        sig[3] === 0x66 && sig[4] === 0x00 && sig[5] === 0x00; // "Exif\0\0"
        if (isExif) {
          const tiffStart = offset + 10;
          const parsed = parseTIFF(view, tiffStart);
          if (parsed) return parsed;
        }
      }

      offset += 2 + segLength;
    }
    return null; // no EXIF found — could be a screenshot, or already-cleaned
  }

  global.ExifReader = { parse };
})(window);
