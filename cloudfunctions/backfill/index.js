const cloud = require('wx-server-sdk');
const axios = require('axios');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const LBMA_HIST = 'https://prices.lbma.org.uk/json/gold_pm.json';
const SGE_HIST = 'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_=/GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=AUTD';
const FX_URL = 'https://api.exchangerate-api.com/v4/latest/USD';
const OZ_TO_G = 31.1034768;

const HTTP_TIMEOUT = 8000;      // 单个下载超时，挂起时快速失败
const WAVE = 10;                // 每波并行插入条数
const MAX_INSERT_PER_RUN = 120; // 单次运行插入上限，超出部分下次调用续跑（可断点续跑）

// 支持 YYYY-MM-DD（LBMA 新格式）与 MM/DD/YYYY（旧格式），无法识别返回 null
function fmtLBMA(s) {
  if (typeof s !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const parts = s.split('/');
  if (parts.length !== 3) return null;
  const [m, d, y] = parts;
  if (!m || !d || !y) return null;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// 北京时区日期字符串，offsetDays: 0=今天, -1=昨天
function bjDate(offsetDays) {
  return new Date(Date.now() + 8 * 3600e3 + (offsetDays || 0) * 86400e3).toISOString().slice(0, 10);
}

// 计算"库已新鲜"的日期阈值：黄金仅在工作日交易，需容忍周末/节假日无数据
// 周日→上周五(-2)  周六→上周五(-1)  周一→上周五(-3, 周一数据尚未发布)
// 周二~周五→昨天(-1)
function freshnessThreshold() {
  const dow = new Date(Date.now() + 8 * 3600e3).getUTCDay(); // 0=Sun..6=Sat
  let back;
  if (dow === 0) back = 2;
  else if (dow === 6) back = 1;
  else if (dow === 1) back = 3;
  else back = 1;
  return bjDate(-back);
}

async function loadLbma() {
  const { data } = await axios.get(LBMA_HIST, { timeout: HTTP_TIMEOUT });
  // data: [{ d:"YYYY-MM-DD"（新）或 "MM/DD/YYYY"（旧）, v:[usd, gbp, eur] }, ...]
  const map = new Map();
  for (const row of data) {
    if (!row || !row.d || !Array.isArray(row.v)) continue;
    const usd = Number(row.v[0]);
    if (!usd || usd <= 0) continue;
    const key = fmtLBMA(row.d);
    if (!key) continue;
    map.set(key, usd);
  }
  return map;
}

async function loadSge() {
  const { data } = await axios.get(SGE_HIST, {
    headers: { Referer: 'https://finance.sina.com.cn' },
    responseType: 'text',
    timeout: HTTP_TIMEOUT
  });
  // 形如 var _=[{...},{...}];
  const m = /=\s*(\[[\s\S]*\])/.exec(data);
  if (!m) return new Map();
  let arr;
  try { arr = JSON.parse(m[1]); } catch (e) { return new Map(); }
  const map = new Map();
  for (const row of arr) {
    if (!row || !row.date) continue;
    const c = Number(row.close);
    if (!c || c <= 0) continue;
    map.set(String(row.date).slice(0, 10), c);
  }
  return map;
}

async function getUsdCny() {
  const { data } = await axios.get(FX_URL, { timeout: HTTP_TIMEOUT });
  return Number(data.rates.CNY);
}

exports.main = async (event) => {
  const t0 = Date.now();
  const days = Math.min(Math.max(Number(event && event.days) || 30, 1), 3650);

  // 1) 新鲜度预检：最新记录 >= 阈值日（周末/周一自动放宽到最近工作日）且行数已满足请求天数
  //    → 视为库已新鲜，直接跳过 914KB 的 LBMA 全量下载与全部写入，冷启动也能秒回；
  //    行数不足（如深历史分次续跑）时仍会进入补数流程
  const [latest, cnt] = await Promise.all([
    db.collection('gold_prices').orderBy('date', 'desc').limit(1).field({ date: true }).get(),
    db.collection('gold_prices').count()
  ]);
  const latestDate = latest.data && latest.data[0] && latest.data[0].date;
  const threshold = freshnessThreshold();
  if (latestDate && latestDate >= threshold && cnt.total >= days) {
    return { ok: true, skipped: 'db-fresh', latest: latestDate, threshold, count: cnt.total, ms: Date.now() - t0 };
  }

  // 2) 三个数据源并行下载
  const [lbma, sge, usdcny] = await Promise.all([
    loadLbma(),
    loadSge().catch(() => new Map()),
    getUsdCny()
  ]);

  // 3) 取所有日期并集，倒序取前 N 天
  const allDates = Array.from(new Set([...lbma.keys(), ...sge.keys()]))
    .sort((a, b) => (a < b ? 1 : -1))
    .slice(0, days);

  // 4) 查询已存在日期，避免重复写入
  const existed = new Set();
  for (let i = 0; i < allDates.length; i += 100) {
    const slice = allDates.slice(i, i + 100);
    const r = await db.collection('gold_prices')
      .where({ date: _.in(slice) })
      .field({ date: true })
      .limit(100)
      .get();
    r.data.forEach(x => existed.add(x.date));
  }

  // 5) 分波并行插入（替代逐条串行 await），单波 WAVE 条并发，
  //    单次最多 MAX_INSERT_PER_RUN 条，剩余留给下次调用续跑
  const pending = allDates.filter(d => !existed.has(d) && (lbma.get(d) || sge.get(d)));
  const batch = pending.slice(0, MAX_INSERT_PER_RUN);
  let inserted = 0;
  let failed = 0;
  for (let i = 0; i < batch.length; i += WAVE) {
    await Promise.all(batch.slice(i, i + WAVE).map(d => {
      const lbma_usd = lbma.get(d);
      const sge_price = sge.get(d);
      return db.collection('gold_prices').add({
        data: {
          date: d,
          sge_price: sge_price || null,
          lbma_usd: lbma_usd || null,
          lbma_cny: lbma_usd ? +(lbma_usd * usdcny / OZ_TO_G).toFixed(4) : null,
          usdcny,
          created_at: db.serverDate()
        }
      }).then(() => { inserted++; }, () => { failed++; });
    }));
  }

  return {
    ok: true,
    requested: days,
    inserted,
    failed,
    remaining: pending.length - inserted - failed,
    total_candidates: allDates.length,
    ms: Date.now() - t0
  };
};
