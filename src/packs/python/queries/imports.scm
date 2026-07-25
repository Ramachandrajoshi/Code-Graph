; Python imports.
;
; `from . import x` and `from ..pkg import y` are captured with their dots
; intact: relative depth is the only thing that makes the target resolvable, so
; losing it would silently downgrade every intra-package edge to a guess.

; import os
; import os.path as p
(import_statement
  name: [(dotted_name) @source
         (aliased_import
           name: (dotted_name) @source
           alias: (identifier) @alias)]) @import

; from x.y import a, b as c
(import_from_statement
  module_name: [(dotted_name) @source (relative_import) @source]
  name: [(dotted_name) @symbol
         (aliased_import
           name: (dotted_name) @symbol
           alias: (identifier) @alias)]) @import

; from x import *
(import_from_statement
  module_name: [(dotted_name) @source (relative_import) @source]
  (wildcard_import)) @import
