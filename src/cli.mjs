#!/usr/bin/env node
/**
 * 命令行入口
 *
 *   node src/cli.mjs serve      起本地网页（默认）
 *   node src/cli.mjs run        立刻抓一轮
 *   node src/cli.mjs login      打开专用浏览器登录（第一次用）
 *   node src/cli.mjs schedule   注册/删除 Windows 定时任务
 *   node src/cli.mjs status     看状态
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { APP_ROOT, home, ensureDirs } from './paths.mjs';
import { openDb, stats, listSearches, listRuns, pickNextSearch, listJobs, setJobStatus } from './db.mjs';
import { notify } from './notify.mjs';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

function findEdge() {
  return EDGE_CANDIDATES.find((p) => fs.existsSync(p)) || null;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- serve

async function cmdServe() {
  const { startServer } = await import('./server.mjs');
  const { port } = await startServer();
  const url = `http://127.0.0.1:${port}`;
  console.log('');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │  BOSS 岗位追踪器已启动                       │');
  console.log(`  │  ${url.padEnd(42)}│`);
  console.log('  │  Ctrl+C 停止                                 │');
  console.log('  └──────────────────────────────────────────────┘');
  console.log('');
  if (process.argv.includes('--open')) {
    spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', windowsHide: true, detached: true }).unref();
  }
}

// ---------------------------------------------------------------- run

async function cmdRun() {
  const { runSearch } = await import('./scraper.mjs');
  const { startRun, finishRun } = await import('./db.mjs');
  const db = openDb();

  let sid = process.argv[3] && /^\d+$/.test(process.argv[3]) ? Number(process.argv[3]) : null;
  const runAll = process.argv.includes('--all');

  // 轮转模式：默认一轮只跑一个关键词（详见 db.mjs 的 pickNextSearch 注释）
  if (!sid && !runAll) {
    const next = pickNextSearch(db);
    if (next) {
      sid = next.id;
      const total = listSearches(db, { enabledOnly: true }).length;
      if (total > 1) console.log(`（轮转：本次只跑「${next.keyword}」，想一次跑全部用 --all）`);
    }
  }

  // 记一笔运行日志，这样 status 里能看到"最近运行"
  const runId = startRun(db, sid);
  const says = [];
  let r;
  try {
    r = await runSearch({ searchId: sid, onLog: (m) => console.log(m) });
    finishRun(db, runId, r);
  } catch (e) {
    finishRun(db, runId, { status: 'error', message: e.message });
    throw e;
  }

  if (r.status === 'ok' && r.new_jobs > 0) {
    const names = (r.details || [])
      .slice(0, 3)
      .map((d) => `${d.title}·${d.company}`)
      .join('，');
    const body = r.new_jobs > 3 ? `${names} 等 ${r.new_jobs} 个新岗位` : `${names}`;
    notify(`BOSS 有 ${r.new_jobs} 个新岗位`, body);
    says.push(`发现 ${r.new_jobs} 个新岗位`);
  } else if (r.status === 'ok') {
    says.push('没有新岗位');
  } else if (r.status === 'need_login') {
    notify('BOSS 岗位追踪需要登录', '登录态过期了。运行 node src/cli.mjs login 重新扫码');
    says.push('需要重新登录');
  } else if (r.status === 'need_verify') {
    // 注意：code=37 绝大多数情况是「请求太快、额度用完」，不是登录失效。
    // 说成"需要登录"会让人白扫一次码，所以这里必须区分开。
    notify('BOSS 本次被风控拦了', '额度用完了，过几小时会自动恢复，不用手动处理');
    says.push('被风控拦了，等几小时就恢复');
  } else {
    notify('BOSS 岗位追踪出错', r.message || '未知错误');
    says.push(`出错：${r.message}`);
  }

  console.log('');
  console.log(`本轮结论：${r.message}`);
  db.close?.();
  process.exit(r.status === 'ok' ? 0 : 2);
}

// ---------------------------------------------------------------- login

async function cmdLogin() {
  const dirs = ensureDirs();
  const edge = findEdge();
  if (!edge) {
    console.error('✗ 找不到 Microsoft Edge。这个工具依赖系统自带 Edge 来带登录态。');
    process.exit(1);
  }

  // 如果浏览器还开着同一 profile，先提醒
  const ck = path.join(dirs.profile, 'Default', 'Network', 'Cookies');

  console.log('');
  console.log('  ┌────────────────────────────────────────────────────┐');
  console.log('  │  即将打开一个专用浏览器窗口                        │');
  console.log('  │  请在窗口里登录 BOSS 直聘（手机扫码最省事）        │');
  console.log('  │  登录成功后，把这个窗口关掉，我会自动检测           │');
  console.log('  └────────────────────────────────────────────────────┘');
  console.log('');

  const child = spawn(
    edge,
    [
      `--user-data-dir=${dirs.profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,msEdgeTranslate',
      '--window-size=1440,950',
      'https://www.zhipin.com/',
    ],
    { stdio: 'ignore', detached: true },
  );
  child.unref();

  // 轮询：Cookies 文件可读 且 含登录态 cookie
  const deadline = Date.now() + 15 * 60 * 1000;
  let loggedIn = false;
  while (Date.now() < deadline) {
    await delay(3000);
    let buf;
    try {
      const tmp = path.join(home(), 'ck-probe.db');
      fs.copyFileSync(ck, tmp);
      buf = tmp;
    } catch {
      continue; // 浏览器还开着
    }
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(buf, { readOnly: true });
      const rows = db.prepare("select name from cookies where host_key like '%zhipin%'").all();
      db.close();
      const names = rows.map((r) => r.name);
      if (names.some((n) => /^zp_at$/i.test(n))) {
        loggedIn = true;
        console.log(`✓ 检测到登录态（${names.length} 个 cookie）`);
        break;
      }
    } catch {}
    try {
      fs.rmSync(buf, { force: true });
    } catch {}
  }

  if (!loggedIn) {
    console.error('✗ 等了 15 分钟没检测到登录，请重试');
    process.exit(2);
  }

  // 写标记
  fs.writeFileSync(
    path.join(home(), 'login-state.json'),
    JSON.stringify({ loggedIn: true, loggedInAt: new Date().toISOString() }, null, 2),
    'utf8',
  );
  console.log('');
  console.log('✓ 登录完成。现在可以：');
  console.log('    node src/cli.mjs run      立刻抓一轮');
  console.log('    node src/cli.mjs serve    打开界面做配置');
  process.exit(0);
}

// ---------------------------------------------------------------- schedule

function cmdSchedule() {
  const action = process.argv[3] || 'install';
  const times = (process.argv[4] || '09:30,20:30').split(',').map((s) => s.trim());

  if (action === 'remove' || action === 'uninstall') {
    const out = spawnSync('schtasks', ['/Query', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    const lines = (out.stdout || '').split(/\r?\n/).filter((l) => l.includes('BossJobs_'));
    for (const line of lines) {
      const name = line.split('","')[0].replace(/^"/, '');
      spawnSync('schtasks', ['/Delete', '/TN', name, '/F'], { windowsHide: true });
      console.log(`已删除定时任务: ${name}`);
    }
    if (!lines.length) console.log('没有找到已注册的任务');
    return;
  }

  // 用一个包装 bat，避免 schtasks 参数里引号转义出问题
  const wrapper = path.join(home(), 'run-once.bat');
  const nodeExe = process.execPath;
  const cliPath = path.join(APP_ROOT, 'src', 'cli.mjs');
  fs.writeFileSync(
    wrapper,
    [
      '@echo off',
      'chcp 65001 >nul',
      `cd /d "${APP_ROOT}"`,
      `"${nodeExe}" "${cliPath}" run >> "${path.join(home(), 'schedule.log')}" 2>&1`,
    ].join('\r\n'),
    'utf8',
  );
  console.log(`已生成包装脚本: ${wrapper}`);

  for (const t of times) {
    if (!/^\d{1,2}:\d{2}$/.test(t)) {
      console.error(`时间格式不对: ${t}（应形如 09:30）`);
      continue;
    }
    const name = `BossJobs_${t.replace(':', '')}`;
    const r = spawnSync(
      'schtasks',
      ['/Create', '/TN', name, '/TR', `"${wrapper}"`, '/SC', 'DAILY', '/ST', t, '/F'],
      { encoding: 'utf8', windowsHide: true },
    );
    if (r.status === 0) console.log(`✓ 已注册每天 ${t} 运行: ${name}`);
    else console.error(`✗ 注册 ${t} 失败: ${(r.stderr || r.stdout || '').trim()}`);
  }
  console.log('');
  console.log('提示：定时任务只在电脑开机且已登录 Windows 时会跑。');
}

// ---------------------------------------------------------------- reset-browser

/**
 * 重置浏览器数据。
 *
 * 为什么需要：浏览器 profile 一旦被弄脏（比如反复被风控、cookie 状态异常），
 * 表现就是 BOSS 所有页面都变 about:blank，怎么跑都拿不到数据。
 * 这时候唯一的解法是清掉 profile 重新登录一次 —— 这个命令就是干这个的。
 */
