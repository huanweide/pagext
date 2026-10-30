**中文** · [README.md](./README.md)

<p align="center">
  <img src="assets/banner.svg" alt="pagext">
</p>

<p align="center">
  <a href="#why-pagext-instead-of-the-alternatives">30-second overview</a> · <a href="#usage">Usage</a> · <a href="#library-use">API</a> · <a href="#extraction-quality">Boundaries</a> · <a href="#ci-gate-usage">CI</a>
</p>

# pagext

> Zero-dependency, pure-Node single-file web content extractor. One command turns any webpage / local HTML / stdin into clean Markdown.

[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![zero deps](https://img.shields.io/badge/dependencies-0-brightgreen)](./package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

When you feed a webpage to an LLM, raw HTML wastes tokens on tags, styles, scripts, and navigation. **pagext keeps only the body** and turns it into structured Markdown — straight into a model, a RAG pipeline, or an archive.

```bash
# Run with no install (clone the repo, it works; no node_modules needed)
node index.js https://example.com/article

# Local file / pipe
node index.js page.html
cat page.html | node index.js --stdin
```

## Install

This project is **zero npm-dependency and single-file**, so it is **not published to npm** (in practice `npm view pagext` returns 404). `npx` or `npm i -g pagext` will not install it; use one of the options below:

```bash
# Option 1: clone and run (recommended, zero install)
git clone https://github.com/huanweide/pagext.git
node pagext/index.js https://example.com

# Option 2: global install (npm installs straight from GitHub, no publish needed)
npm install -g github:huanweide/pagext
pagext https://example.com
```

Requires Node.js >= 18 (uses the built-in `https`, named capture groups, etc.).

## Exit-code contract

When used as a gate / script component, rely on this contract:

| Exit code | Meaning |
|-----------|---------|
| `0` | Success |
| `1` | Runtime error (network failure, file read failure, etc.) |
| `2` | **Usage error**: unknown option, option missing a value, non-positive-integer `--max`, invalid `--format`, missing input |

A wrong argument does **not** silently continue — e.g. typing `--stin` instead of `--stdin` exits 2 with "unknown option" rather than quietly skipping the stdin logic and giving you a result you think came from the pipe but actually came from a file.

## Why pagext (instead of the alternatives)

| Competitor | Deps | Built-in fetch | Extraction | Pain point |
|------------|------|----------------|------------|------------|
| copy-as-markdown / Clipper / html2md | Requires `npm install` (`@mozilla/readability` + `Turndown`) | Yes | Readability black box | Not zero-dep single-file |
| webread | Close to zero-dep | **No** (needs an external fetcher) | Custom | Incomplete without fetch |
| Web2MD / mdream | Rust / WASM | Yes | Custom | Huge surface (crawl / MCP / llms.txt) |

**pagext = zero npm deps + single-file + built-in fetch + custom deterministic extraction**, the empty intersection:

- Zero-dependency: only Node built-ins `https` / `fs` / `zlib` / `url`; `git clone` and run, no `node_modules`.
- Built-in fetch: internal `https`, with gzip/deflate/redirect following — one command URL→MD, no fetcher to configure.
- Custom deterministic extraction: a hand-written tokenizer→tree→Readability-style content scorer; reproducible results, CI-friendly, no reliance on the Readability black box.
- Safe: strips `javascript:` / `vbscript:` / dangerous `data:` links, cleans terminal control characters, and restricts private / loopback addresses (SSRF warning).

## Usage

The examples below use `pagext` for the CLI. If it is not globally installed, replace it with `node /path/to/pagext/index.js`.

```bash
# Fetch a URL and output Markdown
pagext https://example.com/article

# Prefix the <title> as an H1
pagext https://example.com/article --title

# Drop image rows (saves tokens)
pagext https://example.com/article --no-images

# Output plain text (no Markdown markup)
pagext https://example.com/article --format text

# Output JSON (includes title / description / markdown / text)
pagext https://example.com/article --format json

# Truncate by word count (friendly for long-article summaries)
pagext https://example.com/article --max 500

# Convert a local HTML file
pagext article.html

# Read HTML from a pipe
cat article.html | pagext --stdin

# Write to a file
pagext https://example.com/article -o article.md

# Fetch an internal / loopback address (rejected by default to prevent SSRF; only when you know the target is safe)
pagext http://192.168.1.10/status --allow-private
```

### Compose with your toolchain

```bash
# Render in the terminal with glow after converting to Markdown
pagext https://example.com/article | glow -

# Batch archive (with xargs)
cat urls.txt | xargs -I{} pagext {} -o {}.md

# Feed a local LLM
pagext https://example.com/docs | ollama run llama3 "summarize the key points"
```

## Extraction quality

pagext's extractor is a **lightweight custom version** of the Readability idea (based on text-density + punctuation-density + link-density scoring, preferring `<article>` / `<main>`), not the full Firefox reader-view engine. It produces clean results on well-structured article pages; for JS-heavy (SPA) or extremely malformed pages, get the HTML with a browser / headless tool first and then `pagext --stdin`. This is a deliberate trade-off for "zero-dependency single-file" — **no browser-automation dependency is introduced**.

## Library use

```js
const pagext = require('pagext');

// Convert an HTML string directly (no network)
const { markdown, title, description } = pagext.convert(htmlString, {
  url: 'https://example.com',  // for resolving relative links
  title: true,                 // prefix <title> as H1
  noImages: false,
});

// You can also use the internal pieces separately
pagext.tokenize(html);
pagext.buildTree(tokens);
pagext.extractContent(tree);
pagext.fetchUrl('https://example.com'); // returns Promise<string>
```

## Four questions

**1. What is the pain point?**
In the AI era there is constant demand to feed webpages into models / RAG / notes, but raw HTML is 70–90% noise (navigation, ads, scripts, styles). Existing tools either need a pile of dependencies (Readability+Turndown), are zero-dep but lack fetch, or are heavy Rust/WASM. A "clone-and-run, one command, zero-dependency" clean extractor is a real gap.

**2. Why now?**
LLM feeding, RAG indexing, and agent webpage-reading exploded in 2025–2026, sharply increasing demand for "lightweight, reproducible, CI-friendly" HTML→MD. No one currently occupies the intersection of zero-dep + single-file + built-in fetch.

**3. What is the differentiation?**
It does not depend on the Readability / Turndown / jsdom black boxes; it uses a custom deterministic parser and extractor whose results are reproducible, auditable, and CI-gateable. The trio of zero npm deps + single-file + built-in fetch all hold at once — a gap that copy-as-markdown (needs deps), webread (no fetch), and Web2MD/mdream (heavy Rust) each leave open.

**4. Why will it stay maintainable?**
Small surface, logic concentrated in one file, stable Node built-in APIs; the extraction algorithm is a set of deterministic pure functions (tokenizer / scorer / serializer) with no external-dependency drift risk; unit tests cover parsing and extraction edge cases, so changes rarely regress. New site rules / table enhancements are incremental and do not break the existing structure.

## Who should use this

- You feed web content into an LLM, a RAG index, or a note archive and want clean Markdown without a dependency install.
- You run extraction inside CI and need deterministic, reproducible output plus an honest exit-code contract.

## Who should NOT use this

- You must extract heavily JS-rendered (SPA) pages — get the rendered HTML with a headless browser first, then `pagext --stdin`.
- You want a full Firefox reader-view engine — pagext is a lighter custom scorer, not that.

## CI gate usage

pagext is not a "health score" gate (do not copy other family repos' template copy here). Its correct role in a pipeline is an **output-size assertion** — treat the fetched result as input and check that it is clean, short enough, and free of leaked nav noise:

```bash
# 1) Page-size ceiling: body over N words means noise was not stripped, block it
words=$(pagext "$URL" --format text | wc -w)
[ "$words" -gt 3000 ] && { echo "body $words words, exceeds expectation, extraction likely failed"; exit 1; }

# 2) Must contain key content: failing to extract body means selector mismatch
pagext "$URL" | grep -q 'key phrase' || { echo "no body extracted"; exit 1; }

# 3) Use the exit-code contract: a wrong arg exits 2, so CI can tell "used wrong" from "crashed"
pagext "$URL" --max abc || exit $?    # -> 2
```

This repo's own CI (`.github/workflows/verify.yml`) runs: unit tests + CLI smoke on Node 18/20/22 × ubuntu/windows, a zero-dependency self-proof, and a README-vs-implementation consistency check.

## License

See [LICENSE](LICENSE).

---

Maintained by **huanweide** · [GitHub](https://github.com/huanweide)
