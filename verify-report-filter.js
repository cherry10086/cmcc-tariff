// 报告筛选功能的端到端验证：拿真实数据渲染报告，再用浏览器模拟「输入价格词 / 勾选排除校园」，
// 断言可见卡片数与 Node 侧的预期一致。
//
// 它复用 tariff-scrape.js 的生产代码（截取主流程之前的定义段），不是另写一份渲染逻辑 ——
// 另写一份就只能验证「验证脚本自己是对的」，验证不了抓取器。
//
//   node verify-report-filter.js               # 默认用上海数据
//   node verify-report-filter.js --province 江苏省
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = __dirname;
const src = fs.readFileSync(path.join(ROOT, 'tariff-scrape.js'), 'utf8');
// 主流程是 IIFE，直接 require 会启动抓取 —— 所以截到主流程之前，单独求值。
// 首行的 shebang 在 Function 构造体里是非法 token，先剥掉。
const head = src.split('// ════════════════ 主流程 ════════════════')[0].replace(/^#![^\n]*\n/, '');
const api = new Function('require', 'module', 'exports', '__dirname',
  `${head}\n; return { renderHTML, enrich, sortByOnlineDate, isCampus, priceValue, findBrowser };`,
)(require, module, exports, ROOT);

let pass = 0, fail = 0;
/** 断言：实测值与预期相等才算通过；不等就打印出来，不做「大致一致」这种含糊处理。 */
function check(label, actual, expected) {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}: 实测 ${actual} / 预期 ${expected}`);
}

(async () => {
  const argIdx = process.argv.indexOf('--province');
  const province = argIdx > -1 ? process.argv[argIdx + 1] : '上海市';
  const file = path.join(ROOT, 'data', `${province}-data.json`);
  if (!fs.existsSync(file)) {
    console.error(`缺少 ${file} —— 先跑一次抓取：node tariff-scrape.js -p ${province}`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const items = api.sortByOnlineDate(api.enrich(raw.items || []));
  const html = api.renderHTML(items, province, { newCount: 0, quietTabs: raw.quietTabs || [] });

  // Node 侧的预期值 —— 与页面里那段 JS 用同一套判定，但各算各的，两边对不上就是有 bug。
  const expectCampus = items.filter(api.isCampus).length;
  const expectZero = items.filter((i) => api.priceValue(i.price) === '0').length;
  const expectNonCampusZero = items.filter((i) => api.priceValue(i.price) === '0' && !api.isCampus(i)).length;
  console.log(`${province}: 共 ${items.length} 条 · 校园 ${expectCampus} 条 · 0元 ${expectZero} 条（其中非校园 ${expectNonCampusZero} 条）\n`);

  // 落盘到 data/（已被 .gitignore 忽略），别把临时报告写到仓库根目录。
  const tmpDir = path.join(ROOT, 'data');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, 'verify-report.html');
  fs.writeFileSync(tmp, html);

  const browser = await puppeteer.launch({
    executablePath: api.findBrowser(),
    headless: true,
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.goto('file://' + tmp.replace(/\\/g, '/'), { waitUntil: 'load' });

    const count = () => page.$$eval('.card', (cs) => cs.filter((c) => c.style.display !== 'none').length);
    const sectShown = () => page.$$eval('.sect', (ss) => ss.filter((s) => s.style.display !== 'none').length);
    const sectsTotal = await page.$$eval('.sect', (ss) => ss.length);

    console.log('【初始状态】数据属性');
    check('data-campus=1 的卡片数', await page.$$eval('.card[data-campus="1"]', (c) => c.length), expectCampus);
    check('data-price=0 的卡片数', await page.$$eval('.card[data-price="0"]', (c) => c.length), expectZero);
    check('初始可见卡片数', await count(), items.length);

    console.log('\n【搜索 0元 —— 应只留 price 数值为 0 的，不得混入 10元 / 100元】');
    await page.type('#q', '0元');
    check('可见卡片数', await count(), expectZero);
    // 反向验证：可见卡片里不能有任何 data-price 非 0 的
    const leak = await page.$$eval('.card', (cs) => cs.filter((c) => c.style.display !== 'none' && c.dataset.price !== '0').length);
    check('混入的非 0 元卡片数', leak, 0);

    console.log('\n【排除校园叠加在 0元 之上】');
    await page.click('#no-campus');
    check('可见卡片数', await count(), expectNonCampusZero);

    console.log('\n【清空搜索，仅排除校园】');
    await page.$eval('#q', (el) => { el.value = ''; el.dispatchEvent(new Event('input')); });
    check('可见卡片数', await count(), items.length - expectCampus);

    console.log('\n【取消勾选应完全复原】');
    await page.click('#no-campus');
    check('可见卡片数', await count(), items.length);
    check('可见区块数', await sectShown(), sectsTotal);

    console.log('\n【原有子串搜索不受影响】');
    await page.$eval('#q', (el) => { el.value = ''; el.dispatchEvent(new Event('input')); });
    await page.type('#q', '套餐');
    const expectSub = items.filter((i) => `${i.name} ${i.code} ${i.price}`.toLowerCase().includes('套餐')).length;
    check('搜「套餐」可见卡片数', await count(), expectSub);

    console.log('\n【搜不到东西时给提示，而不是白屏】');
    await page.$eval('#q', (el) => { el.value = ''; el.dispatchEvent(new Event('input')); });
    await page.type('#q', '这个词不存在xyz');
    check('可见卡片数', await count(), 0);
    check('可见区块数', await sectShown(), 0);
    check('「没有匹配的业务」提示可见', await page.$eval('#none', (el) => el.style.display !== 'none'), true);

    console.log(`\n${fail ? '✗' : '✓'} ${pass} 项通过，${fail} 项失败`);
    process.exitCode = fail ? 1 : 0;
  } finally {
    await browser.close();
    fs.unlinkSync(tmp);
  }
})();
