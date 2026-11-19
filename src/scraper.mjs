/**
 * 抓取层
 *
 * 全部结论都来自实测（2026-11-19），改代码前请先读这段：
 *
 *  1. 数据走接口，不解析 DOM。列表页会在几秒后被 BOSS 跳成 about:blank，DOM 取不到东西。
 *  2. 用 ctx.request 发请求：它共享浏览器的 cookie（含 __zp_stoken__），
 *     所以签名合法，并且完全不受页面存续影响。
 *  3. 打开一次搜索页只为两件事：让 cookie 生效、拿一份真实请求头模板。
 *  4. 【额度很紧】一轮里大约 7~8 次请求就会被 code=37 拦。所以：
 *       - 翻页优先级最高，详情放最后抓
 *       - 每个关键词详情预算 3 个，抓不完下次接着补
 *       - 页间 8~15 秒、关键词间 40~70 秒
 *  5. 未登录时第 1 页能看、薪资为空、第 2 页被静默封掉 —— 用「薪资是否为空」判断登录态最准。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { ensureDirs, newRunDir } from './paths.mjs';
import {
  openDb,
  getSearch,
  listSearches,
  upsertJob,
  saveJobDetail,
  recordSighting,
  touchSearchRun,
  hasJob,
  getJob,
  getSetting,
  parseSalary,
} from './db.mjs';
import { getProfile, evaluateJob, profileSummary } from './profile.mjs';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

const JOBLIST_API = 'https://www.zhipin.com/wapi/zpgeek/search/joblist.json';
const DETAIL_API = 'https://www.zhipin.com/wapi/zpgeek/job/detail.json';
const DETAIL_BUDGET = 3; // 每个关键词每轮最多抓几个详情

function traceId() {
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = 'F-';
  for (let i = 0; i < 27; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

function jobTypeName(t) {
  if (t === 0) return '全职';
  if (t === 1) return '实习';
  if (t === 2) return '兼职';
  return null;
}

function mapJob(x) {
  return {
    jobId: x.encryptJobId,
    title: x.jobName || '',
    company: x.brandName || null,
    company_id: x.encryptBrandId || null,
    industry: x.brandIndustry || null,
    scale: x.brandScaleName || null,
    stage: x.brandStageName || null,
    city: x.cityName || null,
    district: x.areaDistrict || null,
    business_zones: x.businessDistrict ? [x.businessDistrict] : null,
    salary_desc: x.salaryDesc || null,
    experience: x.jobExperience || null,
    degree: x.jobDegree || null,
    job_type: jobTypeName(x.jobType),
    skills: Array.isArray(x.skills) && x.skills.length ? x.skills : null,
    welfare: Array.isArray(x.welfareList) && x.welfareList.length ? x.welfareList : null,
    hr_name: x.bossName || null,
    hr_title: x.bossTitle || null,
    hr_active: x.bossOnline ? '在线' : null,
    url: `https://www.zhipin.com/job_detail/${x.encryptJobId}.html`,
  };
}

function parseExclude(str) {
  if (!str) return [];
  return String(str)
    .split(/[,，;；\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function hitExclude(job, words) {
  if (!words || !words.length) return null;
  const hay = `${job.title || ''} ${job.company || ''}`.toLowerCase();
  for (const w of words) {
    const k = String(w).trim().toLowerCase();
    if (k && hay.includes(k)) return w;
  }
  return null;
}

/**
 * 按搜索配置过滤岗位，返回跳过原因（null = 保留）。
 *
 * 几个刻意的取舍：
 *  - 薪资只按月薪比较。日薪岗（实习）和"面议"不参与，否则会把实习全误杀。
 *  - 判断"无交集"而不是"完全包含"：岗位写 15-30K、你期望 20-40K，有交集就该留。
 *  - 经验/学历带"不限"的一律保留，别把人筛没了。
 */
