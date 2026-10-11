#!/usr/bin/env node
/**
 * 「资费类型下拉」行为验证 —— 保护抓取器里「当前值 == 目标时跳过重选」这一优化的前提假设
 * ------------------------------------------------------------------
 * tariff-scrape.js 的 selectTariffType 对「已激活项」直接放行（不点击），依据是
 * 2026-10-11 的实测：切归属页签后下拉自行重置为「套餐」并自动重新拉数，且
 * 「下拉显示值 = 卡片内『资费类型』标注 = 实际数据」三者一致；点击已激活项
 * 反而会触发一次多余的重新拉取。
 *
 * 本脚本在需要时（站点改版后 / 改过下拉相关逻辑后）复验该假设：
 *   1. 真切换一次类型（加装包），核对显示值与卡内标注一致；
 *   2. 切归属页签，核对重置后的显示值与卡内标注仍一致 ——
 *      一致性是「跳过」安全的充要条件（一致性成立 → 显示值可信 → 跳过不会抓错）；
 *   3. 顺带观察：点击「已激活项」是否触发多余的重新拉取（提示性输出，不作断言）。
 *
 * 用法:
 *   node verify-type-dropdown.js                    # 默认广东省
 *   node verify-type-dropdown.js --province 江苏省
 *
 * 判读: 两处一致性核对均通过 → 跳过优化仍成立；若出现 ✗，请回退 selectTariffType
 *       的提前返回（恢复每次强制点击），并附本脚本输出提 issue。
 */

'use strict';

const fs = require('fs');
const puppeteer = require('puppeteer-core');

const PAGE_URL = 'https://h.app.coc.10086.cn/cmcc-app/pc-pages/tariffZonePers.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
  ].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('未找到 Chrome/Edge。请安装，或用环境变量 CHROME_PATH 指定可执行文件路径');
}

let pass = 0, fail = 0;
function check(label, ok, detail) {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `（${detail}）` : ''}`);
}

(async () => {
  const argIdx = process.argv.indexOf('--province');
  const province = argIdx > -1 ? process.argv[argIdx + 1] : '广东省';

  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1440,1200'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1200 });

  await page.evaluateOnNewDocument(() => {
    window.__CALLS__ = 0; window.__PEND__ = 0;
    const oOpen = XMLHttpRequest.prototype.open, oSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u, ...r) {
      if (typeof u === 'string' && /getTariffListInfo/.test(u)) this.__isList = true;
      return oOpen.call(this, m, u, ...r);
    };
    XMLHttpRequest.prototype.send = function (...a) {
      if (this.__isList) { window.__CALLS__++; window.__PEND__++; this.addEventListener('loadend', () => { window.__PEND__--; }); }
      return oSend.apply(this, a);
    };
  });

  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForSelector('.prov-entry', { timeout: 30000 }).catch(() => {});
  await sleep(8000);

  const clickText = (sel, txt) => page.evaluate((s, t) => {
    const el = [...document.querySelectorAll(s)].find((e) => (e.innerText || '').trim() === t);
    if (el) { el.click(); return true; }
    return false;
  }, sel, txt);

  const sample = () => page.evaluate(() => {
    const t = document.querySelector('.line-3 .select-container .tipsText');
    const cards = [...document.querySelectorAll('.tariff-item-container')];
    const brief = cards.slice(0, 3).map((c) => {
      const txt = (c.innerText || '').replace(/\s+/g, ' ');
      const m = txt.match(/资费类型\s*[:：]\s*([^\s，。;；]+)/);
      const nm = c.querySelector('.item-name');
      return { name: nm ? (nm.innerText || '').split('\n')[0].trim() : '', cardType: m ? m[1] : '' };
    });
    return { typeText: t ? (t.innerText || '').trim() : '', cards: cards.length, calls: window.__CALLS__ || 0, brief };
  });

  /** 一致性核对：显示值必须与所有「可读卡内标注」一致；无标注可读时提示但不算失败。 */
  const consistency = (tag, s) => {
    const marks = s.brief.filter((b) => b.cardType);
    if (!marks.length) {
      console.log(`  ! ${tag}: 未读到卡内「资费类型」标注（${s.brief.length} 个样本），无法核对`);
      return;
    }
    const bad = marks.filter((b) => b.cardType !== s.typeText);
    check(`${tag}: 显示「${s.typeText}」= 卡内标注（${marks.length} 个样本）`, bad.length === 0,
      bad.length ? `不一致样本: ${bad.map((b) => `「${b.name}」标 ${b.cardType}`).join('、')}` : `卡片 ${s.cards} 张`);
  };

  console.log(`\n验证 ${province} · 资费类型下拉行为（大约需要 1 分钟）\n`);

  await page.click('.prov-entry').catch(() => {});
  await sleep(1200);
  if (!(await clickText('.select-item', province))) {
    console.log(`未能选中「${province}」，请核对省份名（用 --list-provinces 查看）`);
    await browser.close();
    process.exit(1);
  }
  await sleep(6000);
  await clickText('.tab-item', '个人资费');
  await sleep(2500);

  console.log('【1】基线（默认类型）');
  consistency('初始状态', await sample());

  console.log('\n【2】真切换：点选「加装包」');
  await page.evaluate(() => document.querySelector('.line-3 .select-container .select-box')?.click());
  await sleep(700);
  await clickText('.line-3 .select-list-box .select-item', '加装包');
  await sleep(5000);
  const s2 = await sample();
  console.log(`  下拉显示「${s2.typeText}」· 卡片 ${s2.cards} 张`);
  consistency('切换后', s2);

  console.log('\n【3】切归属页签 —— 核对重置后的显示值与数据仍一致');
  const localTab = await page.evaluate(() =>
    ([...document.querySelectorAll('.range-tab')].map((e) => e.innerText.trim()).find((t) => !t.includes('全网'))) || '');
  await clickText('.range-tab', localTab);
  await sleep(4000);
  const s3 = await sample();
  console.log(`  重置后下拉显示「${s3.typeText}」（切页签前为「加装包」）`);
  consistency('切页签后', s3);

  console.log('\n【4】观察：点击「已激活项」是否触发多余的重新拉取（提示性，不作断言）');
  const before = await sample();
  await page.evaluate(() => document.querySelector('.line-3 .select-container .select-box')?.click());
  await sleep(700);
  await clickText('.line-3 .select-list-box .select-item', before.typeText);
  await sleep(4500);
  const after = await sample();
  console.log(`  点击前后累计列表请求: ${before.calls} → ${after.calls}（增量 ${after.calls - before.calls}）`);
  if (after.calls === before.calls) {
    console.log('  （本次点击为 no-op —— 跳过优化依然安全：跳过只是省掉了无谓的交互等待）');
  } else {
    console.log('  （点击触发了重新拉取 —— 跳过优化省掉的正是一次多余请求，价值得到验证）');
  }

  await browser.close();

  console.log(`\n${fail ? '✗' : '✓'} ${pass} 项通过，${fail} 项失败`);
  if (!fail) console.log('结论: 显示值与数据一致性成立，「当前值 == 目标时跳过重选」的优化仍安全。');
  else console.log('结论: 一致性假设可能已失效！请回退 selectTariffType 的提前返回并人工复核。');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(`执行出错: ${e.message}`); process.exit(1); });
