/**
 * 岗位匹配度评分
 *
 * 从 job-hunter-skill 的 6 维加权借鉴，但砍到 4 维 —— 只留"我们的数据能算准、
 * 且求职者真的在意"的部分。刻意不做 AI 评分：单次几百条岗位调 AI 又慢又贵，
 * 而且这种规则评分的好处是**每一分都能解释给用户看**。
 *
 * 权重（合计 100）：
 *   薪资匹配 35   —— 岗位薪资区间与期望区间重合得越好越高
 *   关键词命中 35 —— 标题里命中最高，JD / 技能标签命中次之
 *   新鲜度  20   —— 越近发现越高，10 天衰减到 0
 *   HR 活跃 10   —— HR 近期在线说明这岗位真的在招
 *
 * 拿不到数据的维度给"中性分"而不是 0 分，避免因为未登录/面议把岗位冤枉掉。
 */
import { parseSalary } from './db.mjs';

const WEIGHTS = {
  salary: 35,
  keyword: 35,
  freshness: 20,
  hrActive: 10,
};

function norm(s) {
  return String(s || '').toLowerCase();
}

/** 薪资匹配：看两个区间怎么重合 */
function scoreSalary(job, search) {
  const wantMin = Number(search.salary_min) || 0; // 单位 K
  const wantMax = Number(search.salary_max) || 0;
  if (!wantMin && !wantMax) {
    return { score: WEIGHTS.salary * 0.6, reason: '没设薪资期望' };
  }

  const s = parseSalary(job.salary_desc);
  if (s.min == null || s.unit === 'day') {
    // 面议 / 日薪岗：给中性分，别冤枉
    return { score: WEIGHTS.salary * 0.5, reason: '薪资未知或日薪' };
  }

  const lo = wantMin ? wantMin * 1000 : 0;
  const hi = wantMax ? wantMax * 1000 : Infinity;
  const overlap = Math.max(0, Math.min(s.max, hi) - Math.max(s.min, lo));
  const width = Math.max(1, Math.min(s.max, hi) === Infinity ? s.max - lo : Math.min(s.max, hi) - Math.max(s.min, lo));

  if (overlap <= 0) return { score: 0, reason: `薪资 ${job.salary_desc} 不在期望范围` };

  // 岗位区间整个落在期望里 → 满分；部分重叠按比例
  const jobWidth = Math.max(1, s.max - s.min);
  const ratio = Math.min(1, overlap / jobWidth);
  // 中位数越靠近期望区间中位越好
  const wantMid = (lo + (hi === Infinity ? lo + 20000 : hi)) / 2;
  const jobMid = (s.min + s.max) / 2;
  const dist = Math.abs(jobMid - wantMid);
  const distPenalty = Math.min(0.3, dist / Math.max(wantMid, 1) * 0.3);

  const score = WEIGHTS.salary * Math.max(0, ratio - distPenalty);
  return { score, reason: `薪资 ${job.salary_desc} 与期望重合 ${Math.round(ratio * 100)}%` };
}

/** 关键词命中：标题最重，其次技能标签，再次 JD 正文 */
function scoreKeyword(job, search) {
  const kws = String(search.keyword || '')
    .split(/[,，;；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!kws.length) return { score: WEIGHTS.keyword * 0.5, reason: '没设关键词' };

  const title = norm(job.title);
  const skills = norm(job.skills);
  const jd = norm(job.jd_text);

  let best = 0;
  let bestKw = '';
  for (const kw of kws) {
    const k = norm(kw);
    if (!k) continue;
    let v = 0;
    if (title.includes(k)) v = 1; // 标题命中，最可信
    else if (skills.includes(k)) v = 0.8;
    else if (jd.includes(k)) v = 0.6;
    if (v > best) {
      best = v;
      bestKw = kw;
    }
  }

  if (best === 0) {
    return { score: 0, reason: `标题/JD 都没命中「${kws.join('/')}」` };
  }
  return {
    score: WEIGHTS.keyword * best,
    reason: best === 1 ? `标题命中「${bestKw}」` : `「${bestKw}」命中在正文/标签里`,
  };
}

/** 新鲜度：今天=满分，10 天线性衰减到 0 */
function scoreFreshness(job) {
  if (!job.first_seen_at) return { score: 0, reason: '无入库时间' };
  const days = (Date.now() - new Date(job.first_seen_at).getTime()) / 86400000;
  if (days < 0) return { score: WEIGHTS.freshness, reason: '刚刚入库' };
  const ratio = Math.max(0, 1 - days / 10);
  return { score: WEIGHTS.freshness * ratio, reason: days < 1 ? '今天入库' : `${Math.floor(days)} 天前入库` };
}

/** HR 活跃度 */
function scoreHr(job) {
  if (job.hr_active && /在线/.test(job.hr_active)) {
    return { score: WEIGHTS.hrActive, reason: 'HR 近期在线' };
  }
  return { score: WEIGHTS.hrActive * 0.3, reason: 'HR 不在线' };
}

/** 对单条搜索配置算一次分 */
export function scoreAgainst(job, search) {
  const parts = [
    { key: 'salary', name: '薪资匹配', ...scoreSalary(job, search), max: WEIGHTS.salary },
    { key: 'keyword', name: '关键词命中', ...scoreKeyword(job, search), max: WEIGHTS.keyword },
    { key: 'freshness', name: '新鲜度', ...scoreFreshness(job), max: WEIGHTS.freshness },
    { key: 'hr', name: 'HR活跃', ...scoreHr(job), max: WEIGHTS.hrActive },
  ];
  const total = Math.round(parts.reduce((a, p) => a + p.score, 0));
  return { total, parts };
}

/**
 * 对一批搜索配置算分，取最匹配的那条。
 * 为什么取最高：同一个岗位可能被多个关键词捞到，按最贴合的那个关键词给分才合理。
 */
export function scoreJob(job, searches) {
  if (!searches || !searches.length) {
    const parts = [
      { key: 'freshness', name: '新鲜度', ...scoreFreshness(job), max: WEIGHTS.freshness },
      { key: 'hr', name: 'HR活跃', ...scoreHr(job), max: WEIGHTS.hrActive },
    ];
    return {
      total: Math.round(parts.reduce((a, p) => a + p.score, 0)),
      parts,
      matchedSearch: null,
    };
  }

  let best = null;
  for (const s of searches) {
    const r = scoreAgainst(job, s);
    if (!best || r.total > best.total) best = { ...r, matchedSearch: s.name || s.keyword };
  }
  return best;
}

export const SCORE_WEIGHTS = WEIGHTS;
