/**
 * C# language pack.
 *
 * The interesting difference from the other packs: a `using` names a *namespace*,
 * not a file. One namespace spans many files and one file may declare several,
 * so import resolution maps namespace -> declaring files rather than
 * specifier -> path. That mapping only exists once the whole repo is indexed,
 * which is why `resolveImport` consults the index rather than the filesystem.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import builtins from './builtins.js';
import { extractSummary } from './xmldoc.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export default {
  id: 'csharp',
  languages: ['csharp'],

  queries: {
    tags: path.join(here, 'queries', 'tags.scm'),
    imports: path.join(here, 'queries', 'imports.scm'),
  },

  builtins,

  detect(ctx) {
    return (
      ctx.hasAnyMatching?.(/\.(csproj|sln|fsproj)$/) ||
      ctx.hasFile('global.json') ||
      ctx.hasFile('Directory.Build.props') ||
      ctx.hasFile('nuget.config') ||
      ctx.hasFile('NuGet.config')
    );
  },

  /** Declaration up to the body, so attributes and generics survive. */
  signature(def, source) {
    const text = source.slice(def.startByte, def.endByte);
    const end = findBodyStart(text);
    return (end === -1 ? text.split('\n')[0] : text.slice(0, end))
      // Attributes sit on their own lines above the member; folding them in
      // makes a [HttpPost][Authorize] method unreadable.
      .replace(/\[[^\]]*\]\s*/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')')
      .replace(/<\s+/g, '<')
      .replace(/\s+>/g, '>')
      .trim()
      .slice(0, 300) || null;
  },

  /**
   * XML documentation comments (`///`), summary text only.
   *
   * The tags are markup, not prose: `<summary>` wraps the sentence a reader
   * wants and `<param>`/`<returns>` restate the signature. Stripping the markup
   * and keeping the summary is what makes these searchable.
   */
  docComment(def, source) {
    const lines = source.slice(0, def.startByte).split('\n');
    lines.pop();

    const collected = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) { if (collected.length) break; continue; }
      if (line.startsWith('[') && line.endsWith(']')) continue;   // attribute
      if (!line.startsWith('///')) break;
      collected.unshift(line.replace(/^\/\/\/\s?/, ''));
    }
    if (!collected.length) return null;

    // Shared with the dependency-docs path so a doc comment reads the same
    // whether it came from your source or from a NuGet package's XML file.
    return extractSummary(collected.join(' '));
  },

  isExported(def, source) {
    return /\bpublic\b/.test(modifiersOf(def, source));
  },

  visibility(def, source) {
    const head = modifiersOf(def, source);
    // A namespace has no access modifier at all; reporting it as private would
    // be actively wrong, since a namespace is visible everywhere.
    if (/^\s*namespace\b/.test(head)) return null;

    if (/\bprivate\b/.test(head)) return 'private';
    if (/\bprotected\b/.test(head)) return 'protected';
    if (/\binternal\b/.test(head)) return 'internal';
    if (/\bpublic\b/.test(head)) return 'public';
    // C# members default to private; types default to internal.
    return /\b(class|struct|interface|enum|record)\b/.test(head) ? 'internal' : 'private';
  },

  /**
   * Resolve a `using` to a file that declares that namespace.
   *
   * Namespaces are declared, not located, so this asks the index which files
   * declare a matching namespace node. Framework namespaces (System.*) and
   * anything the repo does not declare are external.
   */
  resolveImport(spec, fromPath, ctx) {
    const ns = String(spec).trim();
    if (!ns) return null;

    const owner = ctx.findNamespace?.(ns);
    if (owner) return { file: owner };

    const head = ns.split('.')[0];
    if (head === 'System' || head === 'Microsoft') {
      // Two segments keeps System.Text.Json distinct from System.Linq, which is
      // how NuGet packages them anyway.
      return { external: { ecosystem: 'dotnet', package: ns.split('.').slice(0, 2).join('.') } };
    }
    return { external: { ecosystem: 'nuget', package: ns.split('.').slice(0, 2).join('.') } };
  },

  parseImport(match) {
    const source = match.captures.find((c) => c.name === 'source');
    if (!source) return null;
    const alias = match.captures.find((c) => c.name === 'alias');
    const spec = source.text.trim();
    return {
      spec,
      symbol: null,
      // Without an alias the binding is the trailing segment, which is what a
      // qualified reference (`Json.Serialize`) will use.
      alias: alias?.text ?? spec.split('.').pop(),
      line: source.startLine,
    };
  },
};

/**
 * The modifier list belonging to this declaration.
 *
 * Bounded to the declaration head so a method body containing the word
 * `private` cannot influence the answer, and taken from the node's own text
 * rather than scanning backwards — scanning back reads the *previous* member's
 * modifiers, which is how the Java pack initially reported every protected
 * method following a private one as private.
 */
function modifiersOf(def, source) {
  const text = source.slice(def.startByte, def.endByte);
  const stop = text.search(/[({=;]/);
  return stop === -1 ? text.slice(0, 160) : text.slice(0, stop);
}

/** Body start: `{`, or `;` for an abstract/interface member or auto-property. */
function findBodyStart(text) {
  let paren = 0, angle = 0, bracket = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') paren++;
    else if (c === ')') paren--;
    else if (c === '<') angle++;
    else if (c === '>') angle = Math.max(0, angle - 1);
    else if (c === '[') bracket++;
    else if (c === ']') bracket--;
    else if ((c === '{' || c === ';') && paren === 0 && angle === 0 && bracket === 0) return i;
  }
  return -1;
}
