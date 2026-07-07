#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TZ_OFFSET_H = 8;
export const DAY = 86400_000;

export function getApiKey() {
  if (process.env.VIBE_USAGE_API_KEY) return process.env.VIBE_USAGE_API_KEY;

  const configPath = join(homedir(), '.vibe-usage', 'config.json');
  if (existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    if (config.apiKey) return config.apiKey;
  }

  throw new Error('No API key: set VIBE_USAGE_API_KEY or run vibe-usage init');
}

export function localMs(iso, tzOffsetH = TZ_OFFSET_H) {
  return new Date(iso).getTime() + tzOffsetH * 3600_000;
}

export function windowBounds(nowMs = Date.now(), tzOffsetH = TZ_OFFSET_H) {
  const nowLocal = nowMs + tzOffsetH * 3600_000;
  const todayStart = Math.floor(nowLocal / DAY) * DAY;
  const curFrom = todayStart - 6 * DAY;
  const prevFrom = curFrom - 7 * DAY;

  return { todayStart, curFrom, prevFrom };
}

export function stats(buckets = [], sessions = []) {
  const summary = {
    cost: 0,
    total: 0,
    input: 0,
    output: 0,
    cached: 0,
    active: 0,
    duration: 0,
    sessions: sessions.length,
    msgs: 0,
    userMsgs: 0,
  };

  for (const bucket of buckets) {
    summary.cost += Number(bucket.estimatedCost) || 0;
    summary.total += (Number(bucket.totalTokens) || 0) + (Number(bucket.cachedInputTokens) || 0);
    summary.input += Number(bucket.inputTokens) || 0;
    summary.output += Number(bucket.outputTokens) || 0;
    summary.cached += Number(bucket.cachedInputTokens) || 0;
  }

  for (const session of sessions) {
    summary.active += Number(session.activeSeconds) || 0;
    summary.duration += Number(session.durationSeconds) || 0;
    summary.msgs += Number(session.messageCount) || 0;
    summary.userMsgs += Number(session.userMessageCount) || 0;
  }

  return summary;
}

export function fmtTok(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

export function fmtHrs(sec) {
  return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`;
}

export function fmtInt(n) {
  return Math.round(n).toLocaleString('en-US');
}

export function delta(current, previous) {
  if (!previous) return '';
  const pct = ((current - previous) / previous) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

export function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function inWindow(localTime, from) {
  return localTime >= from && localTime < from + 7 * DAY;
}

function splitUsage({ buckets = [], sessions = [] }, nowMs = Date.now()) {
  const { curFrom, prevFrom } = windowBounds(nowMs);
  const curB = buckets.filter((bucket) => inWindow(localMs(bucket.bucketStart), curFrom));
  const prevB = buckets.filter((bucket) => inWindow(localMs(bucket.bucketStart), prevFrom));
  const curS = sessions.filter((session) => inWindow(localMs(session.firstMessageAt), curFrom));
  const prevS = sessions.filter((session) => inWindow(localMs(session.firstMessageAt), prevFrom));

  return {
    curFrom,
    curB,
    prevB,
    curS,
    prevS,
    cur: stats(curB, curS),
    prev: stats(prevB, prevS),
  };
}

function buildDays(curB, curFrom) {
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const from = curFrom + i * DAY;
    const d = new Date(from);
    days.push({
      label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`,
      output: 0,
      input: 0,
      cached: 0,
      total: 0,
    });
  }

  for (const bucket of curB) {
    const i = Math.floor((localMs(bucket.bucketStart) - curFrom) / DAY);
    if (i >= 0 && i < 7) {
      days[i].output += Number(bucket.outputTokens) || 0;
      days[i].input += Number(bucket.inputTokens) || 0;
      days[i].cached += Number(bucket.cachedInputTokens) || 0;
      days[i].total += (Number(bucket.totalTokens) || 0) + (Number(bucket.cachedInputTokens) || 0);
    }
  }

  return days;
}

