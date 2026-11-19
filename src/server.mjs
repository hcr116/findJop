#!/usr/bin/env node
/**
 * 本地 Web 服务：所有数据都从本机 SQLite 读，不联网、不上传。
 * 端口自动避让，启动后在控制台打印实际地址。
 */
import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { APP_ROOT, home } from './paths.mjs';
import { scoreJob } from './score.mjs';
import {
  openDb,
  stats,
  listJobs,
  getJob,
  setJobStatus,
  listSearches,
  getSearch,
  addSearch,
  updateSearch,
  deleteSearch,
  listRuns,
  startRun,
  finishRun,
  touchSearchRun,
  todayStartIso,
  daysAgoIso,
  companyHistory,
  getSetting,
  setSetting,
  pickNextSearch,
  listTags,
  ensureTag,
  renameTag,
  setTagColor,
  deleteTag,
  linkTag,
  unlinkTag,
  attachTags,
  targetsWithTag,
  listApplications,
  addApplication,
  deleteApplication,
  stagesFor,
  STAGES,
  suggestExcludeWords,
  addExcludeWordEverywhere,
} from './db.mjs';
import {
  getProfile,
  saveProfile,
  evaluateJob,
  profileSummary,
  presetFor,
  IDENTITIES,
  DEGREES,
  KIND_LABEL,
} from './profile.mjs';

