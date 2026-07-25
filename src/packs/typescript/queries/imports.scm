; TypeScript / JavaScript imports.
;
; Every form that creates a cross-file binding is captured, because the import
; table is what upgrades a call edge from INFERRED to EXACT. A missed import form
; degrades resolution silently rather than loudly, so the list is exhaustive
; rather than convenient.

; import { a, b as c } from 'mod'
(import_statement
  (import_clause
    (named_imports
      (import_specifier
        name: (identifier) @symbol
        alias: (identifier)? @alias)))
  source: (string) @source) @import

; import Default from 'mod'
(import_statement
  (import_clause (identifier) @alias)
  source: (string) @source) @import

; import * as ns from 'mod'
(import_statement
  (import_clause
    (namespace_import (identifier) @alias))
  source: (string) @source) @import

; import 'mod'  — side-effect only, but still a real dependency edge
(import_statement
  source: (string) @source) @import

; export { a } from 'mod'  /  export * from 'mod'
(export_statement
  source: (string) @source) @import

; const x = require('mod')
(variable_declarator
  name: (identifier) @alias
  value: (call_expression
    function: (identifier) @_req
    arguments: (arguments (string) @source))
  (#eq? @_req "require")) @import

; const { a, b } = require('mod')
(variable_declarator
  name: (object_pattern (shorthand_property_identifier_pattern) @symbol)
  value: (call_expression
    function: (identifier) @_req
    arguments: (arguments (string) @source))
  (#eq? @_req "require")) @import

; await import('mod')
(call_expression
  function: (import)
  arguments: (arguments (string) @source)) @import
