; JavaScript definitions and references.
;
; Deliberately NOT shared with the TypeScript query file. The two grammars have
; different node types — `type_identifier`, `abstract_class_declaration` and
; `public_field_definition` do not exist in the JavaScript grammar — and a query
; naming a node the grammar has never heard of fails to compile entirely rather
; than degrading. One shared file would mean neither language works.

;; ---------------------------------------------------------------- definitions

(class_declaration
  name: (identifier) @name) @definition.class

(function_declaration
  name: (identifier) @name) @definition.function

(generator_function_declaration
  name: (identifier) @name) @definition.function

(method_definition
  name: [(property_identifier) (private_property_identifier)] @name) @definition.method

(field_definition
  property: [(property_identifier) (private_property_identifier)] @name) @definition.field

; `const handler = () => {}` reads as a function definition, because that is what
; a developer means when they search for `handler`.
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression)])) @definition.function

(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (class))) @definition.class

(variable_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression)])) @definition.function

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
; The namespace-object pattern is everywhere in JavaScript, and without this the
; members are invisible: `color.dim()` resolves to nothing even though `color`
; itself was imported and proven. That turns a whole category of real call edges
; into unresolved noise.
(pair
  key: [(property_identifier) (string)] @name
  value: [(arrow_function) (function_expression)]) @definition.method

(pair
  key: [(property_identifier) (string)] @name
  value: [(string) (number) (true) (false) (null) (object) (array)]) @definition.field

; Shorthand: `const api = { create, destroy }`
(object
  (shorthand_property_identifier) @name) @definition.field

; CommonJS exports: `exports.foo = ...` / `module.exports.foo = ...`
(assignment_expression
  left: (member_expression
    object: (identifier) @_exports
    property: (property_identifier) @name)
  (#eq? @_exports "exports")) @definition.function

;; ---------------------------------------------------------------- references

(call_expression
  function: (identifier) @name) @reference.call

(call_expression
  function: (member_expression
    object: (_) @receiver
    property: (property_identifier) @name)) @reference.call

(new_expression
  constructor: [(identifier) (member_expression property: (property_identifier))] @name) @reference.instantiates

(class_heritage
  [(identifier) @name
   (member_expression property: (property_identifier) @name)]) @reference.extends

(decorator
  [(identifier) @name
   (call_expression function: (identifier) @name)]) @reference.decorates
