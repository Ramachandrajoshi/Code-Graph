; C# using directives.
;
; `using` names a namespace, not a file. One namespace usually spans many files
; and one file may declare several, so resolution maps the namespace to whichever
; file declares it rather than to a path on disk.

; using System.Collections.Generic;
(using_directive
  [(identifier) (qualified_name)] @source) @import

; using Data = MyApp.Models;  — the alias is the local binding.
(using_directive
  (name_equals (identifier) @alias)
  [(identifier) (qualified_name)] @source) @import
