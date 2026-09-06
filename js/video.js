/**
 * video.js — reads hidden metadata out of MP4/MOV video files.
 *
 * These use a completely different container format than JPEG/PNG: a tree
 * of "boxes" (also called atoms), each `size(4 bytes) + type(4 bytes) +
 * content`. Verified against real files before writing any of this — same
 * approach as the photo EXIF reader. Unlike JPEG EXIF, which is one tightly
 * standardized spec, video metadata genuinely varies by manufacturer, so
 * this supports every real-world convention found during testing rather
 * than assuming one:
 *
 *  - moov/mvhd — the mandatory movie header. Always present. Has the
 *    canonical creation/modification timestamps (seconds since 1904-01-01,
 *    not the Unix epoch).
 *  - moov/trak/mdia/mdhd — same timestamp fields, per track.
 *  - moov/udta/loci — the ISO/3GPP "location information" box (confirmed
 *    via ffmpeg-generated test files). Binary, fixed layout.
 *  - moov/udta/©xyz as a *direct* short-text atom (2-byte length + 2-byte
 *    language code + raw text, no wrapper) — confirmed via a real Android
 *    device recording. GPS as an ISO-6709 string.
 *  - moov/udta/meta/ilst — the older iTunes-style tag list (©xyz/©mak/©mod,
 *    each wrapped in a nested 'data' box) — confirmed via a hand-built
 *    Apple-convention test file.
 *  - moov/meta (a *sibling* of udta, not nested inside it) using an 'mdta'
 *    handler with paired 'keys' + 'ilst' boxes — confirmed via the same
 *    real Android device recording. Keys are plain strings like
 *    "com.android.manufacturer" / "com.android.model", not 4-char codes,
 *    and ilst items are matched to keys positionally (1-indexed).
 *
 * One real gotcha found while testing against that file: not every
 * 'meta' box has the 4-byte version+flags header the format normally
 * gives it — the top-level Android-style one doesn't, the nested
 * Apple-style one does. metaChildrenStart() below detects which by
 * checking whether a valid box actually starts right where each
 * assumption says it should, rather than hardcoding one and breaking on
 * the other.
 *
 * Exposes window.VideoReader.parse(arrayBuffer) -> same shape as
 * ExifReader.parse: { make, model, dateTime, gps } or null.
 */
