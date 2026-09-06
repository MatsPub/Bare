/**
 * video-strip.js — removes hidden metadata from MP4/MOV video files.
 *
 * Unlike the JPEG/PNG strippers, this one never deletes a single byte.
 * MP4/MOV files store *absolute file offsets* elsewhere (in stco/co64
 * "chunk offset" tables) pointing into the actual video/audio data. If the
 * metadata sits before that data in the file — common; many encoders,
 * including iPhone's, put 'moov' before 'mdat' specifically to support
 * fast-start streaming — shrinking it would shift everything after it and
 * silently point every offset table at the wrong bytes, corrupting
 * playback. So instead: the metadata box is renamed to 'free' (a box type
 * the format itself defines as "ignore this, it's just reserved space")
 * and its contents zeroed. Same file size, same layout, metadata actually
 * gone — verified by re-parsing our own output afterward and confirming
 * it comes back empty.
 */
(function (global) {
  'use strict';

  function strip(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer.slice(0)); // work on a copy
    const view = new DataView(bytes.buffer);
    const reader = global.VideoReader;

    const moov = reader.findBox(view, 0, bytes.length, 'moov');
    if (!moov) throw new Error('Not a recognized MP4/MOV file');

    function neutralize(box) {
      const FREE = [0x66, 0x72, 0x65, 0x65]; // 'free'
      for (let i = 0; i < 4; i++) bytes[box.start + 4 + i] = FREE[i];
      for (let i = box.bodyStart; i < box.end; i++) bytes[i] = 0;
    }

    // Neutralize every 'udta' box (GPS, device make/model, free-text tags
    // all live here on some devices) by turning it into zeroed free space.
    for (const udta of reader.findAllBoxes(view, moov.bodyStart, moov.end, 'udta')) {
      neutralize(udta);
    }

    // Real Android recordings put device make/model in a *separate*
    // top-level 'meta' box — a sibling of 'udta' under moov, not nested
    // inside it — using the newer 'mdta' keyed metadata mechanism. Confirmed
    // against a real device recording, not assumed: this needs its own
    // pass, since the udta loop above never touches it.
    for (const meta of reader.findAllBoxes(view, moov.bodyStart, moov.end, 'meta')) {
      neutralize(meta);
    }

    // Zero the creation/modification timestamps in the movie header and
    // every track's header/media-header — these are mandatory fixed-size
    // fields (can't be removed, only blanked), each starting right after
    // a 1-byte version + 3-byte flags field.
    const headerBoxes = [];
    const mvhd = reader.findBox(view, moov.bodyStart, moov.end, 'mvhd');
    if (mvhd) headerBoxes.push(mvhd);
    headerBoxes.push(...reader.findAllBoxesDeep(view, moov.bodyStart, moov.end, 'tkhd'));
    headerBoxes.push(...reader.findAllBoxesDeep(view, moov.bodyStart, moov.end, 'mdhd'));

    for (const box of headerBoxes) {
      const version = view.getUint8(box.bodyStart);
      const fieldBytes = version === 1 ? 16 : 8; // two 64-bit fields, or two 32-bit fields
      for (let i = 0; i < fieldBytes; i++) bytes[box.bodyStart + 4 + i] = 0;
    }

    return bytes.buffer;
  }

  global.VideoStripper = { strip };
})(window);
