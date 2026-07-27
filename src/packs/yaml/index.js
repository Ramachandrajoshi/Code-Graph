/**
 * YAML language pack.
 *
 * Same idea as JSON: keys are the only meaningful symbol, and nesting falls
 * out of the generic byte-range containment in extract.js.
 *
 * NOT currently registered in `BUILTIN` (src/packs/registry.js). The bundled
 * tree-sitter-yaml.wasm (tree-sitter-wasms@0.1.13) fails to parse any YAML
 * source at all under the pinned web-tree-sitter@0.25.10 — a WASM dynamic-
 * linking symbol resolution error in the grammar's external scanner, thrown
 * on every parse() call regardless of query content. Verified against the
 * exact bundled file (its sha256 matches grammar-manifest.json, so it is not
 * a corrupted install). The query below has NOT been runtime-verified against
 * the real grammar as a result — parsing fails before a query ever runs — so
 * treat it as a draft. Re-check it once the grammar/runtime versions are
 * compatible again, then add 'yaml' back to BUILTIN.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export default {
  id: 'yaml',
  languages: ['yaml'],

  queries: {
    tags: path.join(here, 'queries', 'tags.scm'),
  },
};
