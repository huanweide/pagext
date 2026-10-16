'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const px = require('./index.js');

test('decodeEntities: 命名与数字实体', () => {
  assert.equal(px.decodeEntities('a &amp; b &lt;c&gt;'), 'a & b <c>');
  assert.equal(px.decodeEntities('&quot;x&quot; &apos;y&apos;'), '"x" \'y\'');
  assert.equal(px.decodeEntities('&#65;&#x41;'), 'AA'); // A A
  assert.equal(px.decodeEntities('&nbsp;空格'), ' 空格');
});

test('tokenize + buildTree: 标签与文本结构', () => {
  const root = px.buildTree(px.tokenize('<div class="a">hi <b>bold</b></div>'));
  assert.equal(root.children.length, 1);
  const div = root.children[0];
  assert.equal(div.tag, 'div');
  assert.equal(div.attrs.class, 'a');
  // 属性里含 > 不应截断
  const root2 = px.buildTree(px.tokenize('<a href="x>y">t</a>'));
  assert.equal(root2.children[0].attrs.href, 'x>y');
});

test('extractContent: 噪声(导航/广告/页脚)被剔除，正文保留', () => {
  const html = `<html><head><title>测试页</title><meta name="description" content="这是描述"></head>
<body>
<nav><a href="/x">首页</a><a href="/y">关于</a></nav>
<aside><div>广告广告广告广告广告广告广告广告广告广告广告广告广告广告广告广告</div></aside>
<article>
<h1>主标题</h1>
<p>这是第一段正文内容，用来验证正文提取器确实能把页面中的无用区块过滤掉，只留下真正有信息量的文字部分，这一段要足够长以超过阈值。</p>
<p>这是第二段正文，我们特意加入大量标点。来衡量正文密度。从而让评分函数选中 article 节点而不是外层的杂讯容器。这样输出才干净。</p>
<p>第三段继续补充内容，确保文章整体文本长度足够大，避免回退到 body 时混入其它残留节点，保证测试结论稳定可复现。</p>
</article>
<footer><a href="/p">隐私</a><a href="/t">条款</a></footer>
</body></html>`;
  const res = px.convert(html, {});
  assert.match(res.markdown, /主标题/);
  assert.match(res.markdown, /第一段正文/);
  assert.match(res.markdown, /第三段/);
  // 噪声不应出现
  assert.doesNotMatch(res.markdown, /广告/);
  assert.doesNotMatch(res.markdown, /首页/);
  assert.doesNotMatch(res.markdown, /隐私/);
  assert.doesNotMatch(res.markdown, /条款/);
  // 元数据
  assert.equal(res.title, '测试页');
  assert.equal(res.description, '这是描述');
});

