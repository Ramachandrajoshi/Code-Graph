/**
 * Bash language pack.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export default {
  id: 'bash',
  languages: ['bash'],

  queries: {
    tags: path.join(here, 'queries', 'tags.scm'),
  },
};
