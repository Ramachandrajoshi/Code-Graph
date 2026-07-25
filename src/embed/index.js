/**
 * Optional semantic search.
 *
 * Off by default and deliberately so. Embeddings cost money per index, send
 * source code to a third party, and answer a narrower question than the
 * structural tools already handle. They earn their place only for "find the
 * code that does X" when the caller does not know what X is called.
 *
 * The provider is an interface, not a hard dependency: no embedding code loads
 * unless the user configures it, and no API key ever appears in config — only
 * the NAME of the environment variable holding it.
 */

/** Providers we know how to call. Each maps to a plain HTTP request. */
const PROVIDERS = {
  voyage: {
    url: 'https://api.voyageai.com/v1/embeddings',
    defaultModel: 'voyage-code-3',
    build: (texts, model) => ({ input: texts, model, input_type: 'document' }),
    parse: (json) => json.data.map((d) => d.embedding),
    auth: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  openai: {
    url: 'https://api.openai.com/v1/embeddings',
    defaultModel: 'text-embedding-3-small',
    build: (texts, model) => ({ input: texts, model }),
    parse: (json) => json.data.map((d) => d.embedding),
    auth: (key) => ({ Authorization: `Bearer ${key}` }),
  },
};

export class Embedder {
  constructor({ provider, model, apiKey }) {
    const spec = PROVIDERS[provider];
    if (!spec) {
      throw new Error(
        `Unknown embedding provider '${provider}'. Known: ${Object.keys(PROVIDERS).join(', ')}`
      );
    }
    this.spec = spec;
    this.model = model ?? spec.defaultModel;
    this.apiKey = apiKey;
  }

  /**
   * Build an embedder from config, or return null when embeddings are off.
   *
   * Returning null rather than throwing keeps every caller free of "is this
   * enabled" branching — the feature is simply absent.
   */
  static fromConfig(config) {
    const e = config.embeddings;
    if (!e?.enabled) return null;
    if (!e.provider) throw new Error('embeddings.enabled is true but embeddings.provider is not set');

    const envVar = e.apiKeyEnv ?? defaultEnvVar(e.provider);
    const apiKey = process.env[envVar];
    if (!apiKey) {
      throw new Error(
        `Embeddings are enabled but ${envVar} is not set.\n` +
          'The key is read from the environment; it is never stored in .codegraph/config.json.'
      );
    }
    return new Embedder({ provider: e.provider, model: e.model, apiKey });
  }

  /** Embed a batch of texts. Batching matters: per-item requests are ~50x slower. */
  async embed(texts) {
    const res = await fetch(this.spec.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.spec.auth(this.apiKey) },
      body: JSON.stringify(this.spec.build(texts, this.model)),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Embedding request failed: ${res.status} ${res.statusText} ${detail.slice(0, 200)}`);
    }
    return this.spec.parse(await res.json());
  }
}

function defaultEnvVar(provider) {
  return provider === 'voyage' ? 'VOYAGE_API_KEY' : 'OPENAI_API_KEY';
}

/**
 * The text embedded for a symbol.
 *
 * Signature and documentation, not the body. Bodies are mostly syntax that
 * embeds poorly and pushes every function toward the same region of the vector
 * space; the declaration and its doc comment carry nearly all the semantics at
 * a fraction of the cost.
 */
export function symbolText(node) {
  return [
    node.kind,
    node.qname,
    node.signature ?? node.name,
    node.doc ?? '',
  ].filter(Boolean).join(' — ').slice(0, 1000);
}

/** Pack a float array into a Buffer for BLOB storage. */
export function packVector(vector) {
  const buf = Buffer.allocUnsafe(vector.length * 4);
  for (let i = 0; i < vector.length; i++) buf.writeFloatLE(vector[i], i * 4);
  return buf;
}

export function unpackVector(buf) {
  const out = new Float32Array(buf.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

/**
 * Cosine similarity.
 *
 * Vectors are normalized on write so this reduces to a dot product, but the
 * norms are computed anyway — a provider that returns unnormalized vectors
 * would otherwise produce silently wrong rankings.
 */
export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Embed every symbol worth embedding and store the vectors.
 *
 * Only ranked, named symbols are embedded — embedding every local variable
 * would multiply cost several-fold for results nobody searches.
 */
export async function embedIndex(store, config, { onProgress = null, batchSize = 96 } = {}) {
  const embedder = Embedder.fromConfig(config);
  if (!embedder) return { embedded: 0, skipped: 'not configured' };

  const nodes = store.all(
    `SELECT n.id, n.kind, n.qname, n.name, n.signature, n.doc
       FROM nodes n
       LEFT JOIN chunks c ON c.node_id = n.id
      WHERE n.kind NOT IN ('module', 'var', 'const')
        AND c.node_id IS NULL
      ORDER BY n.rank DESC`
  );

  if (!nodes.length) return { embedded: 0, upToDate: true };

  let embedded = 0;
  for (let i = 0; i < nodes.length; i += batchSize) {
    const batch = nodes.slice(i, i + batchSize);
    const vectors = await embedder.embed(batch.map(symbolText));

    store.transaction(() => {
      const insert = store.stmt('INSERT OR REPLACE INTO chunks(node_id, dim, vector) VALUES(?, ?, ?)');
      for (let j = 0; j < batch.length; j++) {
        insert.run(batch[j].id, vectors[j].length, packVector(vectors[j]));
      }
    });

    embedded += batch.length;
    onProgress?.(embedded, nodes.length);
  }

  store.setMeta('embeddings_model', `${config.embeddings.provider}:${embedder.model}`);
  return { embedded };
}

/** Nearest symbols to a natural-language query. */
export async function semanticSearch(store, config, query, { limit = 10 } = {}) {
  const embedder = Embedder.fromConfig(config);
  if (!embedder) throw new Error('Embeddings are not configured.');

  const rows = store.all(
    `SELECT c.node_id, c.vector, n.qname, n.kind, n.start_line, n.signature, f.path
       FROM chunks c JOIN nodes n ON n.id = c.node_id JOIN files f ON f.id = n.file_id`
  );
  if (!rows.length) {
    throw new Error('No embeddings stored. Run `cgraph index --embed` first.');
  }

  const [queryVector] = await embedder.embed([query]);
  const q = Float32Array.from(queryVector);

  const scored = rows.map((r) => ({ ...r, score: cosine(q, unpackVector(r.vector)) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
