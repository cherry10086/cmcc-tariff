#!/usr/bin/env node
/**
 * 中国移动「资费公示专区」抓取器 · 按上线日期倒序
 * ------------------------------------------------------------------
 * 数据源: https://h.app.coc.10086.cn/cmcc-app/pc-pages/tariffZonePers.html
 *
 * 为什么驱动浏览器而不是直接调接口：
 *   站点是加密网关后的 Vue SPA，请求体/响应体均为 AES 密文，且每次请求带
 *   x-sign / x-nonce / x-token 三重签名。逆向加密一改版即废，所以让本机浏览器
 *   跑页面自己的加解密，脚本只从渲染后的 DOM 取数。代价是慢几分钟，
 *   换来的是站点改版后大概率还能跑。
 *
 * 平台: Windows (PowerShell / cmd) 与 Debian / Ubuntu 通用，依赖本机 Chrome 或 Edge。
 *
 * 风控: 只抓「全网资费 + 指定省份」两个页签，不做全国批量。
 *       31 省连拉会被源站当成恶意爬虫，也容易把自己的 IP 拖下水。
 *
 * 输出: 终端表格 + JSON 数据 + HTML 报告（按上线日期倒序，新上线业务置顶高亮）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const puppeteer = require('puppeteer-core');

// ════════════════ 配置 ════════════════

const PAGE_URL = 'https://h.app.coc.10086.cn/cmcc-app/pc-pages/tariffZonePers.html';

const SELECTORS = {
  provEntry: '.prov-entry',            // 省份切换入口
  provItem: '.select-item',            // 省份列表项
  categoryTab: '.tab-item',            // 业务分类页签（个人资费 / 政企资费）
  rangeTab: '.range-tab',              // 归属页签（全网资费 / 本省资费）
  typeBox: '.line-3 .select-container .select-box',      // 资费类型下拉的触发区
  typeList: '.line-3 .select-list-box .select-item',     // 资费类型下拉的选项
  typeText: '.line-3 .select-container .tipsText',       // 资费类型当前值（用于核对是否切换成功）
  card: '.tariff-item-container',      // 业务卡片根节点
  cardName: '.item-name',              // 业务名称
  tips: '.item-tips-list',             // 字段明细块
  table: '.table-area',                // 资源表
  rowTitle: '.row-title',
  rowContent: '.row-content',
};

// 资费类型。页面默认只显示「套餐」，其余三类全被挡在外面 ——
// 实测北京全网资费：套餐 43 条、加装包 1420 条、港澳台/国际资费 1318 条、
// 营销活动 13 条。只抓默认的那一档会漏掉 98% 的数据。
const TARIFF_TYPES = ['套餐', '加装包', '营销活动', '港澳台/国际资费'];

// 字段标签白名单：只有命中它的行才当作新字段起点，其余视为上一字段的续行
// （「其他说明」这类值本身跨多行，且值内可能含冒号）。
const KNOWN_FIELDS = [
  '资费标准', '方案编号', '资费类型', '适用范围', '适用地区', '销售渠道',
  '上线日期', '下线日期', '有效期限', '在网要求', '退订方式', '违约责任',
  '超出资费说明', '其他服务内容', '其他说明',
];

// 各阶段等待时长（毫秒）。加密网关响应慢，给足时间比事后重试划算。
const WAIT = {
  firstPaint: 8000,   // 首屏 SPA 初始化
  provPanel: 1200,    // 省份弹层展开
  provSwitch: 6000,   // 切省后重新拉数
  tabSwitch: 3000,    // 切页签 / 切资费类型后重新拉数
  settle: 1000,       // 每次滚动触发后的加载等待
  dropdown: 700,      // 资费类型下拉的展开动画
  cardRender: 3000,   // 切页签后的渲染冷却：接口慢，立刻开始判定会把「还没开始加载」误判成「已加载完」
};

// 连续多少轮「卡片数不增、且在途请求为 0、且累计请求数不变」才认定加载结束。
// 调大只是多等几秒；调小则可能把还没吐完的数据当成全部 —— 江西曾把 182 条抓成 5 条。
const STABLE_ROUNDS = 8;

// 滚动轮数上限。它只是防止无限空转的安全阀，正常情况下靠「连续 8 轮稳定」提前退出。
// 这个值必须留足余量：实测山东 661 条要滚到第 88 轮才加载完，按同比例换算，
// 两千条量级的大省需要 200 轮以上 —— 上限设低了会在数据到齐前强行收工。
const MAX_ROUNDS = 400;
const PROGRESS_EVERY = 25; // 每多少轮报一次进度，免得长时间加载看起来像卡死

// ════════════════ 基础工具 ════════════════

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 输出被重定向到文件时不加颜色转义，日志更干净
const COLOR_ON = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (COLOR_ON ? `\x1b[${code}m${s}\x1b[0m` : s);
const log = (m) => console.log(m);
const logStep = (m) => console.log(`${paint(36, '▸')} ${m}`);
const logOk = (m) => console.log(`${paint(32, '✓')} ${m}`);
const logWarn = (m) => console.log(`${paint(33, '!')} ${m}`);

/** 探测本机浏览器（Chrome 优先，其次 Edge）。找不到就报错，不静默降级。 */
function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    // Debian / Ubuntu
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('未找到 Chrome/Edge。请安装，或用环境变量 CHROME_PATH 指定可执行文件路径');
}