export function filterReason(card, search) {
  // ---- 薪资（配置单位是 K/月）----
  const wantMin = Number(search.salary_min) || 0;
  const wantMax = Number(search.salary_max) || 0;
  if (wantMin || wantMax) {
    const s = parseSalary(card.salary_desc);
    const monthly = s.min != null && s.unit !== 'day';
    if (monthly) {
      const lo = wantMin ? wantMin * 1000 : 0;
      const hi = wantMax ? wantMax * 1000 : Infinity;
      if (s.max < lo || s.min > hi) {
        return `薪资 ${card.salary_desc} 与期望 ${wantMin || '不限'}-${wantMax || '不限'}K 无交集`;
      }
    }
  }

  // ---- 经验 ----
  const wantExp = parseExclude(search.experience);
  if (wantExp.length && card.experience) {
    const e = String(card.experience).trim();
    const loose = /不限|应届/.test(e);
    const hit = wantExp.some((w) => e.includes(w) || w.includes(e));
    if (!loose && !hit) return `经验 ${e} 不符合`;
  }

  // ---- 学历 ----
  const wantDeg = parseExclude(search.degree);
  if (wantDeg.length && card.degree) {
    const d = String(card.degree).trim();
    const loose = /不限/.test(d);
    const hit = wantDeg.some((w) => d.includes(w) || w.includes(d));
    if (!loose && !hit) return `学历 ${d} 不符合`;
  }

  return null;
}

/**
 * 跑一轮。
 * opts: { searchId?, onLog? }
 */
