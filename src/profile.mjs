/**
 * 个人档案 —— 决定「哪些岗位根本不该出现在我的列表里」。
 *
 * 为什么要单独一层：
 *   「搜索配置」描述的是**我要找什么工作**（关键词、城市、薪资）；
 *   「档案」描述的是**我是谁**（几年经验、什么学历、能接受什么）。
 *   同一个关键词，5 年经验的社畜和应届生该看到的岗位完全不同 ——
 *   没有档案时，实习、校招这类岗位会混进列表，还白占每轮的 JD 抓取额度。
 *
 * 存在 settings['profile'] 里：每个安装一份，各自用自己的库，
 * 所以「不同的人资料不一样」天然成立。
 */

import { getSetting, setSetting } from './db.mjs';

// ---------------------------------------------------------------- 常量

/** 身份预设：不同身份 → 不同的默认剔除规则（这就是「按不同的人走不同筛选」的入口） */
export const IDENTITIES = [
  {
    key: '社畜',
    label: '社畜（已工作几年）',
    hint: '实习、校招、应届专属岗位一律不看',
    years: 3,
    hardRules: { intern: true, campus: true, belowExp: true, overDegree: false },
  },
  {
    key: '应届生',
    label: '应届生 / 在校生',
    hint: '校招和实习正是你要的，只拦「学历要求高于你」的',
    years: 0,
    hardRules: { intern: false, campus: false, belowExp: false, overDegree: true },
  },
  {
    key: '转行中',
    label: '转行中（愿意从低经验开始）',
    hint: '不拦经验偏低的岗位，只拦校招/应届专属',
    years: 2,
    hardRules: { intern: false, campus: true, belowExp: false, overDegree: false },
  },
  {
    key: '自由',
    label: '不设限（什么都不自动剔）',
    hint: '全部靠搜索配置自己的条件筛',
    years: 0,
    hardRules: { intern: false, campus: false, belowExp: false, overDegree: false },
  },
];

export const DEGREES = ['大专', '本科', '硕士', '博士'];

export const DEFAULT_PROFILE = {
  identity: '社畜',
  years: 3,
  degree: '本科',
  hardRules: { intern: true, campus: true, belowExp: true, overDegree: false },
  excludeWords: '',
};

const DEGREE_RANK = new Map([
  ['初中及以下', 0],
  ['中专/中技', 1],
  ['中专', 1],
  ['高中', 1],
  ['大专', 2],
  ['本科', 3],
  ['硕士', 4],
  ['博士', 5],
]);

const RE_INTERN_TITLE = /实习|见习/;
const RE_DAILY_PAY = /元\s*\/\s*天/;
const RE_INTERN_EXP = /\d+\s*天\s*\/\s*周|\d+\s*个月/;
const RE_CAMPUS_TITLE = /校招|应届|秋招|春招|管培|储备干部|20\d{2}\s*届|20\d{2}\s*校招/;

// ---------------------------------------------------------------- 工具

export function degreeRank(d) {
  if (!d) return null;
  const s = String(d).trim();
  if (/不限/.test(s)) return null;
  return DEGREE_RANK.has(s) ? DEGREE_RANK.get(s) : null;
}

/**
 * 把 BOSS 的经验文案解析成 [最少, 最多] 年。
 * 返回 null 表示「不限 / 不是年限文案」（比如实习的「5天/周 3个月」）。
 */
export function parseExpRange(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  if (/不限/.test(s)) return null;
  if (/应届|在校/.test(s)) return [0, 0];
  if (/以内/.test(s)) {
    const m = s.match(/(\d+)/);
    return m ? [0, Number(m[1])] : null;
  }
  if (/年以上/.test(s)) {
    const m = s.match(/(\d+)/);
    return m ? [Number(m[1]), 99] : null;
  }
  const m = s.match(/(\d+)\s*-\s*(\d+)/);
  if (m) return [Number(m[1]), Number(m[2])];
  return null;
}

