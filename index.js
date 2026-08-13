#!/usr/bin/env node
'use strict';

/*
 * pagext —— 零依赖、纯 Node 单文件网页正文提取器
 * 把任意网页 / 本地 HTML / stdin 变成干净 Markdown。
 * 不依赖 Readability / Turndown / jsdom，自研确定性解析与提取，结果可复现。
 * 内置 fetch（Node https），一条命令 URL -> Markdown。
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const zlib = require('zlib');
const { URL } = require('url');

const UA =
  'Mozilla/5.0 (compatible; pagext/1.0; +https://github.com/huanweide/pagext)';

/* ============================ 实体解码 ============================ */
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·',
  deg: '°', plusmn: '±', times: '×', divide: '÷', frac12: '½', euro: '€',
  pound: '£', yen: '¥', sect: '§', para: '¶', laquo: '«', raquo: '»',
};

function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) =>
      Object.prototype.hasOwnProperty.call(ENTITIES, name) ? ENTITIES[name] : m
    )
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return m; }
    })
    .replace(/&#(\d+);/g, (m, d) => {
      try { return String.fromCodePoint(parseInt(d, 10)); } catch { return m; }
    });
}

/* ============================ 词法 / 语法 ============================ */
function parseAttrs(str) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(str))) {
    const name = m[1].toLowerCase();
    const val =
      m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5] !== undefined ? m[5] : '';
    attrs[name] = val;
  }
  return attrs;
}

function tokenize(html) {
  const tokens = [];
  let i = 0;
  const n = html.length;
  while (i < n) {
    if (html[i] === '<') {
      if (html.startsWith('<!--', i)) {
        const end = html.indexOf('-->', i + 4);
        i = end === -1 ? n : end + 3;
        continue;
      }
      if (html[i + 1] === '!' || html[i + 1] === '?') {
        const end = html.indexOf('>', i);
        i = end === -1 ? n : end + 1;
        continue;
      }
      // 状态机扫描到标签结束 '>'，但跳过引号字符串内的 '>'
      let j = i + 1;
      let inStr = null;
      while (j < n) {
        const ch = html[j];
        if (inStr) {
          if (ch === inStr) inStr = null;
        } else if (ch === '"' || ch === "'") {
          inStr = ch;
        } else if (ch === '>') {
          break;
        }
        j++;
      }
      if (j >= n) { i = n; break; }
      const raw = html.slice(i, j + 1);
      i = j + 1;
      const isClose = raw[1] === '/';
      const inner = raw.slice(isClose ? 2 : 1, -1).trim();
      if (isClose) {
        tokens.push({ type: 'close', tag: inner.toLowerCase() });
      } else {
        const selfClose = inner.endsWith('/');
        const attrStr = selfClose ? inner.slice(0, -1) : inner;
        const sp = attrStr.search(/\s/);
        const tag = (sp === -1 ? attrStr : attrStr.slice(0, sp)).toLowerCase();
        const attrs = parseAttrs(sp === -1 ? '' : attrStr.slice(sp + 1));
        tokens.push({ type: 'open', tag, attrs, selfClose });
      }
    } else {
      const next = html.indexOf('<', i);
      const text = html.slice(i, next === -1 ? n : next);
      i = next === -1 ? n : next;
      if (text.length) tokens.push({ type: 'text', text });
    }
  }
  return tokens;
}

const VOID_TAGS = new Set([
  'br', 'img', 'hr', 'input', 'meta', 'link', 'area', 'base',
  'col', 'embed', 'source', 'track', 'wbr',
]);

function buildTree(tokens) {
  const root = { tag: '#root', attrs: {}, children: [], parent: null };
  const stack = [root];
  for (const t of tokens) {
    const top = stack[stack.length - 1];
    if (t.type === 'text') {
      top.children.push({ type: 'text', text: t.text, parent: top });
    } else if (t.type === 'open') {
      const node = { tag: t.tag, attrs: t.attrs, children: [], parent: top };
      top.children.push(node);
      // void 元素（<br>/<img> 等）即便无显式自闭合也不入栈，避免被后续闭合标签弹出丢弃
      if (!t.selfClose && !VOID_TAGS.has(t.tag)) stack.push(node);
    } else if (t.type === 'close') {
      for (let k = stack.length - 1; k >= 1; k--) {
        if (stack[k].tag === t.tag) { stack.length = k; break; }
      }
    }
  }
  return root;
}