function buildHeat(curS) {
  const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));

  for (const session of curS) {
    const first = new Date(session.firstMessageAt);
    const hours = Array.isArray(session.userPromptHours) ? session.userPromptHours : [];

    for (let hUtc = 0; hUtc < 24; hUtc += 1) {
      const value = Number(hours[hUtc]) || 0;
      if (!value) continue;

      const shifted = hUtc + TZ_OFFSET_H;
      const hLocal = shifted % 24;
      const dow = (first.getUTCDay() + (shifted >= 24 ? 1 : 0)) % 7;
      heat[dow][hLocal] += value;
    }
  }

  return heat;
}

function cardSvg(card, x, y, cardW, cardH) {
  const big = card.value.length > 9 ? 20 : 24;
  return `
  <g>
    <rect x="${x}" y="${y}" width="${cardW}" height="${cardH}" rx="10" fill="#111113" stroke="#232326"/>
    <text x="${x + 16}" y="${y + 27}" font-size="12" fill="#a1a1aa">${esc(card.label)}</text>
    <text x="${x + cardW - 14}" y="${y + 27}" font-size="11" fill="#71717a" text-anchor="end">${esc(card.d)}</text>
    <text x="${x + 16}" y="${y + 64}" font-size="${big}" font-weight="700" fill="${card.color}">${esc(card.value)}</text>
  </g>`;
}

function pillRow(pad) {
  const items = ['今天', '24H', '7D', '30D', '90D', '自定义'];
  let x = pad;
  let out = `<rect x="${x}" y="14" width="248" height="26" rx="13" fill="#111113" stroke="#232326"/>`;

  for (const item of items) {
    const w = item.length * 12 + 16;
    const active = item === '7D';
    if (active) out += `<rect x="${x + 5}" y="17" width="${w}" height="20" rx="10" fill="#fafafa"/>`;
    out += `<text x="${x + 5 + w / 2}" y="31" font-size="11" text-anchor="middle" fill="${active ? '#09090b' : '#a1a1aa'}">${esc(item)}</text>`;
    x += w + 4;
  }

  x = pad + 258;
  for (const filter of ['工具 全部', '模型 全部', '项目 全部', '终端 全部']) {
    const w = filter.length * 11 + 30;
    out += `<rect x="${x}" y="14" width="${w}" height="26" rx="13" fill="#111113" stroke="#232326"/>
      <text x="${x + w / 2}" y="31" font-size="11" text-anchor="middle" fill="#a1a1aa">${esc(filter)} ▾</text>`;
    x += w + 8;
  }

  return out;
}

function trendPanel({ x, y, w, h, days }) {
  const chartX = x + 52;
  const chartY = y + 64;
  const chartW = w - 72;
  const chartH = h - 110;
  const maxV = Math.max(1, ...days.map((day) => day.total));
  const barW = Math.min(46, (chartW / 7) * 0.62);
  let bars = '';
  let labels = '';

  days.forEach((day, i) => {
    const cx = chartX + (chartW / 7) * (i + 0.5);
    const bh = Math.max(2, (day.total / maxV) * chartH);
    bars += `<rect x="${cx - barW / 2}" y="${chartY + chartH - bh}" width="${barW}" height="${bh}" rx="4" fill="url(#barGrad)"/>`;
    labels += `<text x="${cx}" y="${y + h - 18}" font-size="11" fill="#71717a" text-anchor="middle">${esc(day.label)}</text>`;
  });

  return `
  <g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="#0d0d0f" stroke="#232326"/>
    <text x="${x + 18}" y="${y + 30}" font-size="13" fill="#e4e4e7">每日趋势</text>
    <g font-size="10" fill="#71717a">
      <circle cx="${x + w - 218}" cy="${y + 26}" r="4" fill="#fafafa"/><text x="${x + w - 210}" y="${y + 30}">输出</text>
      <circle cx="${x + w - 178}" cy="${y + 26}" r="4" fill="#52525b"/><text x="${x + w - 170}" y="${y + 30}">输入</text>
      <circle cx="${x + w - 138}" cy="${y + 26}" r="4" fill="#3f3f46"/><text x="${x + w - 130}" y="${y + 30}">缓存</text>
    </g>
    <rect x="${x + w - 100}" y="${y + 15}" width="84" height="22" rx="11" fill="#111113" stroke="#232326"/>
    <rect x="${x + w - 98}" y="${y + 17}" width="34" height="18" rx="9" fill="#fafafa"/>
    <text x="${x + w - 81}" y="${y + 30}" font-size="10" text-anchor="middle" fill="#09090b">Token</text>
    <text x="${x + w - 48}" y="${y + 30}" font-size="10" text-anchor="middle" fill="#71717a">费用</text>
    <text x="${x + 40}" y="${chartY + 8}" font-size="10" fill="#52525b" text-anchor="end">${esc(fmtTok(maxV))}</text>
    <text x="${x + 40}" y="${chartY + chartH}" font-size="10" fill="#52525b" text-anchor="end">0</text>
    <line x1="${chartX}" y1="${chartY + chartH + 0.5}" x2="${chartX + chartW}" y2="${chartY + chartH + 0.5}" stroke="#232326"/>
    ${bars}
    ${labels}
  </g>`;
}

