/**
 * JSON language pack.
 *
 * JSON has no functions or classes — the useful "symbols" are its keys, so
 * every object key becomes a `key` definition. Nesting falls out of the
 * generic byte-range containment in extract.js: a key inside `scripts` is a
 * child of the `scripts` key node, giving qnames like
 * `package.json::scripts.build`.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export default {
  id: 'json',
  languages: ['json'],

  queries: {
    tags: path.join(here, 'queries', 'tags.scm'),
  },
};
