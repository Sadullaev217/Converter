"use strict";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Reads width/height straight out of the PNG IHDR chunk (bytes 16-23).
 * pdfimages -png always re-encodes extracted images as PNG, so this is
 * sufficient without pulling in an image-parsing dependency.
 */
function getPngSize(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Not a valid PNG buffer");
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return { width, height };
}

module.exports = { getPngSize };
