/**
 * HTML language pack.
 *
 * Every <div> as a symbol would be noise, so this stays narrow: landmark
 * structural tags, <script>/<style> blocks (distinct node types in the
 * grammar, not plain `element`), and any element carrying an `id` attribute
 * (the closest thing HTML has to a named, addressable symbol).
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export default {
  id: 'html',
  languages: ['html'],

  queries: {
    tags: path.join(here, 'queries', 'tags.scm'),
  },
};
