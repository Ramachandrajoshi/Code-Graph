/**
 * .NET XML documentation text handling.
 *
 * Lives in the C# pack because it is C#-specific knowledge, and is imported by
 * the dependency-docs subsystem so both paths flatten identically. They cover
 * the same markup from different sources — `///` comments in project source,
 * and the generated XML shipped beside a NuGet assembly — and letting the two
 * diverge would mean the same doc comment reading differently depending on
 * whether the code was yours.
 */

/**
 * Flatten XML doc markup to plain prose.
 *
 * Cross-references are rendered, not dropped. `<see cref="T:System.String"/>`
 * stands where a type name belongs in the sentence, so removing the tag
 * outright leaves "Finds a by identifier" — grammatical damage that reads as a
 * bug in the extractor.
 */
export function flattenDocText(xml) {
  if (!xml) return null;

  const text = xml
    // <see cref="T:Namespace.Type"/> -> Type
    .replace(/<see\s+cref\s*=\s*"[A-Z]:([^"]+)"\s*\/?>/gi, (_, ref) => lastSegment(ref))
    .replace(/<seealso\s+cref\s*=\s*"[A-Z]:([^"]+)"\s*\/?>/gi, (_, ref) => lastSegment(ref))
    // <see langword="null"/> -> null
    .replace(/<see\s+langword\s*=\s*"([^"]+)"\s*\/?>/gi, '$1')
    // <paramref name="id"/> and <typeparamref name="T"/> -> the name
    .replace(/<(?:param|typeparam)ref\s+name\s*=\s*"([^"]+)"\s*\/?>/gi, '$1')
    // Everything else is structure.
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  return text || null;
}

/**
 * The `<summary>` of a doc block, flattened.
 *
 * Only the summary: `<param>`, `<returns>` and `<exception>` restate the
 * signature the reader already has, and including them triples the size of
 * every doc string for no added meaning.
 */
export function extractSummary(xml) {
  if (!xml) return null;
  const summary = xml.match(/<summary>([\s\S]*?)<\/summary>/i)?.[1];
  // No <summary> at all usually means a bare one-line comment, which is still
  // worth keeping — but anything after the first block tag is not prose.
  const body = summary ?? xml.split(/<(?:param|returns|exception|remarks|typeparam)\b/i)[0];
  const text = flattenDocText(body);
  return text ? text.slice(0, 500) : null;
}

function lastSegment(ref) {
  // Strip a generic arity marker before taking the name: List`1 -> List
  return ref.replace(/`\d+/g, '').split('.').pop();
}