function heatPanel({ x, y, w, h, heat }) {
  const gridX = x + 52;
  const gridY = y + 58;
  const cols = 24;
  const rows = 7;
  const cell = Math.min((w - 78) / cols, (h - 130) / rows) - 2.5;
  const step = cell + 3;
  const heatMax = Math.max(1, ...heat.flat());
  const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const shades = ['#161618', '#2a2a2e', '#4b4b52', '#75757e', '#a8a8b0', '#e8e8ec'];
  let cells = '';
  let rowLabels = '';
  let colLabels = '';

  for (let r = 0; r < rows; r += 1) {
    rowLabels += `<text x="${gridX - 10}" y="${gridY + r * step + cell * 0.75}" font-size="10" fill="#71717a" text-anchor="end">${dayNames[r]}</text>`;

    for (let c = 0; c < cols; c += 1) {
      const value = heat[r][c];
      const level = value === 0 ? 0 : Math.min(5, 1 + Math.floor((value / heatMax) * 4.999));
      cells += `<rect x="${gridX + c * step}" y="${gridY + r * step}" width="${cell}" height="${cell}" rx="2.5" fill="${shades[level]}"/>`;
    }
  }

  for (let c = 0; c < cols; c += 3) {
    colLabels += `<text x="${gridX + c * step + cell / 2}" y="${gridY + rows * step + 16}" font-size="10" fill="#71717a" text-anchor="middle">${String(c).padStart(2, '0')}</text>`;
  }

  let legend = `<text x="${x + w - 130}" y="${y + h - 16}" font-size="10" fill="#71717a">少</text>`;
  shades.forEach((shade, i) => {
    legend += `<rect x="${x + w - 116 + i * 14}" y="${y + h - 25}" width="11" height="11" rx="2.5" fill="${shade}"/>`;
  });
  legend += `<text x="${x + w - 116 + shades.length * 14 + 4}" y="${y + h - 16}" font-size="10" fill="#71717a">多</text>`;

  return `
  <g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="#0d0d0f" stroke="#232326"/>
    <text x="${x + 18}" y="${y + 30}" font-size="13" fill="#e4e4e7">分时活跃</text>
    <rect x="${x + w - 100}" y="${y + 15}" width="84" height="22" rx="11" fill="#111113" stroke="#232326"/>
    <rect x="${x + w - 98}" y="${y + 17}" width="34" height="18" rx="9" fill="#fafafa"/>
    <text x="${x + w - 81}" y="${y + 30}" font-size="10" text-anchor="middle" fill="#09090b">Token</text>
    <text x="${x + w - 48}" y="${y + 30}" font-size="10" text-anchor="middle" fill="#71717a">费用</text>
    ${rowLabels}${cells}${colLabels}${legend}
  </g>`;
}

