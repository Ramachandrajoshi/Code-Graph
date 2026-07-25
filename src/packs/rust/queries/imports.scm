; Rust use declarations.
;
; `use a::b::{c, d}` binds several names from one statement, and each binding
; needs its own row or resolution of the second name fails.

(use_declaration
  argument: (scoped_identifier
    path: (_) @source
    name: (identifier) @symbol)) @import

(use_declaration
  argument: (use_as_clause
    path: (scoped_identifier
      path: (_) @source
      name: (identifier) @symbol)
    alias: (identifier) @alias)) @import

(use_declaration
  argument: (scoped_use_list
    path: (_) @source
    list: (use_list (identifier) @symbol))) @import

(use_declaration
  argument: (use_wildcard
    (scoped_identifier) @source)) @import

(use_declaration
  argument: (identifier) @source) @import

; `mod foo;` pulls in foo.rs or foo/mod.rs — a real file dependency.
(mod_item
  name: (identifier) @source
  !body) @import
