/**
 * Archive reader tests.
 *
 * Archives are built in-process rather than downloaded, so the suite stays
 * offline and deterministic. Network fetching is exercised separately and
 * skipped when unreachable.
 *
 * The tar tests are pointed: the first implementation read the size field with
 * `subarray(124, 12)` — passing the field *width* where an end index belongs —
 * which yields an empty buffer, parses every size as zero, and returns
 * correctly-named entries with no content. It looked like it worked.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { readTar, readTarGz, readZip, readArchive } from '../src/deps/archive.js';

// ---------------------------------------------------------------- builders

/** Build a tar with one 512-byte header per file, content padded to 512. */
function makeTar(files) {
  const blocks = [];

  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const header = Buffer.alloc(512);

    header.write(name, 0, 100, 'utf8');
    header.write('000644 \0', 100, 8, 'utf8');                       // mode
    header.write('000000 \0', 108, 8, 'utf8');                       // uid
    header.write('000000 \0', 116, 8, 'utf8');                       // gid
    header.write(data.length.toString(8).padStart(11, '0') + ' ', 124, 12, 'utf8');
    header.write('00000000000 ', 136, 12, 'utf8');                   // mtime
    header.write('        ', 148, 8, 'utf8');                        // checksum placeholder
    header.write('0', 156, 1, 'utf8');                               // regular file
    header.write('ustar\0', 257, 6, 'utf8');

    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');

    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }

  blocks.push(Buffer.alloc(1024));   // two zero blocks terminate the archive
  return Buffer.concat(blocks);
}

/** Build a zip with a real central directory, deflating each entry. */
function makeZip(files, { store = false } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, 'utf8');
    const data = store ? raw : zlib.deflateRawSync(raw);
    const method = store ? 0 : 8;
    const nameBuf = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14);                 // crc, unchecked by the reader
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(0, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += 30 + nameBuf.length + data.length;
  }

  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(central);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);

  return Buffer.concat([localPart, centralPart, eocd]);
}

const all = () => true;

// ---------------------------------------------------------------- tar

test('reads tar entries with their full content', () => {
  const body = 'export declare function go(): void;\n';
  const tar = makeTar({ 'package/index.d.ts': body, 'package/README.md': '# hi' });

  const entries = readTar(tar, all);
  assert.equal(entries.size, 2);
  assert.equal(entries.get('package/index.d.ts').toString('utf8'), body,
    'content must survive — a zero-length read here is the classic size-field bug');
});

test('tar sizes are parsed from the octal field, not assumed', () => {
  // Content longer than one block: a broken size parse stops after 512 bytes or
  // returns nothing at all.
  const body = 'x'.repeat(3000);
  const entries = readTar(makeTar({ 'a.txt': body }), all);
  assert.equal(entries.get('a.txt').length, 3000);
});

test('tar content is not confused by block padding', () => {
  // A file whose length is not a multiple of 512 must not absorb its padding.
  const entries = readTar(makeTar({ 'a.txt': 'abc', 'b.txt': 'defg' }), all);
  assert.equal(entries.get('a.txt').toString(), 'abc');
  assert.equal(entries.get('b.txt').toString(), 'defg');
});

test('the tar filter avoids reading unwanted entries', () => {
  const entries = readTar(
    makeTar({ 'keep.d.ts': 'A', 'skip.js': 'B' }),
    (name) => name.endsWith('.d.ts')
  );
  assert.deepEqual([...entries.keys()], ['keep.d.ts']);
});

test('reads a gzipped tar', () => {
  const gz = zlib.gzipSync(makeTar({ 'package/index.d.ts': 'declare const x: number;' }));
  const entries = readTarGz(gz, all);
  assert.match(entries.get('package/index.d.ts').toString(), /declare const x/);
});

test('a truncated tar stops cleanly instead of looping', () => {
  const tar = makeTar({ 'a.txt': 'hello world' });
  assert.doesNotThrow(() => readTar(tar.subarray(0, 700), all));
});

// ---------------------------------------------------------------- zip

test('reads deflated zip entries', () => {
  const body = '<?xml version="1.0"?><doc><assembly><name>X</name></assembly></doc>';
  const entries = readZip(makeZip({ 'lib/net8.0/X.xml': body }), all);
  assert.equal(entries.get('lib/net8.0/X.xml').toString('utf8'), body);
});

test('reads stored (uncompressed) zip entries', () => {
  const entries = readZip(makeZip({ 'a.txt': 'plain' }, { store: true }), all);
  assert.equal(entries.get('a.txt').toString(), 'plain');
});

test('the zip filter avoids decompressing unwanted entries', () => {
  // A 20 MB package holding one XML file should cost one inflate.
  const zip = makeZip({ 'lib/x.xml': 'A', 'lib/x.dll': 'B'.repeat(5000) });
  const entries = readZip(zip, (n) => n.endsWith('.xml'));
  assert.deepEqual([...entries.keys()], ['lib/x.xml']);
});

test('zip reading uses the central directory, not local headers', () => {
  // Local headers may carry zeroed sizes with the real values in a trailing
  // data descriptor; a reader trusting them silently truncates.
  const zip = makeZip({ 'a.txt': 'x'.repeat(2000), 'b.txt': 'y'.repeat(2000) });
  const entries = readZip(zip, all);
  assert.equal(entries.get('a.txt').length, 2000);
  assert.equal(entries.get('b.txt').length, 2000);
});

