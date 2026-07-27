; Every object key is a definition. `key`, not `field`, so buildQName joins
; nested keys with `.` instead of `#` (package.json::scripts.build).
(pair
  key: (string (string_content) @name)) @definition.key
