; Bash definitions and references.

(function_definition
  name: (word) @name) @definition.function

(variable_assignment
  name: (variable_name) @name) @definition.var

(command
  name: (command_name (word) @name)) @reference.call