async function cmdResetBrowser() {
  const dirs = ensureDirs();
  const profile = dirs.profile;
  if (!fs.existsSync(profile)) {
    console.log('浏览器数据本来就不存在，无需重置。');
    return;
  }
  const size = (() => {
    try {
      const walk = (d) =>
        fs.readdirSync(d, { withFileTypes: true }).reduce((sum, e) => {
          const p = path.join(d, e.name);
          if (e.isDirectory()) return sum + walk(p);
          try {
            return sum + fs.statSync(p).size;
          } catch {
            return sum;
          }
        }, 0);
      return walk(profile);
    } catch {
      return 0;
    }
  })();

  console.log(`将删除浏览器数据目录（${(size / 1024 / 1024).toFixed(1)} MB）：`);
  console.log(`  ${profile}`);
  console.log('');
  console.log('岗位数据库不受影响，只丢登录态 —— 之后需要重新 login 一次。');
  console.log('');

  const args = process.argv.slice(3);
  if (!args.includes('--yes') && !args.includes('-y')) {
    console.log('确认执行请加 --yes：');
    console.log('  node src/cli.mjs reset-browser --yes');
    return;
  }

  fs.rmSync(profile, { recursive: true, force: true });
  try {
    fs.rmSync(path.join(home(), 'login-state.json'), { force: true });
  } catch {}
  try {
    fs.rmSync(path.join(home(), 'ck-probe.db'), { force: true });
  } catch {}
  console.log('✓ 已删除。下次运行前请先执行：node src/cli.mjs login');
}

