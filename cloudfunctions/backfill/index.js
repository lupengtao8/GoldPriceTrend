const cloud = require('wx-server-sdk');
const axios = require('axios');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const LBMA_HIST = 'https://prices.lbma.org.uk/json/gold_pm.json';
const SGE_HIST = 'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_=/GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=AUTD';
const FX_URL = 'https://api.exchangerate-api.com/v4/latest/USD';
const OZ_TO_G = 31.1034768;

// MM/DD/YYYY -> YYYY-MM-DD
function fmtLBMA(s) {
  const [m, d, y] = s.split('/');
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

async function loadLbma() {
  const { data } = await axios.get(LBMA_HIST, { timeout: 20000 });
  // data: [{ d:"MM/DD/YYYY", v:[usd, gbp, eur], Currency:"USD" }, ...]
  const map = new Map();
  for (const row of data) {
    if (!row || !row.d || !Array.isArray(row.v)) continue;
    const usd = Number(row.v[0]);
    if (!usd || usd <= 0) continue;
    map.set(fmtLBMA(row.d), usd);
  }
  return map;
}

async function loadSge() {
  const { data } = await axios.get(SGE_HIST, {
    headers: { Referer: 'https://finance.sina.com.cn' },
    responseType: 'text',
    timeout: 20000
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
  const { data } = await axios.get(FX_URL, { timeout: 10000 });
  return Number(data.rates.CNY);
}

exports.main = async (event) => {
  const days = Math.min(Math.max(Number(event && event.days) || 30, 1), 3650);

  const [lbma, sge, usdcny] = await Promise.all([
    loadLbma(),
    loadSge().catch(() => new Map()),
    getUsdCny()
  ]);

  // 取所有日期并集，倒序取前 N 天
  const allDates = Array.from(new Set([...lbma.keys(), ...sge.keys()]))
    .sort((a, b) => (a < b ? 1 : -1))
    .slice(0, days);

  // 查询已存在日期，避免重复写入
  const existed = new Set();
  const chunk = 100;
  for (let i = 0; i < allDates.length; i += chunk) {
    const slice = allDates.slice(i, i + chunk);
    const r = await db.collection('gold_prices')
      .where({ date: _.in(slice) })
      .field({ date: true })
      .limit(chunk)
      .get();
    r.data.forEach(x => existed.add(x.date));
  }

  let inserted = 0;
  for (const d of allDates) {
    if (existed.has(d)) continue;
    const lbma_usd = lbma.get(d);
    const sge_price = sge.get(d);
    if (!lbma_usd && !sge_price) continue;
    const lbma_cny = lbma_usd ? +(lbma_usd * usdcny / OZ_TO_G).toFixed(4) : null;
    try {
      await db.collection('gold_prices').add({
        data: {
          date: d,
          sge_price: sge_price || null,
          lbma_usd: lbma_usd || null,
          lbma_cny,
          usdcny,
          created_at: db.serverDate()
        }
      });
      inserted++;
    } catch (e) {
      // 单条失败继续
    }
  }

  return { ok: true, requested: days, inserted, total_candidates: allDates.length };
};
