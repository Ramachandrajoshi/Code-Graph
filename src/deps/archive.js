/**
 * Archive readers for tar.gz and zip.
 *
 * Every package registry publishes the same artifact cgraph already parses off
 * disk — npm a `.tgz`, NuGet a `.nupkg`, Maven a `-sources.jar`, PyPI a wheel —
 * and the last three are all zip. Being able to read those two formats turns
 * "documentation we happen to have locally" into "documentation for any version
 * of any dependency", using the parsers that already exist.
 *
 * Written against `node:zlib` rather than pulling in tar/unzip packages. The
 * formats are small and stable, and a tool whose selling point is a 6 MB
 * dependency-free install should not grow a dependency tree to read a zip.
 *
 * Both readers are selective by design: they take a filter and only decompress
 * entries that match. A 20 MB framework archive containing one XML file should
 * cost one inflate, not a thousand.
 */

import zlib from 'node:zlib';

/** Guard against a malicious or corrupt archive claiming an absurd size. */
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------- tar.gz

/**
 * Read entries from a gzipped tar.
 *
 * @param {Buffer} buf
 * @param {(name: string, size: number) => boolean} wanted
 * @returns {Map<string, Buffer>}
 */
export function readTarGz(buf, wanted) {
  let tar;
  try {
    tar = zlib.gunzipSync(buf, { maxOutputLength: 256 * 1024 * 1024 });
  } catch (err) {
    throw new Error(`not a valid gzip archive: ${err.message}`);
  }
  return readTar(tar, wanted);
}

/**
 * Read a plain tar.
 *
 * The format is a sequence of 512-byte headers, each followed by its file
 * content padded to a 512-byte boundary. Two zero blocks end the archive.
 */
export function readTar(tar, wanted) {
  const out = new Map();
  let offset = 0;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);

    // Two consecutive zero blocks terminate the archive; one is enough to stop.
    if (header[0] === 0) break;

    const name = cstr(header.subarray(0, 100));
    // subarray takes (start, END) — not (start, length). Passing the field
    // width as the second argument yields an empty buffer, every size parses as
    // zero, and the reader returns correctly-named entries with no content.
    const size = parseOctal(header.subarray(124, 124 + 12));
    const typeFlag = String.fromCharCode(header[156]);
    // `prefix` extends long paths in the ustar format.
    const prefix = cstr(header.subarray(345, 345 + 155));
    const fullName = prefix ? `${prefix}/${name}` : name;

    offset += 512;

    if (!Number.isFinite(size) || size < 0) break;
    const dataEnd = offset + size;
    if (dataEnd > tar.length) break;

    // '0' and '\0' are regular files; everything else (dirs, links, PAX
    // metadata) carries no content we want.
    const isFile = typeFlag === '0' || typeFlag === '\0' || typeFlag === '';
    if (isFile && size <= MAX_ENTRY_BYTES && wanted(fullName, size)) {
      out.set(fullName, tar.subarray(offset, dataEnd));
    }

    // Content is padded up to the next 512-byte boundary.
    offset = dataEnd + ((512 - (size % 512)) % 512);
  }

  return out;
}

function cstr(buf) {
  const end = buf.indexOf(0);
  return buf.toString('utf8', 0, end === -1 ? buf.length : end).trim();
}

function parseOctal(buf) {
  const text = cstr(buf).replace(/[^0-7]/g, '');
  return text ? parseInt(text, 8) : 0;
}

// ---------------------------------------------------------------- zip

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;

/**
 * Read entries from a zip archive (.zip, .nupkg, .jar, .whl).
 *
 * Reads the central directory rather than scanning local headers. The central
 * directory is authoritative — local headers may carry zeroed sizes with the
 * real values in a trailing data descriptor, which is exactly the case that
 * makes naive scanners silently truncate files.
 *
 * @param {Buffer} buf
 * @param {(name: string, size: number) => boolean} wanted
 * @returns {Map<string, Buffer>}
 */
export function readZip(buf, wanted) {
  const eocd = findEocd(buf);
  if (eocd === -1) throw new Error('not a valid zip archive: no end-of-central-directory record');

  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  const out = new Map();

  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CD_SIG) break;

    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);

    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    offset += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;                       // directory entry
    if (uncompressedSize > MAX_ENTRY_BYTES) continue;
    if (!wanted(name, uncompressedSize)) continue;          // decompress only what is asked for

    const data = readLocalEntry(buf, localOffset, method, compressedSize, uncompressedSize);
    if (data) out.set(name, data);
  }

  return out;
}

function readLocalEntry(buf, localOffset, method, compressedSize, uncompressedSize) {
  if (localOffset + 30 > buf.length) return null;

  // The local header repeats the name and extra-field lengths, and they may
  // differ from the central directory's — the data starts after the local ones.
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLen + extraLen;
  const end = start + compressedSize;
  if (end > buf.length) return null;

  const raw = buf.subarray(start, end);

  try {
    if (method === 0) return raw;                            // stored
    if (method === 8) {
      return zlib.inflateRawSync(raw, { maxOutputLength: Math.max(uncompressedSize, 1024) * 2 });
    }
  } catch {
    // A single unreadable entry (unsupported method, corrupt data) should not
    // discard the rest of the archive.
    return null;
  }
  return null;                                               // bzip2, lzma, etc.
}

/**
 * Locate the end-of-central-directory record.
 *
 * It sits at the end of the file, but a trailing comment of up to 64 KB may
 * follow it, so the tail has to be scanned backwards.
 */
function findEocd(buf) {
  const minOffset = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/** Read whichever archive format the bytes actually are. */
export function readArchive(buf, wanted) {
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) return readTarGz(buf, wanted);
  if (buf.length > 2 && buf[0] === 0x50 && buf[1] === 0x4b) return readZip(buf, wanted);
  throw new Error('unrecognised archive format (expected gzip or zip)');
}
