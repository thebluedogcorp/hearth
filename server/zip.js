'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC_TABLE[index] = value >>> 0;
}

function crc32(buffer, previous = 0) {
  let crc = (previous ^ 0xffffffff) >>> 0;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const value = new Date(Math.max(0, date.getTime()));
  const year = Math.max(1980, value.getFullYear());
  const time = (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate();
  return { time, day };
}

async function collect(root, requested = '', base = root) {
  const directory = requested ? path.join(base, requested) : base;
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const result = [];
  for (const entry of entries) {
    const name = requested ? `${requested}/${entry.name}` : entry.name;
    const fullPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      result.push({ name: name + '/', directory: true, fullPath });
      result.push(...await collect(root, name, base));
    } else if (entry.isFile()) {
      const stat = await fs.promises.stat(fullPath);
      result.push({ name, fullPath, stat });
    }
  }
  return result;
}

async function* zipEntries(res, entries) {
  const central = [];
  let offset = 0;
  const write = async chunk => {
    if (!res.write(chunk)) await new Promise(resolve => res.once('drain', resolve));
  };
  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    const stat = entry.stat || await fs.promises.stat(entry.fullPath);
    const size = entry.directory ? 0 : stat.size;
    const crc = entry.directory ? 0 : await fileCrc(entry.fullPath);
    const needsZip64 = size >= 0xffffffff || offset >= 0xffffffff;
    const localExtra = needsZip64 ? zip64Extra([size, size]) : Buffer.alloc(0);
    const { time, day } = dosDateTime(stat.mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(45, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(needsZip64 ? 0xffffffff : size, 18);
    local.writeUInt32LE(needsZip64 ? 0xffffffff : size, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    await write(local);
    await write(nameBuffer);
    await write(localExtra);
    const entryOffset = offset;
    offset += local.length + nameBuffer.length + localExtra.length;
    if (!entry.directory && size) {
      const stream = fs.createReadStream(entry.fullPath, { highWaterMark: 1024 * 256 });
      for await (const chunk of stream) {
        await write(chunk);
        offset += chunk.length;
      }
    }
    const centralExtra = needsZip64 ? zip64Extra([size, size, entryOffset]) : Buffer.alloc(0);
    central.push({ nameBuffer, crc, size, entryOffset, time, day, centralExtra, needsZip64 });
  }
  const centralOffset = offset;
  let centralSize = 0;
  for (const entry of central) {
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(45, 4);
    record.writeUInt16LE(45, 6);
    record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt16LE(entry.time, 12);
    record.writeUInt16LE(entry.day, 14);
    record.writeUInt32LE(entry.crc, 16);
    record.writeUInt32LE(entry.needsZip64 ? 0xffffffff : entry.size, 20);
    record.writeUInt32LE(entry.needsZip64 ? 0xffffffff : entry.size, 24);
    record.writeUInt16LE(entry.nameBuffer.length, 28);
    record.writeUInt16LE(entry.centralExtra.length, 30);
    record.writeUInt16LE(0, 32);
    record.writeUInt16LE(0, 34);
    record.writeUInt16LE(0, 36);
    record.writeUInt32LE(0, 38);
    record.writeUInt32LE(entry.needsZip64 ? 0xffffffff : entry.entryOffset, 42);
    await write(record);
    await write(entry.nameBuffer);
    await write(entry.centralExtra);
    centralSize += record.length + entry.nameBuffer.length + entry.centralExtra.length;
  }
  const needsEocd64 = central.length >= 0xffff || centralOffset >= 0xffffffff || centralSize >= 0xffffffff;
  if (needsEocd64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeUInt32LE(0, 16);
    record.writeUInt32LE(0, 20);
    record.writeBigUInt64LE(BigInt(central.length), 24);
    record.writeBigUInt64LE(BigInt(central.length), 32);
    record.writeBigUInt64LE(BigInt(centralSize), 40);
    record.writeBigUInt64LE(BigInt(centralOffset), 48);
    await write(record);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeUInt32LE(0, 4);
    locator.writeBigUInt64LE(BigInt(centralOffset + centralSize), 8);
    locator.writeUInt32LE(1, 16);
    await write(locator);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length >= 0xffff ? 0xffff : central.length, 8);
  eocd.writeUInt16LE(central.length >= 0xffff ? 0xffff : central.length, 10);
  eocd.writeUInt32LE(centralSize >= 0xffffffff ? 0xffffffff : centralSize, 12);
  eocd.writeUInt32LE(centralOffset >= 0xffffffff ? 0xffffffff : centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  await write(eocd);
}

function zip64Extra(values) {
  const buffer = Buffer.alloc(4 + values.length * 8);
  buffer.writeUInt16LE(1, 0);
  buffer.writeUInt16LE(values.length * 8, 2);
  values.forEach((value, index) => buffer.writeBigUInt64LE(BigInt(value), 4 + index * 8));
  return buffer;
}

async function fileCrc(filePath) {
  const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 256 });
  let crc = 0;
  for await (const chunk of stream) crc = crc32(chunk, crc);
  return crc;
}

async function streamZip(res, entries) {
  res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="Hearth-download.zip"', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
  for await (const chunk of zipEntries(res, entries)) await new Promise((resolve, reject) => {
    if (res.destroyed) return reject(new Error('Client disconnected'));
    res.write(chunk, error => error ? reject(error) : resolve());
  });
  res.end();
}

module.exports = { streamZip, collect, crc32 };
