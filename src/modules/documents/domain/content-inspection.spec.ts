import { MAX_PIXELS, detectFormat, inspect } from './content-inspection';
import { makeJpeg, makePdf, makePng } from './__fixtures__';

describe('what a file actually is', () => {
  it('recognises the three allowed formats from their bytes', () => {
    expect(detectFormat(makePdf())).toBe('application/pdf');
    expect(detectFormat(makeJpeg())).toBe('image/jpeg');
    expect(detectFormat(makePng())).toBe('image/png');
  });

  it('recognises nothing else', () => {
    expect(detectFormat(Buffer.from('MZ\x90\x00', 'latin1'))).toBeNull();
    expect(detectFormat(Buffer.from('<html>', 'latin1'))).toBeNull();
    expect(detectFormat(Buffer.from('PK\x03\x04', 'latin1'))).toBeNull();
  });

  it('accepts a well-formed file with a matching name', () => {
    expect(inspect(makePdf(), 'tct.pdf').ok).toBe(true);
    expect(inspect(makeJpeg(), 'photo.JPG').ok).toBe(true);
    expect(inspect(makePng(), 'plan.png').ok).toBe(true);
  });
});

describe('a file whose extension and bytes disagree', () => {
  // Acceptance criterion. Either a mistake worth telling the applicant about,
  // or an attempt to have an officer's machine open one thing as another.

  it('is rejected when a PDF is named .png', () => {
    const result = inspect(makePdf(), 'plan.png');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe('extension-mismatch');
  });

  it('is rejected when an executable is named .pdf', () => {
    const result = inspect(Buffer.from('MZ\x90\x00\x03', 'latin1'), 'invoice.pdf');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Caught by format detection before the extension is even considered.
    expect(result.failure.reason).toBe('unrecognised-format');
  });

  it('is rejected when a JPEG is named .pdf', () => {
    const result = inspect(makeJpeg(), 'scan.pdf');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe('extension-mismatch');
  });

  it('says which way round the mismatch is, so the applicant can fix it', () => {
    const result = inspect(makePdf(), 'plan.png');

    if (result.ok) return;
    expect(result.failure.detail).toContain('application/pdf');
    expect(result.failure.detail).toContain('.png');
  });

  it('ignores the case of the extension', () => {
    expect(inspect(makeJpeg(), 'PHOTO.JPEG').ok).toBe(true);
    expect(inspect(makePng(), 'Plan.PNG').ok).toBe(true);
  });
});

describe('size and shape', () => {
  it('rejects an empty file', () => {
    const result = inspect(Buffer.alloc(0), 'x.pdf');
    if (result.ok) return;
    expect(result.failure.reason).toBe('empty');
  });

  it('rejects a file over the cap', () => {
    const result = inspect(makePdf(), 'x.pdf', 10);
    if (result.ok) return;
    expect(result.failure.reason).toBe('too-large');
  });

  it('rejects a decompression bomb by its declared dimensions', () => {
    // A PNG can declare 60000x60000 in a few kilobytes and cost gigabytes to
    // render. The header says so before anything is decoded.
    const bomb = makePng({ width: 60_000, height: 60_000, withMetadata: false });

    expect(bomb.length).toBeLessThan(200);
    const result = inspect(bomb, 'bomb.png');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe('dimensions-too-large');
  });

  it('rejects an oversized JPEG the same way', () => {
    const result = inspect(makeJpeg({ width: 30_000, height: 30_000 }), 'big.jpg');
    if (result.ok) return;
    expect(result.failure.reason).toBe('dimensions-too-large');
  });

  it('accepts a large but plausible scanned plan', () => {
    const result = inspect(makePng({ width: 7_000, height: 5_000 }), 'plan.png');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inspection.width).toBe(7_000);
    expect(result.inspection.height).toBe(5_000);
    expect(7_000 * 5_000).toBeLessThan(MAX_PIXELS);
  });

  it('rejects a truncated image rather than guessing its size', () => {
    const result = inspect(makePng().subarray(0, 12), 'x.png');
    expect(result.ok).toBe(false);
  });
});
