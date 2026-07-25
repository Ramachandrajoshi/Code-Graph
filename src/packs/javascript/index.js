/**
 * JavaScript language pack.
 *
 * Extraction hooks are identical to TypeScript — JSDoc, export detection and
 * import parsing behave the same way — so they are reused rather than copied.
 * Only the tags query differs, because the two grammars expose different node
 * types (see the note in queries/tags.scm).
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import typescript from '../typescript/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tsDir = path.join(here, '..', 'typescript');

export default {
  ...typescript,

  id: 'javascript',
  languages: ['javascript'],

  queries: {
    tags: path.join(here, 'queries', 'tags.scm'),
    // The import forms are identical in both grammars, so this file is shared.
    imports: path.join(tsDir, 'queries', 'imports.scm'),
  },

  detect(ctx) {
    return ctx.hasFile('package.json');
  },

  /** JavaScript has no access modifiers; `#private` fields are the only signal. */
  visibility(def, source) {
    const text = source.slice(def.startByte, def.startByte + 80);
    return /^\s*#/.test(text) ? 'private' : null;
  },
};
