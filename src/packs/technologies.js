/**
 * Project technology discovery.
 *
 * Answers "what is this project built with" from its manifests, before a single
 * source file is parsed. Two things depend on it:
 *
 *   1. Pack loading. A .NET repository has no reason to load the Python or Rust
 *      pack, and a pack that loads pulls a grammar with it.
 *   2. Dependency documentation. Knowing the ecosystem is what tells the docs
 *      subsystem to look in node_modules rather than ~/.nuget.
 *
 * Frameworks are reported separately from languages because they are not the
 * same kind of fact: Angular and React are both TypeScript, but knowing which
 * one changes what an agent should expect to find.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Manifest-driven detection. Each entry names the languages it implies and the
 * dependency ecosystem it uses, so discovery and dependency docs stay in step.
 */
const MANIFESTS = [
  {
    id: 'node',
    files: ['package.json'],
    languages: ['javascript', 'typescript', 'tsx'],
    ecosystem: 'npm',
    frameworks: (root, read, paths) => {
      // Every package.json, not just the root one. In a monorepo the root
      // manifest usually holds tooling while the frameworks live in
      // web/package.json or packages/*/package.json — reading only the root
      // reports a repository with an Angular app in it as plain TypeScript.
      const manifests = paths.filter((p) => p.endsWith('package.json'));
      const deps = {};
      for (const rel of manifests) {
        const pkg = readJson(root, rel);
        if (!pkg) continue;
        Object.assign(deps, pkg.dependencies, pkg.devDependencies, pkg.peerDependencies);
      }

      const found = [];
      if (deps['@angular/core']) found.push('angular');
      if (deps.react || deps['react-dom']) found.push('react');
      if (deps.next) found.push('nextjs');
      if (deps.vue) found.push('vue');
      if (deps.svelte) found.push('svelte');
      if (deps.express || deps.fastify || deps['@nestjs/core']) found.push('node-server');
      if (deps.jest || deps.vitest || deps.mocha) found.push('js-tests');
      return found;
    },
  },
  {
    id: 'dotnet',
    // Project files are named after the project, so this needs a pattern.
    patterns: [/\.(csproj|fsproj|vbproj|sln)$/i],
    files: ['global.json', 'Directory.Build.props', 'nuget.config', 'NuGet.config'],
    languages: ['csharp'],
    ecosystem: 'nuget',
    frameworks: (root, read, paths) => {
      const found = [];
      for (const p of paths) {
        if (!/\.csproj$/i.test(p)) continue;
        const text = readText(root, p);
        if (!text) continue;
        if (/Microsoft\.NET\.Sdk\.Web/i.test(text)) found.push('aspnet');
        if (/Microsoft\.EntityFrameworkCore/i.test(text)) found.push('entity-framework');
        if (/Microsoft\.NET\.Sdk\.BlazorWebAssembly/i.test(text)) found.push('blazor');
        if (/xunit|NUnit|MSTest/i.test(text)) found.push('dotnet-tests');
      }
      return [...new Set(found)];
    },
  },
  {
    id: 'python',
    files: ['pyproject.toml', 'setup.py', 'requirements.txt', 'setup.cfg', 'Pipfile'],
    languages: ['python'],
    ecosystem: 'pypi',
    frameworks: (root) => {
      const text = ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile']
        .map((f) => readText(root, f)).filter(Boolean).join('\n').toLowerCase();
      const found = [];
      if (/\bdjango\b/.test(text)) found.push('django');
      if (/\bflask\b/.test(text)) found.push('flask');
      if (/\bfastapi\b/.test(text)) found.push('fastapi');
      if (/\b(torch|tensorflow|jax)\b/.test(text)) found.push('ml');
      if (/\bpytest\b/.test(text)) found.push('pytest');
      return found;
    },
  },
  {
    id: 'java',
    files: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle'],
    languages: ['java'],
    ecosystem: 'maven',
    frameworks: (root) => {
      const text = ['pom.xml', 'build.gradle', 'build.gradle.kts']
        .map((f) => readText(root, f)).filter(Boolean).join('\n');
      const found = [];
      if (/spring-boot|springframework/i.test(text)) found.push('spring');
      if (/quarkus/i.test(text)) found.push('quarkus');
      if (/junit/i.test(text)) found.push('junit');
      return found;
    },
  },
  { id: 'go', files: ['go.mod'], languages: ['go'], ecosystem: 'go' },
  { id: 'rust', files: ['Cargo.toml'], languages: ['rust'], ecosystem: 'cargo' },
  { id: 'ruby', files: ['Gemfile', 'Rakefile'], languages: ['ruby'], ecosystem: 'rubygems' },
  { id: 'php', files: ['composer.json'], languages: ['php'], ecosystem: 'composer' },
];