export async function runSearch(opts = {}) {
  const { searchId = null, onLog = () => {} } = opts;
  const log = (m) => {
    onLog(m);
    console.log(m);
  };

  const dirs = ensureDirs();
  const db = openDb();
  const runDir = newRunDir('scrape');

  let searches;
  if (searchId) {
    const s = getSearch(db, searchId);
    if (!s) throw new Error(`找不到搜索配置 #${searchId}`);
    searches = [s];
  } else {
    searches = listSearches(db, { enabledOnly: true });
    if (!searches.length) {
      return { status: 'no_config', pages: 0, cards_seen: 0, new_jobs: 0, message: '没有启用的搜索配置，请先加一个' };
    }
  }

  const softDedupDays = Number(getSetting(db, 'softDedupDays', 0)) || 0;
  const profile = getProfile(db);
  const result = {
    status: 'ok',
    pages: 0,
    cards_seen: 0,
    new_jobs: 0,
    details: [],
    pending_details: 0,
    profile_skipped: 0,
    message: '',
  };

  log(`本轮任务：${searches.map((s) => s.keyword).join(' / ')}`);
  log(`档案：${profileSummary(profile)}`);

  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(dirs.profile, {
      headless: false,
      channel: 'msedge',
      viewport: { width: 1440, height: 950 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate,msEdgeTranslate',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });
  } catch (e) {
    return { ...result, status: 'error', message: `浏览器起不来：${e.message.split('\n')[0]}` };
  }

  try {
    const pages = ctx.pages();
    for (const p of pages.slice(1)) await p.close().catch(() => {});
    const page = pages[0] || (await ctx.newPage());

    // ---- 拿一份真实的请求头模板 ----
    let tpl = null;
    page.on('request', (r) => {
      if (tpl) return;
      if (r.url().includes('/wapi/zpgeek/search/joblist.json')) tpl = { ...r.headers() };
    });

    const first = searches[0];
    const firstUrl = `https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(first.keyword)}&city=${first.city_code || '100010000'}`;
    log('预热：打开搜索页让登录态与请求头就位');
    await page.goto(firstUrl, { waitUntil: 'commit', timeout: 45000 }).catch(() => {});
    for (let i = 0; i < 30 && !tpl; i++) await delay(500);
    if (!tpl) log('⚠ 没抓到请求头模板，使用兜底头（可能失败）');
    tpl = tpl || {};

    const ua = await page.evaluate(() => navigator.userAgent).catch(() => '');
    if (ua) tpl['user-agent'] = ua;

    const baseHeaders = () => {
      const h = { ...tpl };
      delete h['content-length'];
      delete h.host;
      delete h.connection;
      h['content-type'] = 'application/x-www-form-urlencoded';
      h['x-requested-with'] = 'XMLHttpRequest';
      h.traceid = traceId();
      return h;
    };

    /** 让页面停在一个稳定宿主上，避免被风控跳走导致请求失败 */
    async function stopPage() {
      let u = '';
      try {
        u = page.url();
      } catch {}
      if (!u.includes('zhipin.com')) {
        await page.goto('https://www.zhipin.com/robots.txt', { waitUntil: 'commit', timeout: 20000 }).catch(() => {});
        await delay(400);
      }
    }

    async function fetchList(search, pageNum) {
      await stopPage();
      const res = await ctx.request.post(`${JOBLIST_API}?_=${Date.now()}`, {
        headers: baseHeaders(),
        form: {
          page: String(pageNum),
          pageSize: '15',
          city: search.city_code || '100010000',
          expectInfo: '',
          query: search.keyword,
          multiSubway: '',
          multiBusinessDistrict: '',
          position: '',
          jobType: '',
          salary: '',
          experience: '',
          degree: '',
          industry: '',
          scale: '',
          stage: '',
          scene: '1',
          encryptExpectId: '',
        },
        timeout: 30000,
      });
      const j = await res.json().catch(() => ({}));
      return {
        http: res.status(),
        code: j.code,
        jobList: j.zpData?.jobList || [],
        total: j.zpData?.totalCount,
        hasMore: j.zpData?.hasMore,
      };
    }

    async function fetchDetail(securityId) {
      await stopPage();
      const h = baseHeaders();
      delete h['content-type'];
      const res = await ctx.request.get(`${DETAIL_API}?securityId=${encodeURIComponent(securityId)}`, {
        headers: h,
        timeout: 30000,
      });
      const j = await res.json().catch(() => ({}));
      return j.code === 0 ? j.zpData : null;
    }

    // ---- 登录态探测：用第 1 页的薪资是否为空来判断 ----
    log('检查登录态…');
    const check = await fetchList(first, 1);
    if (check.code === 37) {
      return { ...result, status: 'need_verify', message: '触发安全验证（code=37），请稍后重试或重新登录' };
    }
    if (!check.jobList.length) {
      return {
        ...result,
        status: 'error',
        message:
          '第 1 页没有数据。可能是登录失效、网络问题，或浏览器数据坏了。' +
          '可以先试 node src/cli.mjs login；还不行就 node src/cli.mjs reset-browser --yes 再登录一次。',
      };
    }
    const loggedIn = check.jobList.some((x) => x.salaryDesc);
    if (!loggedIn) {
      log('⚠ 未登录：薪资为空、无法翻页。只会抓第 1 页。请运行 login 命令。');
    } else {
      log('✓ 登录态有效（薪资可读）');
    }

    // ---- 逐关键词 ----
    let aborted = false;
    for (let si = 0; si < searches.length && !aborted; si++) {
      const search = searches[si];
      const excludeWords = parseExclude(search.exclude_words);
      const maxPages = loggedIn ? Math.min(Math.max(Number(search.max_pages) || 3, 1), 10) : 1;
      const wantDetail = Boolean(search.fetch_detail);
      /** 待补详情的岗位（先翻完页，最后再抓详情，把额度让给翻页） */
      const pendingDetail = [];

      log(`\n【${search.name || search.keyword}】最多 ${maxPages} 页`);

      for (let pn = 1; pn <= maxPages; pn++) {
        let r;
        if (si === 0 && pn === 1) {
          r = check; // 刚才探针已经拿过第 1 页，不重复请求
        } else {
          try {
            r = await fetchList(search, pn);
          } catch (e) {
            log(`  第 ${pn} 页请求失败：${e.message.slice(0, 90)}`);
            break;
          }
        }

        if (r.code === 37) {
          log(`  第 ${pn} 页触发安全验证（code=37），中止整轮`);
          result.status = 'need_verify';
          result.message = '触发 BOSS 安全验证（额度用完了），歇几分钟再跑，或重新登录';
          aborted = true;
          break;
        }
        if (!r.jobList.length) {
          log(`  第 ${pn} 页没有数据，结束`);
          break;
        }

        result.pages++;
        log(`  第 ${pn} 页：${r.jobList.length} 条（累计总 ${r.total}）`);

        for (const item of r.jobList) {
          result.cards_seen++;
          const card = mapJob(item);

          const ex = hitExclude(card, excludeWords);
          if (ex) {
            log(`    跳过「${card.title}」@ ${card.company}（命中排除词「${ex}」）`);
            continue;
          }

          // 档案拦在搜索配置前面：这类岗位压根不该入库，别浪费 JD 额度
          const pv = evaluateJob(card, profile);
          if (!pv.ok) {
            result.profile_skipped++;
            log(`    跳过「${card.title}」@ ${card.company}（档案：${pv.reason}）`);
            continue;
          }

          const filtered = filterReason(card, search);
          if (filtered) {
            log(`    跳过「${card.title}」@ ${card.company}（${filtered}）`);
            continue;
          }

          const up = upsertJob(db, card, { softDedupDays });
          recordSighting(db, card.jobId, search.id);

          if (up.isNew) {
            result.new_jobs++;
            result.details.push({
              jobId: card.jobId,
              title: card.title,
              company: card.company,
              salary: card.salary_desc,
            });
            log(`    ★ 新岗位：${card.title} / ${card.company} / ${card.salary_desc || '薪资未知'}`);
            if (wantDetail && item.securityId) {
              pendingDetail.push({ jobId: card.jobId, securityId: item.securityId, title: card.title, isNew: true });
            }
          } else {
            const old = getJob(db, card.jobId);
            if (wantDetail && item.securityId && old && !old.jd_text) {
              pendingDetail.push({ jobId: card.jobId, securityId: item.securityId, title: card.title, isNew: false });
            }
          }
        }

        touchSearchRun(db, search.id);

        if (!r.hasMore) {
          log('  没有更多页了');
          break;
        }
        if (pn < maxPages) {
          const wait = rand(8000, 15000);
          log(`  等 ${(wait / 1000).toFixed(1)} 秒再翻页…`);
          await delay(wait);
        }
      }

      // ---- 翻完页再抓详情，详情优先级低于翻页 ----
      if (pendingDetail.length) {
        const take = pendingDetail.slice(0, DETAIL_BUDGET);
        const rest = pendingDetail.length - take.length;
        log(`  待补详情 ${pendingDetail.length} 个，本轮抓 ${take.length} 个${rest > 0 ? `（剩 ${rest} 个下轮再补）` : ''}`);
        result.pending_details += rest;

        for (const p of take) {
          if (aborted) break;
          try {
            await delay(rand(4000, 8000));
            const d = await fetchDetail(p.securityId);
            if (d?.jobInfo) {
              const ji = d.jobInfo;
              saveJobDetail(db, p.jobId, {
                title: ji.jobName,
                salary_desc: ji.salaryDesc || undefined,
                experience: ji.experienceName,
                degree: ji.degreeName,
                jd_text: ji.postDescription,
              });
              log(`    ${p.isNew ? '已抓' : '补抓'} JD ${(ji.postDescription || '').length} 字：${p.title}`);
            }
          } catch (e) {
            log(`    JD 抓取失败：${e.message.slice(0, 70)}`);
          }
        }
      }

      // 换关键词的冷却
      if (si < searches.length - 1 && !aborted) {
        const gap = rand(40000, 70000);
        log(`  换下一个关键词，先停 ${(gap / 1000).toFixed(0)} 秒（冷却）…`);
        await delay(gap);
      }
    }

    fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
    if (!result.message) {
      result.message = `抓了 ${result.pages} 页 / ${result.cards_seen} 条，新增 ${result.new_jobs} 个`;
      if (result.profile_skipped > 0) result.message += `，档案挡掉 ${result.profile_skipped} 个`;
      if (result.pending_details > 0) result.message += `，${result.pending_details} 个岗位待补 JD`;
    }
    return result;
  } finally {
    await ctx.close().catch(() => {});
  }
}
