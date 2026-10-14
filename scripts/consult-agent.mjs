#!/usr/bin/env node
/**
 * 施工方通道（推荐）：起一个**独立的 Codex agent** 去做活。
 *
 * 与 consult-ccswitch.mjs 的区别是决定性的：
 *   consult-ccswitch.mjs  调的是**模型 HTTP 接口** —— 只回文字，看不到仓库，产出只能是"施工单"
 *   本脚本                起的是 `codex exec` 子进程 —— **真 agent**，能读文件、改文件、跑命令
 *
 * 用法：
 *   node consult-agent.mjs --brief 任务单.md --out 产出.md
 *   node consult-agent.mjs --brief 追问.md --prior 上一轮产出.md --sandbox workspace-write
 *
 * 关键参数：
 *   --sandbox  read-only | workspace-write | danger-full-access   （默认 read-only，要动手必须显式放开）
 *   --model    不传则用 ~/.codex/config.toml 的默认模型（本机即 cc-switch 代理上的 deepseek-v4.1-flash）
 *   --cd       工作根目录，默认当前目录
 *   --timeout  秒，默认 900
 *   --prior    上一轮产出，会作为"上一轮"上下文拼进 prompt
 *
 * 约定：正文走 stdout，诊断信息走 stderr。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
if (!flags.brief) {
  process.stderr.write('用法：node consult-agent.mjs --brief 任务单.md [--out 产出.md] [--sandbox workspace-write]\n');
  process.exit(2);
}

const sandbox = String(flags.sandbox || 'read-only');
const timeoutMs = Number(flags.timeout || 900) * 1000;
const cwd = flags.cd ? String(flags.cd) : process.cwd();

let prompt = readFileSync(String(flags.brief), 'utf8');
if (flags.prior) {
  prompt = `【上一轮你的产出】\n\n${readFileSync(String(flags.prior), 'utf8')}\n\n【本轮】\n\n${prompt}`;
}

// ⚠️ 本机实测出来的两个必需参数，别省：
//   不显式指定 provider 时，codex exec 走**内置 openai provider** —— 它会去刷新 ChatGPT
//   token（本机 auth.json 的 refresh_token 是空的 → 400），并且尝试 ws://127.0.0.1:15721/v1/responses
//   （代理不支持 WebSocket 升级 → 426 Upgrade Required），最后 5 次重连后退出码 1。
//   显式指到 custom（即 cc-switch 本地代理）之后才走 HTTP，并真用上 config 里的模型。
const provider = String(flags.provider || process.env.DUAL_MODEL_BUILDER_PROVIDER || 'custom');
const model = String(flags.model || process.env.DUAL_MODEL_BUILDER_MODEL || 'ccs-opencode-go/deepseek-v4.1-flash');

const outFile = join(mkdtempSync(join(tmpdir(), 'consult-agent-')), 'last-message.md');
const args = [
  'exec',
  '-c', `model_provider=${provider}`,
  '-m', model,
  '--cd', cwd,
  '-s', sandbox,
  '-o', outFile,
  '-',
];

process.stderr.write(`起一个 Codex agent 干活（provider=${provider}, model=${model}, sandbox=${sandbox}）…\n`);

const child = spawn('codex', args, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.write(prompt);
child.stdin.end();

const timer = setTimeout(() => {
  process.stderr.write(`⏱ 超过 ${timeoutMs / 1000}s，终止\n`);
  child.kill();
}, timeoutMs);

const code = await new Promise((resolve) => child.on('close', resolve));
clearTimeout(timer);

let last = '';
try {
  last = readFileSync(outFile, 'utf8');
} catch {
  /* 没产出就是空 */
}

if (flags.out) {
  writeFileSync(String(flags.out), last, 'utf8');
  process.stderr.write(`已写入 ${flags.out}\n`);
}
process.stderr.write(`agent 退出码=${code}，产出 ${last.length} 字\n`);
process.stdout.write(last);
if (code !== 0) process.exit(code);