test('zip directory entries are skipped', () => {
  const entries = readZip(makeZip({ 'dir/': '', 'dir/a.txt': 'x' }), all);
  assert.deepEqual([...entries.keys()], ['dir/a.txt']);
});

test('a non-archive is rejected with a clear message', () => {
  assert.throws(() => readZip(Buffer.from('not a zip at all'), all), /not a valid zip/);
  assert.throws(() => readArchive(Buffer.from('plain text'), all), /unrecognised archive format/);
});

test('readArchive dispatches on the magic bytes', () => {
  const gz = zlib.gzipSync(makeTar({ 'a.txt': 'from tar' }));
  const zip = makeZip({ 'a.txt': 'from zip' });
  assert.equal(readArchive(gz, all).get('a.txt').toString(), 'from tar');
  assert.equal(readArchive(zip, all).get('a.txt').toString(), 'from zip');
});

// ---------------------------------------------------------------- network

/**
 * Live registry checks. Skipped when the network is unavailable so a laptop on
 * a train does not see failures — but run when it is, because the formats these
 * registries actually serve are the point.
 */
const canReach = async (url) => fetch(url, {
  signal: AbortSignal.timeout(5000),
}).then((r) => r.ok).catch(() => false);

const npmOnline = await canReach('https://registry.npmjs.org/ignore');
const nugetOnline = await canReach('https://api.nuget.org/v3-flatcontainer/serilog/index.json');
const mavenSearchOnline = await canReach('https://search.maven.org/solrsearch/select?q=g:com.google.guava&rows=1&wt=json');
const mavenRepoOnline = await canReach('https://repo1.maven.org/maven2/com/google/guava/guava/33.5.0-jre/guava-33.5.0-jre-sources.jar');
const mavenOnline = mavenSearchOnline && mavenRepoOnline;
const webOnline = await canReach('https://svelte.dev/llms.txt');

const npmNet = { skip: npmOnline ? false : 'npm registry unavailable' };
const nugetNet = { skip: nugetOnline ? false : 'NuGet registry unavailable' };
const mavenNet = { skip: mavenOnline ? false : 'Maven Central unavailable' };
const webNet = { skip: webOnline ? false : 'docs site unavailable' };

test('fetches and parses a real npm package', npmNet, async () => {
  const { fetchPackageArtifact } = await import('../src/deps/registry.js');
  const a = await fetchPackageArtifact({ ecosystem: 'npm', package: 'ignore' });
  assert.ok(a, 'ignore ships its own .d.ts');
  assert.ok(a.files.size > 0);
  assert.match([...a.files.values()][0], /interface|declare|export/);
});

test('falls back to DefinitelyTyped for a package with no bundled types', npmNet, async () => {
  // A large share of npm ships no types of its own; without this, express and
  // lodash would return nothing.
  const { fetchPackageArtifact } = await import('../src/deps/registry.js');
  const a = await fetchPackageArtifact({ ecosystem: 'npm', package: 'express' });
  assert.ok(a?.files.size, 'types should come from @types/express');
  assert.equal(a.typesFrom, '@types/express');
});

test('fetches a real NuGet package XML doc', nugetNet, async () => {
  const { fetchPackageArtifact } = await import('../src/deps/registry.js');
  const a = await fetchPackageArtifact({ ecosystem: 'nuget', package: 'Serilog' });
  assert.ok(a?.files.size);
  assert.match([...a.files.values()][0], /<assembly>/);
});

test('picks the primary Maven artifact, not a variant', mavenNet, async (t) => {
  // Searching a group returns every artifact in it: guava-gwt comes back before
  // guava, and documenting the wrong one is worse than documenting none.
  const { fetchPackageArtifact } = await import('../src/deps/registry.js');
  const a = await fetchPackageArtifact({ ecosystem: 'maven', package: 'com.google.guava' });
  if (!a) t.skip('Maven Central was reachable, but guava sources could not be fetched in time');
  assert.equal(a.coordinates, 'com.google.guava:guava');
});

test('llms.txt is fetched where published and refused where not', webNet, async () => {
  const { fetchLlmsTxt } = await import('../src/deps/registry.js');

  const hit = await fetchLlmsTxt('https://svelte.dev');
  assert.ok(hit?.text.length > 100, 'svelte publishes llms-full.txt');

  // A site without llms.txt commonly serves its index.html for any unknown
  // path, so HTML must be rejected rather than stored as documentation.
  assert.equal(await fetchLlmsTxt('https://example.com'), null);
  assert.equal(await fetchLlmsTxt('https://github.com/some/repo'), null,
    'a repository is not a docs site');
  assert.equal(await fetchLlmsTxt(null), null);
});

test('an unreachable registry returns null rather than throwing', async () => {
  const { fetchPackageArtifact } = await import('../src/deps/registry.js');
  const a = await fetchPackageArtifact({ ecosystem: 'npm', package: 'this-package-does-not-exist-xyzzy-9f3' });
  assert.equal(a, null, 'documentation is an enhancement; its absence must never fail anything');
});
