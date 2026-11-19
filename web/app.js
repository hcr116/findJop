// BOSS 岗位追踪 · 前端
// 纯原生 JS，无构建步骤，方便打包分发。

const API = (p) => `/api${p}`;

const state = {
  since: 'today',
  status: '',
  q: '',
  tagId: '',
  jobs: [],
  hasMore: false,
  tags: [],
  current: null,
  running: false,
  pollTimer: null,
};

// ---------------------------------------------------------------- 工具

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function relTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

/**
 * 岗位「多久没再见到」的标记。
 * 用途：BOSS 上岗位下架后，我们不会收到通知，只能靠"最近几次抓取都没它"来推断。
 * 超过 3 天没再出现就提示一下，避免你去投一个已经关掉的岗。
 */
function staleMark(lastSeenAt) {
  if (!lastSeenAt) return '';
  const days = (Date.now() - new Date(lastSeenAt).getTime()) / 86400000;
  if (days < 3) return '';
  return `${Math.floor(days)} 天未见`;
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.hidden = true), 2200);
}

async function api(path, opts = {}) {
  const res = await fetch(API(path), {
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      msg = j.error || msg;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

// ---------------------------------------------------------------- 概览

async function loadOverview() {
  try {
    const o = await api('/overview');
    const s = o.stats;
    $('#stToday').textContent = s.today;
    $('#stWeek').textContent = s.last7;
    $('#stTotal').textContent = s.total;
    $('#stCompany').textContent = s.companies;
    $('#stStar').textContent = s.starred;
    $('#homePath').textContent = `数据目录：${o.home}`;
    $('#homePath').title = o.home;
    state.running = o.running;
    updateRunBtn();
  } catch (e) {
    toast('读取概览失败：' + e.message);
  }
}

function updateRunBtn() {
  const b = $('#btnRun');
  b.disabled = state.running;
  b.textContent = state.running ? '抓取中…' : '立即抓取一轮';
}

// ---------------------------------------------------------------- 列表

const PAGE_SIZE = 200;

async function loadJobs({ append = false } = {}) {
  const params = new URLSearchParams();
  if (state.since) params.set('since', state.since);
  if (state.status) params.set('status', state.status);
  if (state.q) params.set('q', state.q);
  if (state.tagId) params.set('tag', state.tagId);
  if (state.sort === 'score') params.set('sort', 'score');
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String(append ? state.jobs.length : 0));

  const { jobs } = await api(`/jobs?${params}`);
  state.jobs = append ? [...state.jobs, ...jobs] : jobs;
  // 拿满一页才认为后面可能还有
  state.hasMore = jobs.length >= PAGE_SIZE;
  renderJobs();
}

function renderJobs() {
  const list = $('#list');
  const empty = $('#empty');

  if (!state.jobs.length) {
    list.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  list.innerHTML = state.jobs
    .map((j) => {
      const cls = [
        'job',
        isToday(j.first_seen_at) && j.status === 'new' ? 'is-new' : '',
        j.status === 'starred' ? 'is-starred' : '',
        j.status === 'ignored' ? 'is-ignored' : '',
      ]
        .filter(Boolean)
        .join(' ');

      const tags = [];
      if (j.experience) tags.push(`<span class="tag">${esc(j.experience)}</span>`);
      if (j.degree) tags.push(`<span class="tag">${esc(j.degree)}</span>`);
      if (j.city) tags.push(`<span class="tag brand">${esc(j.city)}</span>`);
      if (j.likely_repost_of) tags.push(`<span class="tag warn">疑似重发</span>`);
      if (j.stage) {
        const st = (state.stages || []).find((s) => s.key === j.stage);
        const bad = j.stage === 'rejected' || j.stage === 'withdrawn';
        tags.push(`<span class="tag ${bad ? 'warn' : 'brand'}">${esc(st ? st.name : j.stage)}</span>`);
      } else if (j.status === 'applied') {
        tags.push(`<span class="tag brand">已投递</span>`);
      }
      if (j.status === 'starred') tags.push(`<span class="tag warn">★ 收藏</span>`);

      const sc = Number(j.score) || 0;
      const scCls = sc >= 75 ? 'hi' : sc >= 50 ? 'mid' : 'lo';

      return `
      <article class="${cls}" data-id="${esc(j.job_id)}">
        <div class="job-title-row">
          <h3 class="job-title">${esc(j.title || '（无标题）')}</h3>
          <span class="salary">${esc(j.salary_desc || '面议')}</span>
          <span class="score ${scCls}" title="匹配度（薪资/关键词/新鲜度/HR活跃）">${sc}<small>分</small></span>
        </div>
        <div class="job-meta">
          <span class="company">${esc(j.company || '—')}</span>
          ${j.industry ? `<span class="sep">·</span><span>${esc(j.industry)}</span>` : ''}
          ${j.scale ? `<span class="sep">·</span><span>${esc(j.scale)}</span>` : ''}
          ${tags.length ? `<span class="sep">·</span>${tags.join('')}` : ''}
          ${(() => {
            const jt = j.job_tags || [];
            const ct = j.company_tags || [];
            if (!jt.length && !ct.length) return '';
            const chips = [
              ...jt.map((t) => `<span class="mini mini-job">${esc(t.name)}</span>`),
              ...ct.map((t) => `<span class="mini mini-company">${esc(t.name)}</span>`),
            ].join('');
            return `<span class="sep">·</span><span class="job-tags">${chips}</span>`;
          })()}
        </div>
        <div class="job-right">
          <span class="job-time">${esc(relTime(j.first_seen_at))}入库${(() => {
            const st = staleMark(j.last_seen_at);
            return st ? ` · <span style="color:#d97706">${esc(st)}</span>` : '';
          })()}</span>
          ${j.hr_name ? `<span class="hr">${esc(j.hr_name)}${j.hr_title ? ' · ' + esc(j.hr_title) : ''}</span>` : ''}
        </div>
      </article>`;
    })
    .join('') +
    (state.hasMore
      ? '<button id="btnMore" class="btn" style="margin:18px auto 8px;display:block;min-width:220px">加载更多</button>'
      : '');
}

// ---------------------------------------------------------------- 详情抽屉

async function openJob(jobId) {
  try {
    const { job, companyHistory, score } = await api(`/jobs/${encodeURIComponent(jobId)}`);
    state.current = job;

    $('#dTitle').textContent = job.title || '（无标题）';
    $('#dCompany').textContent = [job.company, job.industry, job.scale].filter(Boolean).join(' · ') || '—';

    const meta = [];
    if (job.salary_desc) meta.push(`<span class="tag brand">${esc(job.salary_desc)}</span>`);
    if (job.city) meta.push(`<span class="tag">${esc(job.city)}${job.district ? ' ' + esc(job.district) : ''}</span>`);
    if (job.experience) meta.push(`<span class="tag">${esc(job.experience)}</span>`);
    if (job.degree) meta.push(`<span class="tag">${esc(job.degree)}</span>`);
    if (job.job_type) meta.push(`<span class="tag">${esc(job.job_type)}</span>`);
    if (job.hr_name) meta.push(`<span class="tag">${esc(job.hr_name)}${job.hr_title ? ' · ' + esc(job.hr_title) : ''}</span>`);
    meta.push(`<span class="tag">首次 ${esc(relTime(job.first_seen_at))}</span>`);
    meta.push(`<span class="tag">见过 ${job.seen_count} 次</span>`);
    $('#dMeta').innerHTML = meta.join('');

    // 匹配度分项：每一分都能解释，方便判断这个分靠不靠谱
    if (score) {
      const cls = score.total >= 75 ? 'hi' : score.total >= 50 ? 'mid' : 'lo';
      $('#dScore').innerHTML = `
        <span class="score ${cls}" style="font-size:14px">${score.total}<small>分</small></span>
        <span class="muted" style="font-size:12px;margin-left:8px">匹配度</span>
        <div class="score-parts">
          ${score.parts
            .map(
              (p) =>
                `<div class="sp"><span class="sp-name">${esc(p.name)}</span>
                 <span class="sp-bar"><i style="width:${Math.max(2, (p.score / p.max) * 100)}%"></i></span>
                 <span class="sp-val">${p.score.toFixed(0)}/${p.max}</span>
                 <span class="sp-reason">${esc(p.reason)}</span></div>`,
            )
            .join('')}
        </div>`;
    } else {
      $('#dScore').innerHTML = '';
    }

    $('#dOpen').href = job.url || `https://www.zhipin.com/job_detail/${job.job_id}.html`;
    renderTagArea(job);
    await renderApplications(job);

    let jd = job.jd_text || '';
    const parseArr = (s) => {
      if (!s) return [];
      try {
        const v = JSON.parse(s);
        return Array.isArray(v) ? v : [];
      } catch {
        return []; // 数据脏了也不能让整个抽屉打不开
      }
    };
    const skills = parseArr(job.skills);
    const welfare = parseArr(job.welfare);
    let html = '';
    if (skills.length) html += `<h3>技能标签</h3><div>${skills.map((s) => `<span class="tag">${esc(s)}</span>`).join(' ')}</div>`;
    if (welfare.length) html += `<h3>福利</h3><div>${welfare.map((s) => `<span class="tag brand">${esc(s)}</span>`).join(' ')}</div>`;
    html += `<h3>职位描述</h3>${jd ? `<div>${esc(jd)}</div>` : '<p class="muted">还没抓取正文（只对新岗位抓详情，或该岗位被忽略了）。</p>'}`;
    $('#dJd').innerHTML = html;

    if (companyHistory && companyHistory.count > 1) {
      $('#dHist').innerHTML = `
        <strong>这家公司你之前见过 ${companyHistory.count} 个岗位：</strong>
        ${companyHistory.titles
          .filter((t) => t.title)
          .slice(-8)
          .map((t) => `<div class="hist-item">· ${esc(t.title)} — ${esc(relTime(t.first_seen_at))}</div>`)
          .join('')}`;
    } else {
      $('#dHist').innerHTML = '';
    }

    $('#drawer').hidden = false;
  } catch (e) {
    toast('打开详情失败：' + e.message);
  }
}

async function setStatus(status) {
  if (!state.current) return;
  await api(`/jobs/${encodeURIComponent(state.current.job_id)}/status`, {
    method: 'POST',
    body: JSON.stringify({ status }),
  });
  toast('已更新');
  state.current.status = status;
  await Promise.all([loadJobs(), loadOverview()]);
}

// ---------------------------------------------------------------- 标签

async function loadTags() {
  try {
    const { tags } = await api('/tags');
    state.tags = tags;

    const sel = $('#tagFilter');
    const cur = sel.value;
    sel.innerHTML =
      '<option value="">全部标签</option>' +
      tags
        .map(
          (t) =>
            `<option value="${t.id}">${esc(t.name)}（${(t.job_count || 0) + (t.company_count || 0)}）</option>`,
        )
        .join('');
    sel.value = cur;

    $('#tagSuggest').innerHTML = tags.map((t) => `<option value="${esc(t.name)}"></option>`).join('');
  } catch {}
}

function renderTagArea(job) {
  const chips = [];
  for (const t of job.job_tags || []) {
    chips.push(
      `<span class="chip chip-job">${esc(t.name)}<button data-tag-del="${t.id}" data-scope="job" title="从这条岗位移除">×</button></span>`,
    );
  }
  for (const t of job.company_tags || []) {
    chips.push(
      `<span class="chip chip-company">${esc(t.name)}<button data-tag-del="${t.id}" data-scope="company" title="从这家公司移除（影响它所有岗位）">×</button></span>`,
    );
  }
  $('#dTags').innerHTML = chips.length
    ? chips.join('')
    : '<span class="muted" style="font-size:12px">还没打标签，下面输入框加一个</span>';
}

async function addTag() {
  const name = $('#tagInput').value.trim();
  const scope = $('#tagScope').value;
  const job = state.current;
  if (!name || !job) {
    $('#tagInput').focus();
    return;
  }
  const targetId = scope === 'company' ? job.company_id : job.job_id;
  if (!targetId) {
    toast('这条没有公司 ID，只能标到岗位');
    return;
  }
  try {
    await api('/tags/link', {
      method: 'POST',
      body: JSON.stringify({ name, targetType: scope, targetId }),
    });
    $('#tagInput').value = '';
    await loadTags();
    await openJob(job.job_id);
    await loadJobs();
    toast(`已加上「${name}」`);
  } catch (e) {
    toast('添加失败：' + e.message);
  }
}

async function removeTag(tagId, scope) {
  const job = state.current;
  if (!job) return;
  const targetId = scope === 'company' ? job.company_id : job.job_id;
  if (!targetId) return;
  try {
    await api('/tags/unlink', {
      method: 'POST',
      body: JSON.stringify({ tagId: Number(tagId), targetType: scope, targetId }),
    });
    await loadTags();
    await openJob(job.job_id);
    await loadJobs();
  } catch (e) {
    toast('移除失败：' + e.message);
  }
}

// ---------------------------------------------------------------- 投递时间线

async function renderApplications(job) {
  let data;
  try {
    data = await api(`/jobs/${encodeURIComponent(job.job_id)}/applications`);
  } catch {
    return;
  }
  if (data.stages && data.stages.length) state.stages = data.stages;

  const apps = data.applications || [];
  const cur = apps.length ? apps[0].stage : null;
  const reached = new Set(apps.map((a) => a.stage));

  const curName = cur ? (state.stages.find((s) => s.key === cur) || {}).name || cur : null;
  $('#dStageNow').textContent = curName ? `当前：${curName}` : '还没记录';

  // 阶段按钮：已走过的标记 done，当前高亮
  $('#dStages').innerHTML = state.stages
    .map((s) => {
      const bad = s.key === 'rejected' || s.key === 'withdrawn';
      const kls = [
        'stage-btn',
        bad ? 'bad' : '',
        s.key === cur ? 'cur' : reached.has(s.key) ? 'done' : '',
      ]
        .filter(Boolean)
        .join(' ');
      return `<button class="${kls}" data-stage="${s.key}">${esc(s.name)}</button>`;
    })
    .join('');

  // 时间线（倒序，最新在上）
  $('#dTimeline').innerHTML = apps.length
    ? apps
        .map((a, i) => {
          const st = state.stages.find((s) => s.key === a.stage);
          const bad = a.stage === 'rejected' || a.stage === 'withdrawn';
          return `<div class="tl-item ${i === 0 ? 'first' : ''} ${bad ? a.stage : ''}" data-app="${a.id}">
            <span class="tl-dot"></span>
            <div class="tl-body">
              <div class="tl-stage">${esc(st ? st.name : a.stage)}</div>
              ${a.note ? `<div class="tl-note">${esc(a.note)}</div>` : ''}
            </div>
            <div style="display:flex;align-items:center">
              <span class="tl-time">${esc(relTime(a.happened_at))}</span>
              <button class="tl-del" data-app-del="${a.id}" title="删掉这条记录">✕</button>
            </div>
          </div>`;
        })
        .join('')
    : '<p class="muted" style="font-size:12.5px;margin:4px 0 0">还没投递记录。点上面的阶段按钮开始记。</p>';
}

async function addStage(stageKey) {
  const job = state.current;
  if (!job) return;
  const note = ($('#appNote').value || '').trim() || null;
  try {
    await api(`/jobs/${encodeURIComponent(job.job_id)}/applications`, {
      method: 'POST',
      body: JSON.stringify({ stage: stageKey, note }),
    });
    $('#appNote').value = '';
    await openJob(job.job_id);
    await loadJobs();
    await loadOverview();
  } catch (e) {
    toast('记录失败：' + e.message);
  }
}

async function deleteStage(appId) {
  const job = state.current;
  if (!job) return;
  try {
    await api(`/applications/${appId}`, { method: 'DELETE' });
    await openJob(job.job_id);
    await loadJobs();
  } catch (e) {
    toast('删除失败：' + e.message);
  }
}

// ---------------------------------------------------------------- 配置页

const CITIES = [
  ['100010000', '全国'],
  ['101020100', '上海'],
  ['101010100', '北京'],
  ['101280600', '深圳'],
  ['101280100', '广州'],
  ['101210100', '杭州'],
  ['101270100', '成都'],
  ['101200100', '武汉'],
  ['101190100', '南京'],
  ['101110100', '西安'],
  ['101250100', '长沙'],
  ['101040100', '重庆'],
  ['101190400', '苏州'],
  ['101230200', '厦门'],
  ['101120200', '青岛'],
];

async function renderSearches() {
  const { searches } = await api('/searches');
  const pane = $('#paneSearches');

  const rows = searches
    .map(
      (s) => `
    <tr data-id="${s.id}">
      <td>${esc(s.name || s.keyword)}</td>
      <td><code>${esc(s.keyword)}</code></td>
      <td>${esc(s.city_name || s.city_code || '—')}</td>
      <td>${s.max_pages}</td>
      <td>${s.fetch_detail ? '是' : '否'}</td>
      <td>${s.last_run_at ? esc(relTime(s.last_run_at)) : '从未'}</td>
      <td>
        <button class="btn tiny" data-run="${s.id}">跑这个</button>
        <button class="btn tiny" data-toggle="${s.id}" data-enabled="${s.enabled}">${s.enabled ? '停用' : '启用'}</button>
        <button class="btn tiny" data-del="${s.id}">删除</button>
      </td>
    </tr>`,
    )
    .join('');

  pane.innerHTML = `
    <form id="formSearch" class="form-grid">
      <div class="field"><label>名称（随便起）</label><input name="name" placeholder="比如：战斗策划-上海" /></div>
      <div class="field"><label>关键词 *</label><input name="keyword" required placeholder="战斗策划" /></div>
      <div class="field"><label>城市</label>
        <select name="city_code">
          ${CITIES.map(([c, n]) => `<option value="${c}">${n}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>薪资下限(K/月)</label><input name="salary_min" type="number" placeholder="15" /></div>
      <div class="field"><label>薪资上限(K/月)</label><input name="salary_max" type="number" placeholder="40" /></div>
      <div class="field"><label>最多翻几页</label><input name="max_pages" type="number" value="3" min="1" max="10" /></div>
      <div class="field"><label>经验（逗号分隔，留空=不限）</label><input name="experience" placeholder="3-5年,5-10年" /></div>
      <div class="field"><label>学历（逗号分隔，留空=不限）</label><input name="degree" placeholder="本科,硕士" /></div>
      <div class="field wide"><label>排除词（逗号分隔，命中就跳过）</label><input name="exclude_words" placeholder="外包,驻场,代练,销售" /></div>
      <div class="field"><label>给新岗位抓 JD 正文</label>
        <select name="fetch_detail"><option value="1">是（推荐）</option><option value="0">否</option></select>
      </div>
      <div class="field" style="justify-content:flex-end"><button class="btn primary" type="submit">添加搜索</button></div>
    </form>
    <table class="search-table">
      <thead><tr><th>名称</th><th>关键词</th><th>城市</th><th>页数</th><th>抓JD</th><th>上次跑</th><th>操作</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="muted" style="padding:20px;text-align:center">还没有搜索配置</td></tr>'}</tbody>
    </table>
    <div class="field wide" style="flex-direction:row;align-items:center;gap:10px;background:#fafbfc;border:1px solid var(--line);border-radius:8px;padding:10px 12px">
      <label style="display:flex;align-items:center;gap:7px;font-size:13px;color:var(--text);cursor:pointer">
        <input type="checkbox" id="chkSoftDedup" style="width:15px;height:15px" />
        开启「疑似重发」过滤（30 天内同公司同岗位重发，不提醒）
      </label>
    </div>
    <div id="suggestBox" style="margin-bottom:14px"></div>
    <p class="muted" style="margin-top:14px">提示：关键词可以写多个，用逗号分隔会分别抓取（如 <code>战斗策划,系统策划</code>）。</p>
  `;

  $('#formSearch').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    body.max_pages = Number(body.max_pages) || 3;
    body.fetch_detail = body.fetch_detail === '1';
    for (const k of ['salary_min', 'salary_max']) {
      body[k] = body[k] ? Number(body[k]) : null;
    }
    const city = CITIES.find(([c]) => c === body.city_code);
    body.city_name = city ? city[1] : body.city_code;
    try {
      await api('/searches', { method: 'POST', body: JSON.stringify(body) });
      toast('已添加');
      renderSearches();
    } catch (err) {
      toast('添加失败：' + err.message);
    }
  });

  pane.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('确定删除这个搜索配置？已抓到的岗位数据不会删。')) return;
      await api(`/searches/${b.dataset.del}`, { method: 'DELETE' });
      toast('已删除');
      renderSearches();
    }),
  );

  pane.querySelectorAll('[data-toggle]').forEach((b) =>
    b.addEventListener('click', async () => {
      await api(`/searches/${b.dataset.toggle}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: b.dataset.enabled === '1' ? 0 : 1 }),
      });
      renderSearches();
    }),
  );

  pane.querySelectorAll('[data-run]').forEach((b) =>
    b.addEventListener('click', async () => {
      await triggerRun(Number(b.dataset.run));
    }),
  );

  // 软去重开关
  const chk = $('#chkSoftDedup');
  if (chk) {
    api('/settings')
      .then((s) => {
        chk.checked = Number(s.softDedupDays) > 0;
      })
      .catch(() => {});
    chk.addEventListener('change', async () => {
      try {
        await api('/settings', {
          method: 'POST',
          body: JSON.stringify({ softDedupDays: chk.checked ? 30 : 0 }),
        });
        toast(chk.checked ? '已开启：30 天内同公司同岗位重发不再标新' : '已关闭软去重');
        loadJobs();
      } catch (e) {
        toast('保存失败：' + e.message);
      }
    });
  }

  loadSuggestExcludes();
}