/* ============================ 文本工具 ============================ */
function getText(node) {
  if (node.type === 'text') return node.text;
  let s = '';
  for (const c of node.children) s += getText(c);
  return s;
}
function textLength(node) {
  return getText(node).replace(/\s+/g, ' ').trim().length;
}
function linkTextLength(node) {
  if (node.tag === 'a') return textLength(node);
  if (!node.children) return 0;
  let s = 0;
  for (const c of node.children) if (typeof c === 'object') s += linkTextLength(c);
  return s;
}

/* ============================ 正文提取（Readability 简化） ============================ */
const DROP_TAGS = new Set([
  'script', 'style', 'noscript', 'head', 'nav', 'header', 'footer',
  'aside', 'form', 'iframe', 'svg', 'template', 'dialog', 'script',
]);
const NOISE_PENALTY = new Set(['nav', 'header', 'footer', 'aside', 'form']);

function prune(node) {
  if (!node.children) return;
  node.children = node.children.filter((c) => {
    if (typeof c === 'object' && c.children && DROP_TAGS.has(c.tag)) return false;
    if (typeof c === 'object' && c.children) prune(c);
    return true;
  });
}

function scoreNode(node) {
  const tl = node._tl != null ? node._tl : textLength(node);
  const ll = linkTextLength(node);
  const linkDensity = tl > 0 ? ll / tl : 0;
  const text = getText(node);
  const punct = (text.match(/[。.!?！？]/g) || []).length;
  let score = tl + punct * 10 - linkDensity * tl * 0.6;
  if (NOISE_PENALTY.has(node.tag)) score -= 1e7;
  return score;
}

// 单遍后序缓存每个节点的文本长度，避免 scoreNode 反复全子树 getText（O(n^2) -> O(n)）
function cacheLengths(node) {
  if (!node.children) return;
  for (const c of node.children) if (typeof c === 'object') cacheLengths(c);
  node._tl = textLength(node);
}

function findTag(node, tag) {
  if (node.tag === tag) return node;
  if (!node.children) return null;
  for (const c of node.children) {
    if (typeof c === 'object') {
      const r = findTag(c, tag);
      if (r) return r;
    }
  }
  return null;
}
function collectByTags(node, tags) {
  const out = [];
  const walk = (n) => {
    if (typeof n === 'object' && tags.includes(n.tag)) out.push(n);
    if (typeof n === 'object' && n.children) for (const c of n.children) walk(c);
  };
  walk(node);
  return out;
}

function extractContent(root) {
  cacheLengths(root);
  const body = findTag(root, 'body') || root;
  const pref = findTag(body, 'article') || findTag(body, 'main');
  if (pref && textLength(pref) >= 200) return pref;
  let best = null;
  let bestScore = -Infinity;
  const cands = collectByTags(body, ['div', 'section', 'article', 'main', 'td', 'li', 'blockquote', 'pre']);
  for (const n of cands) {
    const s = scoreNode(n);
    if (s > bestScore) { bestScore = s; best = n; }
  }
  if (best && textLength(best) >= 200) return best;
  return body;
}

