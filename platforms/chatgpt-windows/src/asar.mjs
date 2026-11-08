import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

// Read only the ASAR index and explicitly requested entries. Never unpack or modify it.
export async function openAsar(filename) {
  const file = await open(filename, 'r');
  try {
    const stat = await file.stat();
    const prefix = Buffer.alloc(16);
    const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
    if (bytesRead !== 16 || prefix.readUInt32LE(0) !== 4) throw new Error('Invalid ASAR prefix');
    const headerSize = prefix.readUInt32LE(4);
    const jsonSize = prefix.readUInt32LE(12);
    const dataOffset = 8 + headerSize;
    if (headerSize < 8 || jsonSize < 2 || jsonSize > 32 * 1024 * 1024 ||
        16 + jsonSize > dataOffset || dataOffset > stat.size) throw new Error('Invalid ASAR header bounds');
    const header = Buffer.alloc(jsonSize);
    if ((await file.read(header, 0, jsonSize, 16)).bytesRead !== jsonSize) throw new Error('Truncated ASAR header');
    const index = JSON.parse(header.toString('utf8'));
    if (!index.files || typeof index.files !== 'object') throw new Error('Missing ASAR file index');
    const entries = new Map();
    function walk(files, parent = '') {
      for (const [name, value] of Object.entries(files)) {
        if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) throw new Error('Invalid ASAR entry name');
        const path = parent + name;
        if (value.files) walk(value.files, `${path}/`);
        else entries.set(path, value);
      }
    }
    walk(index.files);
    return {
      filename,
      size: stat.size,
      headerSha256: createHash('sha256').update(header).digest('hex'),
      entries,
      async readText(path, limit = 16 * 1024 * 1024) {
        const entry = entries.get(path);
        if (!entry || entry.unpacked || entry.link) throw new Error(`Packed ASAR entry unavailable: ${path}`);
        const offset = Number(entry.offset);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(entry.size) ||
            entry.size < 0 || entry.size > limit || dataOffset + offset + entry.size > stat.size) {
          throw new Error(`Invalid ASAR entry bounds: ${path}`);
        }
        const buffer = Buffer.alloc(entry.size);
        if ((await file.read(buffer, 0, entry.size, dataOffset + offset)).bytesRead !== entry.size) {
          throw new Error(`Truncated ASAR entry: ${path}`);
        }
        return buffer.toString('utf8');
      },
      close: () => file.close(),
    };
  } catch (error) {
    await file.close();
    throw error;
  }
}
