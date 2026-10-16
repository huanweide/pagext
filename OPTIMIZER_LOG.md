# 优化器工作日志 — pagext

## Round 1 · 2026-10-16

**存活评估**：保留。同类对比后，「零依赖 + 单文件 + 内置 fetch」交集无碾压级替代。

**方向**：单点深度特化 —— 参数契约与门禁可信度。

### 做了什么

1. **参数契约从「沉默」改为「报错」**
   原实现对所有参数错误一律静默成功（rc=0）：
   `--max abc` / `--max` 缺值 / `--format xml` / `--bogus` / 拼错的 `--stin`
   → 全部改为退 2 并给出明确 stderr。抽出 `parseArgs` 纯函数 + `UsageError` 类（`--help` 返回 null 表示「打印后退出」）。

2. **`process.exit()` → `process.exitCode`**
   前者会截断 stdout，导致 `--format json` 在出错路径下输出残缺 JSON。

3. **spawn 级冒烟 `scripts/smoke-cli.js`（25 断言）**
   为什么必须有：`node --test` 只测导出函数，**根本不碰进程级行为**。变异测试证明：改退出码逻辑时单测可全绿。

4. **CI**：Node 18/20/22 × ubuntu/windows，含单测 + 冒烟 + 零依赖自证 + README 与实现一致性。
   零依赖自证很关键：仓库一旦混入 `node_modules` 就说明「零依赖」这个核心卖点已破。

5. **README 三处真缺陷**
   - `npx pagext` / `npm i -g pagext` 实测 **404**（包从未发布）→ 改为 clone 直跑 + `npm i -g github:huanweide/pagext`
   - 尾部整段「它会输出健康分与严重度」是从家族体检 CLI 模板复制来的，本项目根本没有健康分 → 改写为真实的 CI 体量断言示例
   - `--allow-private` 从未在文档出现；`## License` 与 `## 许可证` 重复 → 补文档、删重复节

### 验证

- `node --test test.js` → 23/23 绿（原 14）
- `node scripts/smoke-cli.js` → ALL_OK（25 断言）
- 变异测试 **5/5 被拦截**，其中两条首版漏网，据此补强断言
- README 门禁本地注入 `npx pagext` 实测能抓到

### 自身失误

- 首次 Edit README 时误删「为什么是 pagext」标题 —— 大段重排必须先 Read 定位再改。
- 初版冒烟对「`--format` 缺值」的断言过弱，被 M4 变异证明是假阳性，已补强为自证 stderr 内容。