// ---------------------------------------------------------------- prune

/**
 * 清理历史数据：把不符合「任何一条启用中的搜索配置」的岗位标成 ignored。
 *
 * 场景：你后来才加上薪资/经验筛选，之前入库的一批低薪岗位还留在列表里。
 * 按当前配置回头扫一遍，把它们标忽略 —— 只改状态，不删数据，
 * 界面上点「重置为未处理」就能恢复。默认预演，加 --yes 才真的改。
 */
async function cmdPrune() {
  const { filterReason } = await import('./scraper.mjs');
  const db = openDb();
  const searches = listSearches(db, { enabledOnly: true });
  if (!searches.length) {
    console.log('没有启用的搜索配置，无从判断，先加一个再跑。');
    return;
  }

  const jobs = listJobs(db, { limit: 100000 });
  const hits = [];
  for (const j of jobs) {
    if (j.status === 'ignored') continue;
    const card = {
      title: j.title,
      company: j.company,
      salary_desc: j.salary_desc,
      experience: j.experience,
      degree: j.degree,
    };
    const accepted = searches.some((s) => !filterReason(card, s));
    if (!accepted) hits.push(j);
  }

  console.log(`库内共 ${jobs.length} 条，其中 ${hits.length} 条不符合当前筛选条件。`);
  if (hits.length) {
    console.log('');
    for (const j of hits.slice(0, 30)) {
      console.log(`  · ${(j.title || '').slice(0, 30)} | ${j.company || ''} | ${j.salary_desc || '?'}`);
    }
    if (hits.length > 30) console.log(`  … 还有 ${hits.length - 30} 条`);
    console.log('');
  }

  const args = process.argv.slice(3);
  if (!args.includes('--yes') && !args.includes('-y')) {
    console.log('预演结束，没有改动任何数据。真要标为忽略请加 --yes：');
    console.log('  node src/cli.mjs prune --yes');
    console.log('（只改状态，不删数据，界面里可以逐条恢复）');
    return;
  }

  for (const j of hits) setJobStatus(db, j.job_id, 'ignored');
  console.log(`✓ 已把 ${hits.length} 条标为忽略。界面「已忽略」里可查看，「重置为未处理」可恢复。`);
}

