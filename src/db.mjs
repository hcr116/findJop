/**
 * 数据层：全部用 Node 内置的 node:sqlite，零原生依赖（分发时不用编译任何东西）。
 *
 * 设计的核心是"去重"：
 *   - 硬去重：job_id 从没见过 => 真·新岗位
 *   - 软去重（默认关）：同公司 + 同归一化标题 在 N 天内出现过 => 标为"疑似重新发布"，
 *     仍然入库、仍然能被搜到，但可以不计入"新机会"提醒。
 */
import { DatabaseSync } from 'node:sqlite';
import { dbPath, ensureDirs } from './paths.mjs';

let _db = null;

export function openDb() {
  if (_db) return _db;
  ensureDirs();
  const db = new DatabaseSync(dbPath());
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  _db = db;
  return db;
}

export function closeDb() {
  if (_db) {
    try {
      _db.close();
    } catch {}
    _db = null;
  }
}

// ---------------------------------------------------------------- schema

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS jobs (
  job_id         TEXT PRIMARY KEY,
  title          TEXT NOT NULL DEFAULT '',
  title_norm     TEXT NOT NULL DEFAULT '',
  company        TEXT,
  company_id     TEXT,
  industry       TEXT,
  scale          TEXT,
  stage          TEXT,
  city           TEXT,
  district       TEXT,
  business_zones TEXT,
  salary_desc    TEXT,
  salary_min     INTEGER,
  salary_max     INTEGER,
  salary_months  INTEGER,
  experience     TEXT,
  degree         TEXT,
  job_type       TEXT,
  skills         TEXT,
  welfare        TEXT,
  hr_name        TEXT,
  hr_title       TEXT,
  hr_active      TEXT,
  url            TEXT,
  jd_text        TEXT,
  jd_fetched_at  TEXT,
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  seen_count     INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'new',
  likely_repost_of TEXT,
  notes          TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_first_seen ON jobs(first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_last_seen  ON jobs(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_company    ON jobs(company_id, title_norm);
CREATE INDEX IF NOT EXISTS idx_jobs_status     ON jobs(status);

CREATE TABLE IF NOT EXISTS searches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  keyword      TEXT NOT NULL,
  city_code    TEXT,
  city_name    TEXT,
  salary_min   INTEGER,
  salary_max   INTEGER,
  experience   TEXT,
  degree       TEXT,
  job_type     TEXT,
  exclude_words TEXT,
  max_pages    INTEGER NOT NULL DEFAULT 3,
  fetch_detail INTEGER NOT NULL DEFAULT 1,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  last_run_at  TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  search_id   INTEGER,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL DEFAULT 'running',
  pages       INTEGER NOT NULL DEFAULT 0,
  cards_seen  INTEGER NOT NULL DEFAULT 0,
  new_jobs    INTEGER NOT NULL DEFAULT 0,
  message     TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);

CREATE TABLE IF NOT EXISTS sightings (
  job_id    TEXT NOT NULL,
  search_id INTEGER NOT NULL,
  seen_at   TEXT NOT NULL,
  PRIMARY KEY (job_id, search_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

/**
 * v2：自定义标签。
 *
 * 设计要点（贴着想用的场景来的）：
 *  - 标签名完全由用户自定义（「老逼登厂」这种也行），输入即创建。
 *  - 同一个标签可以挂在「岗位」或「公司」上：
 *      · 挂公司 = 这家公司所有岗位都自动带上（外包、老逼登厂）
 *      · 挂岗位 = 只影响这一条（已投递未过、已投递面过）
 *  - 一个目标可以挂任意多个标签。
 */
const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  color      TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tag_links (
  tag_id      INTEGER NOT NULL,
  target_type TEXT NOT NULL,   -- 'job' | 'company'
  target_id   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (tag_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_tag_links_target ON tag_links(target_type, target_id);
`;

/**
 * v3：投递时间线。
 *
 * 为什么不复用 jobs.status：status 是"这条岗位要不要看"的开关（新/收藏/忽略），
 * 而投递进展是**可以多次发生的流水**（投了→一面→二面→挂），
 * 用一条状态字段表达会丢历史。所以单独一张表，每次进展插一行。
 */
const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS applications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      TEXT NOT NULL,
  stage       TEXT NOT NULL,
  note        TEXT,
  happened_at TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_job ON applications(job_id, happened_at DESC);
`;

/** 投递阶段（顺序即推进顺序，UI 按这个排按钮） */
export const STAGES = [
  { key: 'applied', name: '已投递' },
  { key: 'screening', name: '简历筛选中' },
  { key: 'interview1', name: '一面' },
  { key: 'interview2', name: '二面' },
  { key: 'interview3', name: '三面' },
  { key: 'hr', name: 'HR 面' },
  { key: 'offer', name: '拿到 Offer' },
  { key: 'rejected', name: '挂了' },
  { key: 'withdrawn', name: '我放弃了' },
];

function migrate(db) {
  const row = db.prepare('PRAGMA user_version').get();
  const v = Number(row?.user_version ?? 0);
  if (v < 1) {
    db.exec(SCHEMA_V1);
    db.exec('PRAGMA user_version = 1');
  }
  if (v < 2) {
    db.exec(SCHEMA_V2);
    db.exec('PRAGMA user_version = 2');
  }
  if (v < 3) {
    db.exec(SCHEMA_V3);
    db.exec('PRAGMA user_version = 3');
  }
}

// ---------------------------------------------------------------- 小工具

export const nowIso = () => new Date().toISOString();

/** 本地时区"今天 0 点"对应的 UTC ISO 字符串 */
export function todayStartIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export function daysAgoIso(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

/** "15-25K·14薪" / "200-300元/天" / "面议" -> {min,max,months} */
export function parseSalary(desc) {
  if (!desc) return { min: null, max: null, months: null };
  const s = String(desc).replace(/\s+/g, '');
  // 月薪 K 区间
  let m = s.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*[Kk千]/);
  if (m) {
    const min = Math.round(parseFloat(m[1]) * 1000);
    const max = Math.round(parseFloat(m[2]) * 1000);
    const mm = s.match(/[·*xX×]\s*(\d{1,2})\s*薪/);
    return { min, max, months: mm ? Number(mm[1]) : 12 };
  }
  // 单一数值 + K
  m = s.match(/(\d+(?:\.\d+)?)\s*[Kk千]/);
  if (m) {
    const v = Math.round(parseFloat(m[1]) * 1000);
    return { min: v, max: v, months: 12 };
  }
  // 日薪
  m = s.match(/(\d+)\s*-\s*(\d+)\s*元?\/?[天日]/);
  if (m) return { min: Number(m[1]), max: Number(m[2]), months: null, unit: 'day' };
  return { min: null, max: null, months: null };
}

/** 标题归一化：用于软去重，别过度 —— 只做空白/全半角/括号内容处理 */
export function normalizeTitle(title) {
  return String(title || '')
    .replace(/[（(][^）)]*[）)]/g, '') // 去括号补充说明
    .replace(/[\s\u3000·・\-—_/\\|]+/g, '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .trim();
}

// ---------------------------------------------------------------- 岗位写入

const UPDATABLE = [
  'title',
  'title_norm',
  'company',
  'company_id',
  'industry',
  'scale',
  'stage',
  'city',
  'district',
  'business_zones',
  'salary_desc',
  'salary_min',
  'salary_max',
  'salary_months',
  'experience',
  'degree',
  'job_type',
  'skills',
  'welfare',
  'hr_name',
  'hr_title',
  'hr_active',
  'url',
];

/**
 * 写入一个列表页抓到的岗位。
 * 返回 { isNew, jobId, likelyRepostOf }
 */
export function upsertJob(db, card, opts = {}) {
  const { softDedupDays = 0 } = opts;
  const now = nowIso();
  const jobId = String(card.jobId);
  if (!jobId) throw new Error('upsertJob: 缺少 jobId');

  const norm = normalizeTitle(card.title);
  const salary = parseSalary(card.salary_desc);
  const row = {
    job_id: jobId,
    title: card.title || '',
    title_norm: norm,
    company: card.company ?? null,
    company_id: card.company_id ?? null,
    industry: card.industry ?? null,
    scale: card.scale ?? null,
    stage: card.stage ?? null,
    city: card.city ?? null,
    district: card.district ?? null,
    business_zones: card.business_zones ? JSON.stringify(card.business_zones) : null,
    salary_desc: card.salary_desc ?? null,
    salary_min: card.salary_min ?? salary.min,
    salary_max: card.salary_max ?? salary.max,
    salary_months: card.salary_months ?? salary.months,
    experience: card.experience ?? null,
    degree: card.degree ?? null,
    job_type: card.job_type ?? null,
    skills: card.skills ? JSON.stringify(card.skills) : null,
    welfare: card.welfare ? JSON.stringify(card.welfare) : null,
    hr_name: card.hr_name ?? null,
    hr_title: card.hr_title ?? null,
    hr_active: card.hr_active ?? null,
    url: card.url ?? null,
  };

  const existing = db.prepare('SELECT job_id, first_seen_at FROM jobs WHERE job_id = ?').get(jobId);

  if (existing) {
    // 用 COALESCE 保留旧值：这次没抓到的字段（null）不覆盖已有数据
    const sets = UPDATABLE.map((f) => `${f} = COALESCE(?, ${f})`).join(', ');
    const stmt = db.prepare(
      `UPDATE jobs SET last_seen_at = ?, seen_count = seen_count + 1, ${sets} WHERE job_id = ?`,
    );
    stmt.run(now, ...UPDATABLE.map((f) => row[f] ?? null), jobId);
    return { isNew: false, jobId, likelyRepostOf: null };
  }

  // 软去重：同公司 + 同标题，N 天内出现过
  let repostOf = null;
  if (softDedupDays > 0 && row.company_id && norm) {
    const cutoff = daysAgoIso(softDedupDays);
    const prev = db
      .prepare(
        `SELECT job_id FROM jobs
         WHERE company_id = ? AND title_norm = ? AND first_seen_at >= ?
         ORDER BY first_seen_at ASC LIMIT 1`,
      )
      .get(row.company_id, norm, cutoff);
    if (prev) repostOf = prev.job_id;
  }

  db.prepare(
    `INSERT INTO jobs (
       job_id, ${UPDATABLE.join(', ')},
       first_seen_at, last_seen_at, seen_count, status, likely_repost_of
     ) VALUES (?, ${UPDATABLE.map(() => '?').join(', ')}, ?, ?, 1, 'new', ?)`,
  ).run(jobId, ...UPDATABLE.map((f) => row[f] ?? null), now, now, repostOf);

  return { isNew: true, jobId, likelyRepostOf: repostOf };
}

export function saveJobDetail(db, jobId, detail) {
  const sets = [];
  const vals = [];
  const map = {
    title: detail.title,
    company: detail.company,
    salary_desc: detail.salary_desc,
    city: detail.city,
    district: detail.district,
    experience: detail.experience,
    degree: detail.degree,
    jd_text: detail.jd_text,
    hr_name: detail.hr_name,
    hr_title: detail.hr_title,
  };
  for (const [k, v] of Object.entries(map)) {
    if (v !== undefined && v !== null && v !== '') {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
  }
  if (detail.title) {
    sets.push('title_norm = ?');
    vals.push(normalizeTitle(detail.title));
  }
  sets.push('jd_fetched_at = ?');
  vals.push(nowIso());
  if (detail.salary_min != null) {
    sets.push('salary_min = ?', 'salary_max = ?');
    vals.push(detail.salary_min, detail.salary_max);
  }
  db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE job_id = ?`).run(...vals, jobId);
}

export function recordSighting(db, jobId, searchId) {
  db.prepare(
    `INSERT INTO sightings (job_id, search_id, seen_at) VALUES (?, ?, ?)
     ON CONFLICT(job_id, search_id) DO UPDATE SET seen_at = excluded.seen_at`,
  ).run(jobId, searchId, nowIso());
}

// ---------------------------------------------------------------- 查询

export function hasJob(db, jobId) {
  return Boolean(db.prepare('SELECT 1 FROM jobs WHERE job_id = ?').get(jobId));
}

export function listJobs(db, opts = {}) {
  const {
    since = null,
    status = null,
    q = null,
    company = null,
    limit = 200,
    offset = 0,
    includeReposts = true,
    onlyNew = false,
    excludeStatus = null,
  } = opts;
  const where = [];
  const args = [];
  if (since) {
    where.push('first_seen_at >= ?');
    args.push(since);
  }
  if (status) {
    where.push('status = ?');
    args.push(status);
  }
  if (onlyNew) {
    where.push("status = 'new'");
  }
  // 档案滤掉的岗位（status='filtered'）默认不进主列表 —— 它们是"本来就不该出现的"，
  // 但数据留着：档案一改就能恢复，也方便回头核对规则有没有误杀。
  if (excludeStatus) {
    where.push('status != ?');
    args.push(excludeStatus);
  }
  if (!includeReposts) {
    where.push('likely_repost_of IS NULL');
  }
  if (company) {
    where.push('company = ?');
    args.push(company);
  }
  if (q) {
    where.push('(title LIKE ? OR company LIKE ? OR jd_text LIKE ?)');
    const like = `%${q}%`;
    args.push(like, like, like);
  }
  const sql = `SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY first_seen_at DESC LIMIT ? OFFSET ?`;
  return db.prepare(sql).all(...args, limit, offset);
}

export function getJob(db, jobId) {
  return db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId) ?? null;
}

export function setJobStatus(db, jobId, status) {
  db.prepare('UPDATE jobs SET status = ? WHERE job_id = ?').run(status, jobId);
}

export function stats(db) {
  const today = todayStartIso();
  const get = (sql, ...a) => db.prepare(sql).get(...a);
  // 'filtered' = 被个人档案挡掉的。它们留在库里（档案一改就能放回），
  // 但不算进这些「你能看到多少」的数字，否则统计和列表对不上。
  const live = "status != 'filtered'";
  return {
    total: get(`SELECT COUNT(*) n FROM jobs WHERE ${live}`).n,
    today: get(`SELECT COUNT(*) n FROM jobs WHERE ${live} AND first_seen_at >= ?`, today).n,
    last7: get(`SELECT COUNT(*) n FROM jobs WHERE ${live} AND first_seen_at >= ?`, daysAgoIso(7)).n,
    starred: get("SELECT COUNT(*) n FROM jobs WHERE status='starred'").n,
    reposts: get('SELECT COUNT(*) n FROM jobs WHERE likely_repost_of IS NOT NULL').n,
    companies: get(`SELECT COUNT(DISTINCT company_id) n FROM jobs WHERE company_id IS NOT NULL AND ${live}`).n,
    searches: get('SELECT COUNT(*) n FROM searches WHERE enabled=1').n,
    filtered: get("SELECT COUNT(*) n FROM jobs WHERE status='filtered'").n,
  };
}

/** 这家公司之前出现过几次（给"你见过这家 N 次"用） */
export function companyHistory(db, companyId) {
  if (!companyId) return { count: 0, titles: [] };
  const rows = db
    .prepare(
      `SELECT title, title_norm, first_seen_at FROM jobs
       WHERE company_id = ? ORDER BY first_seen_at ASC`,
    )
    .all(companyId);
  return { count: rows.length, titles: rows };
}

// ---------------------------------------------------------------- 搜索配置

export function listSearches(db, { enabledOnly = false } = {}) {
  const sql = `SELECT * FROM searches ${enabledOnly ? 'WHERE enabled = 1' : ''} ORDER BY id`;
  return db.prepare(sql).all();
}

export function getSearch(db, id) {
  return db.prepare('SELECT * FROM searches WHERE id = ?').get(id) ?? null;
}

export function addSearch(db, s) {
  const stmt = db.prepare(
    `INSERT INTO searches
     (name, keyword, city_code, city_name, salary_min, salary_max, experience, degree,
      job_type, exclude_words, max_pages, fetch_detail, enabled, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
  );
  const r = stmt.run(
    s.name || s.keyword,
    s.keyword,
    s.city_code ?? null,
    s.city_name ?? null,
    s.salary_min ?? null,
    s.salary_max ?? null,
    s.experience ?? null,
    s.degree ?? null,
    s.job_type ?? null,
    s.exclude_words ?? null,
    s.max_pages ?? 3,
    s.fetch_detail ? 1 : 0,
    nowIso(),
  );
  return Number(r.lastInsertRowid);
}

export function updateSearch(db, id, patch) {
  const allowed = [
    'name',
    'keyword',
    'city_code',
    'city_name',
    'salary_min',
    'salary_max',
    'experience',
    'degree',
    'job_type',
    'exclude_words',
    'max_pages',
    'fetch_detail',
    'enabled',
  ];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (k in patch) {
      sets.push(`${k} = ?`);
      vals.push(patch[k]);
    }
  }
  if (!sets.length) return;
  db.prepare(`UPDATE searches SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
}

export function deleteSearch(db, id) {
  db.prepare('DELETE FROM searches WHERE id = ?').run(id);
}

export function touchSearchRun(db, id) {
  db.prepare('UPDATE searches SET last_run_at = ? WHERE id = ?').run(nowIso(), id);
}

/**
 * 挑出本轮该跑的那个搜索。
 *
 * 为什么需要它：实测一轮累计 7~9 次请求就会被 code=37 拦，
 * 所以默认「轮转」——一次只跑一个关键词，下次自动换下一个。
 * CLI 和网页按钮必须走同一个逻辑，否则从界面点「立即抓取」会一次跑全部，第二个必被拦。
 */
export function pickNextSearch(db) {
  const all = listSearches(db, { enabledOnly: true });
  if (!all.length) return null;
  if (all.length === 1) return all[0];
  const last = Number(getSetting(db, 'lastSearchId', 0)) || 0;
  const idx = all.findIndex((s) => s.id === last);
  const next = all[(idx + 1) % all.length];
  setSetting(db, 'lastSearchId', next.id);
  return next;
}

// ---------------------------------------------------------------- 运行记录

export function startRun(db, searchId) {
  const r = db
    .prepare('INSERT INTO runs (search_id, started_at, status) VALUES (?, ?, ?)')
    .run(searchId ?? null, nowIso(), 'running');
  return Number(r.lastInsertRowid);
}

export function finishRun(db, runId, patch) {
  db.prepare(
    `UPDATE runs SET finished_at = ?, status = ?, pages = ?, cards_seen = ?, new_jobs = ?, message = ?
     WHERE id = ?`,
  ).run(
    nowIso(),
    patch.status || 'ok',
    patch.pages ?? 0,
    patch.cards_seen ?? 0,
    patch.new_jobs ?? 0,
    patch.message ?? null,
    runId,
  );
}

export function listRuns(db, limit = 30) {
  return db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit);
}

// ---------------------------------------------------------------- 标签

/** 所有标签 + 各自被用了多少次，按使用量倒序（常用的排前面好点） */
export function listTags(db) {
  return db
    .prepare(
      `SELECT t.id, t.name, t.color, t.created_at,
              SUM(CASE WHEN l.target_type='job' THEN 1 ELSE 0 END) AS job_count,
              SUM(CASE WHEN l.target_type='company' THEN 1 ELSE 0 END) AS company_count
       FROM tags t LEFT JOIN tag_links l ON l.tag_id = t.id
       GROUP BY t.id
       ORDER BY (job_count + company_count) DESC, t.id ASC`,
    )
    .all();
}

/** 按名字取或建（输入即创建） */
export function ensureTag(db, name, color = null) {
  const n = String(name || '').trim();
  if (!n) throw new Error('标签名不能为空');
  const hit = db.prepare('SELECT id FROM tags WHERE name = ?').get(n);
  if (hit) return hit.id;
  const r = db.prepare('INSERT INTO tags (name, color, created_at) VALUES (?,?,?)').run(n, color, nowIso());
  return Number(r.lastInsertRowid);
}

export function renameTag(db, id, name) {
  db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(String(name).trim(), id);
}

export function setTagColor(db, id, color) {
  db.prepare('UPDATE tags SET color = ? WHERE id = ?').run(color, id);
}

/** 删标签（连带移除所有挂载） */
export function deleteTag(db, id) {
  db.prepare('DELETE FROM tag_links WHERE tag_id = ?').run(id);
  db.prepare('DELETE FROM tags WHERE id = ?').run(id);
}

/** 给某个岗位/公司挂标签。targetType: 'job' | 'company' */
export function linkTag(db, tagId, targetType, targetId) {
  db.prepare(
    `INSERT INTO tag_links (tag_id, target_type, target_id, created_at) VALUES (?,?,?,?)
     ON CONFLICT(tag_id, target_type, target_id) DO NOTHING`,
  ).run(tagId, targetType, String(targetId), nowIso());
}

export function unlinkTag(db, tagId, targetType, targetId) {
  db.prepare('DELETE FROM tag_links WHERE tag_id = ? AND target_type = ? AND target_id = ?').run(
    tagId,
    targetType,
    String(targetId),
  );
}

/**
 * 批量给一批 jobs 附上标签。
 * 返回 { [job_id]: { jobTags: [...], companyTags: [...], companyId } }
 * 岗位标签和公司标签分开给，前端才能区分"这条是我标在这岗上的"和"这家公司本来就这德行"。
 */
export function attachTags(db, jobs) {
  const result = {};
  if (!jobs.length) return result;

  const jobIds = jobs.map((j) => j.job_id);
  const companyIds = [...new Set(jobs.map((j) => j.company_id).filter(Boolean))];

  const byJob = {};
  if (jobIds.length) {
    const ph = jobIds.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT l.target_id, t.id, t.name, t.color
         FROM tag_links l JOIN tags t ON t.id = l.tag_id
         WHERE l.target_type = 'job' AND l.target_id IN (${ph})`,
      )
      .all(...jobIds);
    for (const r of rows) {
      (byJob[r.target_id] ||= []).push({ id: r.id, name: r.name, color: r.color });
    }
  }

  const byCompany = {};
  if (companyIds.length) {
    const ph = companyIds.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT l.target_id, t.id, t.name, t.color
         FROM tag_links l JOIN tags t ON t.id = l.tag_id
         WHERE l.target_type = 'company' AND l.target_id IN (${ph})`,
      )
      .all(...companyIds);
    for (const r of rows) {
      (byCompany[r.target_id] ||= []).push({ id: r.id, name: r.name, color: r.color });
    }
  }

  for (const j of jobs) {
    result[j.job_id] = {
      jobTags: byJob[j.job_id] || [],
      companyTags: j.company_id ? byCompany[j.company_id] || [] : [],
      companyId: j.company_id || null,
    };
  }
  return result;
}

/** 挂了某个标签的所有目标 id（用于按标签筛选） */
export function targetsWithTag(db, tagId) {
  return db
    .prepare('SELECT target_type, target_id FROM tag_links WHERE tag_id = ?')
    .all(tagId);
}

/**
 * 从「已忽略」的岗位里提炼排除词建议。
 *
 * 思路（借鉴 job-hunter-skill 的排除反馈）：你忽略的岗位是最诚实的偏好信号。
 * 这里只统计**公司名** —— 中文标题分词不可靠，而"这家公司我不想再看"是最常见的排除理由，
 * 也正好是 BOSS 上最容易反复刷屏的东西。
 */
export function suggestExcludeWords(db) {
  const rows = db
    .prepare(
      `SELECT company, COUNT(*) n, MAX(title) sample
       FROM jobs
       WHERE status = 'ignored' AND company IS NOT NULL AND company != ''
       GROUP BY company
       ORDER BY n DESC, company ASC
       LIMIT 40`,
    )
    .all();

  // 已有排除词的就别重复建议了
  const existing = new Set();
  for (const s of db.prepare('SELECT exclude_words FROM searches').all()) {
    for (const w of String(s.exclude_words || '').split(/[,，;；\n]/)) {
      const t = w.trim();
      if (t) existing.add(t);
    }
  }

  return rows
    .filter((r) => !existing.has(r.company))
    .map((r) => ({ word: r.company, count: r.n, sampleTitle: r.sample }));
}

/** 把一个词追加到所有启用中搜索配置的排除词里（去重） */
export function addExcludeWordEverywhere(db, word) {
  const w = String(word || '').trim();
  if (!w) return 0;
  let touched = 0;
  for (const s of listSearches(db, { enabledOnly: true })) {
    const list = String(s.exclude_words || '')
      .split(/[,，;；\n]/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (list.includes(w)) continue;
    list.push(w);
    db.prepare('UPDATE searches SET exclude_words = ? WHERE id = ?').run(list.join(','), s.id);
    touched++;
  }
  return touched;
}

// ---------------------------------------------------------------- 投递时间线

export function listApplications(db, jobId) {
  return db
    .prepare('SELECT * FROM applications WHERE job_id = ? ORDER BY happened_at DESC, id DESC')
    .all(jobId);
}

export function addApplication(db, jobId, stage, note = null, happenedAt = null) {
  const now = nowIso();
  const r = db
    .prepare('INSERT INTO applications (job_id, stage, note, happened_at, created_at) VALUES (?,?,?,?,?)')
    .run(jobId, stage, note, happenedAt || now, now);
  // 顺手把岗位状态标成已投递（除非已经是收藏/忽略这种更强的语义）
  const job = db.prepare('SELECT status FROM jobs WHERE job_id = ?').get(jobId);
  if (job && job.status === 'new') {
    db.prepare("UPDATE jobs SET status = 'applied' WHERE job_id = ?").run(jobId);
  }
  return Number(r.lastInsertRowid);
}

export function deleteApplication(db, id) {
  db.prepare('DELETE FROM applications WHERE id = ?').run(id);
}

/** 当前阶段 = 最新一条（挂掉/放弃也算当前状态） */
export function currentStage(db, jobId) {
  const rows = listApplications(db, jobId);
  return rows.length ? rows[0].stage : null;
}

/** 批量取当前阶段，列表页用（不做 N+1 查询） */
export function stagesFor(db, jobIds) {
  if (!jobIds.length) return {};
  const ph = jobIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT job_id, stage FROM applications
       WHERE id IN (SELECT MAX(id) FROM applications WHERE job_id IN (${ph}) GROUP BY job_id)`,
    )
    .all(...jobIds);
  const out = {};
  for (const r of rows) out[r.job_id] = r.stage;
  return out;
}

// ---------------------------------------------------------------- settings

export function getSetting(db, key, fallback = null) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!r) return fallback;
  try {
    return JSON.parse(r.value);
  } catch {
    return r.value;
  }
}

export function setSetting(db, key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, JSON.stringify(value));
}