/* ============================ 元数据 ============================ */
function extractMeta(html) {
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const descM =
    html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i);
  const canonM =
    html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']*)["']/i) ||
    html.match(/<link[^>]+href=["']([^"']*)["'][^>]*rel=["']canonical["']/i);
  return {
    title: titleM ? decodeEntities(titleM[1]).trim() : '',
    description: descM ? decodeEntities(descM[1]).trim() : '',
    canonical: canonM ? canonM[1] : '',
  };
}

/* ============================ 安全清洗 ============================ */
function sanitizeUrl(href, base) {
  if (!href) return '';
  const h = href.trim();
  if (/^(javascript|vbscript):/i.test(h)) return '';
  // 仅放行位图 data:（png/jpeg/gif/webp/bmp/avif），svg 仍可含 script 故拒绝；其余 data:（text/html、svg、application/*）一律拒绝
  if (/^data:/i.test(h) && !/^data:image\/(png|jpe?g|gif|webp|bmp|avif)/i.test(h)) return '';
  if (base) {
    try { return new URL(h, base).toString(); } catch { return h; }
  }
  return h;
}

function sanitizeControl(s) {
  // 去除 C0 控制字符（保留 \n \t），防终端/下游注入
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function escapeText(s) {
  return s.replace(/([*_`\\])/g, '\\$1');
}

/* ============================ HTML -> Markdown ============================ */
const BLOCK_TAGS = new Set([
  'h1','h2','h3','h4','h5','h6','p','pre','blockquote','ul','ol','li',
  'table','tr','div','section','article','main','header','footer','nav',
  'aside','figure','figcaption','hr','br','img','a',
]);
function hasBlockChild(node) {
  return node.children.some((c) => typeof c === 'object' && BLOCK_TAGS.has(c.tag));
}

function serializeInline(nodes, ctx) {
  let out = '';
  for (const c of nodes) {
    if (typeof c === 'string' || c.type === 'text') {
      out += escapeText(decodeEntities(typeof c === 'string' ? c : c.text));
    } else if (c.tag === 'br') {
      out += '\n';
    } else if (c.tag === 'a') {
      const href = sanitizeUrl(c.attrs.href || '', ctx.base);
      const label = serializeInline(c.children, ctx);
      out += href ? '[' + label + '](' + href + ')' : label;
    } else if (c.tag === 'img') {
      const src = sanitizeUrl(c.attrs.src || '', ctx.base);
      const alt = decodeEntities(c.attrs.alt || '');
      if (ctx.noImages) { if (alt) out += alt; }
      else if (src) out += '![' + escapeText(alt) + '](' + src + ')';
      else if (alt) out += alt;
    } else if (c.tag === 'strong' || c.tag === 'b') {
      out += '**' + serializeInline(c.children, ctx) + '**';
    } else if (c.tag === 'em' || c.tag === 'i') {
      out += '*' + serializeInline(c.children, ctx) + '*';
    } else if (c.tag === 'code') {
      out += '`' + decodeEntities(getText(c)) + '`';
    } else {
      out += serializeInline(c.children, ctx);
    }
  }
  return out;
}

function serializeBlockChildren(children, ctx) {
  const parts = [];
  for (const c of children) {
    const s = serializeBlock(c, ctx);
    if (s && s.trim()) parts.push(s.trim());
  }
  return parts.join('\n\n');
}

function serializeList(node, ctx, ordered) {
  let i = 0;
  const items = node.children.filter((c) => c.tag === 'li');
  return items
    .map((li) => {
      i++;
      const prefix = ordered ? i + '. ' : '- ';
      const headParts = [];
      const subLists = [];
      for (const c of li.children) {
        if (typeof c === 'object' && (c.tag === 'ul' || c.tag === 'ol')) subLists.push(c);
        else headParts.push(c);
      }
      const head = serializeBlockChildren(headParts, ctx)
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .join(' ');
      let out = prefix + head;
      for (const sl of subLists) {
        const sub = serializeBlock(sl, ctx);
        out += '\n' + sub.split('\n').map((l) => '  ' + l).join('\n');
      }
      return out;
    })
    .join('\n');
}

function serializeTable(node, ctx) {
  const rows = [];
  const walk = (n) => {
    if (n.tag === 'tr') rows.push(n);
    if (typeof n === 'object' && n.children) for (const c of n.children) walk(c);
  };
  walk(node);
  if (!rows.length) return '';
  const toCells = (tr) =>
    tr.children
      .filter((c) => c.tag === 'td' || c.tag === 'th')
      .map((c) => serializeInline(c.children, ctx).trim().replace(/\s+/g, ' '));
  const header = toCells(rows[0]);
  const lines = [];
  lines.push('| ' + header.join(' | ') + ' |');
  lines.push('| ' + header.map(() => '---').join(' | ') + ' |');
  for (let r = 1; r < rows.length; r++) {
    const cells = toCells(rows[r]);
    while (cells.length < header.length) cells.push('');
    lines.push('| ' + cells.join(' | ') + ' |');
  }
  return lines.join('\n');
}

function serializeBlock(node, ctx) {
  if (node.type === 'text') {
    const t = node.text.replace(/\s+/g, ' ').trim();
    return t ? escapeText(decodeEntities(t)) : '';
  }
  const tag = node.tag;
  if (tag === '#root') return serializeBlockChildren(node.children, ctx);

  switch (tag) {
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      const level = +tag[1];
      return '#'.repeat(level) + ' ' + serializeInline(node.children, ctx).trim();
    }
    case 'p':
      return serializeInline(node.children, ctx).trim();
    case 'pre':
      return '```\n' + decodeEntities(getText(node)).replace(/\n$/, '') + '\n```';
    case 'blockquote': {
      const inner = serializeBlockChildren(node.children, ctx);
      return inner.split('\n').map((l) => '> ' + l).join('\n');
    }
    case 'ul':
      return serializeList(node, ctx, false);
    case 'ol':
      return serializeList(node, ctx, true);
    case 'li':
      return '- ' + serializeInline(node.children, ctx).trim();
    case 'table':
      return serializeTable(node, ctx);
    case 'hr':
      return '---';
    case 'br':
      return '';
    case 'img': {
      const src = sanitizeUrl(node.attrs.src || '', ctx.base);
      const alt = node.attrs.alt || '';
      if (ctx.noImages) return alt || '';
      if (src) return '![' + escapeText(alt) + '](' + src + ')';
      return alt || '';
    }
    case 'a': {
      const href = sanitizeUrl(node.attrs.href || '', ctx.base);
      const label = serializeInline(node.children, ctx).trim();
      return href ? '[' + label + '](' + href + ')' : label;
    }
    case 'div': case 'section': case 'article': case 'main':
    case 'figure': case 'figcaption': {
      if (hasBlockChild(node)) return serializeBlockChildren(node.children, ctx);
      return serializeInline(node.children, ctx).trim();
    }
    case 'span': case 'strong': case 'b': case 'em': case 'i':
    case 'code': case 'small': case 'mark': case 'u': case 'sub':
    case 'sup': case 'label': case 'font':
      return serializeInline([node], ctx);
    default:
      return serializeBlockChildren(node.children, ctx);
  }
}

/* ============================ 公共转换 API ============================ */
function convert(html, opts) {
  opts = opts || {};
  const meta = extractMeta(html);
  const tree = buildTree(tokenize(html));
  prune(tree);
  let content = extractContent(tree);

  let md = serializeBlock(content, {
    base: opts.url || meta.canonical || '',
    noImages: !!opts.noImages,
  });
  md = sanitizeControl(md).replace(/\n{3,}/g, '\n\n').trim();

  if (opts.max && opts.max > 0) {
    const words = md.split(/\s+/);
    if (words.length > opts.max) md = words.slice(0, opts.max).join(' ') + ' …';
  }
  if (opts.title && meta.title) {
    // 防 title 元数据 Markdown 头注入：单行化 + 行首特殊符转义
    const safeTitle = meta.title
      .replace(/\r?\n/g, ' ')
      .replace(/^([#>\-*`])/, '\\$1')
      .trim();
    md = '# ' + safeTitle + '\n\n' + md;
  }

  return {
    ok: true,
    title: meta.title,
    description: sanitizeControl(meta.description).replace(/\s+/g, ' ').trim(),
    markdown: md,
    text: md.replace(/[#>*_`\-|]/g, ' ').replace(/\s+/g, ' ').trim(),
    url: opts.url || '',
  };
}

/* ============================ fetch ============================ */
const PRIVATE_HOST = /^(localhost|127\.|::1|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i;

const MAX_BODY = 50 * 1024 * 1024; // 响应体上限 50MB，防 OOM

function fetchUrl(target, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    let redirects = 0;
    const doFetch = (u) => {
      let url;
      try { url = new URL(u); } catch (e) { return reject(new Error('非法 URL: ' + u)); }
      if (url.protocol !== 'http:' && url.protocol !== 'https:')
        return reject(new Error('仅支持 http/https 协议'));
      const host = url.hostname;
      // SSRF 防护：默认拒绝私有/回环地址，--allow-private 可放开（如本地 dev server）
      if (PRIVATE_HOST.test(host) && !opts.allowPrivate)
        return reject(new Error('拒绝访问私有/回环地址 ' + host + '（如需允许加 --allow-private）'));

      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.get(
        u,
        { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' } },
        (res) => {
          const { statusCode } = res;
          const loc = res.headers.location;
          if (statusCode >= 300 && statusCode < 400 && loc) {
            if (++redirects > 5) { res.resume(); return reject(new Error('重定向过多')); }
            const next = new URL(loc, u).toString();
            res.resume();
            return doFetch(next, opts);
          }
          if (statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + statusCode)); }
          const enc = res.headers['content-encoding'];
          let stream = res;
          if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
          else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
          const chunks = [];
          let total = 0;
          stream.on('data', (c) => {
            total += c.length;
            if (total > MAX_BODY) {
              stream.destroy();
              return reject(new Error('响应体过大（>' + MAX_BODY + ' 字节）'));
            }
            chunks.push(c);
          });
          stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          stream.on('error', reject);
        }
      );
      req.on('error', reject);
      req.setTimeout(15000, () => req.destroy(new Error('请求超时')));
    };
    doFetch(target, opts);
  });
}

/* ============================ CLI ============================ */
function printHelp() {
  process.stdout.write(
    `pagext —— 零依赖网页正文提取器

用法:
  pagext <url>                抓取 URL 并输出 Markdown
  pagext <file.html>          转换本地 HTML 文件
  pagext --stdin             从 stdin 读取 HTML
  cat page.html | pagext     同上（管道）

选项:
  -u, --url <url>            指定 URL（同位置参数）
  -i, --input <file>         指定本地 HTML 文件
  --title                    把页面 <title> 作为 H1 前置
  --no-images               不输出图片行（省 token）
  --format <md|text|json>    输出格式（默认 md）
  --max <n>                  按词数截断输出
  -o, --output <file>        写入文件而非 stdout
  -h, --help                 显示本帮助
`
  );
}

function main() {
  const argv = process.argv.slice(2);
  let src = null;
  let output = null;
  let format = 'md';
  let stdin = false;
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stdin') stdin = true;
    else if (a === '-i' || a === '--input') src = argv[++i];
    else if (a === '-u' || a === '--url') src = argv[++i];
    else if (a === '--title') opts.title = true;
    else if (a === '--no-images') opts.noImages = true;
    else if (a === '--allow-private') opts.allowPrivate = true;
    else if (a === '--format') format = argv[++i];
    else if (a === '-o' || a === '--output') output = argv[++i];
    else if (a === '--max') opts.max = parseInt(argv[++i], 10);
    else if (a === '-h' || a === '--help') { printHelp(); return; }
    else if (!a.startsWith('-')) src = src || a;
  }

  (async () => {
    let html;
    if (stdin) {
      html = fs.readFileSync(0, 'utf8');
    } else if (!src) {
      process.stderr.write('缺少输入：URL / 文件路径 / --stdin\n');
      process.exit(2);
    } else if (/^https?:\/\//i.test(src)) {
      html = await fetchUrl(src, opts);
      opts.url = src;
    } else if (fs.existsSync(src)) {
      html = fs.readFileSync(src, 'utf8');
    } else {
      process.stderr.write('文件不存在，且输入非 URL/HTML：' + src + '\n');
      process.exit(2);
    }

    if (!html || !html.trim()) {
      process.stderr.write('警告：输入为空，无内容可转换\n');
    }

    const res = convert(html, opts);
    let out;
    if (format === 'json') out = JSON.stringify(res, null, 2);
    else if (format === 'text') out = res.text;
    else out = res.markdown;

    if (output) fs.writeFileSync(output, out + '\n');
    else process.stdout.write(out + '\n');
  })().catch((e) => {
    process.stderr.write('错误: ' + e.message + '\n');
    process.exit(1);
  });
}

module.exports = {
  tokenize, buildTree, decodeEntities, getText, textLength,
  scoreNode, extractContent, prune, extractMeta, sanitizeUrl,
  serializeBlock, convert, fetchUrl,
};

if (require.main === module) main();