/**
 * 排除词建议：把你「忽略」过的岗位里的公司名提炼出来，一键加进排除词。
 * 这就是排除反馈闭环 —— 你的忽略动作本身应该让下一轮更准。
 */
async function loadSuggestExcludes() {
  const box = $('#suggestBox');
  if (!box) return;
  let suggestions = [];
  try {
    suggestions = (await api('/suggest-excludes')).suggestions || [];
  } catch {
    return;
  }

  if (!suggestions.length) {
    box.innerHTML = `<p class="muted" style="font-size:12.5px;margin:0">还没有可提炼的排除词。你「忽略」掉一些岗位后，这里会建议把对应公司加进排除词。</p>`;
    return;
  }

  box.innerHTML = `
    <div class="tag-area-head" style="margin-bottom:8px">
      <span>从「已忽略」的岗位提炼排除词</span>
      <span class="muted" style="font-size:12px">加进排除词后，下次抓到这些公司会直接跳过</span>
    </div>
    <div class="tag-list">
      ${suggestions
        .map(
          (s) =>
            `<span class="chip chip-company">${esc(s.word)}<span style="opacity:.55;margin-left:4px">×${s.count}</span><button data-add-exclude="${esc(s.word)}" title="加进排除词">+</button></span>`,
        )
        .join('')}
    </div>`;

  box.querySelectorAll('[data-add-exclude]').forEach((b) =>
    b.addEventListener('click', async () => {
      const w = b.dataset.addExclude;
      try {
        const r = await api('/add-exclude-word', { method: 'POST', body: JSON.stringify({ word: w }) });
        toast(`已把「${w}」加进 ${r.touched} 条配置的排除词`);
        loadSuggestExcludes();
        renderSearches();
      } catch (e) {
        toast('失败：' + e.message);
      }
    }),
  );
}