(function (global) {
  'use strict';

  const MAC_TO_UNIX_EPOCH_OFFSET = 2082844800; // seconds between 1904-01-01 and 1970-01-01

  function fourCC(view, offset) {
    return String.fromCharCode(
      view.getUint8(offset), view.getUint8(offset + 1),
      view.getUint8(offset + 2), view.getUint8(offset + 3)
    );
  }

  /**
   * Yields { type, start, end, bodyStart } for each direct child box in
   * [start, end). Handles the 64-bit "largesize" extension (real phone
   * recordings routinely use this for 'mdat', even well under 4GB).
   */
  function* walkBoxes(view, start, end) {
    let offset = start;
    while (offset + 8 <= end) {
      let size = view.getUint32(offset);
      const type = fourCC(view, offset + 4);
      let bodyStart = offset + 8;

      if (size === 1) { // 64-bit extended size
        const high = view.getUint32(offset + 8);
        const low = view.getUint32(offset + 12);
        size = high * 2 ** 32 + low;
        bodyStart = offset + 16;
      } else if (size === 0) { // box extends to end of the containing range
        size = end - offset;
      }

      if (size < 8 || offset + size > end) break; // malformed/truncated — stop safely

      yield { type, start: offset, end: offset + size, bodyStart };
      offset += size;
    }
  }

  function findBox(view, start, end, type) {
    for (const box of walkBoxes(view, start, end)) {
      if (box.type === type) return box;
    }
    return null;
  }

  function findAllBoxes(view, start, end, type) {
    const results = [];
    for (const box of walkBoxes(view, start, end)) {
      if (box.type === type) results.push(box);
    }
    return results;
  }

  /** True if a plausible box header (sane size, printable 4-character
   *  type) starts exactly at `offset`. Used to detect whether a 'meta'
   *  box's children start immediately or after a 4-byte version+flags
   *  field — this genuinely differs between real files (see file header
   *  comment), so it's detected rather than assumed. */
  function looksLikeBoxAt(view, offset, end) {
    if (offset + 8 > end) return false;
    const size = view.getUint32(offset);
    if (size !== 0 && size !== 1 && (size < 8 || offset + size > end + 8)) return false;
    for (let i = 0; i < 4; i++) {
      const c = view.getUint8(offset + 4 + i);
      if (c < 0x20 || c > 0x7e) return false; // must be printable ASCII
    }
    return true;
  }

  function metaChildrenStart(view, metaBox) {
    if (looksLikeBoxAt(view, metaBox.bodyStart, metaBox.end)) return metaBox.bodyStart;
    return metaBox.bodyStart + 4; // classic FullBox version+flags header
  }

  /** Recursively finds every box of `type` anywhere under [start,end),
   *  descending into known container box types. */
  function findAllBoxesDeep(view, start, end, type, results) {
    results = results || [];
    const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'meta', 'ilst', 'edts']);
    for (const box of walkBoxes(view, start, end)) {
      if (box.type === type) results.push(box);
      if (CONTAINERS.has(box.type)) {
        const childStart = box.type === 'meta' ? metaChildrenStart(view, box) : box.bodyStart;
        findAllBoxesDeep(view, childStart, box.end, type, results);
      }
    }
    return results;
  }

  /** Reads the creation_time out of an mvhd/tkhd/mdhd-style box, handling
   *  both version 0 (32-bit fields) and version 1 (64-bit fields). */
  function readHeaderCreationTime(view, box) {
    const version = view.getUint8(box.bodyStart);
    const macTime = version === 1
      ? Number(view.getBigUint64(box.bodyStart + 4))
      : view.getUint32(box.bodyStart + 4);
    if (!macTime) return null;
    const unixSeconds = macTime - MAC_TO_UNIX_EPOCH_OFFSET;
    if (unixSeconds <= 0) return null;
    return new Date(unixSeconds * 1000);
  }

  /** Decodes an ISO/3GPP 'loci' location box (see file header comment for
   *  the verified layout). */
  function parseLoci(view, box) {
    let pos = box.bodyStart + 4; // skip version+flags
    pos += 2; // skip packed language code — not needed for our purposes
    // name: null-terminated string
    while (view.getUint8(pos) !== 0 && pos < box.end) pos++;
    pos += 1;
    pos += 1; // role byte
    if (pos + 12 > box.end) return null;
    const lon = view.getInt32(pos) / 65536; pos += 4;
    const lat = view.getInt32(pos) / 65536; pos += 4;
    const alt = view.getInt32(pos) / 65536; pos += 4;
    return { lat, lon, altitude: alt };
  }

  /** Parses an ISO 6709 location string like "+41.8903+012.4922/" or
   *  "+41.8903+012.4922+021.000/" (with optional altitude — this example
   *  is the Colosseum in Rome, chosen deliberately as an obvious landmark
   *  rather than any real person's location), the format used for GPS in
   *  both the direct-atom and data-wrapped '©xyz' conventions below. */
  function parseISO6709(str) {
    const m = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?\/?$/.exec(str.trim());
    if (!m) return null;
    return {
      lat: parseFloat(m[1]),
      lon: parseFloat(m[2]),
      altitude: m[3] ? parseFloat(m[3]) : null,
    };
  }

  /** Decodes the older QuickTime "short text atom" layout used when a tag
   *  sits directly under 'udta' with no 'data' wrapper: 2-byte text
   *  length + 2-byte packed language code + raw text. Confirmed against a
   *  real Android device recording, which stores GPS this way. */
  function readShortTextAtom(view, box) {
    if (box.end - box.bodyStart < 4) return null;
    const textLen = view.getUint16(box.bodyStart);
    const available = box.end - box.bodyStart - 4;
    const bytes = new Uint8Array(view.buffer, box.bodyStart + 4, Math.min(textLen, available));
    return new TextDecoder('utf-8').decode(bytes);
  }

  /** Reads an iTunes-style ilst tag list into a plain { fourCC: text }
   *  object, decoding each entry's nested 'data' box as UTF-8 text. Used
   *  for the older Apple-style convention (fixed 4-character tag names). */
  function readIlst(view, ilstBox) {
    const tags = {};
    for (const item of walkBoxes(view, ilstBox.bodyStart, ilstBox.end)) {
      const data = findBox(view, item.bodyStart, item.end, 'data');
      if (!data) continue;
      const textStart = data.bodyStart + 8; // skip type-indicator(4) + locale(4)
      if (textStart > data.end) continue;
      const bytes = new Uint8Array(view.buffer, textStart, data.end - textStart);
      tags[item.type] = new TextDecoder('utf-8').decode(bytes);
    }
    return tags;
  }

  /** Reads the newer 'mdta' key/value metadata mechanism: a 'keys' box
   *  listing arbitrary string keys (not 4-char codes), and an 'ilst' box
   *  whose items are matched to those keys *positionally* (item #1 → key
   *  #1, etc.) rather than by name. This is what real Android
   *  recordings use for device make/model, under moov/meta directly (a
   *  sibling of udta, not nested inside it). */
  function readMdtaKeyedMetadata(view, metaBox) {
    const childStart = metaChildrenStart(view, metaBox);
    const keysBox = findBox(view, childStart, metaBox.end, 'keys');
    const ilstBox = findBox(view, childStart, metaBox.end, 'ilst');
    if (!keysBox || !ilstBox) return {};

    const keys = [];
    let pos = keysBox.bodyStart + 8; // skip version+flags(4) + entry_count(4)
    while (pos + 8 <= keysBox.end) {
      const entrySize = view.getUint32(pos);
      if (entrySize < 8 || pos + entrySize > keysBox.end) break;
      const keyBytes = new Uint8Array(view.buffer, pos + 8, entrySize - 8);
      keys.push(new TextDecoder('utf-8').decode(keyBytes));
      pos += entrySize;
    }

    const values = {};
    for (const item of walkBoxes(view, ilstBox.bodyStart, ilstBox.end)) {
      const index = view.getUint32(item.start + 4); // the box "type" is really a 1-based key index here
      const keyName = keys[index - 1];
      if (!keyName) continue;
      const data = findBox(view, item.bodyStart, item.end, 'data');
      if (!data) continue;
      const textStart = data.bodyStart + 8;
      if (textStart > data.end) continue;
      const bytes = new Uint8Array(view.buffer, textStart, data.end - textStart);
      values[keyName] = new TextDecoder('utf-8').decode(bytes);
    }
    return values;
  }

  function parse(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    if (view.byteLength < 12) return null;

    const ftyp = findBox(view, 0, view.byteLength, 'ftyp');
    if (!ftyp) return null; // not an MP4/MOV-family file

    const moov = findBox(view, 0, view.byteLength, 'moov');
    if (!moov) return null;

    const result = { make: null, model: null, dateTime: null, gps: null };

    const mvhd = findBox(view, moov.bodyStart, moov.end, 'mvhd');
    if (mvhd) {
      const date = readHeaderCreationTime(view, mvhd);
      if (date) result.dateTime = date.toISOString();
    }

    // Device make/model: the newer keyed 'mdta' mechanism (moov/meta,
    // sibling of udta) — this is what real Android device recordings use.
    const topMeta = findBox(view, moov.bodyStart, moov.end, 'meta');
    if (topMeta) {
      const kv = readMdtaKeyedMetadata(view, topMeta);
      if (kv['com.android.manufacturer']) result.make = kv['com.android.manufacturer'];
      if (kv['com.android.model']) result.model = kv['com.android.model'];
    }

    const udta = findBox(view, moov.bodyStart, moov.end, 'udta');
    if (udta) {
      // GPS, tried in the order real files were actually found to use it.
      const loci = findBox(view, udta.bodyStart, udta.end, 'loci');
      if (loci) result.gps = parseLoci(view, loci);

      if (!result.gps) {
        const xyzDirect = findBox(view, udta.bodyStart, udta.end, '\u00a9xyz');
        if (xyzDirect) {
          const text = readShortTextAtom(view, xyzDirect);
          if (text) result.gps = parseISO6709(text);
        }
      }

      const meta = findBox(view, udta.bodyStart, udta.end, 'meta');
      if (meta) {
        const ilstStart = metaChildrenStart(view, meta);
        const ilst = findBox(view, ilstStart, meta.end, 'ilst');
        if (ilst) {
          const tags = readIlst(view, ilst);
          if (!result.make && tags['\u00a9mak']) result.make = tags['\u00a9mak'];
          if (!result.model && tags['\u00a9mod']) result.model = tags['\u00a9mod'];
          if (!result.gps && tags['\u00a9xyz']) {
            result.gps = parseISO6709(tags['\u00a9xyz']);
          }
        }
      }
    }

    return result;
  }

  global.VideoReader = {
    parse, walkBoxes, findBox, findAllBoxes, findAllBoxesDeep, metaChildrenStart,
  };
})(window);
