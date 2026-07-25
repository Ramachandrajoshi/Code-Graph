; Python definitions and references.
;
; Extends the upstream tree-sitter-python tags.scm, which only covers classes,
; functions, module constants and calls. Decorators and typed attributes carry
; too much architectural signal in real Python codebases to leave out.

;; ---------------------------------------------------------------- definitions

(class_definition
  name: (identifier) @name) @definition.class

(function_definition
  name: (identifier) @name) @definition.function

(decorated_definition
  definition: (function_definition
    name: (identifier) @name)) @definition.function

(decorated_definition
  definition: (class_definition
    name: (identifier) @name)) @definition.class

; Module-level bindings.
;
; The @definition capture must sit on the statement, NOT on the enclosing
; (module ...) — a capture on `module` gives the node the byte range of the
; entire file, which makes every later definition a child of this constant.
(module
  (expression_statement
    (assignment
      left: (identifier) @name)) @definition.const)

(module
  (expression_statement
    (assignment
      left: (pattern_list (identifier) @name))) @definition.const)

; Annotated class attributes: `count: int = 0` inside a class body.
(class_definition
  body: (block
    (expression_statement
      (assignment
        left: (identifier) @name
        type: (type))) @definition.field))

;; ---------------------------------------------------------------- references

(call
  function: (identifier) @name) @reference.call

(call
  function: (attribute
    object: (_) @receiver
    attribute: (identifier) @name)) @reference.call

; Base classes: `class Admin(User):`
(class_definition
  superclasses: (argument_list
    [(identifier) @name
     (attribute attribute: (identifier) @name)])) @reference.extends

(decorator
  [(identifier) @name
   (attribute attribute: (identifier) @name)
   (call function: (identifier) @name)
   (call function: (attribute attribute: (identifier) @name))]) @reference.decorates

; Type annotations in signatures and variables.
(type (identifier) @name) @reference.type
