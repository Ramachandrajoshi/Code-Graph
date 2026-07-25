/**
 * .NET XML documentation parser.
 *
 * NuGet ships compiled assemblies, so there is no source to run through
 * tree-sitter. What it does ship — whenever the author enabled documentation
 * generation, which every Microsoft package does — is an XML file beside the
 * DLL listing every public member with its summary.
 *
 * That file is a better source than decompiled source would be: it is already
 * the public API surface, already prose-documented, and small.
 *
 * The format is a flat list of members keyed by a signature string:
 *
 *   <member name="M:System.Text.Json.JsonSerializer.Serialize``1(``0)">
 *     <summary>Converts the value of a type into a JSON string.</summary>
 *   </member>
 *
 * The prefix letter is the member kind: T type, M method, P property, F field,
 * E event, N namespace.
 */

import { extractSummary } from '../packs/csharp/xmldoc.js';

const KIND_BY_PREFIX = {
  T: 'class',
  M: 'method',
  P: 'field',      // a C# property is what a caller binds to, like a field
  F: 'field',
  E: 'field',
  N: 'module',
};

/**
 * Parse an XML doc file into the symbol shape the dependency store expects.
 *
 * Written as a regex scan rather than with an XML parser: the format is
 * machine-generated and rigidly shaped, the files reach several megabytes, and
 * adding an XML dependency to a tool whose selling point is a 6 MB install is a
 * poor trade.
 *
 * @param {string} xml
 * @param {object} [opts]
 * @param {number} [opts.limit] cap on returned symbols; large framework
 *   packages carry thousands and nobody reads past the first page.
 */
export function parseXmlDoc(xml, { limit = 400 } = {}) {
  const assembly = xml.match(/<assembly>\s*<name>([^<]+)<\/name>/i)?.[1]?.trim() ?? null;

  const symbols = [];
  const seen = new Set();
  const memberRe = /<member\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/member>/gi;

  let match;
  while ((match = memberRe.exec(xml)) !== null) {
    const [, rawName, body] = match;
    const parsed = parseMemberName(rawName);
    if (!parsed) continue;

    // Compiler-generated and explicitly-implemented members are noise: nobody
    // searches for `<>c__DisplayClass` or `System.IDisposable.Dispose`.
    if (/[<>`]|\.\.ctor$/.test(parsed.symbol) && parsed.kind !== 'method') continue;
    if (parsed.symbol.startsWith('_')) continue;

    const doc = extractSummary(body);
    if (!doc && parsed.kind === 'module') continue;   // a bare namespace entry says nothing

    const key = `${parsed.kind}:${parsed.symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);

    symbols.push({
      symbol: parsed.symbol,
      kind: parsed.kind,
      signature: parsed.signature,
      doc,
    });

    if (symbols.length >= limit) break;
  }

  return { assembly, symbols };
}

/**
 * Turn `M:Namespace.Type.Method(System.String)` into a usable symbol name and
 * a readable signature.
 *
 * The fully-qualified name is discarded in favour of `Type.Member`, because
 * that is what appears at a call site and therefore what someone searches for.
 */
function parseMemberName(raw) {
  const prefix = raw[0];
  const kind = KIND_BY_PREFIX[prefix];
  if (!kind || raw[1] !== ':') return null;

  let rest = raw.slice(2);

  // Parameters are part of the signature, not the name.
  let params = '';
  const paren = rest.indexOf('(');
  if (paren !== -1) {
    params = rest.slice(paren);
    rest = rest.slice(0, paren);
  }

  // Generic arity markers: `1 on a type, ``1 on a method.
  rest = rest.replace(/``?\d+/g, '');

  const segments = rest.split('.').filter(Boolean);
  if (!segments.length) return null;

  const member = segments.at(-1);
  const owner = segments.length > 1 ? segments.at(-2) : null;

  // `#ctor` is how a constructor is encoded.
  const name = member === '#ctor' ? (owner ?? 'ctor') : member;
  const symbol = kind === 'class' || kind === 'module' || !owner ? name : `${owner}.${name}`;

  const signature = params
    ? `${symbol}(${simplifyParams(params)})`
    : symbol;

  return { symbol, kind, signature };
}

/** `(System.String,System.Int32)` -> `string, int`. */
function simplifyParams(params) {
  const inner = params.slice(1, -1);
  if (!inner) return '';

  const ALIASES = {
    'System.String': 'string', 'System.Int32': 'int', 'System.Int64': 'long',
    'System.Boolean': 'bool', 'System.Double': 'double', 'System.Decimal': 'decimal',
    'System.Object': 'object', 'System.Void': 'void', 'System.Byte': 'byte',
    'System.Char': 'char', 'System.Single': 'float', 'System.DateTime': 'DateTime',
    'System.Guid': 'Guid',
  };

  return splitTopLevel(inner)
    .map((p) => {
      const clean = p.replace(/``?\d+/g, '').trim();
      if (ALIASES[clean]) return ALIASES[clean];
      // Keep the last segment: System.Collections.Generic.List{T} -> List{T}
      return clean.split('.').pop();
    })
    .join(', ')
    .slice(0, 160);
}

/** Split on commas that are not inside generic braces. */
function splitTopLevel(text) {
  const out = [];
  let depth = 0, current = '';
  for (const c of text) {
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(current); current = ''; continue; }
    current += c;
  }
  if (current) out.push(current);
  return out;
}

