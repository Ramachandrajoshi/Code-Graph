; Java imports.
;
; A Java import names a fully-qualified type; the binding is the final segment.

(import_declaration
  (scoped_identifier) @source) @import

; `import com.acme.*;` — the asterisk FOLLOWS the name in the grammar, so it
; must follow here too; the reverse order is a pattern-structure error that
; fails the whole query to compile.
(import_declaration
  (scoped_identifier) @source
  (asterisk) @wildcard) @import
