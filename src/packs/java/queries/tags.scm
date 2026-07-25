; Java definitions and references.

;; ---------------------------------------------------------------- definitions

(class_declaration
  name: (identifier) @name) @definition.class

(interface_declaration
  name: (identifier) @name) @definition.interface

(enum_declaration
  name: (identifier) @name) @definition.enum

(record_declaration
  name: (identifier) @name) @definition.class

(annotation_type_declaration
  name: (identifier) @name) @definition.interface

(method_declaration
  name: (identifier) @name) @definition.method

(constructor_declaration
  name: (identifier) @name) @definition.method

(field_declaration
  declarator: (variable_declarator
    name: (identifier) @name)) @definition.field

;; ---------------------------------------------------------------- references

(method_invocation
  name: (identifier) @name
  !object) @reference.call

(method_invocation
  object: (_) @receiver
  name: (identifier) @name) @reference.call

(object_creation_expression
  type: [(type_identifier) @name
         (generic_type (type_identifier) @name)]) @reference.instantiates

(superclass
  (type_identifier) @name) @reference.extends

(super_interfaces
  (type_list (type_identifier) @name)) @reference.implements

; Annotations carry a lot of architectural signal in Java —
; @Service, @Entity, @RestController all say what a class IS.
(annotation
  name: (identifier) @name) @reference.decorates

(marker_annotation
  name: (identifier) @name) @reference.decorates

(type_identifier) @name @reference.type
