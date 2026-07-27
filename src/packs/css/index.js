/**
 * CSS language pack.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export default {
  id: 'css',
  languages: ['css'],

  queries: {
    tags: path.join(here, 'queries', 'tags.scm'),
  },
};
