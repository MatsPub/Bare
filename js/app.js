(function () {
  'use strict';

  const fileInput = document.getElementById('file-input');
  const dropZone = document.getElementById('drop-zone');
  const report = document.getElementById('report');
  const previewImg = document.getElementById('preview-img');
  const previewVideo = document.getElementById('preview-video');
  const videoPlaceholder = document.getElementById('video-placeholder');
  const fieldList = document.getElementById('field-list');
  const redactionNote = document.getElementById('redaction-note');
  const mapMarker = document.getElementById('map-marker');
  const mapWrap = document.getElementById('map-wrap');
  const deviceGlyph = document.getElementById('device-glyph');
  const cleanBtn = document.getElementById('clean-btn');
  const statusEl = document.getElementById('status');
  const verifyEl = document.getElementById('verify');
  const startOverBtn = document.getElementById('start-over');

  let currentFile = null;
  let currentPreviewUrl = null;
  let videoReadyTimer = null;

  // Generic device silhouettes (not brand logos — see note below) using
  // the same "colored shape + background-colored cutout" trick as the
  // app icon, so the cutouts need to match --surface.
  const CAMERA_SVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <rect x="2" y="7" width="20" height="13" rx="2.5" fill="currentColor"/>
    <rect x="8" y="4" width="6.5" height="3.5" rx="1" fill="currentColor"/>
    <circle cx="12" cy="14" r="4.3" fill="#161d1d"/>
    <circle cx="12" cy="14" r="2.7" fill="currentColor"/>
    <circle cx="18.2" cy="9.7" r="0.9" fill="#161d1d"/>
  </svg>`;
  const PHONE_SVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <rect x="6" y="1.5" width="12" height="21" rx="2.6" fill="currentColor"/>
    <circle cx="12" cy="4.4" r="0.8" fill="#161d1d"/>
    <rect x="9" y="18.2" width="6" height="1.4" rx="0.7" fill="#161d1d"/>
  </svg>`;

  // Shown when a video is selected but the browser can't actually decode
  // it for an in-page preview (common for HEVC/H.265 — many phones record
  // in it by default for space savings, but plenty of browsers can't play
  // it in a <video> tag even though the OS's own Gallery/Photos app can,
  // since that uses a separate, licensed hardware decoder path). Metadata
  // reading never needs to decode a frame, so that still works regardless
  // — only the visual preview is affected. The pattern itself is styled
  // via CSS (.video-placeholder); nothing to set up here.

  // Brand *color* recognition, not brand *logo* reproduction — matching a
  // model string to a manufacturer's general color identity and a plain
  // camera/phone silhouette. Deliberately not attempting actual trademarked
  // logos here: this is a small offline tool, not licensed to reproduce them.
  const BRAND_MATCHERS = [
    [/nikon/i, { kind: 'camera', color: '#FFD400', label: 'Nikon' }],
    [/canon/i, { kind: 'camera', color: '#E10600', label: 'Canon' }],
    [/\bsony\b|ilce-|dsc-/i, { kind: 'camera', color: '#8FA3B0', label: 'Sony' }],
    [/fuji ?film/i, { kind: 'camera', color: '#00A651', label: 'Fujifilm' }],
    [/panasonic|lumix/i, { kind: 'camera', color: '#2A6EBB', label: 'Panasonic' }],
    [/olympus|om[ -]?system/i, { kind: 'camera', color: '#0D3B66', label: 'Olympus' }],
    [/leica/i, { kind: 'camera', color: '#E20612', label: 'Leica' }],
    [/gopro/i, { kind: 'camera', color: '#4DB8FF', label: 'GoPro' }],
    [/pixel/i, { kind: 'phone', color: '#4285F4', label: 'Google Pixel' }],
    [/iphone|apple/i, { kind: 'phone', color: '#A3AAAE', label: 'Apple' }],
    [/galaxy|\bsm-[a-z0-9]/i, { kind: 'phone', color: '#1428A0', label: 'Samsung' }],
    [/\boppo\b|cph\d/i, { kind: 'phone', color: '#1BA784', label: 'Oppo' }],
    [/\bvivo\b/i, { kind: 'phone', color: '#4477DD', label: 'Vivo' }],
    [/honor/i, { kind: 'phone', color: '#2AACE2', label: 'Honor' }],
    [/realme/i, { kind: 'phone', color: '#FFC900', label: 'Realme' }],
    [/huawei/i, { kind: 'phone', color: '#FF0000', label: 'Huawei' }],
    [/xiaomi|redmi|poco/i, { kind: 'phone', color: '#FF6900', label: 'Xiaomi' }],
    [/oneplus/i, { kind: 'phone', color: '#EB0028', label: 'OnePlus' }],
    [/motorola|\bmoto[ a-z]/i, { kind: 'phone', color: '#5A50FF', label: 'Motorola' }],
    [/nokia/i, { kind: 'phone', color: '#124191', label: 'Nokia' }],
  ];

  function deviceIconFor(deviceLabel) {
    if (!deviceLabel) return null;
    const hit = BRAND_MATCHERS.find(([re]) => re.test(deviceLabel));
    if (hit) return hit[1];
    // Unrecognized brand, but we still have a model string — guess the
    // category from common camera-model naming patterns.
    const looksLikeCamera = /coolpix|powershot|cybershot|dslr|mirrorless|ilce-|dsc-/i.test(deviceLabel);
    return { kind: looksLikeCamera ? 'camera' : 'phone', color: null, label: null };
  }

  function setDeviceGlyph(deviceLabel) {
    const info = deviceIconFor(deviceLabel);
    if (!info) {
      deviceGlyph.innerHTML = '';
      deviceGlyph.textContent = '❔';
      deviceGlyph.style.color = '';
      deviceGlyph.title = '';
      return;
    }
    deviceGlyph.style.color = info.color || 'var(--accent)';
    deviceGlyph.innerHTML = info.kind === 'camera' ? CAMERA_SVG : PHONE_SVG;
    deviceGlyph.title = info.label || '';
  }

  function fmtCoord(n) {
    return n.toFixed(5) + '°';
  }

  // Photo EXIF dates look like "2026:09:05 22:47:47"; video container dates
  // come out of video.js as ISO strings like "2026-09-05T22:47:47.000Z".
  // Normalize either to a plain, readable "YYYY-MM-DD HH:MM:SS".
  function fmtDateTime(raw) {
    if (/^\d{4}:\d{2}:\d{2}/.test(raw)) {
      return raw.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
    }
    return raw.replace('T', ' ').replace(/\.\d+Z$/, '').replace(/Z$/, '');
  }

  function isVideoFile(file) {
    return file.type.startsWith('video/');
  }

  // Equirectangular projection matching the embedded map file exactly —
  // verified against its real coordinate data (cross-checked the UK's
  // known lat/lon against where its shape actually sits in the source
  // file's pixel space). This map is centered at 10°E, not 0°E, so the
  // longitude wrap for the left/right seam sits at -170° — hence the
  // modulo, so a photo taken near that seam (mid-Pacific) still lands on
  // the correct side instead of just going negative.
  function projectToMap(lat, lon) {
    const x = (((lon + 170) % 360 + 360) % 360) / 360 * 100;
    const y = ((90 - lat) / 180) * 100;
    return { x, y };
  }

  function addField(label, value) {
    const row = document.createElement('div');
    row.className = 'field-row';
    const l = document.createElement('span');
    l.className = 'field-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'field-value';
    v.textContent = value;
    row.appendChild(l);
    row.appendChild(v);
    fieldList.appendChild(row);
  }

  function renderReport(exif, file) {
    fieldList.innerHTML = '';
    mapWrap.hidden = true;
    redactionNote.hidden = true;

    let riskCount = 0;

    if (exif && exif.model) {
      const deviceLabel = [exif.make, exif.model].filter(Boolean).join(' ');
      addField('Device', deviceLabel);
      setDeviceGlyph(deviceLabel);
      riskCount++;
    } else {
      setDeviceGlyph(null);
    }

    if (exif && exif.dateTime) {
      addField('Taken', fmtDateTime(exif.dateTime));
      riskCount++;
    }

    // Android's photo picker silently zeroes GPS coordinates to 0,0 before
    // a website ever sees the file — a deliberate OS privacy behavior since
    // Android 10, applied through the picker regardless of what app or
    // website is requesting the photo. A real photo landing at exactly
    // 0.0000°, 0.0000° (open ocean, nowhere near any coastline) is
    // effectively never going to happen, so treat that exact reading as
    // "redacted by the OS" rather than a real location — showing it as a
    // genuine coordinate would be actively misleading, not just unhelpful.
    const NULL_ISLAND_EPSILON = 0.0001;
    const looksRedacted = exif && exif.gps &&
      Math.abs(exif.gps.lat) < NULL_ISLAND_EPSILON && Math.abs(exif.gps.lon) < NULL_ISLAND_EPSILON;

    const gpsValid = exif && exif.gps && !looksRedacted &&
      Number.isFinite(exif.gps.lat) && Number.isFinite(exif.gps.lon) &&
      Math.abs(exif.gps.lat) <= 90 && Math.abs(exif.gps.lon) <= 180;

    if (gpsValid) {
      addField('Latitude', fmtCoord(exif.gps.lat));
      addField('Longitude', fmtCoord(exif.gps.lon));
      if (exif.gps.altitude != null) addField('Altitude', exif.gps.altitude.toFixed(0) + ' m');
      riskCount += 2;

      const { x, y } = projectToMap(exif.gps.lat, exif.gps.lon);
      mapMarker.style.left = x + '%';
      mapMarker.style.top = y + '%';
      mapWrap.hidden = false;
    } else if (looksRedacted) {
      addField('Location', 'Blocked by your phone, not by us');
      redactionNote.hidden = false;
    } else if (exif && exif.gps) {
      // GPS block was present but out of range / unparseable — surface
      // that plainly instead of silently drawing a marker at a wrong spot.
      addField('Location', 'GPS data present but could not be read reliably');
    }

    if (riskCount === 0 && looksRedacted) {
      statusEl.textContent = "Your phone's OS blocked this photo's location before we ever saw it — see the note below.";
    } else if (riskCount === 0) {
      addField('Result', 'No hidden device or location data found in this file.');
      statusEl.textContent = 'This photo looks clean already — nothing to strip.';
    } else if (looksRedacted) {
      statusEl.textContent = `Found ${riskCount} piece${riskCount === 1 ? '' : 's'} of hidden data — and your phone already blocked us from seeing the location. See the note below.`;
    } else {
      statusEl.textContent = `Found ${riskCount} piece${riskCount === 1 ? '' : 's'} of hidden data. Nobody you send this to should be able to see this.`;
    }

    report.hidden = false;
  }

  function readAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  }

  // Single pipeline, always the same regardless of the input photo:
  //
  //   1. Redraw onto a canvas and re-export. This costs a little quality
  //      (recompression), but it means orientation is always handled
  //      correctly (the browser bakes any EXIF rotation into the actual
  //      pixels as it decodes) instead of needing a special case for
  //      rotated photos. One path, not two — simpler, and nothing to get
  //      subtly wrong by picking the wrong branch.
  //   2. Run the result through the binary segment stripper. This is
  //      still needed even after redrawing: testing found the browser's
  //      own JPEG encoder stamps a default color profile onto its output,
  //      and this step removes that too, along with anything else that
  //      might have snuck in.
  //
  // The upshot: always lossy-recompressed (a deliberate tradeoff — real
  // photos get compressed again by every social platform anyway), but
  // always fully clean, and always correctly oriented.
  function canvasRedraw(file, quality) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(url);
          if (!blob) return reject(new Error('Export failed'));
          resolve(blob);
        }, mime, quality);
      };
      img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
      img.src = url;
    });
  }

  async function stripMetadata(file) {
    if (isVideoFile(file)) {
      // Videos never get redrawn/re-encoded — that would mean full video
      // transcoding (slow, lossy, needs machinery like ffmpeg.wasm this
      // app deliberately doesn't carry). The in-place box stripper is
      // already lossless and doesn't need that tradeoff.
      const buffer = await file.arrayBuffer();
      const strippedBuffer = window.VideoStripper.strip(buffer);
      return new Blob([strippedBuffer], { type: file.type });
    }
    const redrawnBlob = await canvasRedraw(file, 0.92);
    const redrawnBuffer = await redrawnBlob.arrayBuffer();
    const strippedBuffer = window.MetadataStripper.strip(redrawnBuffer, redrawnBlob.type);
    return new Blob([strippedBuffer], { type: redrawnBlob.type });
  }

  async function handleFile(file) {
    currentFile = file;

    if (currentPreviewUrl) URL.revokeObjectURL(currentPreviewUrl); // don't leak old blob URLs
    currentPreviewUrl = URL.createObjectURL(file);

    if (isVideoFile(file)) {
      previewVideo.src = currentPreviewUrl;
      previewVideo.hidden = false;
      previewImg.hidden = true;
      videoPlaceholder.hidden = true;
      // Just setting .src and unhiding isn't enough — unlike <img>, a
      // <video> renders nothing at all until it actually starts decoding
      // frames, which normally only happens once playback begins. Muted
      // autoplay is reliably allowed by every modern browser specifically
      // for cases like this; .play() is called explicitly too since some
      // browsers don't act on the autoplay attribute for a video element
      // that was just unhidden after being created.
      previewVideo.play().catch(() => { /* fine if this is blocked — not critical */ });

      // The 'error' event alone isn't a reliable enough signal: some
      // browsers "load" a codec they can't actually decode (e.g. HEVC,
      // common on Android by default) without ever throwing a formal
      // error — they just never manage to paint a frame. Since this is a
      // local blob, not a network fetch, decode capability (not load
      // speed) is the only real bottleneck, so if no frame is ready
      // shortly after asking it to play, it's not going to happen —
      // fall back to the placeholder instead of leaving an empty box.
      clearTimeout(videoReadyTimer);
      videoReadyTimer = setTimeout(() => {
        if (previewVideo.readyState < 2 && !previewVideo.hidden) { // < HAVE_CURRENT_DATA
          previewVideo.hidden = true;
          videoPlaceholder.hidden = false;
        }
      }, 1500);
    } else {
      previewImg.src = currentPreviewUrl;
      previewImg.hidden = false; // was never actually being shown before — fixed alongside the other hidden-state bugs
      previewVideo.hidden = true;
      previewVideo.pause();
      videoPlaceholder.hidden = true;
      clearTimeout(videoReadyTimer);
    }

    cleanBtn.disabled = false;
    verifyEl.textContent = '';

    const buffer = await readAsArrayBuffer(file);
    let exif = null;
    if (isVideoFile(file)) {
      exif = window.VideoReader.parse(buffer);
    } else {
      // ExifReader now understands both JPEG's APP1/Exif segment and
      // PNG's eXIf chunk internally, and safely returns null for
      // anything else — no need to gate by MIME type here anymore.
      exif = window.ExifReader.parse(buffer);
    }
    renderReport(exif, file);
  }

  cleanBtn.addEventListener('click', async () => {
    if (!currentFile) return;
    cleanBtn.disabled = true;
    cleanBtn.textContent = 'Cleaning…';

    try {
      const cleanedBlob = await stripMetadata(currentFile);

      // Self-check: re-parse our own output and confirm nothing survived.
      const cleanedBuffer = await cleanedBlob.arrayBuffer();
      let recheck = null;
      if (isVideoFile(currentFile)) {
        recheck = window.VideoReader.parse(cleanedBuffer);
      } else {
        recheck = window.ExifReader.parse(cleanedBuffer);
      }
      const clean = !recheck || (!recheck.gps && !recheck.model && !recheck.dateTime);
      verifyEl.textContent = clean
        ? '✓ Verified: re-scanned the cleaned file ourselves — no device or location data remains.'
        : '⚠ Some fields may remain — please check before sharing.';

      const nameParts = currentFile.name.split('.');
      const ext = isVideoFile(currentFile)
        ? (currentFile.name.split('.').pop() || 'mp4')
        : (cleanedBlob.type === 'image/png' ? 'png' : 'jpg');
      nameParts.pop();
      const outName = nameParts.join('.') + '-cleaned.' + ext;

      const a = document.createElement('a');
      a.href = URL.createObjectURL(cleanedBlob);
      a.download = outName;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      statusEl.textContent = 'Something went wrong cleaning that file: ' + err.message;
    } finally {
      cleanBtn.disabled = false;
      cleanBtn.textContent = 'Clean & download';
    }
  });

  startOverBtn.addEventListener('click', () => {
    currentFile = null;
    fileInput.value = '';

    if (currentPreviewUrl) URL.revokeObjectURL(currentPreviewUrl);
    currentPreviewUrl = null;
    previewImg.src = '';
    previewImg.hidden = true;
    previewVideo.pause();
    previewVideo.src = '';
    previewVideo.hidden = true;
    videoPlaceholder.hidden = true;
    clearTimeout(videoReadyTimer);

    cleanBtn.disabled = true;
    cleanBtn.textContent = 'Clean & download';
    mapWrap.hidden = true;
    redactionNote.hidden = true;
    fieldList.innerHTML = '';
    statusEl.textContent = '';
    report.hidden = true;
    verifyEl.textContent = '';
  });

  // If the browser genuinely can't decode this video for preview (most
  // commonly HEVC — see the comment near the top of this file), the
  // element fires 'error' rather than ever showing a frame. Fall back to
  // the placeholder instead of leaving an empty box.
  previewVideo.addEventListener('error', () => {
    if (previewVideo.hidden) return; // not currently the active preview
    clearTimeout(videoReadyTimer);
    previewVideo.hidden = true;
    videoPlaceholder.hidden = false;
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
  });

  ['dragover', 'dragenter'].forEach((evt) =>
    dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.add('drag'); })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.remove('drag'); })
  );
  dropZone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
  dropZone.addEventListener('click', () => fileInput.click());

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {
        /* offline installs still work without this; fail quietly */
      });
    });
  }
})();