// ---------------------------------------------------------------- 运行

async function triggerRun(searchId = null) {
  try {
    await api('/run', { method: 'POST', body: JSON.stringify({ searchId }) });
    state.running = true;
    updateRunBtn();
    openModal('log');
    startPolling();
  } catch (e) {
    toast(e.message);
  }
}

function startPolling() {
  clearInterval(state.pollTimer);
  pollOnce();
  state.pollTimer = setInterval(pollOnce, 1500);
}

async function pollOnce() {
  try {
    const st = await api('/run-status');
    $('#paneLog').innerHTML = `<div class="logbox">${esc(st.logs.join('\n') || '（暂无输出）')}</div>`;
    const box = $('#paneLog .logbox');
    if (box) box.scrollTop = box.scrollHeight;

    state.running = st.active;
    updateRunBtn();

    if (!st.active) {
      clearInterval(state.pollTimer);
      await Promise.all([loadOverview(), loadJobs()]);
      if (st.result) {
        const r = st.result;
        if (r.status === 'ok') toast(`抓到 ${r.cards_seen ?? 0} 个，新增 ${r.new_jobs ?? 0} 个`);
        else if (r.status === 'need_login') toast('需要扫码登录，请看浏览器窗口');
        else if (r.status === 'captcha') toast('遇到验证码，已停下等你手动处理');
        else toast(`本轮结束：${r.message || r.status}`);
      }
    }
  } catch {}
}