/** 用系统默认程序打开文件，三平台通用。 */
function openPath(file) {
  const cmd =
    process.platform === 'win32' ? `start "" "${file}"`
    : process.platform === 'darwin' ? `open "${file}"`
    : `xdg-open "${file}"`;
  exec(cmd, { shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh' }, () => {});
}

/** 字符串显示宽度：全角字符占 2 列。终端表格对齐全靠它。 */
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += /[\u2E80-\uFFFF]/.test(ch) ? 2 : 1;
  return w;
}

/** 按显示宽度右侧补空格，超宽则截断加省略号。 */
function padDisp(s, width) {
  s = String(s ?? '');
  if (dispWidth(s) <= width) return s + ' '.repeat(width - dispWidth(s));
  let out = '';
  for (const ch of s) {
    const cw = /[\u2E80-\uFFFF]/.test(ch) ? 2 : 1;
    if (dispWidth(out) + cw > width - 1) break;
    out += ch;
  }
  return out + '…';
}

/** 中文日期归一化："2026年2月9日" / "2026-02-09" / "2026/2/9" / "2026.2.9" 全部吃下。 */
function parseCnDate(raw) {
  const m = String(raw || '').match(/(\d{4})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Date → "2026-02-09" */
function isoDate(d) {
  if (!d) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 相对今天的自然语言描述，让「新不新」一眼可判。 */
function relativeDays(d) {
  if (!d) return '';
  const t = new Date();
  const days = Math.round((new Date(t.getFullYear(), t.getMonth(), t.getDate()) - d) / 86400000);
  if (days < 0) return `${-days} 天后上线`;
  if (days === 0) return '今天上线';
  if (days === 1) return '昨天上线';
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${(days / 365).toFixed(1)} 年前`;
}

// ════════════════ 参数解析 ════════════════

function parseArgs(argv) {
  const cfg = {
    provinces: [],       // 目标省份
    categories: [],      // 空 = 全部（个人资费 + 政企资费）
    scopes: [],          // 空 = 全部（全网资费 + 本省资费）
    tariffTypes: [],     // 空 = 全部四种资费类型
    outDir: path.join(__dirname, 'data'),
    top: 0,              // 终端打印条数上限，0 = 全部
    json: true, html: true, snapshot: true, open: true,
    headful: false, listProvinces: false, overviewOnly: false, help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-p': case '--province': cfg.provinces.push(next()); break;
      case '--category': cfg.categories.push(next()); break;
      case '--scope': cfg.scopes.push(next()); break;
      case '--type': cfg.tariffTypes.push(next()); break;
      case '--out': cfg.outDir = path.resolve(next()); break;
      case '--top': cfg.top = parseInt(next(), 10) || 0; break;
      case '--no-json': cfg.json = false; break;
      case '--no-html': cfg.html = false; break;
      case '--no-snapshot': cfg.snapshot = false; break;
      case '--no-open': cfg.open = false; break;
      case '--overview': cfg.overviewOnly = true; break;
      case '--headful': cfg.headful = true; break;
      case '--list-provinces': cfg.listProvinces = true; break;
      case '-h': case '--help': cfg.help = true; break;
      default:
        if (!a.startsWith('-')) cfg.provinces.push(a); // 裸参数当省份
    }
  }
  return cfg;
}

// ════════════════ 页面层 ════════════════

async function openPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1200 });

  // 页面加载前注入监控。两个计数各司其职：
  //   __LIST_CALLS__   列表接口累计调用次数 → 识别「源站压根没发请求」的空数据组合；
  //   __LIST_PENDING__ 在途请求数           → 判断数据是否真的加载完毕。
  // 少了后者会出事：请求已发出未返回时，卡片数和请求数都不动，
  // 会被误判成「加载完了」，于是几百条数据只抓到个零头。
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.__LIST_CALLS__ = 0;
    window.__LIST_PENDING__ = 0;
    const oOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u, ...r) {
      if (typeof u === 'string' && /getTariffListInfo/.test(u)) this.__isList = true;
      return oOpen.call(this, m, u, ...r);
    };
    const oSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...a) {
      if (this.__isList) {
        window.__LIST_CALLS__++;
        window.__LIST_PENDING__++;
        this.addEventListener('loadend', () => { window.__LIST_PENDING__--; });
      }
      return oSend.apply(this, a);
    };
  });

  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
    .catch((e) => logWarn(`页面加载告警: ${e.message}`));
  await page.waitForSelector(SELECTORS.provEntry, { timeout: 30000 }).catch(() => {});
  await sleep(WAIT.firstPaint); // SPA 首屏数据
  return page;
}

/** 列出全部可选省份。站点按省组织，没有地级市粒度。 */
async function listProvinces(page) {
  await page.click(SELECTORS.provEntry).catch(() => {});
  await sleep(WAIT.provPanel);
  const names = await page.evaluate((sel) =>
    [...document.querySelectorAll(sel)].map((e) => (e.innerText || '').trim()).filter(Boolean),
    SELECTORS.provItem);
  await page.click(SELECTORS.provEntry).catch(() => {}); // 关弹层
  return [...new Set(names)];
}

async function selectProvince(page, name) {
  await page.click(SELECTORS.provEntry).catch(() => {});
  await sleep(WAIT.provPanel);
  const ok = await page.evaluate((sel, n) => {
    const el = [...document.querySelectorAll(sel)].find((e) => (e.innerText || '').trim() === n);
    if (el) { el.click(); return true; }
    return false;
  }, SELECTORS.provItem, name);
  if (ok) await sleep(WAIT.provSwitch);
  return ok;
}

/** 读取当前页签清单。 */
async function readTabs(page) {
  return page.evaluate((catSel, rangeSel) => ({
    categories: [...document.querySelectorAll(catSel)].map((e) => (e.innerText || '').trim()).filter(Boolean),
    ranges: [...document.querySelectorAll(rangeSel)].map((e) => (e.innerText || '').trim()).filter(Boolean),
  }), SELECTORS.categoryTab, SELECTORS.rangeTab);
}

/**
 * 切换页签。已是激活态就直接返回，不做多余的点击。
 * 实测重复点击已激活的页签不会改变加载结果（有对照实验），这里只是为了
 * 省掉无谓的等待：没点击就不用 sleep，每个省少等几秒。
 */
/**
 * 切换「资费类型」下拉。
 *
 * 页面把资费类型做成了自定义下拉（不是原生 select），默认停在「套餐」，
 * 另外三类完全不可见。必须点开下拉再选具体项，点完还要核对当前值 ——
 * 下拉有时会点空，不核对就会把上一轮的数据当成新类型的抓回去。
 */
async function selectTariffType(page, label) {
  const opened = await page.evaluate((sel) => {
    const box = document.querySelector(sel);
    if (box) { box.click(); return true; }
    return false;
  }, SELECTORS.typeBox);
  if (!opened) return false;

  await sleep(WAIT.dropdown);
  const clicked = await page.evaluate((sel, lb) => {
    const el = [...document.querySelectorAll(sel)].find((e) => (e.innerText || '').trim() === lb);
    if (el) { el.click(); return true; }
    return false;
  }, SELECTORS.typeList, label);
  if (!clicked) return false;

  await sleep(WAIT.tabSwitch);
  // 核对确实切过去了，否则宁可报失败也不要抓成上一类型的数据
  const current = await page.evaluate((sel) => {
    const t = document.querySelector(sel);
    return t ? (t.innerText || '').trim() : '';
  }, SELECTORS.typeText);
  return current === label;
}

/**
 * 读取当前分类下「资费类型」下拉的实际选项。
 *
 * 必须动态读，不能写死：个人资费有四种类型，政企资费只有「加装包」一种。
 * 早先按固定四种去切，政企下每次都找不到目标项而被整段跳过。
 */
async function readTariffTypes(page) {
  const opened = await page.evaluate((sel) => {
    const box = document.querySelector(sel);
    if (box) { box.click(); return true; }
    return false;
  }, SELECTORS.typeBox);
  if (!opened) return [];

  await sleep(WAIT.dropdown);
  const options = await page.evaluate((sel) =>
    [...document.querySelectorAll(sel)].map((e) => (e.innerText || '').trim()).filter(Boolean),
    SELECTORS.typeList);

  // 收回下拉，避免遮挡后续点击
  await page.evaluate((sel) => {
    const box = document.querySelector(sel);
    if (box) box.click();
  }, SELECTORS.typeBox);
  await sleep(400);
  return options;
}

async function clickTab(page, selector, label) {
  const state = await page.evaluate((sel, lb) => {
    const el = [...document.querySelectorAll(sel)].find((e) => (e.innerText || '').trim() === lb);
    if (!el) return 'missing';
    if (el.classList.contains('active')) return 'active';
    el.click();
    return 'clicked';
  }, selector, label);
  if (state === 'clicked') await sleep(WAIT.tabSwitch);
  return state !== 'missing';
}

/**
 * 滚到底，直到确认数据加载完毕。
 *
 * 判定「加载完」只看两个信号，别的一概不算数：
 *   1. 卡片数连续若干轮不增长；
 *   2. 没有在途的列表请求。
 * 之所以要看第 2 条：请求已发出、响应还没回来的那段空窗里，卡片数同样不动，
 * 只看第 1 条会把「正在加载」误判成「已经到底」，几百条数据就只抓到个零头。
 *
 * 注意不要用「累计请求数是否增长」来判断 —— 滚动本身就会不断触发新请求
 * （这正是懒加载的工作方式），拿它当条件会永远等不到稳定，白白空转到上限。
 *
 * 另外必须同时用三种方式触发滚动：实测某些省份对 window.scrollTo 完全无反应，
 * 只有键盘 End / 鼠标滚轮才让数据继续加载。少了这一步，页面看着到底了，其实没加载。
 *
 * 每轮只做一次 evaluate，把滚动、兜底点击与采样合并 —— 原先每轮要 7 次跨进程调用。
 */
async function loadAllCards(page) {
  await sleep(WAIT.cardRender); // 切页签后先让数据有机会起步，再谈「有没有加载完」
  await page.mouse.move(720, 600).catch(() => {});
  let prev = -1, stable = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    await page.keyboard.press('End').catch(() => {});
    await page.mouse.wheel({ deltaY: 1200 }).catch(() => {});

    // 只做滚动与采样。这里曾有一段「查找加载更多按钮」的兜底逻辑，
    // 遍历全页 div/button/span 并对每个元素读 offsetParent，会强制触发上千次布局重算，
    // 单轮 evaluate 被拖慢到数秒，滚动事件直接被拖没 —— 表现为数据始终不加载。
    // 该按钮从未在站点上出现过，属过度防御，删掉。
    const probe = await page.evaluate((sel) => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      return {
        cards: document.querySelectorAll(sel).length,
        pending: window.__LIST_PENDING__ || 0,
      };
    }, SELECTORS.card);

    if (probe.cards === prev && probe.pending === 0) {
      if (++stable >= STABLE_ROUNDS) break;
    } else {
      stable = 0;
      prev = probe.cards;
    }
    if (process.env.DEBUG_ROLL) {
      log(`      轮${String(round).padStart(2)} 卡片=${String(probe.cards).padStart(3)} 在途=${probe.pending} 稳定=${stable}`);
    } else if (round > 0 && round % PROGRESS_EVERY === 0) {
      log(`      …滚动 ${round} 轮，已见 ${probe.cards} 条`);
    }
    await sleep(WAIT.settle);
  }

  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  return Math.max(prev, 0);
}

/**
 * 抓取当前视图下的全部业务卡片。整个函数在浏览器上下文执行，
 * 解析逻辑无法引用 Node 侧代码，故内联。
 */
async function scrapeCards(page, meta) {
  return page.evaluate((SEL, knownFields, meta) => {
    /** 把「标签: 值」混排文本切成对象；白名单外的行并入上一字段（长文本跨行）。 */
    function extractFields(tipText) {
      const fields = {};
      let cur = null;
      for (const raw of String(tipText).split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const m = line.match(/^([\u4e00-\u9fa5A-Za-z]{2,8})\s*[:：]\s*(.*)$/);
        if (m && knownFields.includes(m[1])) {
          cur = m[1];
          fields[cur] = (fields[cur] ? fields[cur] + '\n' : '') + (m[2] || '');
          continue;
        }
        if (cur) fields[cur] += (fields[cur] ? '\n' : '') + line;
      }
      return fields;
    }

    /** 资源表：.row-title / .row-content 在 DOM 中交替出现，按序配对。 */
    function extractResources(card) {
      const rows = [];
      for (const area of card.querySelectorAll(SEL.table)) {
        let cur = null;
        for (const node of area.querySelectorAll(`${SEL.rowTitle},${SEL.rowContent}`)) {
          const txt = (node.innerText || '').trim();
          if (!txt) continue;
          if (node.classList.contains(SEL.rowTitle.slice(1))) cur = txt;
          else if (cur) { rows.push({ label: cur, value: txt }); cur = null; }
        }
      }
      return rows;
    }

    return [...document.querySelectorAll(SEL.card)].map((card, idx) => {
      const nameEl = card.querySelector(SEL.cardName);
      const name = nameEl ? (nameEl.innerText || '').trim().split('\n')[0] : '';
      const tip = card.querySelector(SEL.tips);
      const f = tip ? extractFields(tip.innerText || '') : {};
      const pick = (k) => (f[k] || '').trim();
      return {
        domIndex: idx,
        name,
        code: pick('方案编号'),
        price: pick('资费标准').replace(/\s+/g, ' '),
        tariffType: pick('资费类型'),
        scope: pick('适用范围'),
        region: pick('适用地区'),
        channel: pick('销售渠道'),
        onlineRaw: pick('上线日期'),
        offlineRaw: pick('下线日期'),
        validPeriod: pick('有效期限'),
        contractReq: pick('在网要求'),
        unsubscribe: pick('退订方式'),
        liability: pick('违约责任'),
        overage: pick('超出资费说明'),
        extraService: pick('其他服务内容'),
        extraNote: pick('其他说明'),
        resources: extractResources(card),
        category: meta.category,   // 个人资费 / 政企资费
        rangeTab: meta.rangeTab,   // 全网资费 / 本省资费
        tariffType: meta.tariffType, // 套餐 / 加装包 / 营销活动 / 港澳台·国际资费
      };
    }).filter((r) => r.name || r.code);
  }, SELECTORS, KNOWN_FIELDS, meta);
}

/** 抓取一个省份：遍历 分类页签 × 归属页签。 */
async function scrapeProvince(page, province, cfg) {
  if (!(await selectProvince(page, province))) return { province, selected: false, items: [], coverage: [] };

  const tabs = await readTabs(page);
  const cats = cfg.categories.length ? tabs.categories.filter((c) => cfg.categories.includes(c)) : tabs.categories;
  const ranges = cfg.scopes.length
    ? tabs.ranges.filter((r) => cfg.scopes.some((s) => (s === '本省' ? !r.includes('全网') : r.includes('全网'))))
    : tabs.ranges;
  const types = cfg.tariffTypes.length ? TARIFF_TYPES.filter((t) => cfg.tariffTypes.includes(t)) : TARIFF_TYPES;
  log(`  分类页签: ${cats.join(' / ')}   归属页签: ${ranges.join(' / ')}`);

  const all = [];
  const coverage = [];
  for (const cat of cats) {
    if (!(await clickTab(page, SELECTORS.categoryTab, cat))) { logWarn(`未找到分类页签「${cat}」，跳过`); continue; }

    // 资费类型的可选项随分类变化，必须在切完分类之后再读
    const available = await readTariffTypes(page);
    const catTypes = types.filter((t) => available.includes(t));
    log(`  ── ${cat}：资费类型可选 ${available.join(' / ') || '(未读到)'}`);
    if (!catTypes.length) { logWarn(`${cat}: 没有匹配的资费类型，跳过`); continue; }

    for (const range of ranges) {
      if (!(await clickTab(page, SELECTORS.rangeTab, range))) { logWarn(`未找到页签「${range}」，跳过`); continue; }
      for (const type of catTypes) {
        if (!(await selectTariffType(page, type))) { logWarn(`未找到资费类型「${type}」，跳过`); continue; }
        const callsBefore = await page.evaluate(() => window.__LIST_CALLS__ || 0).catch(() => 0);
        const cards = await loadAllCards(page);
        const callsAfter = await page.evaluate(() => window.__LIST_CALLS__ || 0).catch(() => 0);
        const rows = await scrapeCards(page, { category: cat, rangeTab: range, tariffType: type });

        // 0 条 + 全程没发过列表请求 = 源站对该组合走「不请求直接不渲染」分支。
        // 实测 11 个省的「政企资费 + 本省资费」全是这个行为，且前端源码里压根没有
        // 「暂无数据」这类文案 —— 判定为源站对空数据的正常处理，而非抓取故障。
        // 仍如实标出，供人工复核，不替使用者下结论。
        const quiet = rows.length === 0 && callsAfter === callsBefore;
        coverage.push({ category: cat, rangeTab: range, tariffType: type, cards, parsed: rows.length, quiet });
        log(`  [${cat} · ${range} · ${type}] 卡片 ${cards} 张 → 解析 ${rows.length} 条${quiet ? '  · 源站无数据' : ''}`);
        all.push(...rows);
      }
    }
  }

  // 同一方案编号可能同时出现在多个页签或类型下，按编号合并，保留全部归属标签与类型
  const byCode = new Map();
  for (const r of all) {
    const key = r.code || `${r.name}|${r.price}`;
    const hit = byCode.get(key);
    if (!hit) byCode.set(key, { ...r, categories: [r.category], rangeTabs: [r.rangeTab], tariffTypes: [r.tariffType] });
    else {
      if (!hit.categories.includes(r.category)) hit.categories.push(r.category);
      if (!hit.rangeTabs.includes(r.rangeTab)) hit.rangeTabs.push(r.rangeTab);
      if (!hit.tariffTypes.includes(r.tariffType)) hit.tariffTypes.push(r.tariffType);
    }
  }
  return { province, selected: true, items: [...byCode.values()], coverage };
}

// ════════════════ 数据层 ════════════════

/** 补上解析后的日期，并识别「预约上线」（源站存在 2029 年这类未来生效的业务）。 */
function enrich(items) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return items.map((it) => {
    const online = parseCnDate(it.onlineRaw);
    const priceNum = (() => {
      const m = (it.price || '').match(/([\d.]+)\s*元\s*\/?\s*月/);
      return m ? parseFloat(m[1]) : null;
    })();
    return {
      ...it,
      onlineDate: isoDate(online),
      onlineTs: online ? online.getTime() : null,
      offlineDate: isoDate(parseCnDate(it.offlineRaw)),
      priceNum,
      isFuture: !!online && online.getTime() > today.getTime(),
    };
  });
}

/**
 * 核心排序：上线日期倒序。
 * 两处例外，都是为了让「刚上线的业务」留在第一屏：
 *   1. 未来生效的预约业务沉底 —— 它们还没上线，置顶只会把真新业务挤下去；
 *   2. 无日期的记录置底 —— 宁可沉底也不给假日期。
 */
function sortByOnlineDate(items) {
  return items.slice().sort((a, b) => {
    if (a.isFuture !== b.isFuture) return a.isFuture ? 1 : -1;
    if (a.onlineTs === null && b.onlineTs === null) return (a.domIndex ?? 0) - (b.domIndex ?? 0);
    if (a.onlineTs === null) return 1;
    if (b.onlineTs === null) return -1;
    return b.onlineTs - a.onlineTs || String(a.name).localeCompare(String(b.name), 'zh');
  });
}

/**
 * 读取上次快照。必须区分两种「读不到」：
 *   - 文件不存在   = 真正首次运行，可以建立新基线；
 *   - 读取/解析失败 = 异常，绝不能当成首次 —— 否则会以本次抓取范围重建快照，
 *     把没抓到的业务从基线里抹掉，下次全量抓取时它们会被整批误报为「新上线」。
 */
function loadSnapshot(file) {
  if (!fs.existsSync(file)) return { ok: true, data: null, reason: 'absent' };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || !data.items) return { ok: false, reason: 'malformed' };
    return { ok: true, data, reason: 'ok' };
  } catch (e) {
    return { ok: false, reason: String(e.code || 'parse-error') };
  }
}

/** 对比快照，标记新增。快照是「历史见过的业务」的累积集合，必须合并写回。 */
function diffSnapshot(items, snap) {
  const firstRun = !snap || !snap.items;
  const known = firstRun ? {} : snap.items;
  const now = new Date().toISOString();

  const out = items.map((it) => {
    const prev = known[it.code || it.name];
    return { ...it, isNew: !firstRun && !prev, firstSeen: prev ? prev.firstSeen : now };
  });

  const merged = { ...known };
  for (const it of out) {
    merged[it.code || it.name] = {
      name: it.name, onlineDate: it.onlineDate, price: it.price, firstSeen: it.firstSeen,
    };
  }
  return {
    items: out, firstRun,
    newCount: out.filter((i) => i.isNew).length,
    snapshot: { updatedAt: now, count: Object.keys(merged).length, items: merged },
  };
}

/** 单省结果落盘：快照比对 → 终端表格 → JSON → HTML。 */
function persistProvince(cfg, province, items, quietTabs, coverage) {
  const snapFile = path.join(cfg.outDir, `snapshot-${province}.json`);
  let itemsFinal = items, firstRun = false, newCount = 0;

  if (cfg.snapshot) {
    const loaded = loadSnapshot(snapFile);
    const partial = !!(cfg.categories.length || cfg.scopes.length);
    if (!loaded.ok) logWarn(`${province}: 快照读取失败（${loaded.reason}），本次跳过写入以免破坏基线`);

    const d = diffSnapshot(items, loaded.ok ? loaded.data : null);
    itemsFinal = d.items; firstRun = d.firstRun; newCount = d.newCount;

    // 快照是「新上线」检测的基线，写坏一次就会让后续抓取整批误报。两道闸：
    // 读取失败不写；局部抓取且无历史基线不写（避免建立残缺基线）。
    const canWrite = loaded.ok && !(d.firstRun && partial);
    if (canWrite) {
      d.snapshot.province = province;
      fs.writeFileSync(snapFile, JSON.stringify(d.snapshot, null, 2), 'utf8');
    } else if (d.firstRun && partial) {
      logWarn(`${province}: 局部抓取且无历史快照，跳过写入以免建立不完整基线`);
    }

    // 基线若曾被截断，本次会把大量旧业务报成新增。显式提示，免得以为天降几百个新业务。
    if (!firstRun && newCount > 20 && newCount > items.length * 0.5) {
      logWarn(`${province}: 新增占比异常（${newCount}/${items.length}），快照基线可能不完整，建议核对后再依赖「新增」标记`);
    }
  }

  log(renderConsole(itemsFinal, province, cfg, quietTabs));

  if (cfg.json) {
    const jf = path.join(cfg.outDir, `${province}-data.json`);
    fs.writeFileSync(jf, JSON.stringify({
      province, scrapedAt: new Date().toISOString(), total: itemsFinal.length,
      newThisRun: newCount, firstRun, coverage,
      quietTabs: quietTabs.map((c) => `${c.category} + ${c.rangeTab} + ${c.tariffType}`),
      items: itemsFinal,
    }, null, 2), 'utf8');
    logOk(`JSON → ${jf}`);
  }

  if (cfg.html) {
    const hf = path.join(cfg.outDir, `${province}-report.html`);
    fs.writeFileSync(hf, renderHTML(itemsFinal, province, { newCount, quietTabs }), 'utf8');
    logOk(`HTML → ${hf}`);
    if (cfg.open) openPath(hf);
  }

  return { total: itemsFinal.length, newCount, firstRun };
}

// ════════════════ 渲染层 ════════════════

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 终端表格。完整字段看 HTML/JSON。 */
function renderConsole(items, province, cfg, quietTabs = []) {
  const cols = [
    { key: '上线日期', w: 12, get: (r) => (r.onlineDate || r.onlineRaw || '未知') + (r.isFuture ? '*' : '') },
    { key: '业务名称', w: 36, get: (r) => r.name },
    { key: '方案编号', w: 12, get: (r) => r.code },
    { key: '资费标准', w: 14, get: (r) => r.price },
    { key: '类型', w: 12, get: (r) => (r.tariffTypes || [r.tariffType]).filter(Boolean).join('+') },
    { key: '归属', w: 14, get: (r) => (r.rangeTabs || [r.rangeTab]).filter(Boolean).join('+') },
  ];
  const sep = '+' + cols.map((c) => '-'.repeat(c.w + 2)).join('+') + '+';
  const row = (cells) => '| ' + cells.map((c, i) => padDisp(c, cols[i].w) + ' ').join('|') + '|';

  const limit = cfg.top > 0 ? cfg.top : items.length;
  const out = ['', `═══ ${province} · 全量业务（按上线日期倒序） ═══`, sep, row(cols.map((c) => c.key)), sep];
  for (const r of items.slice(0, limit)) {
    const cells = cols.map((c) => c.get(r));
    if (r.isNew) cells[1] = '★NEW ' + cells[1];
    out.push(row(cells));
  }
  out.push(sep);
  out.push(`共 ${items.length} 条 · 本次新增 ${items.filter((i) => i.isNew).length} 条 · 预约上线 ${items.filter((i) => i.isFuture).length} 条`);
  if (limit < items.length) out.push(`（终端仅显示前 ${limit} 条，完整数据见 HTML 报告与 JSON）`);
  out.push('★NEW = 相比上次抓取新上线   * = 生效日期在未来（预约业务，已置底）');
  if (quietTabs.length) {
    out.push('', `· 以下 ${quietTabs.length} 个页签组合该地区未公示，源站无数据（非抓取遗漏）：`);
    for (const c of quietTabs) out.push(`    ${c.category} + ${c.rangeTab} + ${c.tariffType}`);
  }
  return out.join('\n');
}

/** 单省 HTML 报告：单文件、零外部依赖，倒序排列，新增置顶高亮。 */
function renderHTML(items, province, meta) {
  const newItems = items.filter((i) => i.isNew);
  const futures = items.filter((i) => i.isFuture && !i.isNew);
  const others = items.filter((i) => !i.isNew && !i.isFuture);

  const card = (r) => {
    const tags = [
      ...(r.categories || [r.category]).map((c) => `<span class="tag">${esc(c)}</span>`),
      ...(r.rangeTabs || [r.rangeTab]).map((c) => `<span class="tag tag-alt">${esc(c)}</span>`),
      ...(r.tariffTypes || [r.tariffType]).filter(Boolean).map((t) => `<span class="tag tag-dim">${esc(t)}</span>`),
      r.isFuture ? '<span class="tag tag-future">预约上线</span>' : '',
    ].join('');
    const res = (r.resources || []).map((x) => `<div class="res"><span>${esc(x.label)}</span><b>${esc(x.value)}</b></div>`).join('');
    const kv = [
      ['方案编号', r.code], ['资费标准', r.price], ['适用范围', r.scope], ['适用地区', r.region],
      ['下线日期', r.offlineRaw], ['有效期限', r.validPeriod], ['销售渠道', r.channel],
      ['在网要求', r.contractReq], ['退订方式', r.unsubscribe], ['违约责任', r.liability],
    ].filter(([, v]) => v).map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
    const long = [['超出资费说明', r.overage], ['其他服务内容', r.extraService], ['其他说明', r.extraNote]]
      .filter(([, v]) => v).map(([k, v]) => `<details><summary>${esc(k)}</summary><p>${esc(v)}</p></details>`).join('');

    return `<article class="card${r.isNew ? ' is-new' : ''}" data-name="${esc((r.name + ' ' + r.code + ' ' + r.price).toLowerCase())}">
      <div class="date-col">
        <div class="date">${esc(r.onlineDate || '未知')}</div>
        <div class="rel">${esc(relativeDays(parseCnDate(r.onlineRaw)))}</div>
        ${r.isNew ? '<div class="badge">NEW</div>' : ''}
      </div>
      <div class="body">
        <h3>${esc(r.name)}</h3>
        <div class="tags">${tags}</div>
        ${res ? `<div class="res-grid">${res}</div>` : ''}
        <div class="kv-grid">${kv}</div>
        ${long}
      </div>
    </article>`;
  };

  const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(province)} 移动资费公示 · 上线倒序</title>
<style>
  :root{--bg:#0d1117;--panel:#161b22;--line:#30363d;--fg:#e6edf3;--dim:#8b949e;--accent:#58a6ff;--new:#3fb950}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  header{position:sticky;top:0;z-index:9;background:rgba(13,17,23,.94);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:18px 28px}
  h1{margin:0 0 6px;font-size:19px;font-weight:600;letter-spacing:.3px}
  .stat{color:var(--dim);font-size:13px}
  .stat b{color:var(--fg)}
  .stat .hot{color:var(--new);font-weight:700}
  #q{margin-top:12px;width:100%;max-width:420px;padding:8px 12px;background:var(--panel);border:1px solid var(--line);border-radius:6px;color:var(--fg);font-size:14px;outline:none}
  #q:focus{border-color:var(--accent)}
  main{max-width:1180px;margin:0 auto;padding:20px 28px 80px}
  .sect{margin:26px 0 12px;font-size:13px;color:var(--dim);letter-spacing:1px;border-bottom:1px solid var(--line);padding-bottom:8px}
  .sect.new-sect{color:var(--new);border-color:var(--new)}
  .notice{margin:16px 0 0;padding:10px 14px;border-radius:8px;background:#6e768115;border:1px solid #6e768155;color:var(--dim);font-size:12.5px;line-height:1.7}
  .card{display:flex;gap:22px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px 22px;margin-bottom:12px}
  .card.is-new{border-color:var(--new);box-shadow:0 0 0 1px rgba(63,185,80,.35)}
  .date-col{flex:0 0 118px;text-align:right;padding-top:2px}
  .date{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:.4px}
  .rel{font-size:12px;color:var(--dim);margin-top:2px}
  .badge{display:inline-block;margin-top:8px;background:var(--new);color:#06210c;font-size:11px;font-weight:800;padding:2px 8px;border-radius:20px;letter-spacing:1px}
  .body{flex:1;min-width:0}
  h3{margin:0 0 8px;font-size:16px;font-weight:600;line-height:1.45}
  .tags{margin-bottom:10px}
  .tag{display:inline-block;font-size:11px;padding:2px 8px;border-radius:4px;background:#1f6feb22;color:var(--accent);border:1px solid #1f6feb55;margin:0 6px 6px 0}
  .tag-alt{background:#8957e522;color:#bc8cff;border-color:#8957e555}
  .tag-dim{background:#6e768122;color:var(--dim);border-color:#6e768155}
  .tag-future{background:#d2992222;color:#d29922;border-color:#d2992255}
  .res-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:8px 18px;background:#0d1117;border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin-bottom:12px}
  .res,.kv{display:flex;justify-content:space-between;gap:14px;font-size:13px}
  .res span,.kv span{color:var(--dim);flex:0 0 auto}
  .res b,.kv b{font-weight:600;text-align:right;word-break:break-word}
  .res b{color:var(--accent)}
  .kv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:6px 20px;font-size:13px}
  details{margin-top:10px;font-size:13px}
  summary{cursor:pointer;color:var(--dim);outline:none}
  summary:hover{color:var(--accent)}
  details p{margin:8px 0 0;color:#c9d1d9;white-space:pre-wrap;line-height:1.7}
  .empty{color:var(--dim);padding:40px;text-align:center}
</style></head><body>
<header>
  <h1>中国移动 · ${esc(province)}资费公示专区</h1>
  <div class="stat">按<b>上线日期</b>倒序 · 共 <b>${items.length}</b> 条业务 ${meta.newCount ? `· 本次新增 <span class="hot">${meta.newCount}</span> 条` : '· 无新增'}${futures.length ? ` · 另有 ${futures.length} 条预约上线已置底` : ''} · 抓取于 ${esc(stamp)}</div>
  <input id="q" placeholder="筛选业务名 / 方案编号 / 资费…">
  ${(meta.quietTabs || []).length ? `<div class="notice">该地区未公示以下业务，源站无数据（非抓取遗漏）：<br>${meta.quietTabs.map((c) => `· ${esc(c.category)} + ${esc(c.rangeTab)}`).join('<br>')}</div>` : ''}
</header>
<main>
${newItems.length ? `<div class="sect new-sect">⚡ 本次新上线 ${newItems.length} 条</div>${newItems.map(card).join('\n')}` : ''}
<div class="sect">已上线业务 ${others.length} 条</div>
${others.map(card).join('\n')}
${futures.length ? `<div class="sect">预约上线（生效日期在未来，${futures.length} 条）</div>${futures.map(card).join('\n')}` : ''}
<div class="empty" id="none" style="display:none">没有匹配的业务</div>
</main>
<script>
  const q = document.getElementById('q'), none = document.getElementById('none');
  const cards = [...document.querySelectorAll('.card')];
  q.addEventListener('input', () => {
    const k = q.value.trim().toLowerCase(); let shown = 0;
    for (const c of cards) {
      const hit = !k || c.dataset.name.includes(k);
      c.style.display = hit ? '' : 'none';
      if (hit) shown++;
    }
    none.style.display = shown ? 'none' : 'block';
  });
</script>
</body></html>`;
}

/** 全国总览：把 data 目录下已有的各省 JSON 并成一张表（纯本地汇总，不访问网络）。 */
function renderOverview(list) {
  const total = list.reduce((a, d) => a + (d.total || 0), 0);
  const totalNew = list.reduce((a, d) => a + (d.newThisRun || 0), 0);
  const news = list.flatMap((d) => (d.items || []).filter((i) => i.isNew).map((i) => ({ ...i, province: d.province })))
    .sort((a, b) => (b.onlineTs || 0) - (a.onlineTs || 0));
  const recent = list.flatMap((d) => (d.items || []).filter((i) => i.onlineTs && !i.isFuture).map((i) => ({ ...i, province: d.province })))
    .sort((a, b) => b.onlineTs - a.onlineTs).slice(0, 60);

  const provRow = (d) => {
    const live = (d.items || []).filter((i) => i.onlineTs && !i.isFuture);
    const latest = live.length ? live.reduce((a, b) => (b.onlineTs > a.onlineTs ? b : a)) : null;
    return `<tr><td><a href="${esc(encodeURIComponent(d.province))}-report.html">${esc(d.province)}</a></td>
      <td class="num">${d.total || 0}</td><td class="num">${d.newThisRun || 0}</td>
      <td class="dt">${latest ? esc(latest.onlineDate) : '—'}</td>
      <td class="nm">${latest ? esc(latest.name) : '—'}</td>
      <td class="dim">${(d.quietTabs || []).map(esc).join('、')}</td></tr>`;
  };

  const newsRow = (r) => `<tr class="is-new"><td class="dt">${esc(r.onlineDate)}</td>
    <td><a href="${esc(encodeURIComponent(r.province))}-report.html">${esc(r.province)}</a></td>
    <td>${esc(r.name)}</td><td class="num">${esc(r.price)}</td></tr>`;
  const recentRow = (r) => `<tr><td class="dt">${esc(r.onlineDate)}</td>
    <td><a href="${esc(encodeURIComponent(r.province))}-report.html">${esc(r.province)}</a></td>
    <td>${esc(r.name)}</td><td class="num">${esc(r.price)}</td><td class="dim">${esc(r.code)}</td></tr>`;

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>中国移动资费公示 · 全国总览</title>
<style>
  :root{--bg:#0d1117;--panel:#161b22;--line:#30363d;--fg:#e6edf3;--dim:#8b949e;--accent:#58a6ff;--new:#3fb950}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  header{position:sticky;top:0;z-index:9;background:rgba(13,17,23,.94);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:18px 28px}
  h1{margin:0 0 6px;font-size:19px;font-weight:600}
  .stat{color:var(--dim);font-size:13px}
  .stat b{color:var(--fg)}
  .stat .hot{color:var(--new);font-weight:700}
  #q{margin-top:12px;width:100%;max-width:420px;padding:8px 12px;background:var(--panel);border:1px solid var(--line);border-radius:6px;color:var(--fg);font-size:14px;outline:none}
  main{max-width:1280px;margin:0 auto;padding:20px 28px 80px}
  .sect{margin:30px 0 12px;font-size:13px;color:var(--dim);letter-spacing:1px;border-bottom:1px solid var(--line);padding-bottom:8px}
  .sect.new-sect{color:var(--new);border-color:var(--new)}
  table{width:100%;border-collapse:collapse;font-size:13.5px}
  th{text-align:left;color:var(--dim);font-weight:500;font-size:12px;padding:8px 10px;border-bottom:1px solid var(--line);text-transform:uppercase}
  td{padding:9px 10px;border-bottom:1px solid #21262d;vertical-align:top}
  tr.is-new td{background:#3fb9500f}
  tr:hover td{background:#161b22}
  a{color:var(--accent);text-decoration:none}
  a:hover{text-decoration:underline}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .dt{font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--dim)}
  .nm{max-width:360px}
  .dim{color:var(--dim);font-size:12px}
</style></head><body>
<header>
  <h1>中国移动资费公示 · 全国总览</h1>
  <div class="stat">已抓 <b>${list.length}</b> 个省份 · 共 <b>${total}</b> 条业务 ${totalNew ? `· 新增 <span class="hot">${totalNew}</span> 条` : '· 无新增'} · 汇总于 ${esc(new Date().toLocaleString('zh-CN', { hour12: false }))}</div>
  <input id="q" placeholder="筛选省份 / 业务名 / 编号…">
</header>
<main>
${news.length ? `<div class="sect new-sect">⚡ 新上线 ${news.length} 条</div>
<table><thead><tr><th>上线日期</th><th>省份</th><th>业务名称</th><th>资费标准</th></tr></thead><tbody>${news.map(newsRow).join('\n')}</tbody></table>` : ''}
<div class="sect">各省一览（按业务数排序）</div>
<table><thead><tr><th>省份</th><th>业务数</th><th>新增</th><th>最新上线</th><th>最新业务</th><th>未公示组合</th></tr></thead><tbody>
${[...list].sort((a, b) => (b.total || 0) - (a.total || 0)).map(provRow).join('\n')}
</tbody></table>
<div class="sect">最近上线的 60 条</div>
<table><thead><tr><th>上线日期</th><th>省份</th><th>业务名称</th><th>资费标准</th><th>方案编号</th></tr></thead><tbody>${recent.map(recentRow).join('\n')}</tbody></table>
</main>
<script>
  const q = document.getElementById('q');
  q.addEventListener('input', () => {
    const k = q.value.trim().toLowerCase();
    for (const tr of document.querySelectorAll('tbody tr')) {
      tr.style.display = (!k || tr.innerText.toLowerCase().includes(k)) ? '' : 'none';
    }
  });
</script>
</body></html>`;
}

// ════════════════ 主流程 ════════════════

const HELP = `中国移动资费公示专区 · 抓取指定省份全部业务（按上线日期倒序）

用法:
  node tariff-scrape.js --list-provinces        列出全部可选省份名
  node tariff-scrape.js -p 北京市                抓北京：全网资费 + 北京资费
  node tariff-scrape.js -p 江苏省 -p 上海市      抓多个省
  node tariff-scrape.js --overview              把已有数据汇总成全国总览（不联网）

选项:
  -p, --province <名>     省份名，可多次（须与页面一致，如 北京市 / 广西）
  --category <名>         只抓指定分类（个人资费 / 政企资费），可多次
  --scope <全网|本省>     只抓指定归属页签，可多次
  --type <名>             只抓指定资费类型（套餐 / 加装包 / 营销活动 / 港澳台国际资费），
                          可多次；默认全部四种。页面本身只显示「套餐」，
                          不去要其余三类会漏掉 98% 的数据
  --out <目录>            输出目录（默认 ./data）
  --top <n>               终端只打印前 n 条（默认全部；HTML/JSON 始终完整）
  --no-json / --no-html   不导出对应文件
  --no-snapshot           关闭快照对比（不标记新上线）
  --no-open               不自动打开 HTML 报告
  --headful               显示浏览器窗口（调试用）
  --list-provinces        列出省份后退出
  --overview              只汇总已有数据出全国总览，不抓取
  -h, --help              帮助

输出:
  data/<省>-report.html   单省报告：倒序排列，新增置顶高亮 ★ 直接双击看
  data/<省>-data.json     结构化全量数据
  data/snapshot-<省>.json 快照，下次运行据此比对出「新上线业务」
  data/全国总览.html      多省汇总（需先抓过多个省）`;

async function runOnce(cfg) {
  fs.mkdirSync(cfg.outDir, { recursive: true });

  // 纯本地汇总，不启动浏览器、不碰网络
  if (cfg.overviewOnly) {
    const list = fs.existsSync(cfg.outDir)
      ? fs.readdirSync(cfg.outDir).filter((f) => /-data\.json$/.test(f)).flatMap((f) => {
          try { return [JSON.parse(fs.readFileSync(path.join(cfg.outDir, f), 'utf8'))]; }
          catch { logWarn(`跳过无法解析的 ${f}`); return []; }
        })
      : [];
    if (!list.length) { logWarn(`${cfg.outDir} 下没有任何 <省>-data.json，先抓一个省`); return; }
    const of = path.join(cfg.outDir, '全国总览.html');
    fs.writeFileSync(of, renderOverview(list), 'utf8');
    logOk(`全国总览 → ${of}（汇总 ${list.length} 个省）`);
    if (cfg.open) openPath(of);
    return;
  }

  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: !cfg.headful,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1440,1200'],
  });

  try {
    const page = await openPage(browser);

    if (cfg.listProvinces) {
      const provs = await listProvinces(page);
      log(`可选省份 (${provs.length}):\n` + provs.map((p) => '  ' + p).join('\n'));
      return;
    }

    for (let i = 0; i < cfg.provinces.length; i++) {
      const prov = cfg.provinces[i];
      logStep(`[${i + 1}/${cfg.provinces.length}] 抓取 ${prov} …`);
      try {
        const raw = await scrapeProvince(page, prov, cfg);
        if (!raw.selected) { logWarn(`${prov}: 未能选中该省，请用 --list-provinces 核对名称`); continue; }
        const items = sortByOnlineDate(enrich(raw.items));
        const quietTabs = raw.coverage.filter((c) => c.quiet);
        logOk(`${prov}: 解析到 ${items.length} 条业务${quietTabs.length ? `（${quietTabs.length} 个组合源站无数据）` : ''}`);
        persistProvince(cfg, prov, items, quietTabs, raw.coverage);
      } catch (e) {
        // 单省失败不该带走整批。页面可能卡在异常状态（弹窗、路由错乱），
        // 重载一次把状态冲干净，否则后面每个省都会跟着失败。
        logWarn(`${prov}: 抓取失败（${e.message}），重载页面后继续`);
        try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }); await sleep(WAIT.firstPaint); }
        catch (e2) { logWarn(`页面重载也失败（${e2.message}）`); }
      }
    }
  } finally {
    await browser.close();
  }
}

(async () => {
  const cfg = parseArgs(process.argv);
  if (cfg.help) { log(HELP); return; }
  if (!cfg.listProvinces && !cfg.overviewOnly && !cfg.provinces.length) {
    log('缺少 --province。先跑 `node tariff-scrape.js --list-provinces` 查省份名。\n');
    log(HELP);
    return;
  }
  try {
    await runOnce(cfg);
  } catch (e) {
    logWarn(`执行出错: ${e.message}`);
    if (process.env.DEBUG) console.error(e.stack);
    process.exitCode = 1;
  }
})();
