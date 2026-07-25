; Go definitions and references.

;; ---------------------------------------------------------------- definitions

(function_declaration
  name: (identifier) @name) @definition.function

; Methods carry their receiver type, which is what distinguishes
; (*Server).Start from (*Client).Start — without it both collapse to 'Start'.
(method_declaration
  receiver: (parameter_list
    (parameter_declaration
      type: [(type_identifier) @receiver
             (pointer_type (type_identifier) @receiver)]))
  name: (field_identifier) @name) @definition.method

(type_declaration
  (type_spec
    name: (type_identifier) @name
    type: (struct_type))) @definition.class

(type_declaration
  (type_spec
    name: (type_identifier) @name
    type: (interface_type))) @definition.interface

(type_declaration
  (type_spec
    name: (type_identifier) @name)) @definition.type

(const_declaration
  (const_spec
    name: (identifier) @name)) @definition.const

(var_declaration
  (var_spec
    name: (identifier) @name)) @definition.var

(field_declaration
  name: (field_identifier) @name) @definition.field

;; ---------------------------------------------------------------- references

(call_expression
  function: (identifier) @name) @reference.call

(call_expression
  function: (selector_expression
    operand: (_) @receiver
    field: (field_identifier) @name)) @reference.call

; Struct literals: `Server{...}` and `pkg.Server{...}`
(composite_literal
  type: [(type_identifier) @name
         (qualified_type name: (type_identifier) @name)]) @reference.instantiates

; Embedded types in a struct are Go's composition mechanism — the closest
; equivalent to inheritance, and worth an edge.
(field_declaration
  type: [(type_identifier) @name
         (qualified_type name: (type_identifier) @name)]) @reference.type

(parameter_declaration
  type: [(type_identifier) @name
         (pointer_type (type_identifier) @name)
         (qualified_type name: (type_identifier) @name)]) @reference.type
