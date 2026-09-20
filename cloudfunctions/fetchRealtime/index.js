const cloud = require('wx-server-sdk');
const axios = require('axios');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const SINA_URL = 'https://hq.sinajs.cn/list=gds_AUTD';
const LBMA_URL = 'https://api.gold-api.com/price/XAU';
const FX_URL = 'https://api.exchangerate-api.com/v4/latest/USD';
const OZ_TO_G = 31.1034768;
const CACHE_TTL = 10 * 1000;

// 云函数实例复用 global 做内存级缓存
const g = global;

async function getSge() {
  const res = await axios.get(SINA_URL, {
    headers: { Referer: 'https://finance.sina.com.cn' },
    responseType: 'arraybuffer',
    timeout: 8000
  });
  let text;
  try {
    text = new TextDecoder('gbk').decode(Buffer.from(res.data));
  } catch (e) {
    text = Buffer.from(res.data).toString('utf8');
  }
  const m = /"([^"]+)"/.exec(text);
  if (!m || !m[1]) return null;
  const parts = m[1].split(',');
  const candidates = [8, 7, 6, 5, 4, 3, 2];
  for (const idx of candidates) {
    const p = parseFloat(parts[idx]);
    if (!isNaN(p) && p > 50 && p < 5000) return p;
  }
  return null;
}

async function getLbma() {
  const { data } = await axios.get(LBMA_URL, { timeout: 8000 });
  return Number(data.price);
}

async function getUsdCny() {
  const { data } = await axios.get(FX_URL, { timeout: 8000 });
  return Number(data.rates.CNY);
}

exports.main = async () => {
  const now = Date.now();
  if (g.__rt_cache && now - g.__rt_cache.ts < CACHE_TTL) {
    return Object.assign({}, g.__rt_cache.data, { cached: true });
  }

  const [sge, lbma_usd, usdcny] = await Promise.all([
    getSge().catch(() => null),
    getLbma().catch(() => null),
    getUsdCny().catch(() => null)
  ]);

  if (!lbma_usd || !usdcny) {
    throw new Error('upstream_unavailable');
  }

  // 取昨日收盘（用于涨跌幅）
  let prevSge = null;
  let prevLbma = null;
  try {
    const r = await db.collection('gold_prices')
      .orderBy('date', 'desc')
      .limit(1)
      .get();
    if (r.data && r.data[0]) {
      prevSge = r.data[0].sge_price;
      prevLbma = r.data[0].lbma_usd;
    }
  } catch (_) {}

  const sge_change_pct = (sge && prevSge)
    ? +(((sge - prevSge) / prevSge) * 100).toFixed(2)
    : null;
  const lbma_change_pct = (lbma_usd && prevLbma)
    ? +(((lbma_usd - prevLbma) / prevLbma) * 100).toFixed(2)
    : null;

  const data = {
    sge_price: sge,
    sge_change_pct,
    lbma_usd,
    lbma_change_pct,
    lbma_cny: +(lbma_usd * usdcny / OZ_TO_G).toFixed(4),
    usdcny,
    timestamp: new Date().toISOString()
  };

  g.__rt_cache = { ts: now, data };
  return data;
};