const WEB_DIR = path.join(APP_ROOT, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 2e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

// 抓取任务状态（内存里即可，进程重启就清空）
const runner = { active: false, runId: null, searchId: null, logs: [], startedAt: null, finishedAt: null, result: null };

function pushLog(line) {
  runner.logs.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${line}`);
  if (runner.logs.length > 400) runner.logs.splice(0, runner.logs.length - 400);
}

async function startScrape(searchId) {
  if (runner.active) return { ok: false, error: '已经有一轮在跑了' };
  const db = openDb();

  // 和 CLI 保持同一套轮转逻辑：不指定就用 pickNextSearch 挑一个，
  // 否则从界面点「立即抓取」会一次跑全部关键词，第二个必被 code=37 拦。
  let target = searchId ?? null;
  if (!target) {
    const next = pickNextSearch(db);
    if (!next) return { ok: false, error: '还没有启用的搜索配置' };
    target = next.id;
  }

  runner.active = true;
  runner.logs = [];
  runner.startedAt = new Date().toISOString();
  runner.finishedAt = null;
  runner.result = null;
  runner.searchId = target;
  runner.runId = startRun(db, target);
  pushLog('开始抓取…');

  // 动态导入，避免没装 playwright 时连服务都起不来
  (async () => {
    try {
      const { runSearch } = await import('./scraper.mjs');
      const r = await runSearch({
        searchId: target,
        onLog: pushLog,
      });
      finishRun(db, runner.runId, r);
      runner.result = r;
      pushLog(`完成：${r.message || ''}`);
    } catch (e) {
      finishRun(db, runner.runId, { status: 'error', message: e.message });
      pushLog(`出错：${e.message}`);
      runner.result = { status: 'error', message: e.message };
    } finally {
      runner.active = false;
      runner.finishedAt = new Date().toISOString();
    }
  })();
  return { ok: true, runId: runner.runId };
}

// ---------------------------------------------------------------- API

/**
 * 按当前档案扫一遍库里所有岗位，算「该挡掉哪些、该放回哪些」。
 * 只算不改，rescan 和 preview 共用。
 */
function previewProfile(db, override = null) {
  const profile = override || getProfile(db);
  const jobs = listJobs(db, { limit: 100000 });
  const hits = [];
  const restore = [];
  const byKind = {};
  const samples = [];
  for (const j of jobs) {
    const v = evaluateJob(j, profile);
    if (!v.ok) {
      byKind[v.kind] = (byKind[v.kind] || 0) + 1;
      // 样例要包含「已经标成 filtered 的」——否则重扫完再看，界面会自相矛盾：
      // 上面说挡了 15 条，下面却说没有需要挡的。
      if (samples.length < 30) {
        samples.push({
          job_id: j.job_id,
          title: j.title,
          company: j.company,
          reason: v.reason,
          kind: v.kind,
          status: j.status,
          already: j.status === 'filtered',
        });
      }
      // 用户手动忽略的不动；已经是 filtered 的也不重复算
      if (j.status !== 'filtered' && j.status !== 'ignored') {
        hits.push({ job_id: j.job_id, title: j.title, company: j.company, reason: v.reason, kind: v.kind, status: j.status });
      }
    } else if (j.status === 'filtered') {
      // 档案放宽了 —— 之前挡掉的该放回来
      restore.push({ job_id: j.job_id, title: j.title, company: j.company });
    }
  }
  return {
    total: jobs.length,
    summary: profileSummary(profile),
    byKind,
    kinds: KIND_LABEL,
    hits,
    restore,
    samples,
  };
}

async function handleApi(req, res, url) {
  const db = openDb();
  const p = url.pathname.replace(/^\/api/, '');
  const q = url.searchParams;
  const method = req.method;

  // 概览
  if (p === '/overview' && method === 'GET') {
    const runs = listRuns(db, 1);
    return sendJson(res, {
      stats: stats(db),
      lastRun: runs[0] || null,
      running: runner.active,
      home: home(),
      loginHint: getSetting(db, 'loginHint', null),
    });
  }

  // 岗位列表
  if (p === '/jobs' && method === 'GET') {
    const since = q.get('since');
    let sinceIso = null;
    if (since === 'today') sinceIso = todayStartIso();
    else if (since === '7d') sinceIso = daysAgoIso(7);
    else if (since === '30d') sinceIso = daysAgoIso(30);
    else if (since) sinceIso = since;

    const tagFilter = q.get('tag') ? Number(q.get('tag')) : null;

    const wantStatus = q.get('status') || null;
    const includeFiltered = q.get('includeFiltered') === '1';

    let rows = listJobs(db, {
      since: sinceIso,
      status: wantStatus,
      // 档案滤掉的（status='filtered'）默认不进主列表：它们本来就不该出现。
      // 想看就带 includeFiltered=1，或者直接筛 status=filtered。
      excludeStatus: wantStatus || includeFiltered ? null : 'filtered',
      q: q.get('q') || null,
      company: q.get('company') || null,
      // 按标签筛只能在内存里做（标签是多对多，SQL 里 join 会让分页变复杂），
      // 所以带标签筛选时先多取一些再截断。几百条的规模完全够用。
      limit: tagFilter ? 100000 : Math.min(Number(q.get('limit')) || 200, 1000),
      offset: tagFilter ? 0 : Number(q.get('offset')) || 0,
      includeReposts: q.get('includeReposts') !== '0',
      onlyNew: q.get('onlyNew') === '1',
    });

    if (tagFilter) {
      const targets = targetsWithTag(db, tagFilter);
      const jobSet = new Set(targets.filter((t) => t.target_type === 'job').map((t) => t.target_id));
      const compSet = new Set(targets.filter((t) => t.target_type === 'company').map((t) => t.target_id));
      rows = rows.filter((r) => jobSet.has(r.job_id) || (r.company_id && compSet.has(r.company_id)));
      const limit = Math.min(Number(q.get('limit')) || 200, 1000);
      const offset = Number(q.get('offset')) || 0;
      rows = rows.slice(offset, offset + limit);
    }

    const tagMap = attachTags(db, rows);
    const searchesForScore = listSearches(db, { enabledOnly: true });
    const stageMap = stagesFor(db, rows.map((r) => r.job_id));
    let jobs = rows.map((r) => {
      const t = tagMap[r.job_id] || { jobTags: [], companyTags: [] };
      return {
        ...r,
        job_tags: t.jobTags,
        company_tags: t.companyTags,
        score: scoreJob(r, searchesForScore).total,
        stage: stageMap[r.job_id] || null,
      };
    });

    if (q.get('sort') === 'score') {
      jobs.sort((a, b) => b.score - a.score);
    }

    return sendJson(res, { jobs });
  }

  // 单个岗位
  let m = p.match(/^\/jobs\/([^/]+)$/);
  if (m && method === 'GET') {
    const job = getJob(db, decodeURIComponent(m[1]));
    if (!job) return sendJson(res, { error: 'not found' }, 404);
    const tagMap = attachTags(db, [job]);
    const t = tagMap[job.job_id] || { jobTags: [], companyTags: [] };
    const searchesForScore = listSearches(db, { enabledOnly: true });
    return sendJson(res, {
      job: { ...job, job_tags: t.jobTags, company_tags: t.companyTags },
      companyHistory: companyHistory(db, job.company_id),
      score: scoreJob(job, searchesForScore),
    });
  }

  // ---------------- 标签 ----------------
  if (p === '/tags' && method === 'GET') {
    return sendJson(res, { tags: listTags(db) });
  }
  if (p === '/tags' && method === 'POST') {
    const body = await readBody(req);
    try {
      const id = ensureTag(db, body.name, body.color || null);
      return sendJson(res, { ok: true, id });
    } catch (e) {
      return sendJson(res, { error: e.message }, 400);
    }
  }

  m = p.match(/^\/tags\/(\d+)$/);
  if (m && method === 'PATCH') {
    const body = await readBody(req);
    const id = Number(m[1]);
    if (body.name) renameTag(db, id, body.name);
    if (body.color !== undefined) setTagColor(db, id, body.color);
    return sendJson(res, { ok: true });
  }
  if (m && method === 'DELETE') {
    deleteTag(db, Number(m[1]));
    return sendJson(res, { ok: true });
  }

  // 挂标签：可以传 tagId，也可以只传 name（不存在就建）
  if (p === '/tags/link' && method === 'POST') {
    const body = await readBody(req);
    const { targetType, targetId } = body;
    if (!['job', 'company'].includes(targetType) || !targetId) {
      return sendJson(res, { error: 'targetType 必须是 job/company，且 targetId 不能为空' }, 400);
    }
    let tagId = body.tagId ? Number(body.tagId) : null;
    if (!tagId) {
      if (!body.name) return sendJson(res, { error: '需要 tagId 或 name' }, 400);
      tagId = ensureTag(db, body.name, body.color || null);
    }
    linkTag(db, tagId, targetType, String(targetId));
    return sendJson(res, { ok: true, tagId });
  }

  if (p === '/tags/unlink' && method === 'POST') {
    const body = await readBody(req);
    const { tagId, targetType, targetId } = body;
    if (!tagId || !targetType || !targetId) return sendJson(res, { error: '参数不全' }, 400);
    unlinkTag(db, Number(tagId), targetType, String(targetId));
    return sendJson(res, { ok: true });
  }

  // 改状态
  m = p.match(/^\/jobs\/([^/]+)\/status$/);
  if (m && method === 'POST') {
    const body = await readBody(req);
    if (!['new', 'starred', 'ignored', 'applied', 'expired'].includes(body.status)) {
      return sendJson(res, { error: 'bad status' }, 400);
    }
    setJobStatus(db, decodeURIComponent(m[1]), body.status);
    return sendJson(res, { ok: true });
  }

  // 搜索配置
  if (p === '/searches' && method === 'GET') {
    return sendJson(res, { searches: listSearches(db) });
  }
  if (p === '/searches' && method === 'POST') {
    const body = await readBody(req);
    if (!body.keyword || !String(body.keyword).trim()) {
      return sendJson(res, { error: '关键词不能为空' }, 400);
    }
    const id = addSearch(db, body);
    return sendJson(res, { ok: true, id });
  }
  m = p.match(/^\/searches\/(\d+)$/);
  if (m && method === 'PATCH') {
    const body = await readBody(req);
    updateSearch(db, Number(m[1]), body);
    return sendJson(res, { ok: true });
  }
  if (m && method === 'DELETE') {
    deleteSearch(db, Number(m[1]));
    return sendJson(res, { ok: true });
  }

  // 运行
  if (p === '/run' && method === 'POST') {
    const body = await readBody(req);
    const r = await startScrape(body.searchId ? Number(body.searchId) : null);
    return sendJson(res, r, r.ok ? 200 : 409);
  }
  if (p === '/run-status' && method === 'GET') {
    return sendJson(res, {
      active: runner.active,
      runId: runner.runId,
      searchId: runner.searchId,
      startedAt: runner.startedAt,
      finishedAt: runner.finishedAt,
      logs: runner.logs.slice(-200),
      result: runner.result,
    });
  }
  if (p === '/runs' && method === 'GET') {
    return sendJson(res, { runs: listRuns(db, 50) });
  }

  // 导出 CSV（带 BOM，Excel 打开不乱码）
  if (p === '/export.csv' && method === 'GET') {
    const since = q.get('since');
    let sinceIso = null;
    if (since === 'today') sinceIso = todayStartIso();
    else if (since === '7d') sinceIso = daysAgoIso(7);
    else if (since === '30d') sinceIso = daysAgoIso(30);

    const rows = listJobs(db, {
      since: sinceIso,
      status: q.get('status') || null,
      excludeStatus: q.get('status') ? null : 'filtered',
      q: q.get('q') || null,
      limit: 10000,
      offset: 0,
    });

    const cell = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = ['岗位', '薪资', '公司', '行业', '规模', '融资', '城市', '区', '经验', '学历', 'HR', 'HR职位', '首次发现', '见过次数', '状态', '链接', 'JD'];
    const lines = [head.map(cell).join(',')];
    for (const r of rows) {
      lines.push(
        [
          r.title,
          r.salary_desc,
          r.company,
          r.industry,
          r.scale,
          r.stage,
          r.city,
          r.district,
          r.experience,
          r.degree,
          r.hr_name,
          r.hr_title,
          r.first_seen_at,
          r.seen_count,
          r.status,
          r.url,
          r.jd_text,
        ]
          .map(cell)
          .join(','),
      );
    }
    const csv = '\uFEFF' + lines.join('\r\n');
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="boss-jobs-${new Date().toISOString().slice(0, 10)}.csv"`,
      'cache-control': 'no-store',
    });
    return res.end(csv);
  }

  // 设置
  if (p === '/settings' && method === 'GET') {
    return sendJson(res, {
      softDedupDays: getSetting(db, 'softDedupDays', 0),
      notify: getSetting(db, 'notify', true),
    });
  }
  if (p === '/settings' && method === 'POST') {
    const body = await readBody(req);
    for (const [k, v] of Object.entries(body)) setSetting(db, k, v);
    return sendJson(res, { ok: true });
  }

  // ---------------- 个人档案 ----------------
  // 「我是谁」决定「哪些岗位根本不该出现」：抓取时挡在入库前，老数据可以按档案重扫一遍。
  if (p === '/profile' && method === 'GET') {
    const profile = getProfile(db);
    return sendJson(res, {
      profile,
      identities: IDENTITIES,
      degrees: DEGREES,
      kinds: KIND_LABEL,
      summary: profileSummary(profile),
    });
  }
  if (p === '/profile' && method === 'POST') {
    const body = await readBody(req);
    const patch = {};
    for (const k of ['identity', 'years', 'degree', 'hardRules', 'excludeWords']) {
      if (body[k] !== undefined) patch[k] = body[k];
    }
    const profile = saveProfile(db, patch);
    return sendJson(res, { ok: true, profile, summary: profileSummary(profile) });
  }
  // 换身份时问一下该带出什么默认规则
  if (p === '/profile/preset' && method === 'GET') {
    return sendJson(res, { preset: presetFor(q.get('identity') || '') });
  }
  // 预演：按当前档案（或 body 里传来的候选档案），库里哪些会被挡掉（只看不改）
  if (p === '/profile/preview' && (method === 'GET' || method === 'POST')) {
    const body = method === 'POST' ? await readBody(req) : null;
    const r = previewProfile(db, body && Object.keys(body).length ? body : null);
    return sendJson(res, { ...r, hits: undefined, pending: r.hits.length });
  }
  // 落地：不符合的标成 filtered；之前被滤、现在符合的恢复成 new
  if (p === '/profile/rescan' && method === 'POST') {
    const r = previewProfile(db);
    for (const h of r.hits) setJobStatus(db, h.job_id, 'filtered');
    for (const x of r.restore) setJobStatus(db, x.job_id, 'new');
    return sendJson(res, {
      ok: true,
      filtered: r.hits.length,
      restored: r.restore.length,
      byKind: r.byKind,
      summary: r.summary,
    });
  }

  // ---------------- 排除词建议 ----------------
  if (p === '/suggest-excludes' && method === 'GET') {
    return sendJson(res, { suggestions: suggestExcludeWords(db) });
  }
  if (p === '/add-exclude-word' && method === 'POST') {
    const body = await readBody(req);
    const n = addExcludeWordEverywhere(db, body.word);
    return sendJson(res, { ok: true, touched: n });
  }

  // ---------------- 投递时间线 ----------------
  m = p.match(/^\/jobs\/([^/]+)\/applications$/);
  if (m && method === 'GET') {
    const jobId = decodeURIComponent(m[1]);
    return sendJson(res, { applications: listApplications(db, jobId), stages: STAGES });
  }
  if (m && method === 'POST') {
    const jobId = decodeURIComponent(m[1]);
    const body = await readBody(req);
    if (!STAGES.some((s) => s.key === body.stage)) {
      return sendJson(res, { error: '未知阶段' }, 400);
    }
    const id = addApplication(db, jobId, body.stage, body.note || null, body.happenedAt || null);
    return sendJson(res, { ok: true, id });
  }

  m = p.match(/^\/applications\/(\d+)$/);
  if (m && method === 'DELETE') {
    deleteApplication(db, Number(m[1]));
    return sendJson(res, { ok: true });
  }

  return sendJson(res, { error: 'unknown api' }, 404);
}