async function cmdStatus() {
  ensureDirs();
  const db = openDb();
  const s = stats(db);
  const searches = listSearches(db);
  const runs = listRuns(db, 5);

  let login = null;
  try {
    login = JSON.parse(fs.readFileSync(path.join(home(), 'login-state.json'), 'utf8'));
  } catch {}

  console.log('');
  console.log('  数据目录 :', home());
  console.log('  登录状态 :', login?.loggedIn ? `已登录（${login.loggedInAt || login.verifiedAt || '?'}）` : '未登录或未知');
  console.log('  岗位总数 :', s.total, `（今日 ${s.today} / 近7天 ${s.last7}）`);
  console.log('  覆盖公司 :', s.companies, `（收藏 ${s.starred}）`);
  console.log('  搜索配置 :', searches.length, '条', searches.length ? `（启用 ${searches.filter((x) => x.enabled).length}）` : '');
  for (const x of searches) {
    console.log(`    #${x.id} ${x.keyword} @ ${x.city_name || x.city_code || '全国'} 最多${x.max_pages}页 ${x.enabled ? '' : '(已停用)'}`);
  }
  console.log('  最近运行 :');
  for (const r of runs) {
    console.log(`    ${r.started_at.slice(0, 19).replace('T', ' ')}  ${r.status}  页${r.pages} 条${r.cards_seen} 新${r.new_jobs}  ${r.message || ''}`);
  }
  console.log('');
}

// ---------------------------------------------------------------- main

const cmd = process.argv[2] || 'serve';
const table = {
  serve: cmdServe,
  run: cmdRun,
  login: cmdLogin,
  schedule: cmdSchedule,
  status: cmdStatus,
  'reset-browser': cmdResetBrowser,
  prune: cmdPrune,
  help: async () => {
    console.log(`
BOSS 岗位追踪器

  node src/cli.mjs serve [--open]   起本地网页（--open 顺便打开浏览器）
  node src/cli.mjs run [id|--all]   立刻抓一轮（默认轮转，一次只跑一个关键词）
  node src/cli.mjs login            第一次用 / 登录过期：打开专用浏览器登录
  node src/cli.mjs schedule install [09:30,20:30]   注册每天定时任务
  node src/cli.mjs schedule remove                  删除定时任务
  node src/cli.mjs status           查看状态
  node src/cli.mjs reset-browser --yes              重置浏览器数据（修复白屏/拿不到数据）
`);
  },
};

if (!table[cmd]) {
  console.error(`未知命令: ${cmd}`);
  process.exit(1);
}
await table[cmd]();
