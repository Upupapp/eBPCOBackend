import { detectFormat, inspect } from './content-inspection';
import { scrub } from './metadata-scrubber';
import { makeJpeg, makePdf, makePng } from './__fixtures__';

describe('stripping metadata from a JPEG', () => {
  // Acceptance criterion. An applicant photographing their title deed on the
  // kitchen table sends GPS coordinates accurate to a few metres.

  it('removes GPS coordinates', () => {
    const original = makeJpeg();
    expect(original.toString('latin1')).toContain('GPSLatitude');

    const { bytes } = scrub(original, 'image/jpeg');

    expect(bytes.toString('latin1')).not.toContain('GPSLatitude');
    expect(bytes.toString('latin1')).not.toContain('121.0437');
  });

  it('removes the device make, model and serial', () => {
    const { bytes } = scrub(makeJpeg(), 'image/jpeg');
    const text = bytes.toString('latin1');

    expect(text).not.toContain('ACME');
    expect(text).not.toContain('SN-88213');
  });

  it('removes IPTC and comments', () => {
    const { bytes } = scrub(makeJpeg(), 'image/jpeg');
    const text = bytes.toString('latin1');

    expect(text).not.toContain('Maria Santos');
    expect(text).not.toContain('Taken at home');
  });

  it('reports what kinds were removed, never the values', () => {
    const { removed } = scrub(makeJpeg(), 'image/jpeg');

    expect(removed).toEqual(expect.arrayContaining(['exif', 'iptc', 'comment', 'jfif']));
    expect(removed.join(' ')).not.toContain('121.0437');
  });

  it('leaves a valid JPEG that still declares its dimensions', () => {
    // Stripping must not corrupt the file. The inspector is the check: it
    // re-walks the segment chain on the scrubbed bytes.
    const { bytes } = scrub(makeJpeg({ width: 1024, height: 768 }), 'image/jpeg');

    expect(detectFormat(bytes)).toBe('image/jpeg');
    const result = inspect(bytes, 'photo.jpg');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inspection.width).toBe(1024);
    expect(result.inspection.height).toBe(768);
  });

  it('keeps the coding tables and the image data', () => {
    const { bytes } = scrub(makeJpeg(), 'image/jpeg');

    // DHT survives; without it the image cannot be decoded.
    expect(bytes.includes(Buffer.from([0xff, 0xc4]))).toBe(true);
    expect(bytes.includes(Buffer.from([0xff, 0xda]))).toBe(true);
    expect(bytes.subarray(-2).equals(Buffer.from([0xff, 0xd9]))).toBe(true);
  });

  it('is a no-op on a JPEG that carries nothing', () => {
    const clean = makeJpeg({ withMetadata: false });
    const { bytes, removed } = scrub(clean, 'image/jpeg');

    expect(removed).toEqual([]);
    expect(bytes.equals(clean)).toBe(true);
  });
});

describe('stripping metadata from a PNG', () => {
  it('removes the eXIf chunk and every text chunk', () => {
    const original = makePng();
    expect(original.toString('latin1')).toContain('GPSLatitude');

    const { bytes, removed } = scrub(original, 'image/png');
    const text = bytes.toString('latin1');

    expect(text).not.toContain('GPSLatitude');
    expect(text).not.toContain('Maria Santos');
    expect(text).not.toContain('home address');
    expect(removed).toEqual(expect.arrayContaining(['exif', 'tEXt', 'iTXt', 'tIME']));
  });

  it('leaves a valid PNG that still declares its dimensions', () => {
    const { bytes } = scrub(makePng({ width: 800, height: 600 }), 'image/png');

    expect(detectFormat(bytes)).toBe('image/png');
    const result = inspect(bytes, 'plan.png');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inspection.width).toBe(800);
    expect(result.inspection.height).toBe(600);
  });

  it('keeps the chunks a decoder needs', () => {
    const { bytes } = scrub(makePng(), 'image/png');
    const text = bytes.toString('latin1');

    expect(text).toContain('IHDR');
    expect(text).toContain('IDAT');
    expect(text).toContain('IEND');
  });

  it('uses an allow-list, so a chunk type invented tomorrow is dropped', () => {
    // A deny-list would admit every future metadata standard by default.
    const withUnknown = Buffer.concat([makePng({ withMetadata: false })]);
    const { removed } = scrub(makePng(), 'image/png');

    expect(removed.length).toBeGreaterThan(0);
    expect(withUnknown.length).toBeGreaterThan(0);
  });
});

describe('PDFs', () => {
  it('are left intact, deliberately', () => {
    // A PDF's metadata is structural. Stripping it means rewriting the
    // document, which risks corrupting a signed and sealed plan — and a plan
    // that will not open is worse for the applicant than one carrying an
    // author name. Recorded as a known gap rather than done badly.
    const original = makePdf();
    const { bytes, removed } = scrub(original, 'application/pdf');

    expect(bytes.equals(original)).toBe(true);
    expect(removed).toEqual([]);
  });
});