function readText(root, rel) {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return null;
  }
}

function readJson(root, rel) {
  const text = readText(root, rel);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Shallow scan for manifest files.
 *
 * Depth-limited on purpose: a .csproj lives beside its source, often two or
 * three directories down in a multi-project solution, but walking the whole
 * tree to find one would cost more than the indexing it is meant to inform.
 */
function shallowPaths(root, maxDepth = 3) {
  const skip = new Set(['node_modules', '.git', '.cgraph', 'bin', 'obj', 'dist', 'build',
                        'target', 'vendor', '.venv', 'venv', '__pycache__', 'packages']);
  const out = [];

  const walk = (dir, rel, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth >= maxDepth || skip.has(e.name) || e.name.startsWith('.')) continue;
        walk(path.join(dir, e.name), childRel, depth + 1);
      } else if (e.isFile()) {
        out.push(childRel);
      }
    }
  };

  walk(root, '', 0);
  return out;
}

/**
 * Detect the project's technologies.
 *
 * @returns {{ stacks, languages, ecosystems, frameworks, evidence }}
 *   `evidence` records which file proved each stack, so `doctor` can explain a
 *   detection the user disagrees with rather than asserting it.
 */
export function detectTechnologies(root) {
  const paths = shallowPaths(root);
  const names = new Set(paths.map((p) => p.split('/').pop()));

  const stacks = [];
  const languages = new Set();
  const ecosystems = new Set();
  const frameworks = new Set();
  const evidence = {};

  const read = (rel) => readJson(root, rel);

  for (const m of MANIFESTS) {
    const byName = (m.files ?? []).filter((f) => names.has(f));
    const byPattern = (m.patterns ?? []).length
      ? paths.filter((p) => m.patterns.some((re) => re.test(p)))
      : [];

    const hits = [...byName, ...byPattern];
    if (!hits.length) continue;

    stacks.push(m.id);
    evidence[m.id] = hits.slice(0, 4);
    for (const l of m.languages) languages.add(l);
    if (m.ecosystem) ecosystems.add(m.ecosystem);

    try {
      for (const f of m.frameworks?.(root, read, paths) ?? []) frameworks.add(f);
    } catch {
      // A malformed manifest should narrow detection, never break indexing.
    }
  }

  return {
    stacks,
    languages: [...languages],
    ecosystems: [...ecosystems],
    frameworks: [...frameworks],
    evidence,
  };
}

/**
 * Languages worth loading a pack for.
 *
 * Manifests are the strong signal, but they are not the whole story: a repo
 * with a stray build script or a vendored tool has files in languages no
 * manifest mentions. So detected extensions are unioned in — discovery narrows
 * what is loaded eagerly, it never decides that a file present on disk should
 * be ignored.
 */
export function languagesToLoad(root, { extensionsPresent = [] } = {}) {
  const tech = detectTechnologies(root);
  const langs = new Set(tech.languages);
  for (const l of extensionsPresent) langs.add(l);
  return { languages: [...langs], technologies: tech };
}
