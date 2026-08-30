/**
 * Real files, built byte by byte.
 *
 * Not stubs: the inspector walks JPEG segment chains and reads PNG IHDR
 * headers, and the scrubber rewrites both. A fixture that is not a valid file
 * would let a broken parser pass.
 */

/** PNG chunk CRC-32, so the fixtures are files a real decoder would accept. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = -1;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

export function makePng(options: { width?: number; height?: number; withMetadata?: boolean } = {}): Buffer {
  const { width = 800, height = 600, withMetadata = true } = options;

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const chunks: Buffer[] = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
  ];

  if (withMetadata) {
    // An eXIf chunk carrying a GPS-looking payload, and the text chunks camera
    // software and editors leave behind.
    chunks.push(pngChunk('eXIf', Buffer.from('GPSLatitude=14.6760;GPSLongitude=121.0437', 'latin1')));
    chunks.push(pngChunk('tEXt', Buffer.concat([Buffer.from('Author\0Maria Santos', 'latin1')])));
    chunks.push(pngChunk('iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta>home address</x:xmpmeta>', 'latin1')));
    chunks.push(pngChunk('tIME', Buffer.from([0x07, 0xea, 0x08, 0x13, 0x0c, 0x00, 0x00])));
  }

  chunks.push(pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])));
  chunks.push(pngChunk('IEND', Buffer.alloc(0)));

  return Buffer.concat(chunks);
}

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const header = Buffer.from([0xff, marker]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2);
  return Buffer.concat([header, length, payload]);
}

export function makeJpeg(options: { width?: number; height?: number; withMetadata?: boolean } = {}): Buffer {
  const { width = 1024, height = 768, withMetadata = true } = options;

  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])]; // SOI

  if (withMetadata) {
    // APP1 / Exif, with a GPS IFD marker and coordinates in the payload —
    // exactly what a phone camera writes when someone photographs a document
    // at home.
    parts.push(
      jpegSegment(
        0xe1,
        Buffer.concat([
          Buffer.from('Exif\0\0', 'latin1'),
          Buffer.from('MM\0*\0\0\0\x08', 'latin1'),
          Buffer.from('GPSLatitude 14.6760 N GPSLongitude 121.0437 E', 'latin1'),
          Buffer.from('Make=ACME Model=Phone9 Serial=SN-88213', 'latin1'),
        ]),
      ),
    );
    parts.push(jpegSegment(0xe0, Buffer.from('JFIF\0\x01\x02\0\0\x01\0\x01\0\0', 'latin1'))); // APP0
    parts.push(jpegSegment(0xed, Buffer.from('Photoshop 3.0\0IPTC Maria Santos', 'latin1'))); // APP13
    parts.push(jpegSegment(0xfe, Buffer.from('Taken at home', 'latin1'))); // COM
  }

  // SOF0: precision, height, width, components.
  const sof = Buffer.alloc(6 + 3);
  sof[0] = 8;
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 1;
  sof[6] = 1; sof[7] = 0x11; sof[8] = 0;
  parts.push(jpegSegment(0xc0, sof));

  parts.push(jpegSegment(0xc4, Buffer.from([0x00, 0x00]))); // DHT, kept by the scrubber
  parts.push(Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])); // SOS
  parts.push(Buffer.from([0x12, 0x34, 0x56, 0x78])); // entropy-coded data
  parts.push(Buffer.from([0xff, 0xd9])); // EOI

  return Buffer.concat(parts);
}

export function makePdf(): Buffer {
  return Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
    'latin1',
  );
}