export function renderSvg({ buckets = [], sessions = [], nowMs = Date.now() }) {
  const { curFrom, curB, curS, cur, prev } = splitUsage({ buckets, sessions }, nowMs);
  const days = buildDays(curB, curFrom);
  const heat = buildHeat(curS);

  const W = 1024;
  const PAD = 16;
  const GAP = 13;
  const CARD_W = (W - PAD * 2 - GAP * 4) / 5;
  const CARD_H = 86;
  const row1Y = 54;
  const row2Y = row1Y + CARD_H + GAP;
  const panelY = row2Y + CARD_H + GAP;
  const panelH = 286;
  const PANEL_W = (W - PAD * 2 - GAP) / 2;
  const H = panelY + panelH + PAD;

  const cardsRow1 = [
    { label: '预估费用', value: `$${cur.cost.toFixed(2)}`, d: delta(cur.cost, prev.cost), color: '#4ade80' },
    { label: '总 Token', value: fmtTok(cur.total), d: delta(cur.total, prev.total), color: '#fafafa' },
    { label: '输入 Token', value: fmtTok(cur.input), d: delta(cur.input, prev.input), color: '#fafafa' },
    { label: '输出 Token', value: fmtTok(cur.output), d: delta(cur.output, prev.output), color: '#fafafa' },
    { label: '缓存 Token', value: fmtTok(cur.cached), d: delta(cur.cached, prev.cached), color: '#52525b' },
  ];
  const cardsRow2 = [
    { label: '活跃时长', value: fmtHrs(cur.active), d: delta(cur.active, prev.active), color: '#60a5fa' },
    { label: '总时长', value: fmtHrs(cur.duration), d: delta(cur.duration, prev.duration), color: '#fafafa' },
    { label: '会话数', value: fmtInt(cur.sessions), d: delta(cur.sessions, prev.sessions), color: '#fafafa' },
    { label: '总消息数', value: fmtInt(cur.msgs), d: delta(cur.msgs, prev.msgs), color: '#fafafa' },
    { label: '用户消息数', value: fmtInt(cur.userMsgs), d: delta(cur.userMsgs, prev.userMsgs), color: '#fafafa' },
  ];

  let cardsSvg = '';
  cardsRow1.forEach((card, i) => {
    cardsSvg += cardSvg(card, PAD + i * (CARD_W + GAP), row1Y, CARD_W, CARD_H);
  });
  cardsRow2.forEach((card, i) => {
    cardsSvg += cardSvg(card, PAD + i * (CARD_W + GAP), row2Y, CARD_W, CARD_H);
  });

  const now = new Date(nowMs + TZ_OFFSET_H * 3600_000);
  const stamp = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${String(now.getUTCDate()).padStart(2, '0')} ${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Vibe Usage 7-day dashboard: ${esc(fmtTok(cur.total))} tokens, $${cur.cost.toFixed(2)}, ${esc(fmtHrs(cur.active))} active">
  <defs>
    <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#d4d4d8"/>
      <stop offset="100%" stop-color="#52525b"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" rx="14" fill="#09090b"/>
  <g font-family="'JetBrains Mono','SF Mono','PingFang SC','Menlo',monospace" text-rendering="geometricPrecision">
    ${pillRow(PAD)}
    ${cardsSvg}
    ${trendPanel({ x: PAD, y: panelY, w: PANEL_W, h: panelH, days })}
    ${heatPanel({ x: PAD + PANEL_W + GAP, y: panelY, w: PANEL_W, h: panelH, heat })}
    <text x="${W - PAD - 4}" y="${H - 6}" font-size="9" fill="#3f3f46" text-anchor="end">更新于 ${stamp} UTC+8 · vibecafe.ai/usage</text>
  </g>
</svg>
`;
}

export async function fetchUsage(apiKey = getApiKey()) {
  const res = await fetch('https://vibecafe.ai/api/usage?days=14', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) throw new Error(`Vibe Usage API HTTP ${res.status}`);
  return res.json();
}

export async function generateCard({ outputPath = new URL('../vibe-usage-card.svg', import.meta.url), nowMs = Date.now() } = {}) {
  const { buckets = [], sessions = [] } = await fetchUsage();
  const svg = renderSvg({ buckets, sessions, nowMs });
  writeFileSync(outputPath, svg);

  const { cur } = splitUsage({ buckets, sessions }, nowMs);
  return {
    cost: cur.cost,
    total: cur.total,
    active: cur.active,
    sessions: cur.sessions,
  };
}

function isCliRun() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isCliRun()) {
  const result = await generateCard();
  console.log(`Generated: $${result.cost.toFixed(2)} · ${fmtTok(result.total)} · ${fmtHrs(result.active)} · ${result.sessions} sessions`);
}
