; Rust definitions and references.

;; ---------------------------------------------------------------- definitions

(function_item
  name: (identifier) @name) @definition.function

(struct_item
  name: (type_identifier) @name) @definition.class

(enum_item
  name: (type_identifier) @name) @definition.enum

(trait_item
  name: (type_identifier) @name) @definition.interface

(type_item
  name: (type_identifier) @name) @definition.type

(mod_item
  name: (identifier) @name) @definition.module

(const_item
  name: (identifier) @name) @definition.const

(static_item
  name: (identifier) @name) @definition.var

(field_declaration
  name: (field_identifier) @name) @definition.field

; An impl block is not itself a symbol, but it is the parent of the methods
; inside it — capturing it gives those methods the right owner in the hierarchy.
(impl_item
  type: (type_identifier) @name) @definition.class

(macro_definition
  name: (identifier) @name) @definition.function

;; ---------------------------------------------------------------- references

(call_expression
  function: (identifier) @name) @reference.call

(call_expression
  function: (field_expression
    value: (_) @receiver
    field: (field_identifier) @name)) @reference.call

; Associated function / path call: `Server::new(...)`, `mem::swap(...)`
(call_expression
  function: (scoped_identifier
    path: (_) @receiver
    name: (identifier) @name)) @reference.call

(macro_invocation
  macro: (identifier) @name) @reference.call

(struct_expression
  name: [(type_identifier) @name
         (scoped_type_identifier name: (type_identifier) @name)]) @reference.instantiates

; `impl Trait for Type` is Rust's inheritance-shaped relationship.
(impl_item
  trait: [(type_identifier) @name
          (generic_type type: (type_identifier) @name)]) @reference.implements

(trait_bounds
  (type_identifier) @name) @reference.implements

(type_identifier) @name @reference.type
