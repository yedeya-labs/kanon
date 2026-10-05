import { crc32, deflateRawSync } from 'node:zlib';

/** A zip as `actions/upload-artifact` writes it: deflated, with a data descriptor, so the local
 *  header's sizes are zero and only the central directory has them. */
export function zipOf(name: string, content: string, { stored = false } = {}): Buffer {
  const raw = Buffer.from(content, 'utf8');
  const data = stored ? raw : deflateRawSync(raw);
  const method = stored ? 0 : 8;
  const fname = Buffer.from(name, 'utf8');
  const crc = crc32(raw);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0008, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(fname.length, 26);
  const desc = Buffer.alloc(16);
  desc.writeUInt32LE(0x08074b50, 0);
  desc.writeUInt32LE(crc, 4);
  desc.writeUInt32LE(data.length, 8);
  desc.writeUInt32LE(raw.length, 12);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0008, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(fname.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOffset = local.length + fname.length + data.length + desc.length;
  const cd = Buffer.concat([central, fname]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, fname, data, desc, cd, eocd]);
}
