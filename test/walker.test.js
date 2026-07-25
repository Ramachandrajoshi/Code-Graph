/**
 * Walker tests.
 *
 * The bar is git parity. Each test below encodes a `.gitignore` rule that is
 * easy to implement almost-correctly, which is exactly why they are pinned:
 * a walker that is 98% right silently omits real source files from the graph.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walk } from '../src/core/walker.js';
import { withRepo, testConfig } from './helpers.js';

const paths = (root, config) => [...walk(root, config ?? testConfig(root))].map((f) => f.rel);
const kept = (root, config) =>
  [...walk(root, config ?? testConfig(root))].filter((f) => !f.skipReason).map((f) => f.rel);

test('walks a plain tree with POSIX separators', () => {
  withRepo({ 'a.js': '1', 'src/b.js': '2', 'src/deep/c.js': '3' }, (root) => {
    assert.deepEqual(paths(root).sort(), ['a.js', 'src/b.js', 'src/deep/c.js']);
  });
});

test('applies root .gitignore', () => {
  withRepo({
    '.gitignore': 'ignored.js\n',
    'ignored.js': '1',
    'kept.js': '2',
  }, (root) => {
    const p = paths(root);
    assert.ok(!p.includes('ignored.js'));
    assert.ok(p.includes('kept.js'));
  });
});

test('nested .gitignore applies only below its own directory', () => {
  withRepo({
    'sub/.gitignore': 'secret.js\n',
    'sub/secret.js': '1',
    'secret.js': '2',          // same name at root; the nested rule must not reach it
    'sub/keep.js': '3',
  }, (root) => {
    const p = paths(root);
    assert.ok(!p.includes('sub/secret.js'), 'nested rule should ignore sub/secret.js');
    assert.ok(p.includes('secret.js'), 'nested rule must not apply to the root');
    assert.ok(p.includes('sub/keep.js'));
  });
});

test('negation in a deeper .gitignore rescues a parent-ignored file', () => {
  withRepo({
    '.gitignore': '*.log\n',
    'sub/.gitignore': '!important.log\n',
    'sub/important.log': '1',
    'sub/other.log': '2',
    'top.log': '3',
  }, (root) => {
    const p = paths(root);
    assert.ok(p.includes('sub/important.log'), 'deeper negation should re-include');
    assert.ok(!p.includes('sub/other.log'));
    assert.ok(!p.includes('top.log'));
  });
});

test('directory-only pattern does not match a file of the same name', () => {
  // A file and a directory cannot share a name in the same folder, so the file
  // named `build` lives one level down. The rule under test is unanchored, so it
  // reaches both locations and must still distinguish file from directory.
  withRepo({
    '.gitignore': 'build/\n',
    'build/out.js': '1',
    'sub/build': 'this is a file named build',
  }, (root) => {
    const p = paths(root);
    assert.ok(!p.includes('build/out.js'), 'build/ should ignore the directory');
    assert.ok(p.includes('sub/build'), 'build/ must not ignore a file named build');
  });
});

test('anchored pattern matches only at the declaring level', () => {
  withRepo({
    '.gitignore': '/build*\n',
    'build-tool.sh': '1',
    'src/build-tool.sh': '2',
  }, (root) => {
    const p = paths(root);
    assert.ok(!p.includes('build-tool.sh'), '/build* is anchored to the root');
    assert.ok(p.includes('src/build-tool.sh'), '/build* must not match deeper paths');
  });
});

test('unanchored pattern matches at any depth', () => {
  withRepo({
    '.gitignore': 'node_modules\n',
    'node_modules/x.js': '1',
    'packages/app/node_modules/y.js': '2',
    'src/app.js': '3',
  }, (root) => {
    // `.gitignore` itself is a tracked file and must survive the walk.
    assert.deepEqual(paths(root).sort(), ['.gitignore', 'src/app.js']);
  });
});

test('.cgraphignore is honored alongside .gitignore', () => {
  withRepo({
    '.gitignore': 'a.js\n',
    '.cgraphignore': 'b.js\n',
    'a.js': '1', 'b.js': '2', 'c.js': '3',
  }, (root) => {
    assert.deepEqual(paths(root).filter((p) => p.endsWith('.js')), ['c.js']);
  });
});

test('.git directory is never walked', () => {
  withRepo({ '.git/config': 'x', '.git/objects/ab/cd': 'y', 'a.js': '1' }, (root) => {
    assert.deepEqual(paths(root), ['a.js']);
  });
});

test('binary files are yielded as stubs, not dropped', () => {
  withRepo({ 'logo.png': 'PNG\x00\x01\x02binary', 'a.js': '1' }, (root) => {
    const files = [...walk(root, testConfig(root))];
    const png = files.find((f) => f.rel === 'logo.png');
    assert.equal(png.skipReason, 'binary', 'binary content should be detected');
    assert.equal(png.content, undefined, 'binary content is not retained');
    assert.ok(files.some((f) => f.rel === 'a.js' && !f.skipReason));
  });
});

test('minified files are detected by mean line length', () => {
  withRepo({
    'bundle.js': 'var a=1;'.repeat(400),          // one very long line
    'normal.js': 'const a = 1;\n'.repeat(200),
  }, (root) => {
    const files = [...walk(root, testConfig(root))];
    assert.equal(files.find((f) => f.rel === 'bundle.js').skipReason, 'minified');
    assert.equal(files.find((f) => f.rel === 'normal.js').skipReason, null);
  });
});

test('generated-file markers are detected', () => {
  withRepo({
    'api.js': '// Code generated by protoc. DO NOT EDIT.\nexport const x = 1;\n',
    'hand.js': 'export const y = 2;\n',
  }, (root) => {
    const files = [...walk(root, testConfig(root))];
    assert.equal(files.find((f) => f.rel === 'api.js').skipReason, 'generated');
    assert.equal(files.find((f) => f.rel === 'hand.js').skipReason, null);
  });
});

test('oversized files become stubs without being read', () => {
  withRepo({ 'huge.js': 'x'.repeat(5000), 'small.js': '1' }, (root) => {
    const config = testConfig(root, { maxFileBytes: 1000 });
    const files = [...walk(root, config)];
    const huge = files.find((f) => f.rel === 'huge.js');
    assert.equal(huge.skipReason, 'too-large');
    assert.equal(huge.content, undefined);
    assert.ok(kept(root, config).includes('small.js'));
  });
});

test('content hash changes when bytes change and is stable when they do not', () => {
  withRepo({ 'a.js': 'const x = 1;' }, (root) => {
    const first = [...walk(root, testConfig(root))][0].hash;
    const again = [...walk(root, testConfig(root))][0].hash;
    assert.equal(first, again, 'hash must be stable for identical content');
  });

  withRepo({ 'a.js': 'const x = 2;' }, (root) => {
    const other = [...walk(root, testConfig(root))][0].hash;
    withRepo({ 'a.js': 'const x = 1;' }, (root2) => {
      const base = [...walk(root2, testConfig(root2))][0].hash;
      assert.notEqual(base, other, 'hash must change when content changes');
    });
  });
});

test('comments and blank lines in .gitignore are not treated as patterns', () => {
  withRepo({
    '.gitignore': '# a comment\n\n   \nreal.js\n',
    'real.js': '1',
    '# a comment': '2',
    'keep.js': '3',
  }, (root) => {
    const p = paths(root);
    assert.ok(!p.includes('real.js'));
    assert.ok(p.includes('keep.js'));
  });
});

test('readContent:false skips reading file bodies', () => {
  withRepo({ 'a.js': 'const x = 1;' }, (root) => {
    const files = [...walk(root, testConfig(root), { readContent: false })];
    assert.equal(files[0].content, undefined);
    assert.ok(files[0].hash.startsWith('stat:'), 'stat-only mode uses a cheap hash');
  });
});