function splitWords(text) {
  return String(text || '')
    .split(/[,，、\s]+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

/** 补齐缺省字段 + 夹紧范围，保证存进去的一定是可用形状 */
export function normalizeProfile(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const identity = IDENTITIES.some((i) => i.key === src.identity) ? src.identity : DEFAULT_PROFILE.identity;
  const preset = IDENTITIES.find((i) => i.key === identity) || null;
  const base = preset ? preset.hardRules : DEFAULT_PROFILE.hardRules;
  const hr = src.hardRules && typeof src.hardRules === 'object' ? src.hardRules : {};
  const years = Math.max(0, Math.min(50, Number(src.years) || 0));
  return {
    identity,
    years,
    degree: DEGREES.includes(src.degree) ? src.degree : DEFAULT_PROFILE.degree,
    hardRules: {
      intern: hr.intern ?? base.intern ?? true,
      campus: hr.campus ?? base.campus ?? true,
      belowExp: hr.belowExp ?? base.belowExp ?? true,
      overDegree: hr.overDegree ?? base.overDegree ?? false,
    },
    excludeWords: String(src.excludeWords ?? '').trim(),
  };
}

export function getProfile(db) {
  return normalizeProfile(getSetting(db, 'profile', null) || DEFAULT_PROFILE);
}

export function saveProfile(db, patch = {}) {
  const cur = getProfile(db);
  const next = normalizeProfile({
    ...cur,
    ...patch,
    hardRules: { ...cur.hardRules, ...(patch?.hardRules || {}) },
  });
  setSetting(db, 'profile', next);
  return next;
}

/** 切换身份时该用的默认勾选（前端「选身份 → 自动带出规则」用） */
export function presetFor(identity) {
  const p = IDENTITIES.find((i) => i.key === identity);
  return p ? { years: p.years, hardRules: { ...p.hardRules } } : null;
}

/** 一行人类可读的描述，给日志 / 界面标题用 */
export function profileSummary(p) {
  const hr = p.hardRules || {};
  const on = [];
  if (hr.intern) on.push('实习');
  if (hr.campus) on.push('校招/应届');
  if (hr.belowExp) on.push(`经验低于 ${Math.max(0, p.years - 1)} 年`);
  if (hr.overDegree) on.push('学历要求过高');
  const words = splitWords(p.excludeWords);
  return [
    p.identity,
    p.years ? `${p.years} 年` : '',
    p.degree,
    on.length ? '剔除：' + on.join(' / ') : '不自动剔除',
    words.length ? '排除词：' + words.join('、') : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

// ---------------------------------------------------------------- 判定

/**
 * 判断一条岗位该不该进我的列表。
 *
 * job 只要有 title / company / salary_desc / experience / degree 就够 ——
 * 抓取时的 card 和库里的行是同一个形状，所以「抓取时拦」和「回头重扫」共用这一份规则。
 *
 * @returns {{ok: true} | {ok: false, kind: 'intern'|'campus'|'exp'|'degree'|'word', reason: string}}
 */
export function evaluateJob(job, profile = DEFAULT_PROFILE) {
  const p = normalizeProfile(profile);
  const hr = p.hardRules;
  const title = String(job?.title || '');
  const company = String(job?.company || '');
  const salary = String(job?.salary_desc || '');
  const exp = String(job?.experience || '');
  const degree = String(job?.degree || '');

  // ---- 1. 实习 ----
  if (hr.intern) {
    if (RE_INTERN_TITLE.test(title)) return { ok: false, kind: 'intern', reason: '实习岗' };
    if (RE_DAILY_PAY.test(salary)) return { ok: false, kind: 'intern', reason: '日薪岗（基本是实习）' };
    if (RE_INTERN_EXP.test(exp)) return { ok: false, kind: 'intern', reason: '按周实习' };
  }

  // ---- 2. 校招 / 应届专属 ----
  if (hr.campus) {
    if (RE_CAMPUS_TITLE.test(title)) return { ok: false, kind: 'campus', reason: '校招/应届岗' };
    const r = parseExpRange(exp);
    if (r && r[1] === 0) return { ok: false, kind: 'campus', reason: '要求在校/应届' };
  }

  // ---- 3. 经验档位明显低于我（降级）----
  if (hr.belowExp && p.years > 0) {
    const r = parseExpRange(exp);
    if (r && r[1] !== 99 && r[1] < p.years - 1) {
      return { ok: false, kind: 'exp', reason: `经验上限 ${r[1]} 年，低于你的 ${p.years} 年` };
    }
  }

  // ---- 4. 学历要求高于我 ----
  if (hr.overDegree) {
    const need = degreeRank(degree);
    const mine = degreeRank(p.degree);
    if (need != null && mine != null && need > mine) {
      return { ok: false, kind: 'degree', reason: `要求 ${degree}，你填的是 ${p.degree}` };
    }
  }

  // ---- 5. 自定义排除词 ----
  for (const w of splitWords(p.excludeWords)) {
    const k = w.toLowerCase();
    if (title.toLowerCase().includes(k) || company.toLowerCase().includes(k)) {
      return { ok: false, kind: 'word', reason: `命中排除词「${w}」` };
    }
  }

  return { ok: true };
}

/** kind → 中文名，界面和统计里共用 */
export const KIND_LABEL = {
  intern: '实习',
  campus: '校招/应届',
  exp: '经验偏低',
  degree: '学历不够',
  word: '排除词',
};
