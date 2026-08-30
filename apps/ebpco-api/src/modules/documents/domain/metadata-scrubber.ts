import { AllowedFormat } from './content-inspection';

/**
 * Removes everything from an image except the image.
 *
 * An applicant photographing their title deed on the kitchen table sends the
 * LGU a JPEG whose EXIF block routinely contains GPS coordinates accurate to a
 * few metres, the device serial, and the time. None of that is part of the
 * document; all of it is personal data the LGU would then hold, store, back up
 * and have to account for under RA 10173 — collected by accident and justified
 * by nothing.
 *
 * So the scrub is unconditional and happens before the bytes are stored. It
 * drops metadata rather than editing it: an allow-list of what an image needs
 * to render, and everything else discarded.
 */

export interface ScrubResult {
  readonly bytes: Buffer;
  /** What was removed, for the audit trail. Never the values, only the kinds. */
  readonly removed: readonly string[];
}

export function scrub(bytes: Buffer, format: AllowedFormat): ScrubResult {
  if (format === 'image/jpeg') return scrubJpeg(bytes);
  if (format === 'image/png') return scrubPng(bytes);
  // A PDF's metadata is structural and cannot be stripped without rewriting the
  // document, which risks corrupting a signed or sealed plan. Left intact
  // deliberately, and recorded as a known gap rather than half-done.
  return { bytes, removed: [] };
}

/**
 * JPEG is a chain of marker segments. Everything from SOI to the Start Of Scan
 * is metadata or coding tables; the image itself follows SOS.
 *
 * Every APPn segment is dropped — APP1 carries EXIF and XMP, APP13 carries
 * IPTC, APP2 carries ICC — along with comments. Dropping APP0/JFIF costs
 * nothing: it holds density units, which no viewer needs to decode the image.
 * The alternative, keeping an allow-list of "safe" APP segments, means every
 * future metadata standard is included by default.
 */
function scrubJpeg(bytes: Buffer): ScrubResult {
  if (bytes.length < 4) return { bytes, removed: [] };

  const kept: Buffer[] = [bytes.subarray(0, 2)]; // SOI
  const removed = new Set<string>();
  let offset = 2;

  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1];
    if (marker === undefined) break;

    // Start of scan: everything after this is entropy-coded image data.
    if (marker === 0xda) {
      kept.push(bytes.subarray(offset));
      offset = bytes.length;
      break;
    }
    if (marker === 0xd9) break; // EOI

    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) break;

    const isApp = marker >= 0xe0 && marker <= 0xef;
    const isComment = marker === 0xfe;

    if (isApp || isComment) {
      removed.add(labelForJpegMarker(marker, bytes, offset + 4));
    } else {
      kept.push(bytes.subarray(offset, offset + 2 + length));
    }
    offset += 2 + length;
  }

  if (offset < bytes.length) kept.push(bytes.subarray(offset));
  return { bytes: Buffer.concat(kept), removed: [...removed] };
}

function labelForJpegMarker(marker: number, bytes: Buffer, payloadStart: number): string {
  if (marker === 0xfe) return 'comment';
  const tag = bytes.toString('latin1', payloadStart, Math.min(payloadStart + 6, bytes.length));
  if (tag.startsWith('Exif')) return 'exif';
  if (tag.startsWith('http:')) return 'xmp';
  if (tag.startsWith('Photos')) return 'iptc';
  if (tag.startsWith('ICC_PR')) return 'icc-profile';
  if (tag.startsWith('JFIF')) return 'jfif';
  return `app${(marker - 0xe0).toString()}`;
}

/**
 * PNG is a chunk stream. Only a handful of chunks affect rendering; the rest is
 * metadata, and the text chunks in particular are where camera software and
 * editors leave EXIF, GPS and authorship.
 *
 * An allow-list, for the same reason as JPEG: a deny-list admits every chunk
 * type invented after this was written.
 */
const PNG_KEEP = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND', // structure and pixels
  'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs', // colour and rendering
]);

function scrubPng(bytes: Buffer): ScrubResult {
  if (bytes.length < 8) return { bytes, removed: [] };

  const kept: Buffer[] = [bytes.subarray(0, 8)]; // signature
  const removed = new Set<string>();
  let offset = 8;

  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const total = 12 + length; // length + type + data + crc
    if (offset + total > bytes.length) break;

    if (PNG_KEEP.has(type)) {
      kept.push(bytes.subarray(offset, offset + total));
    } else {
      removed.add(type === 'eXIf' ? 'exif' : type);
    }

    offset += total;
    if (type === 'IEND') break;
  }

  return { bytes: Buffer.concat(kept), removed: [...removed] };
}
