; TypeScript / TSX definitions and references.
;
; Capture vocabulary follows the upstream tree-sitter `tags.scm` convention so
; that grammars' own query files can be vendored for other languages without
; translation:
;
;   @definition.<kind>  the whole construct (its byte range becomes the node)
;   @name               the identifier naming it
;   @reference.<kind>   a use of some symbol
;   @receiver           the object part of a member call, for resolution
;
; Order matters only for readability; tree-sitter evaluates all patterns.

;; ---------------------------------------------------------------- definitions

(class_declaration
  name: (type_identifier) @name) @definition.class

(abstract_class_declaration
  name: (type_identifier) @name) @definition.class

(interface_declaration
  name: (type_identifier) @name) @definition.interface

(type_alias_declaration
  name: (type_identifier) @name) @definition.type

(enum_declaration
  name: (identifier) @name) @definition.enum

(function_declaration
  name: (identifier) @name) @definition.function

(generator_function_declaration
  name: (identifier) @name) @definition.function

(method_definition
  name: [(property_identifier) (private_property_identifier)] @name) @definition.method

(abstract_method_signature
  name: (property_identifier) @name) @definition.method

(method_signature
  name: (property_identifier) @name) @definition.method

(public_field_definition
  name: [(property_identifier) (private_property_identifier)] @name) @definition.field

(property_signature
  name: (property_identifier) @name) @definition.field

; `const handler = () => {}` and `const Klass = class {}` read as definitions of
; the function/class, not of a variable — that is what a developer means when
; they search for `handler`.
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression)])) @definition.function

(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (class))) @definition.class

; Ambient declarations. These are the entire content of a .d.ts file, which is
; how every dependency's API is read — without them, dependency documentation
; extracts nothing at all.
(function_signature
  name: (identifier) @name) @definition.function

; Module-level bindings.
;
; Two anchors are needed. The @definition capture must sit on the declaration,
; NOT on the enclosing (program ...) — a capture on `program` gives the node the
; byte range of the entire file, which makes every later definition its child.
; But anchoring on `program` alone misses `export const X`, because that nests
; the declaration inside an export_statement — and exported constants are
; precisely the ones worth indexing.
(program
  (lexical_declaration
    (variable_declarator
      name: (identifier) @name)) @definition.const)

(export_statement
  (lexical_declaration
    (variable_declarator
      name: (identifier) @name)) @definition.const)

(program
  (variable_declaration
    (variable_declarator
      name: (identifier) @name)) @definition.var)

(export_statement
  (variable_declaration
    (variable_declarator
      name: (identifier) @name)) @definition.var)

; Properties of an object literal: `const color = { dim: (s) => ... }`.
;
; The namespace-object pattern is everywhere, and without this the members are
; invisible: `color.dim()` resolves to nothing even though `color` itself was
; imported and proven. That turns a whole category of real call edges into
; unresolved noise.
(pair
  key: [(property_identifier) (string)] @name
  value: [(arrow_function) (function_expression)]) @definition.method

(pair
  key: [(property_identifier) (string)] @name
  value: [(string) (number) (true) (false) (null) (object) (array)]) @definition.field

(object
  (shorthand_property_identifier) @name) @definition.field

;; ---------------------------------------------------------------- references

; Bare call: foo()
(call_expression
  function: (identifier) @name) @reference.call

; Member call: obj.foo() — the receiver is what makes cross-file resolution
; possible, so it is captured separately rather than folded into the name.
(call_expression
  function: (member_expression
    object: (_) @receiver
    property: (property_identifier) @name)) @reference.call

; new Foo()
(new_expression
  constructor: [(identifier) (member_expression property: (property_identifier))] @name) @reference.instantiates

(extends_clause
  value: [(identifier) (member_expression property: (property_identifier))] @name) @reference.extends

(implements_clause
  (type_identifier) @name) @reference.implements

; Type positions: `let x: Foo`, `function f(): Foo`.
(type_annotation
  (type_identifier) @name) @reference.type

(generic_type
  name: (type_identifier) @name) @reference.type

; Decorators are edges too: @Injectable() tells you a great deal about a class.
(decorator
  [(identifier) @name
   (call_expression function: (identifier) @name)]) @reference.decorates
