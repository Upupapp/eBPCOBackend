/**
 * What a file actually is, determined from its bytes.
 *
 * Never from the extension, and never from the `Content-Type` the client sent:
 * both are supplied by whoever is uploading, and this endpoint is open to the
 * public. An LGU officer opens these files on a government workstation, so the
 * question "is this really a PDF" has to be answered by reading it.
 */

export type AllowedFormat = 'application/pdf' | 'image/jpeg' | 'image/png';

export type RejectionReason =
  | 'empty'
  | 'unrecognised-format'
  | 'format-not-allowed'
  | 'extension-mismatch'
  | 'too-large'
  | 'dimensions-too-large'
  | 'truncated';

export interface Inspection {
  readonly format: AllowedFormat;
  readonly width?: number;
  readonly height?: number;
}

export interface InspectionFailure {
  readonly reason: RejectionReason;
  readonly detail: string;
}

export type InspectionResult =
  | { readonly ok: true; readonly inspection: Inspection }
  | { readonly ok: false; readonly failure: InspectionFailure };

/** Extensions each format may legitimately carry. */
const EXTENSIONS: Readonly<Record<AllowedFormat, readonly string[]>> = {
  'application/pdf': ['pdf'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
};

export const MAX_BYTES = 20 * 1024 * 1024;

/**
 * A guard against decompression bombs: a PNG can declare 60000x60000 in a few
 * kilobytes and cost gigabytes to render. The limit is generous for a scanned
 * plan and far below anything that would exhaust a worker.
 */
export const MAX_PIXELS = 80_000_000;

function startsWith(bytes: Buffer, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function detectFormat(bytes: Buffer): AllowedFormat | null {
  if (startsWith(bytes, PDF)) return 'application/pdf';
  if (startsWith(bytes, JPEG)) return 'image/jpeg';
  if (startsWith(bytes, PNG)) return 'image/png';
  return null;
}

/** PNG dimensions live in the IHDR chunk, which is always first. */
function pngDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  if (bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * JPEG dimensions live in whichever Start Of Frame marker the encoder used.
 * Walking the segment chain is the only way to find it; there is no fixed
 * offset.
 */
function jpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  let offset = 2; // past SOI
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === undefined) return null;

    // SOF0..SOF15, excluding DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    // Start of scan: image data follows, no more headers worth walking.
    if (marker === 0xda) return null;

    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

export function inspect(
  bytes: Buffer,
  declaredFileName: string,
  maxBytes: number = MAX_BYTES,
): InspectionResult {
  if (bytes.length === 0) {
    return { ok: false, failure: { reason: 'empty', detail: 'The file is empty.' } };
  }
  if (bytes.length > maxBytes) {
    return {
      ok: false,
      failure: { reason: 'too-large', detail: `The file exceeds the ${Math.floor(maxBytes / 1024 / 1024)}MB limit.` },
    };
  }

  const format = detectFormat(bytes);
  if (format === null) {
    return {
      ok: false,
      failure: {
        reason: 'unrecognised-format',
        detail: 'This is not a PDF, JPEG or PNG. Only those three are accepted.',
      },
    };
  }

  // The extension must agree with the bytes. A disagreement is either a mistake
  // worth telling the applicant about, or an attempt to have an officer's
  // machine open something as one type that is another.
  const extension = declaredFileName.split('.').pop()?.toLowerCase() ?? '';
  if (!EXTENSIONS[format].includes(extension)) {
    return {
      ok: false,
      failure: {
        reason: 'extension-mismatch',
        detail: `The file is a ${format} but is named ".${extension}". Rename it or upload the right file.`,
      },
    };
  }

  if (format === 'application/pdf') {
    return { ok: true, inspection: { format } };
  }

  const dimensions = format === 'image/png' ? pngDimensions(bytes) : jpegDimensions(bytes);
  if (dimensions === null) {
    return {
      ok: false,
      failure: { reason: 'truncated', detail: 'The image header could not be read; the file may be incomplete.' },
    };
  }
  if (dimensions.width * dimensions.height > MAX_PIXELS) {
    // A few kilobytes on the wire, gigabytes to render.
    return {
      ok: false,
      failure: {
        reason: 'dimensions-too-large',
        detail: `The image declares ${dimensions.width}x${dimensions.height}, which is too large to process.`,
      },
    };
  }

  return { ok: true, inspection: { format, width: dimensions.width, height: dimensions.height } };
}
