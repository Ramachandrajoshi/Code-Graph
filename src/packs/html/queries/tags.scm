; Landmark structural tags.
(element
  (start_tag (tag_name) @name)
  (#any-of? @name "html" "head" "body" "main" "nav" "header" "footer"
                  "form" "section" "article")) @definition.element

; <script> and <style> are their own node types in this grammar, not a plain
; `element` with a start_tag — they carry raw, unparsed text as their body.
(script_element
  (start_tag (tag_name) @name)) @definition.element

(style_element
  (start_tag (tag_name) @name)) @definition.element

; Any element with an id="..." attribute — the closest thing HTML has to a
; named, addressable symbol.
(element
  (start_tag
    (attribute
      (attribute_name) @_attr
      (quoted_attribute_value (attribute_value) @name))
    (#eq? @_attr "id"))) @definition.element