// ---------------------------------------------------------------- 个人档案

/**
 * 档案 = 「我是谁」。它比搜索配置更靠前：不满足的岗位抓取时就挡掉，不进库。
 * 换身份会带出一套默认规则（社畜默认剔实习/校招，应届生默认全收），但都能手改。
 */
async function renderProfile() {
  const data = await api('/profile');
  const { profile, identities, degrees, summary } = data;
  const pane = $('#paneProfile');

  pane.innerHTML = `
    <p class="muted" style="margin:0 0 14px">
      档案回答的是「我是谁」—— 同样的关键词，工作几年的社畜和应届生该看到的岗位不一样。
      不满足的岗位<strong>抓取时就挡掉</strong>（不占 JD 抓取额度），库里已有的可以按这份档案重扫。
    </p>

    <form id="formProfile" class="form-grid">
      <div class="field">
        <label>我的身份</label>
        <select name="identity">
          ${identities.map((i) => `<option value="${esc(i.key)}" ${i.key === profile.identity ? 'selected' : ''}>${esc(i.label)}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>工作年限（年）</label>
        <input name="years" type="number" min="0" max="50" value="${profile.years}" />
      </div>
      <div class="field"><label>最高学历</label>
        <select name="degree">
          ${degrees.map((d) => `<option value="${esc(d)}" ${d === profile.degree ? 'selected' : ''}>${esc(d)}</option>`).join('')}
        </select>
      </div>
      <div class="field wide">
        <label>自动剔除（勾上就不进列表）</label>
        <div class="chk-row">
          <label><input type="checkbox" name="hr_intern" ${profile.hardRules.intern ? 'checked' : ''} /> 实习岗（含日薪、按周实习）</label>
          <label><input type="checkbox" name="hr_campus" ${profile.hardRules.campus ? 'checked' : ''} /> 校招 / 应届专属</label>
          <label><input type="checkbox" name="hr_belowExp" ${profile.hardRules.belowExp ? 'checked' : ''} /> 经验要求明显低于我</label>
          <label><input type="checkbox" name="hr_overDegree" ${profile.hardRules.overDegree ? 'checked' : ''} /> 学历要求高于我</label>
        </div>
      </div>
      <div class="field wide">
        <label>额外排除词（逗号分隔，命中标题或公司名就跳过）</label>
        <input name="excludeWords" value="${esc(profile.excludeWords || '')}" placeholder="外包,驻场,代练" />
      </div>
      <div class="field wide" style="flex-direction:row;gap:10px;align-items:center">
        <button class="btn primary" type="submit">保存档案</button>
        <button class="btn" type="button" id="btnRescan">按档案重扫现有岗位</button>
        <span class="muted" style="font-size:12px" id="profileSummary">${esc(summary)}</span>
      </div>
    </form>

    <div id="profilePreview" class="preview-box"></div>
  `;

  const form = $('#formProfile');
  const readForm = () => ({
    identity: form.identity.value,
    years: Number(form.years.value) || 0,
    degree: form.degree.value,
    excludeWords: form.excludeWords.value.trim(),
    hardRules: {
      intern: form.hr_intern.checked,
      campus: form.hr_campus.checked,
      belowExp: form.hr_belowExp.checked,
      overDegree: form.hr_overDegree.checked,
    },
  });

  // 换身份 ⇒ 带出这套身份的默认规则（还能手改）
  form.identity.addEventListener('change', async () => {
    const { preset } = await api(`/profile/preset?identity=${encodeURIComponent(form.identity.value)}`);
    if (!preset) return;
    if (preset.years != null) form.years.value = preset.years;
    form.hr_intern.checked = !!preset.hardRules.intern;
    form.hr_campus.checked = !!preset.hardRules.campus;
    form.hr_belowExp.checked = !!preset.hardRules.belowExp;
    form.hr_overDegree.checked = !!preset.hardRules.overDegree;
    toast('已带出这个身份的默认规则，可以再改');
    refreshPreview(readForm());
  });

  // 勾选/改年限后实时预演（不用先保存）
  form.querySelectorAll('input,select').forEach((el) =>
    el.addEventListener('change', () => refreshPreview(readForm())),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const saved = await api('/profile', { method: 'POST', body: JSON.stringify(readForm()) });
    $('#profileSummary').textContent = saved.summary;
    toast('档案已保存，下一轮抓取就按它过滤');
    refreshPreview(readForm());
  });

  $('#btnRescan').addEventListener('click', async () => {
    const b = $('#btnRescan');
    b.disabled = true;
    try {
      const r = await api('/profile/rescan', { method: 'POST' });
      toast(`已按档案标记 ${r.filtered} 条${r.restored ? `，放回 ${r.restored} 条` : ''}`);
      await refreshPreview(readForm());
      await loadJobs();
      loadOverview();
    } catch (err) {
      toast('重扫失败：' + err.message);
    } finally {
      b.disabled = false;
    }
  });

  await refreshPreview(readForm());
}

/** 预演：问服务端「按这份档案（还没保存也行），库里会挡掉多少、放回多少」 */
async function refreshPreview(candidate) {
  const box = $('#profilePreview');
  if (!box) return;
  try {
    const r = await api('/profile/preview', candidate
      ? { method: 'POST', body: JSON.stringify(candidate) }
      : undefined);
    const kinds = r.kinds || {};
    const parts = Object.entries(r.byKind || {})
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${esc(kinds[k] || k)} ${n}`);

    const samples = (r.samples || [])
      .slice(0, 8)
      .map(
        (s) => `<li><span class="mini">${esc(kinds[s.kind] || s.kind)}</span>
          ${esc((s.title || '').slice(0, 34))} <span class="muted">@ ${esc(s.company || '—')}</span>
          <span class="muted">${s.already ? '· 已挡' : '· 待挡'}</span></li>`,
      )
      .join('');

    const blocked = Object.values(r.byKind || {}).reduce((a, b) => a + b, 0);
    const pending = Number(r.pending) || 0;

    box.innerHTML = `
      <div class="preview-head">
        库里共 <strong>${r.total}</strong> 条，按这份档案会挡掉 <strong>${blocked}</strong> 条
        ${parts.length ? `（${parts.join(' · ')}）` : ''}
        ${blocked ? (pending > 0 ? `，其中 <strong>${pending}</strong> 条还没落地 —— 点「按档案重扫现有岗位」生效` : '，已全部生效') : ''}
      </div>
      ${r.restore?.length ? `<p class="muted" style="margin:6px 0">档案放宽了：有 <strong>${r.restore.length}</strong> 条之前被挡的会放回来（点「重扫」生效）。</p>` : ''}
      ${samples ? `<ul class="preview-list">${samples}</ul>` : '<p class="muted" style="margin:8px 0 0">按当前档案，没有需要挡掉的岗位。</p>'}
    `;
  } catch (err) {
    box.innerHTML = `<p class="muted">预演失败：${esc(err.message)}</p>`;
  }
}