test('标签→MD: 标题/链接/代码块/列表/表格', () => {
  const html = `<body>
<h2>小节</h2>
<p>参见 <a href="https://e.com/p">外链</a> 与 <code>inline()</code> 代码。</p>
<pre><code>def f():\n    return 1</code></pre>
<ul><li>甲</li><li>乙</li></ul>
<ol><li>一</li><li>二</li></ol>
<table><tr><th>名</th><th>值</th></tr><tr><td>a</td><td>1</td></tr></table>
</body>`;
  const md = px.convert(html, {}).markdown;
  assert.match(md, /## 小节/);
  assert.match(md, /\[外链\]\(https:\/\/e\.com\/p\)/);
  assert.match(md, /`inline\(\)`/);
  assert.match(md, /```\ndef f\(\):\n    return 1\n```/);
  assert.match(md, /\n- 甲\n- 乙/);
  assert.match(md, /\n1\. 一\n2\. 二/);
  assert.match(md, /\| 名 \| 值 \|\n\| --- \| --- \|\n\| a \| 1 \|/);
});

test('sanitizeUrl: 危险协议拒绝，相对链接解析绝对', () => {
  assert.equal(px.sanitizeUrl('javascript:alert(1)', ''), '');
  assert.equal(px.sanitizeUrl('JAvaSCRIPT:alert(1)', ''), '');
  assert.equal(px.sanitizeUrl('vbscript:msgbox(1)', ''), '');
  assert.equal(px.sanitizeUrl('../c', 'https://example.com/a/b'), 'https://example.com/c');
  assert.equal(px.sanitizeUrl('/abs', 'https://example.com/a/b'), 'https://example.com/abs');
});

test('convert: javascript: 链接渲染为纯文本(防注入)', () => {
  const md = px.convert('<body><p><a href="javascript:alert(1)">危险词</a></p></body>', {}).markdown;
  assert.doesNotMatch(md, /javascript/);
  assert.match(md, /危险词/);
});

test('sanitizeControl: 去除 C0 控制字符', () => {
  const md = px.convert('<body><p>正常\x1b[2J文本\x07结尾</p></body>', {}).markdown;
  assert.doesNotMatch(md, /\x1b/);
  assert.doesNotMatch(md, /\x07/);
  assert.match(md, /正常/);
  assert.match(md, /结尾/);
});

test('convert: script/style 内容不泄露到输出', () => {
  const html = `<body><script>var secret='should_not_appear';</script>
<style>.x{color:red}</style>
<p>可见正文。</p></body>`;
  const md = px.convert(html, {}).markdown;
  assert.doesNotMatch(md, /should_not_appear/);
  assert.doesNotMatch(md, /color:red/);
  assert.match(md, /可见正文/);
});

test('convert: --title 前置 H1', () => {
  const html = `<html><head><title>页标题</title></head><body><p>内容</p></body></html>`;
  const md = px.convert(html, { title: true }).markdown;
  assert.match(md, /^# 页标题\n\n内容/);
});

test('sanitizeUrl: 危险 data: 拒绝，仅放行图片 data:', () => {
  assert.equal(px.sanitizeUrl('data:text/html,<script>alert(1)</script>', ''), '');
  assert.equal(px.sanitizeUrl('data:image/svg+xml;base64,xx', ''), '');
  assert.equal(px.sanitizeUrl('data:image/png;base64,xxx', ''), 'data:image/png;base64,xxx');
  const md = px.convert('<body><p><a href="data:text/html,<script>x</script>">点</a></p></body>', {}).markdown;
  assert.doesNotMatch(md, /data:text\/html/);
  assert.doesNotMatch(md, /<script>/);
});

test('convert: title 元数据注入被转义', () => {
  const html = `<html><head><title># 假标题
## 注入</title></head><body><h1>真标题</h1><p>正文。</p></body></html>`;
  const md = px.convert(html, { title: true }).markdown;
  assert.doesNotMatch(md, /^## 注入/m);
  assert.match(md, /\\# 假标题/);
});

test('convert: void 元素(<br>/<img>)不被闭合标签丢弃', () => {
  const md = px.convert('<body><p>a<br>b<img src="x.png" alt="图">c</p></body>', {}).markdown;
  assert.match(md, /a/);
  assert.match(md, /b/);
  assert.match(md, /c/);
  assert.match(md, /!\[图\]\(x\.png\)/);
});

test('convert: 嵌套列表不产生空行（CommonMark 缩进）', () => {
  const html = '<body><ul><li>甲<ul><li>子1</li><li>子2</li></ul></li><li>乙</li></ul></body>';
  const md = px.convert(html, {}).markdown;
  assert.doesNotMatch(md, /- 甲\n {2}\n/);
  assert.match(md, /- 甲\n {2}- 子1/);
  assert.match(md, /- 子2\n- 乙/);
});

test('fetchUrl: 默认拒绝私有/回环地址', async () => {
  await assert.rejects(px.fetchUrl('http://127.0.0.1/', {}));
  await assert.rejects(px.fetchUrl('http://169.254.169.254/', {}));
});


// ---- 参数解析契约（纯函数层；进程级行为由 scripts/smoke-cli.js 覆盖）----
const usage = (argv) => {
  try { px.parseArgs(argv); return null; }
  catch (e) { assert.ok(e instanceof px.UsageError, '应为 UsageError，实际 ' + e.name); return e.message; }
};

test('parseArgs: 正常组合解析正确', () => {
  const a = px.parseArgs(['https://x.dev/a', '--title', '--no-images', '--format', 'json', '--max', '20']);
  assert.equal(a.src, 'https://x.dev/a');
  assert.equal(a.format, 'json');
  assert.equal(a.opts.max, 20);
  assert.equal(a.opts.title, true);
  assert.equal(a.opts.noImages, true);
  assert.equal(a.stdin, false);
  assert.equal(a.output, null);
});

test('parseArgs: --max 允许小数并向下取整', () => {
  assert.equal(px.parseArgs(['-u', 'x', '--max', '3.9']).opts.max, 3);
});

test('parseArgs: 用法错误一律抛 UsageError', () => {
  assert.match(usage(['--bogus']), /未知选项/);
  assert.match(usage(['--stin']), /未知选项/);
  assert.match(usage(['--max']), /缺少取值/);
  assert.match(usage(['--max', 'abc']), /正整数/);
  assert.match(usage(['--max', '0']), /正整数/);
  assert.match(usage(['--max', '-1']), /正整数/);
  assert.match(usage(['--format', 'xml']), /非法/);
  assert.match(usage(['--format']), /缺少取值/);
  assert.match(usage(['-o']), /缺少取值/);
});

test('parseArgs: -i / -u / --input / --url / -o / --output 均被识别', () => {
  for (const f of ['-i', '--input', '-u', '--url']) {
    assert.equal(px.parseArgs([f, 'v.html']).src, 'v.html');
  }
  for (const f of ['-o', '--output']) {
    assert.equal(px.parseArgs([f, 'out.md']).output, 'out.md');
  }
});

test('parseArgs: 单独 "-" 不被当作未知选项（视作 stdin 惯例）', () => {
  assert.doesNotThrow(() => px.parseArgs(['-']));
});

test('parseArgs: 位置参数优先保留首个，后续位置参数忽略', () => {
  assert.equal(px.parseArgs(['a.html', 'b.html']).src, 'a.html');
  assert.equal(px.parseArgs(['-u', 'u.html', 'b.html']).src, 'u.html');
});

test('parseArgs: --help 返回 null（调用方负责打印后退出）', () => {
  assert.equal(px.parseArgs(['--help']), null);
  assert.equal(px.parseArgs(['-h']), null);
});

test('parseArgs: 空 argv 不算语法错（缺输入由 main 报「缺少输入」，仍退 2）', () => {
  const a = px.parseArgs([]);
  assert.equal(a.src, null);
  assert.equal(a.stdin, false);
});

test('契约: UsageError 是 Error 子类且被导出', () => {
  assert.ok(new px.UsageError('x') instanceof Error);
});
