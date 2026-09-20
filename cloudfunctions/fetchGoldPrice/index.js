const cloud = require('wx-server-sdk');
const axios = require('axios');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const SINA_URL = 'https://hq.sinajs.cn/list=gds_AUTD';
const LBMA_URL = 'https://api.gold-api.com/price/XAU';
const FX_URL = 'https://api.exchangerate-api.com/v4/latest/USD';
const OZ_TO_G = 31.1034768;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(fn, retries = 3, delay = 30000) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (i < retries - 1) await sleep(delay);
    }
  }
  throw lastErr;
}

// 新浪接口返回 GBK 编码，需要手动解码
async function getSge() {
  const res = await axios.get(SINA_URL, {
    headers: { Referer: 'https://finance.sina.com.cn' },
    responseType: 'arraybuffer',
    timeout: 10000
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
  // gds_AUTD 常见字段序：名称,时间,开盘,最高,最低,昨收,买价,卖价,最新价,...
  const candidates = [8, 7, 6, 5, 4, 3, 2];
  for (const idx of candidates) {
    const p = parseFloat(parts[idx]);
    if (!isNaN(p) && p > 50 && p < 5000) return p;
  }
  return null;
}

async function getLbma() {
  const { data } = await axios.get(LBMA_URL, { timeout: 10000 });
  const price = Number(data.price);
  if (!price || price <= 0) throw new Error('lbma invalid price');
  return { price, currency: data.currency || 'USD' };
}

async function getUsdCny() {
  const { data } = await axios.get(FX_URL, { timeout: 10000 });
  const rate = Number(data && data.rates && data.rates.CNY);
  if (!rate || rate <= 0) throw new Error('fx invalid rate');
  return rate;
}

function todayStr() {
  // 云函数默认 UTC，转北京时间取日期
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}

exports.main = async () => {
  const date = todayStr();
  const col = db.collection('gold_prices');

  const exists = await col.where({ date }).count();
  if (exists.total > 0) return { skipped: true, date };

  try {
    const result = await fetchWithRetry(async () => {
      const [sge, lbma, usdcny] = await Promise.all([
        getSge().catch(() => null),
        getLbma(),
        getUsdCny()
      ]);
      return { sge, lbma, usdcny };
    }, 3, 30000);

    const { sge, lbma, usdcny } = result;
    const lbma_cny = +(lbma.price * usdcny / OZ_TO_G).toFixed(4);

    await col.add({
      data: {
        date,
        sge_price: sge,
        lbma_usd: lbma.price,
        lbma_cny,
        usdcny,
        created_at: db.serverDate()
      }
    });

    return { ok: true, date, sge_price: sge, lbma_usd: lbma.price, lbma_cny };
  } catch (e) {
    try {
      await db.collection('fetch_logs').add({
        data: {
          date,
          source: 'fetchGoldPrice',
          error: String((e && e.message) || e),
          created_at: db.serverDate()
        }
      });
    } catch (_) {}
    return { ok: false, date, error: String((e && e.message) || e) };
  }
};