// ---------------------------------------------------------------- 弹窗

function openModal(tab) {
  $('#modal').hidden = false;
  switchTab(tab || 'searches');
}

function switchTab(tab) {
  $$('#tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $('#paneSearches').hidden = tab !== 'searches';
  $('#paneProfile').hidden = tab !== 'profile';
  $('#paneLog').hidden = tab !== 'log';
  $('#paneAbout').hidden = tab !== 'about';
  if (tab === 'searches') renderSearches();
  if (tab === 'profile') renderProfile();
  if (tab === 'log') pollOnce();
  if (tab === 'about') renderAbout();
}

function renderAbout() {
  $('#paneAbout').innerHTML = `
    <div class="about">
      <h3>它是怎么工作的</h3>
      <p>用你自己的 Edge 打开 BOSS 直聘（带着你已登录的账号），按你配置的关键词翻几页列表，
      把岗位记进本机数据库。然后跟库里已有的对比：<strong>没见过的 job_id 才算新岗位</strong>。</p>

      <h3>为什么不会看到重复</h3>
      <ul>
        <li><strong>硬去重</strong>：job_id 见过就不再提醒。</li>
        <li><strong>软去重</strong>（默认关）：同公司 + 同标题在 N 天内重发，标成「疑似重发」。想减少噪音可以在设置里打开。</li>
        <li>同一家公司换岗发新帖，会正常提醒——那本来就是新机会。</li>
      </ul>

      <h3>数据在哪</h3>
      <p>数据库在 <code id="aboutHome">…</code>。全部在本机，不联网、不上传。别人装了这个工具，用的是他自己的库。</p>

      <h3>风控提醒</h3>
      <p>BOSS 有反自动化检测。这个工具刻意做得「慢」：每次只翻几页、随机停顿、每天最多跑一两次。
      碰到验证码会立刻停下等你手动处理，不会硬试。别把频率调高，代价是账号被风控。</p>

      <h3>登录过期了怎么办</h3>
      <p>跑的时候如果发现需要登录，浏览器窗口会自动打开到登录页，你扫一下码就行。登录态会保存，下次不用再扫。</p>
    </div>`;
  $('#aboutHome').textContent = $('#homePath').textContent.replace('数据目录：', '');
}

// ---------------------------------------------------------------- 事件绑定

function bind() {
  $$('#segSince .seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      $$('#segSince .seg-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      state.since = b.dataset.since;
      loadJobs();
    }),
  );

  $$('#segStatus .seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      $$('#segStatus .seg-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      state.status = b.dataset.status;
      loadJobs();
    }),
  );

  let qt;
  $('#searchBox').addEventListener('input', (e) => {
    clearTimeout(qt);
    qt = setTimeout(() => {
      state.q = e.target.value.trim();
      loadJobs();
    }, 260);
  });

  $('#list').addEventListener('click', (e) => {
    if (e.target.id === 'btnMore') {
      e.stopPropagation();
      loadJobs({ append: true });
      return;
    }
    const card = e.target.closest('article.job');
    if (card) openJob(card.dataset.id);
  });

  $('#dClose').addEventListener('click', () => ($('#drawer').hidden = true));

  $$('.drawer-actions [data-act]').forEach((b) =>
    b.addEventListener('click', () => setStatus(b.dataset.act)),
  );

  $('#btnRun').addEventListener('click', () => triggerRun(null));
  $('#btnConfig').addEventListener('click', () => openModal('searches'));
  $('#btnProfile').addEventListener('click', () => openModal('profile'));
  $('#btnLog').addEventListener('click', () => openModal('log'));
  $('#mClose').addEventListener('click', () => ($('#modal').hidden = true));
  $('#modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal') $('#modal').hidden = true;
  });

  $$('#tabs .tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  // ---- 排序 ----
  $$('#segSort .seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      $$('#segSort .seg-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      state.sort = b.dataset.sort;
      loadJobs();
    }),
  );

  // ---- 标签 ----
  $('#tagFilter').addEventListener('change', (e) => {
    state.tagId = e.target.value;
    loadJobs();
  });
  $('#tagAdd').addEventListener('click', addTag);
  $('#tagInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTag();
    }
  });
  $('#dTags').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tag-del]');
    if (b) {
      e.stopPropagation();
      removeTag(b.dataset.tagDel, b.dataset.scope);
    }
  });

  // ---- 投递时间线 ----
  $('#dStages').addEventListener('click', (e) => {
    const b = e.target.closest('[data-stage]');
    if (b) addStage(b.dataset.stage);
  });
  $('#dTimeline').addEventListener('click', (e) => {
    const b = e.target.closest('[data-app-del]');
    if (b) {
      e.stopPropagation();
      deleteStage(b.dataset.appDel);
    }
  });

  $('#btnRefresh').addEventListener('click', async () => {
    await Promise.all([loadOverview(), loadJobs()]);
    toast('已刷新');
  });

  // 导出时带上当前筛选条件，导出的就是眼前看到的这些
  $('#btnExport').addEventListener('click', (e) => {
    const params = new URLSearchParams();
    if (state.since) params.set('since', state.since);
    if (state.status) params.set('status', state.status);
    if (state.q) params.set('q', state.q);
    const qs = params.toString();
    e.currentTarget.href = `/api/export.csv${qs ? '?' + qs : ''}`;
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('#drawer').hidden = true;
      $('#modal').hidden = true;
    }
  });
}

// ---------------------------------------------------------------- 启动

async function boot() {
  bind();
  await loadOverview();
  await loadTags();
  await loadJobs();
  // 如果后台正在跑，自动接上进度
  try {
    const st = await api('/run-status');
    if (st.active) {
      state.running = true;
      updateRunBtn();
      startPolling();
    }
  } catch {}
  setInterval(loadOverview, 30000);
}

boot();