// ---------------------------------------------------------------- 静态文件

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(WEB_DIR, rel);
  // 防目录穿越
  if (!file.startsWith(WEB_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('404 not found');
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  });
}

// ---------------------------------------------------------------- 启动

function tryListen(server, port, attemptsLeft = 20) {
  return new Promise((resolve, reject) => {
    const onError = (e) => {
      server.off('listening', onOk);
      if (e.code === 'EADDRINUSE' && attemptsLeft > 0) {
        resolve(tryListen(server, port + 1, attemptsLeft - 1));
      } else reject(e);
    };
    const onOk = () => {
      server.off('error', onError);
      resolve(port);
    };
    server.once('error', onError);
    server.once('listening', onOk);
    server.listen(port, '127.0.0.1');
  });
}

export async function startServer(preferredPort = Number(process.env.BJ_PORT || 7799)) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      return serveStatic(req, res, url.pathname);
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
  });
  const port = await tryListen(server, preferredPort);
  return { server, port };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('server.mjs')) {
  const { port } = await startServer();
  console.log('');
  console.log('  ┌────────────────────────────────────────────┐');
  console.log('  │  BOSS 岗位追踪器已启动                     │');
  console.log(`  │  打开浏览器访问: http://127.0.0.1:${port}     │`);
  console.log('  │  Ctrl+C 停止                               │');
  console.log('  └────────────────────────────────────────────┘');
  console.log('');
}
