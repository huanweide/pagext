<p align="center">
  <img src="assets/banner.svg" alt="pagext">
</p>

<p align="center">
  <a href="#为什么是-pagext而不是别的">30 秒看懂</a> · <a href="#用法">用法</a> · <a href="#作为库使用">API</a> · <a href="#提取质量说明">边界</a> · <a href="#ci-门禁用法">CI</a>
</p>

# pagext

> 零依赖、纯 Node 单文件网页正文提取器。一条命令把任意网页 / 本地 HTML / stdin 变成干净 Markdown。

[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![零依赖](https://img.shields.io/badge/dependencies-0-brightgreen)](./package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

给 LLM 喂网页时，原始 HTML 把 token 浪费在标签、样式、脚本、导航上。**pagext 只留下正文**，转成结构化 Markdown，直接喂模型、进 RAG、做归档。

```bash
# 免安装直接跑（仓库 clone 下来就能用，无需 node_modules）
node index.js https://example.com/article

# 本地文件 / 管道
node index.js page.html
cat page.html | node index.js --stdin
```

---

## 安装

本项目**零 npm 依赖、单文件**，因此**没有发布到 npm registry**（实测 `npm view pagext` 返回 404）。
用 npx 或 `npm i -g pagext` 目前都装不上，请用下面任一方式：

```bash
# 方式一：clone 后直接跑（推荐，零安装）
git clone https://github.com/huanweide/pagext.git
node pagext/index.js https://example.com

# 方式二：全局安装（npm 会从 GitHub 直装，无需发布）
npm install -g github:huanweide/pagext
pagext https://example.com
```

要求 Node.js >= 18（用到内置 `https`、正则命名组等）。

---

## 退出码契约

作为门禁 / 脚本组件使用时，请依赖这个约定：

| 退出码 | 含义 |
|--------|------|
| `0` | 成功 |
| `1` | 运行期错误（网络失败、文件读取失败等） |
| `2` | **用法错误**：未知选项、选项缺取值、`--max` 非正整数、`--format` 非法值、缺少输入 |

参数写错时**不会静默继续**——例如把 `--stdin` 拼成 `--stin`，CLI 会退 2 并提示未知选项，
而不是悄悄跳过 stdin 逻辑、给出一份你以为来自管道其实来自文件的结果。

---

## 为什么是 pagext（而不是别的）

| 竞品 | 依赖 | 内置 fetch | 提取算法 | 痛点 |
|------|------|-----------|---------|------|
| copy-as-markdown / Clipper / html2md | 必须 `npm install`（`@mozilla/readability` + `Turndown`） | 有 | Readability 黑盒 | 非零依赖单文件 |
| webread | 零依赖思想接近 | **无**（需外挂 fetcher） | 自研 | 没有 fetch 就不完整 |
| Web2MD / mdream | Rust / WASM | 有 | 自研 | 表面积巨大（crawl/MCP/llms.txt） |

**pagext = 零 npm 依赖 + 单文件 + 自带 fetch + 自研确定性提取** 的交集空白：

- 零依赖：只用 Node 内置 `https`/`fs`/`zlib`/`url`，`git clone` 即可跑，无 `node_modules`。
- 自带 fetch：内置 `https`，支持 gzip/deflate/重定向跟随，一条命令 URL→MD，不必配 fetcher。
- 自研确定性提取：自己写 tokenizer→树→Readability 式正文评分，结果可复现、可进 CI，不依赖 Readability 黑盒。
- 安全：剔除 `javascript:`/`vbscript:`/危险 `data:` 链接、清洗终端控制字符、限制私有/回环地址（SSRF 警示）。

---

## 用法

下文示例用 `pagext` 指代 CLI。若未全局安装，请把它替换成 `node /path/to/pagext/index.js`。

```bash
# 抓取 URL 并输出 Markdown
pagext https://example.com/article

# 把 <title> 作为 H1 前置
pagext https://example.com/article --title

# 不输出图片行（省 token）
pagext https://example.com/article --no-images

# 输出纯文本（去掉 Markdown 标记）
pagext https://example.com/article --format text

# 输出 JSON（含 title / description / markdown / text）
pagext https://example.com/article --format json

# 按词数截断（长文摘要友好）
pagext https://example.com/article --max 500

# 转换本地 HTML 文件
pagext article.html

# 从管道读取 HTML
cat article.html | pagext --stdin

# 写入文件
pagext https://example.com/article -o article.md

# 抓取内网/回环地址（默认拒绝，防 SSRF；确知目标安全时再开）
pagext http://192.168.1.10/status --allow-private
```

### 与工具链组合

```bash
# 转 Markdown 后用 glow 在终端渲染
pagext https://example.com/article | glow -

# 批量归档（配合 xargs）
cat urls.txt | xargs -I{} pagext {} -o {}.md

# 喂给本地 LLM
pagext https://example.com/docs | ollama run llama3 "总结要点"
```

---

## 提取质量说明

pagext 的提取器是 Readability 思路的**轻量自研版**（基于文本密度 + 标点密度 + 链接密度评分，优先 `<article>`/`<main>`），而非完整 Firefox 阅读视图引擎。在结构良好的文章页上效果干净；对 JS 重度渲染（SPA）或极端畸形页面，建议先用浏览器/无头工具拿到 HTML 再 `pagext --stdin`。这是我们为"零依赖单文件"刻意做的取舍——**不引入浏览器自动化依赖**。

---

## 作为库使用

```js
const pagext = require('pagext');

// 直接转换 HTML 字符串（不依赖网络）
const { markdown, title, description } = pagext.convert(htmlString, {
  url: 'https://example.com',  // 用于解析相对链接
  title: true,                 // 前置 <title> 为 H1
  noImages: false,
});

// 也可单独用内部能力
pagext.tokenize(html);
pagext.buildTree(tokens);
pagext.extractContent(tree);
pagext.fetchUrl('https://example.com'); // 返回 Promise<string>
```

---

## 四问摘要

**1. 痛点是什么？**
AI 时代高频需要把网页喂给模型/RAG/笔记，但原始 HTML 70–90% 是噪声（导航、广告、脚本、样式）。市面工具要么要装一堆依赖（Readability+Turndown）、要么零依赖却没 fetch、要么 Rust/WASM 重如泰山。一个"克隆即跑、一条命令、零依赖"的干净提取器是真实真空。

**2. 为什么是现在？**
LLM 喂料、RAG 建库、Agent 网页读取在 2025–2026 爆发，对"轻量、可复现、可进 CI"的 HTML→MD 需求陡增；而零依赖、单文件、自带 fetch 这三点交集目前没人占住。

**3. 差异化在哪？**
不依赖 Readability/Turndown/jsdom 黑盒，自研确定性解析与提取，结果可复现、可审计、可进 CI 门禁；零 npm 依赖 + 单文件 + 内置 fetch 三件套同时成立——这是 copy-as-markdown（要装依赖）、webread（没 fetch）、Web2MD/mdream（Rust 重）都没覆盖的缝隙。

**4. 为什么能长期维护？**
表面积小、逻辑集中在单文件、Node 内置 API 稳定；提取算法是确定性的纯函数（tokenizer/评分/序列化），无外部依赖漂移风险；单测覆盖解析与提取边界，改起来不易回归。新增站点规则/表格增强都是增量，不破坏既有结构。

---

## 作者

由 **ReTr · huanweide** 维护 · [GitHub 主页](https://github.com/huanweide)

---

## CI 门禁用法

pagext 本身不是「健康分」类门禁工具（本仓库其它项目的模板文案不要复制到这里）。
它在流水线里的正确用法是**输出体量断言**——把抓取结果当输入，检查它是否干净、够短、没把导航噪声漏进来：

```bash
# 1) 页面上限：正文超过 N 词说明噪声没剔干净，直接拦下
words=$(pagext "$URL" --format text | wc -w)
[ "$words" -gt 3000 ] && { echo "正文 $words 词，超出预期，疑似提取失效"; exit 1; }

# 2) 必须包含关键内容：抽不到正文说明选择器失配
pagext "$URL" | grep -q '关键短语' || { echo "未抽到正文"; exit 1; }

# 3) 用退出码契约：参数写错退 2，CI 里可区分「用错了」和「跑挂了」
pagext "$URL" --max abc || exit $?    # -> 2
```

本仓库自身的 CI（`.github/workflows/verify.yml`）做的是：Node 18/20/22 × ubuntu/windows
的单元测试 + CLI 冒烟 + 零依赖自证 + README 与实现一致性检查。


## 许可证

详见 [LICENSE](LICENSE)。
