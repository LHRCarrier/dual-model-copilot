#!/usr/bin/env node
/**
 * 施工方通道：调用本机 cc-switch 代理上的模型。
 *
 * 为什么走本机代理而不是官方 API：Codex 自己就用这个口子（~/.codex/config.toml 里的
 * openai_base_url），不用额外配 key，也不用引任何厂商 SDK。代理没开时给一句能照做的提示。
 *
 * 用法：
 *   node consult-ccswitch.mjs --brief 任务单.md [--out 施工单.md]
 *   node consult-ccswitch.mjs --brief 追问.md --prior 上一轮产物.md      # 追问轮：带上上一轮
 *   node consult-ccswitch.mjs --check                       # 只看代理通不通
 *   Get-Content 任务单.md | node consult-ccswitch.mjs       # 从标准输入读
 *
 * 环境变量：
 *   BRIDGE_LLM_BASE    默认 http://127.0.0.1:15721/v1
 *   BRIDGE_LLM_MODEL   默认 ccs-opencode-go/deepseek-v4.1-flash
 *   BRIDGE_LLM_KEY     可选；代理自管鉴权时不用填
 *
 * 约定：正文走 stdout（方便重定向），诊断信息走 stderr。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const BASE = process.env.BRIDGE_LLM_BASE || 'http://127.0.0.1:15721/v1';
const MODEL = process.env.BRIDGE_LLM_MODEL || 'ccs-opencode-go/deepseek-v4.1-flash';

const SYSTEM = `你是施工方，只接收主代理已经界定好范围、目标、约束和验收标准的任务。

职责：把上游方案落成能直接照着做的施工单 —— 改哪个文件、改成什么、怎么验证；并指出方案里含糊、自相矛盾或落地有坑的地方。

不做：架构决策、扩大范围、代替主代理验收、输出"可以考虑……"这类空话。信息不足时直接返回阻塞点，不要猜。

输出按这四段，先说要紧的：
1. 结论与风险
2. 施工步骤（有序；每步写清：文件 / 改动 / 验证方式）
3. 需要主代理确认的阻塞点
4. 未验证项与风险`;

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));
const url = `${BASE.replace(/\/$/, '')}/chat/completions`;
const headers = { 'content-type': 'application/json' };
if (process.env.BRIDGE_LLM_KEY) headers.authorization = `Bearer ${process.env.BRIDGE_LLM_KEY}`;

async function callModel(messages, { maxTokens, temperature }) {
  const body = { model: flags.model || MODEL, messages, max_tokens: maxTokens };
  if (temperature != null) body.temperature = temperature;

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (err) {
    throw new Error(
      `连不上施工方通道 ${BASE}（${err.message}）。\n` +
        'cc-switch 代理没在跑？先确认它的进程起着，或设 BRIDGE_LLM_BASE 指向别处。',
    );
  }
  if (!res.ok) throw new Error(`施工方通道返回 ${res.status}：${(await res.text()).slice(0, 400)}`);

  const data = await res.json();
  const choice = data.choices?.[0];
  return {
    content: choice?.message?.content ?? '',
    reasoning: choice?.message?.reasoning_content ?? '',
    finishReason: choice?.finish_reason ?? null,
    usage: data.usage ?? null,
    model: data.model ?? body.model,
  };
}

if (flags.check) {
  try {
    const res = await fetch(`${BASE.replace(/\/$/, '')}/models`);
    process.stderr.write(res.ok ? `施工方通道就绪：${BASE}\n` : `施工方通道异常：${res.status}\n`);
    process.exit(res.ok ? 0 : 1);
  } catch (err) {
    process.stderr.write(`施工方通道不通：${err.message}\n`);
    process.exit(1);
  }
}

let brief = '';
if (flags.brief) brief = readFileSync(String(flags.brief), 'utf8');
else if (!process.stdin.isTTY) brief = readFileSync(0, 'utf8');
else {
  process.stderr.write('用法：node consult-ccswitch.mjs --brief 任务单.md [--out 施工单.md]\n');
  process.exit(2);
}
if (!brief.trim()) {
  process.stderr.write('任务单是空的，没什么可交给施工方的。\n');
  process.exit(2);
}

process.stderr.write(`把任务单交给施工方（${flags.model || MODEL}）…\n`);

const messages = [
  { role: 'system', content: flags.system ? readFileSync(String(flags.system), 'utf8') : SYSTEM },
];
// --prior：追问轮要把上一轮产出带回去，否则模型会自相矛盾或重开一遍。
if (flags.prior) {
  messages.push({ role: 'assistant', content: readFileSync(String(flags.prior), 'utf8') });
}
messages.push({ role: 'user', content: brief });

const result = await callModel(messages, { maxTokens: Number(flags['max-tokens'] || 16384) });

if (!result.content.trim()) {
  process.stderr.write(
    `⚠️ 正文为空（finish_reason=${result.finishReason}）。这个模型会先吐 reasoning_content，` +
      'max_tokens 给小了就会出现"正文为空"的假象，用 --max-tokens 调大重试。\n',
  );
  if (result.reasoning) process.stderr.write(`推理片段：${result.reasoning.slice(0, 300)}\n`);
}

if (flags.out) {
  writeFileSync(String(flags.out), result.content, 'utf8');
  process.stderr.write(`已写入 ${flags.out}\n`);
}
if (result.usage) process.stderr.write(`用量：${JSON.stringify(result.usage)}\n`);

process.stdout.write(result.content);