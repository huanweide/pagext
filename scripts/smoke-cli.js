#!/usr/bin/env node
// spawn 级冒烟：真实跑进程，验证退出码契约与 stdout 完整性。
// 为什么必须有这一层：node --test 的单测只 import 导出的函数，
// 根本不碰 process.exitCode / 参数解析的进程级行为——改坏了单测全绿。
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CLI = path.join(__dirname, '..', 'index.js');
const FIXTURE = `<html><head><title>Smoke</title></head><body><article>
<h1>Head</h1><p>alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu</p>
<p>second paragraph with enough words to survive a truncation limit applied downstream.</p>
</article></body></html>`;

let fails = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok  ' + name); }
  else { console.error('  FAIL ' + name + (detail ? ' -> ' + detail : '')); fails++; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pagext-smoke-'));
const html = path.join(tmp, 'a.html');
fs.writeFileSync(html, FIXTURE);

function run(args, input) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    input: input === undefined ? '' : input,
    encoding: 'utf8',
  });
  return r;
}

console.log('# 退出码契约：用法错误必须退 2');
for (const [desc, args] of [
  ['无输入', []],
  ['未知选项', [html, '--bogus']],
  ['拼错选项 --stin', [html, '--stin']],
  ['--max 缺值', [html, '--max']],
  ['--max abc', [html, '--max', 'abc']],
  ['--max 0', [html, '--max', '0']],
  ['--max -5', [html, '--max', '-5']],
  ['--format 非法值', [html, '--format', 'xml']],
  ['--format 缺值', [html, '--format']],
  ['文件不存在', [path.join(tmp, 'nope.html')]],
]) {
  const r = run(args);
  check(desc + ' -> rc=2', r.status === 2, 'rc=' + r.status + ' stderr=' + (r.stderr || '').trim());
}

console.log('# 正常路径必须退 0 且有内容');
{
  const r = run([html]);
  check('md 输出 rc=0', r.status === 0, 'rc=' + r.status + ' ' + r.stderr);
  check('md 输出含 Head', /Head/.test(r.stdout));
}
{
  const r = run([html, '--format', 'json']);
  check('json rc=0', r.status === 0);
  let ok = false, parsed = null;
  try { parsed = JSON.parse(r.stdout); ok = true; } catch (e) { /* 截断 */ }
  check('json 输出是完整合法 JSON（验证 process.exitCode 不截断 stdout）', ok, 'stdout 长度=' + r.stdout.length);
  check('json 含 markdown/title/text', ok && typeof parsed.markdown === 'string' && typeof parsed.title === 'string' && typeof parsed.text === 'string');
}
{
  const r = run([html, '--format', 'text']);
  check('text rc=0', r.status === 0);
  check('text 不含 markdown 标记', ok0(r.stdout));
}
{
  const r = run(['--stdin'], FIXTURE);
  check('--stdin rc=0', r.status === 0);
  check('--stdin 有内容', /alpha/.test(r.stdout));
}
{
  const out = path.join(tmp, 'a.md');
  const r = run([html, '-o', out]);
  check('-o rc=0', r.status === 0);
  check('-o 写出文件', fs.existsSync(out) && /Head/.test(fs.readFileSync(out, 'utf8')));
}
{
  const r = run([html, '--max', '3']);
  check('--max 3 生效（词数被截断）', r.status === 0 && r.stdout.trim().split(/\s+/).length <= 4,
    'stdout=' + JSON.stringify(r.stdout.slice(0, 200)));
}
{
  const r = run(['--help']);
  check('--help rc=0 且有用法', r.status === 0 && /--format/.test(r.stdout));
}
{
  const r = run([html, '--no-images', '--title']);
  check('组合开关 rc=0', r.status === 0);
}
{
  const r = run(['https://127.0.0.1:9/x']);
  check('私有/回环地址被拒 -> 非 0', r.status !== 0, 'rc=' + r.status);
}

function ok0(s) { return !/^#{1,6}\s|\]\(|\*\*|__/.test(s); }

console.log('# 源码级防线：禁止 process.exit()（会截断 stdout）');
{
  const src = fs.readFileSync(CLI, 'utf8');
  const offenders = [];
  src.split('\n').forEach((line, i) => {
    if (/[^.\w]process\.exit\s*\(/.test(line)) offenders.push((i + 1) + ': ' + line.trim());
  });
  check('index.js 中无 process.exit()（统一用 process.exitCode）', offenders.length === 0, offenders.join(' | '));
}
{ // --max 缺值与 --format 缺值必须各自独立被拦（防冗余校验互相掩盖）
  const a = run([html, '--format']);
  check('--format 缺值 stderr 指明缺取值', a.status === 2 && /缺少取值/.test(a.stderr), a.stderr);
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(fails === 0 ? '\nALL_OK' : `\nFAILED: ${fails}`);
process.exitCode = fails === 0 ? 0 : 1;