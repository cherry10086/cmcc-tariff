#!/usr/bin/env node
/**
 * 数据完整性审计 —— 独立于抓取器的第二把尺子
 * ------------------------------------------------------------------
 * 抓取器自己说「加载完了」不算数，这个脚本用完全独立的代码路径重新抓一遍：
 *   1. 用远超正常的滚动量（默认 160 轮）反复触发加载；
 *   2. 记录每一轮的卡片数与页面高度，找出数据在哪一轮彻底饱和；
 *   3. 与抓取器产出的 <省>-data.json 对比条数。
 *
 * 两者一致 => 抓取器没漏；审计结果更多 => 抓取器提前收工了，请提 issue。
 *
 * 用法:
 *   node audit.js -p 山东省                 审计山东省（默认 160 轮）
 *   node audit.js -p 广东省 --rounds 300    数据量大的省多滚几轮
 *   node audit.js -p 江苏省 --tab 政企资费   只审计某个分类页签
 */

'use strict';

const fs = require('fs');
const path = require('path');
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
  throw new Error('未找到 Chrome/Edge。请安装，或用 CHROME_PATH 指定路径');
}

function parseArgs(argv) {
  const cfg = { province: null, rounds: 160, tab: null, headful: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '-p' || a === '--province') cfg.province = next();
    else if (a === '--rounds') cfg.rounds = parseInt(next(), 10) || 160;
    else if (a === '--tab') cfg.tab = next();
    else if (a === '--headful') cfg.headful = true;
    else if (!a.startsWith('-')) cfg.province = a;
  }
  return cfg;
}

(async () => {
  const cfg = parseArgs(process.argv);
  if (!cfg.province) {
    console.log('用法: node audit.js -p <省份名> [--rounds 160] [--tab 个人资费|政企资费]\n');
    console.log('例: node audit.js -p 山东省');
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: !cfg.headful,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1440,1200'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1200 });

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.__PEND__ = 0;
    const oOpen = XMLHttpRequest.prototype.open;
    const oSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u, ...r) {
      if (typeof u === 'string' && /getTariffListInfo/.test(u)) this.__isList = true;
      return oOpen.call(this, m, u, ...r);
    };
    XMLHttpRequest.prototype.send = function (...a) {
      if (this.__isList) {
        window.__PEND__++;
        this.addEventListener('loadend', () => { window.__PEND__--; });
      }
      return oSend.apply(this, a);
    };
  });

  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForSelector('.prov-entry', { timeout: 30000 }).catch(() => {});
  await sleep(8000);

  const click = (sel, txt) => page.evaluate((s, t) => {
    const el = [...document.querySelectorAll(s)].find((e) => (e.innerText || '').trim() === t);
    if (el) { el.click(); return true; }
    return false;
  }, sel, txt);
  const cards = () => page.evaluate(() => document.querySelectorAll('.tariff-item-container').length);

  // 选省
  await page.click('.prov-entry').catch(() => {});
  await sleep(1200);
  if (!(await click('.select-item', cfg.province))) {
    console.log(`未能选中「${cfg.province}」，请核对省份名（用 tariff-scrape.js --list-provinces 查看）`);
    await browser.close();
    process.exit(1);
  }
  await sleep(6000);

  const tabName = cfg.tab || '个人资费';
  await click('.tab-item', tabName);
  await sleep(3000);

  const local = await page.evaluate(() =>
    ([...document.querySelectorAll('.range-tab')].map((e) => e.innerText.trim()).find((t) => !t.includes('全网'))) || '');
  await click('.range-tab', local);
  await sleep(4000);

  console.log(`\n审计 ${cfg.province} · ${tabName} · ${local}`);
  console.log(`独立滚动 ${cfg.rounds} 轮\n`);
  console.log('   轮次   卡片数   页面高度   在途');
  console.log('  ' + '-'.repeat(36));

  await page.mouse.move(720, 600);
  const trace = [];
  let lastChange = 0;

  for (let i = 0; i < cfg.rounds; i++) {
    await page.keyboard.press('End');
    await page.mouse.wheel({ deltaY: 1200 });
    const p = await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      return {
        cards: document.querySelectorAll('.tariff-item-container').length,
        h: Math.round(document.documentElement.scrollHeight / 100) / 10,
        pend: window.__PEND__,
      };
    });
    if (trace.length && p.cards !== trace[trace.length - 1].cards) lastChange = i;
    trace.push(p);
    if (i < 10 || i % 20 === 19) {
      console.log(`  ${String(i).padStart(5)}   ${String(p.cards).padStart(6)}   ${String(p.h + 'k').padStart(8)}   ${String(p.pend).padStart(4)}`);
    }
    await sleep(800);
  }

  const final = trace[trace.length - 1].cards;
  const tail = trace.slice(-30).map((t) => t.cards);
  const saturated = new Set(tail).size === 1;

  console.log('  ' + '-'.repeat(36));
  console.log(`\n独立抓取结果: ${final} 张`);
  console.log(`最后一次增长: 第 ${lastChange} 轮；之后 ${trace.length - 1 - lastChange} 轮无变化`);
  console.log(`末 30 轮: ${saturated ? '完全饱和 ✓' : '仍在变化 ✗'}`);

  // 与抓取器产出的数据对比
  const jsonPath = path.join(__dirname, 'data', `${cfg.province}-data.json`);
  if (fs.existsSync(jsonPath)) {
    try {
      const d = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      const same = d.items.filter((i) => (i.categories || []).includes(tabName) && (i.rangeTabs || []).includes(local)).length;
      console.log(`\n抓取器产出: ${same} 条（${tabName} · ${local}）`);
      console.log(`差异: ${final - same} 条`);
      console.log(final === same
        ? '✓ 一致 —— 抓取器没有遗漏'
        : (final > same ? '✗ 抓取器少抓了，请提 issue 并附上本次输出' : '※ 抓取器比审计多，可能是两次抓取之间源站数据有变动'));
    } catch (e) {
      console.log(`\n（读取 ${jsonPath} 失败: ${e.message}）`);
    }
  } else {
    console.log(`\n（未找到 ${jsonPath}，跳过对比。先跑一次 tariff-scrape.js -p ${cfg.province}）`);
  }

  await browser.close();
})();
