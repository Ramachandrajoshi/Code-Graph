; C# definitions and references.
;
; Node names verified against tree-sitter-c_sharp by parsing a representative
; file and dumping its types — the grammar uses `declaration_list` rather than
; `body`, and `base_list` for both inheritance and interface implementation,
; neither of which is guessable from the other packs.

;; ---------------------------------------------------------------- definitions

(class_declaration
  name: (identifier) @name) @definition.class

(struct_declaration
  name: (identifier) @name) @definition.class

(record_declaration
  name: (identifier) @name) @definition.class

(interface_declaration
  name: (identifier) @name) @definition.interface

(enum_declaration
  name: (identifier) @name) @definition.enum

(method_declaration
  name: (identifier) @name) @definition.method

(constructor_declaration
  name: (identifier) @name) @definition.method

; Properties are the idiomatic C# public surface — far more common than fields,
; and what a caller actually binds to.
(property_declaration
  name: (identifier) @name) @definition.field

; A variable_declarator holds a bare identifier — it has no `name:` field, unlike
; every other declaration in this grammar.
(field_declaration
  (variable_declaration
    (variable_declarator
      (identifier) @name))) @definition.field

(enum_member_declaration
  name: (identifier) @name) @definition.const

; A namespace is a real container in C# and belongs in the hierarchy: without
; it, every type in a file appears at module level and the qualified names lose
; the part that disambiguates them.
(namespace_declaration
  name: [(identifier) (qualified_name)] @name) @definition.module

;; ---------------------------------------------------------------- references

; Foo()
(invocation_expression
  function: (identifier) @name) @reference.call

; obj.Foo() / Type.Foo()
(invocation_expression
  function: (member_access_expression
    expression: (_) @receiver
    name: (identifier) @name)) @reference.call

; Generic call: Foo<T>()
(invocation_expression
  function: (generic_name
    (identifier) @name)) @reference.call

(object_creation_expression
  type: [(identifier) @name
         (qualified_name (identifier) @name)
         (generic_name (identifier) @name)]) @reference.instantiates

; `: Base, IThing` — C# does not distinguish a base class from an interface
; syntactically, so both arrive here and resolution sorts them out by what the
; target turns out to be.
(base_list
  [(identifier) @name
   (qualified_name (identifier) @name)
   (generic_name (identifier) @name)]) @reference.extends

; Attributes carry a lot of architectural signal in .NET — [HttpPost],
; [Serializable], [Inject] all say what a member IS.
(attribute
  name: [(identifier) @name
         (qualified_name (identifier) @name)]) @reference.decorates

(parameter
  type: [(identifier) @name
         (qualified_name (identifier) @name)
         (generic_name (identifier) @name)]) @reference.type
