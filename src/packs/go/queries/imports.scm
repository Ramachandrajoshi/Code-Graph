; Go imports.
;
; Go has no named exports at import time — a package is imported whole and its
; symbols are reached through the package name. So the alias (explicit, or the
; last path segment) is what matters for resolution.

(import_spec
  name: (package_identifier)? @alias
  path: (interpreted_string_literal) @source) @import
