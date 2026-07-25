/**
 * Java language pack.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import builtins from './builtins.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Source roots Maven and Gradle both use; a package maps under one of these. */
const SOURCE_ROOTS = [
  'src/main/java/', 'src/test/java/', 'src/main/kotlin/', 'src/', '',
];

export default {
  id: 'java',
  languages: ['java'],

  queries: {
    tags: path.join(here, 'queries', 'tags.scm'),
    imports: path.join(here, 'queries', 'imports.scm'),
  },

  builtins,

  detect(ctx) {
    return ctx.hasFile('pom.xml') || ctx.hasFile('build.gradle') || ctx.hasFile('build.gradle.kts');
  },

  signature(def, source) {
    const text = source.slice(def.startByte, def.endByte);
    const end = findSignatureEnd(text);
    return (end === -1 ? text.split('\n')[0] : text.slice(0, end))
      // Annotations belong on their own conceptual line; folding them into the
      // signature makes @Override @Transactional methods unreadable.
      .replace(/@\w+(\([^)]*\))?\s*/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')')
      .trim()
      .slice(0, 300) || null;
  },

  /** Javadoc block immediately above, tags stripped. */
  docComment(def, source) {
    const before = source.slice(0, def.startByte);
    // Annotations sit between the Javadoc and the declaration.
    const trimmed = before.replace(/(\s*@\w+(\([^)]*\))?\s*)*$/, '').replace(/\s*$/, '');
    if (!trimmed.endsWith('*/')) return null;

    const open = trimmed.lastIndexOf('/**');
    if (open === -1) return null;

    const prose = [];
    for (const raw of trimmed.slice(open + 3, trimmed.length - 2).split('\n')) {
      const line = raw.replace(/^\s*\*\s?/, '').trim();
      if (line.startsWith('@')) break;
      if (line) prose.push(line);
    }
    const doc = prose.join(' ').replace(/\s+/g, ' ').trim();
    return doc ? doc.slice(0, 500) : null;
  },

  isExported(def, source) {
    return /\bpublic\b/.test(modifiersOf(def, source));
  },

  visibility(def, source) {
    const head = modifiersOf(def, source);
    if (/\bprivate\b/.test(head)) return 'private';
    if (/\bprotected\b/.test(head)) return 'protected';
    if (/\bpublic\b/.test(head)) return 'public';
    return 'internal'; // package-private
  },

  /**
   * Map a fully-qualified type to a source file.
   *
   * Java's package-to-directory convention makes this mechanical:
   * `com.example.UserService` lives at `<source root>/com/example/UserService.java`.
   */
  resolveImport(spec, fromPath, ctx) {
    const asPath = String(spec).replace(/\./g, '/');

    for (const root of SOURCE_ROOTS) {
      const candidate = `${root}${asPath}.java`;
      if (ctx.hasFile(candidate)) return { file: candidate };
    }

    // A nested class import (`com.example.Outer.Inner`) resolves to the outer file.
    const cut = asPath.lastIndexOf('/');
    if (cut > 0) {
      const outer = asPath.slice(0, cut);
      for (const root of SOURCE_ROOTS) {
        const candidate = `${root}${outer}.java`;
        if (ctx.hasFile(candidate)) return { file: candidate };
      }
    }

    if (spec.startsWith('java.') || spec.startsWith('javax.')) {
      return { external: { ecosystem: 'jdk', package: spec.split('.').slice(0, 2).join('.') } };
    }
    // Group id is conventionally the first three segments (com.fasterxml.jackson).
    return { external: { ecosystem: 'maven', package: spec.split('.').slice(0, 3).join('.') } };
  },

  parseImport(match) {
    const source = match.captures.find((c) => c.name === 'source');
    if (!source) return null;
    const spec = source.text;
    const wildcard = match.captures.some((c) => c.name === 'wildcard');
    return {
      spec,
      symbol: wildcard ? null : spec.split('.').pop(),
      alias: wildcard ? null : spec.split('.').pop(),
      line: source.startLine,
    };
  },
};

/**
 * The modifier list belonging to this declaration, and nothing else.
 *
 * In the Java grammar `modifiers` is a child of the declaration, so the node's
 * own text already starts with them. Scanning *backwards* from the node — the
 * obvious-looking approach — reads the previous member's modifiers instead, so
 * a protected method following a private one reports as private.
 *
 * Bounded to the declaration head so a method body containing the word
 * `private` cannot influence the result.
 */
function modifiersOf(def, source) {
  const text = source.slice(def.startByte, def.endByte);
  const stop = text.search(/[({=;]/);
  return stop === -1 ? text.slice(0, 120) : text.slice(0, stop);
}

function findSignatureEnd(text) {
  let paren = 0, angle = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') paren++;
    else if (c === ')') paren--;
    else if (c === '<') angle++;
    else if (c === '>') angle = Math.max(0, angle - 1);
    else if ((c === '{' || c === ';') && paren === 0 && angle === 0) return i;
  }
  return -1;
}
