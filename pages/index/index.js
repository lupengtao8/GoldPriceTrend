import * as echarts from '../../components/ec-canvas/echarts';

const RANGES = [
  { key: '1m', label: '1月', days: 30 },
  { key: '3m', label: '3月', days: 90 },
  { key: '6m', label: '6月', days: 180 },
  { key: '1y', label: '1年', days: 365 },
  { key: 'all', label: '全部', days: 0 }
];

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtChange(pct) {
  if (pct === null || pct === undefined || isNaN(pct)) return '';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${Number(pct).toFixed(2)}%`;
}

function changeClass(pct) {
  if (pct === null || pct === undefined || isNaN(pct)) return 'flat';
  if (pct > 0) return 'up';
  if (pct < 0) return 'down';
  return 'flat';
}

Page({
  data: {
    ranges: RANGES,
    activeRange: '3m',
    refreshing: false,
    updatedAt: '',
    sgePriceText: '--',
    lbmaUsdText: '--',
    lbmaCnyText: '--',
    sgeChangeText: '',
    lbmaChangeText: '',
    sgeChangeClass: 'flat',
    lbmaChangeClass: 'flat',
    chartEmpty: true,
    ec: { lazyLoad: true }
  },

  chart: null,

  onLoad() {
    this.ecComponent = this.selectComponent('#chart');
    this.bootstrap();
  },

  onPullDownRefresh() {
    this.onRefresh().finally(() => wx.stopPullDownRefresh());
  },

  async bootstrap() {
    try {
      const cnt = await wx.cloud.callFunction({ name: 'backfill', data: { days: 30 } });
      // backfill 会自动跳过已存在日期，可安全调用
    } catch (e) {
      console.warn('backfill skipped', e);
    }
    await this.loadRealtime();
    await this.loadChart();
  },

  async loadRealtime() {
    this.setData({ refreshing: true });
    try {
      const res = await wx.cloud.callFunction({ name: 'fetchRealtime' });
      const d = res.result || {};
      this.setData({
        sgePriceText: d.sge_price ? Number(d.sge_price).toFixed(2) : '--',
        lbmaUsdText: d.lbma_usd ? Number(d.lbma_usd).toFixed(2) : '--',
        lbmaCnyText: d.lbma_cny ? Number(d.lbma_cny).toFixed(2) : '--',
        sgeChangeText: fmtChange(d.sge_change_pct),
        lbmaChangeText: fmtChange(d.lbma_change_pct),
        sgeChangeClass: changeClass(d.sge_change_pct),
        lbmaChangeClass: changeClass(d.lbma_change_pct),
        updatedAt: fmtTime(d.timestamp)
      });
      wx.showToast({ title: `更新于 ${fmtTime(d.timestamp)}`, icon: 'none', duration: 1500 });
    } catch (e) {
      console.error(e);
      wx.showToast({ title: '刷新失败，请稍后重试', icon: 'none' });
    } finally {
      this.setData({ refreshing: false });
    }
  },

  onRefresh() {
    if (this.data.refreshing) return Promise.resolve();
    return this.loadRealtime();
  },

  onRangeChange(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.activeRange) return;
    this.setData({ activeRange: key });
    this.loadChart();
  },

  async loadChart() {
    const range = RANGES.find(r => r.key === this.data.activeRange) || RANGES[1];
    const db = wx.cloud.database();
    const _ = db.command;

    let query = db.collection('gold_prices').orderBy('date', 'asc');
    if (range.days > 0) {
      const since = new Date(Date.now() - range.days * 86400000);
      const sinceStr = since.toISOString().slice(0, 10);
      query = db.collection('gold_prices')
        .where({ date: _.gte(sinceStr) })
        .orderBy('date', 'asc');
    }

    // 云数据库单次 limit 上限 20（前端）/1000（云函数），前端循环分页
    const all = [];
    const pageSize = 20;
    let skip = 0;
    while (true) {
      const r = await query.skip(skip).limit(pageSize).get();
      all.push(...r.data);
      if (r.data.length < pageSize) break;
      skip += pageSize;
      if (skip > 2000) break;
    }

    if (!all.length) {
      this.setData({ chartEmpty: true });
      return;
    }
    this.setData({ chartEmpty: false });

    const dates = all.map(x => x.date);
    const cny = all.map(x => (x.lbma_cny != null ? x.lbma_cny : null));
    const usd = all.map(x => (x.lbma_usd != null ? x.lbma_usd : null));

    if (!this.chart) {
      this.ecComponent.init(chart => {
        this.chart = chart;
        chart.setOption(this.buildOption(dates, cny, usd));
      });
    } else {
      this.chart.setOption(this.buildOption(dates, cny, usd), true);
    }
  },

  buildOption(dates, cny, usd) {
    return {
      animation: false,
      tooltip: { trigger: 'axis' },
      legend: { data: ['CNY/克', 'USD/盎司'], top: 4, textStyle: { fontSize: 11 } },
      grid: { left: 48, right: 56, top: 40, bottom: 40 },
      xAxis: {
        type: 'category',
        data: dates,
        boundaryGap: false,
        axisLabel: { fontSize: 10, formatter: v => v.slice(5) }
      },
      yAxis: [
        {
          type: 'value',
          name: 'CNY/g',
          nameTextStyle: { fontSize: 10 },
          scale: true,
          axisLabel: { fontSize: 10 },
          splitLine: { lineStyle: { color: '#eee' } }
        },
        {
          type: 'value',
          name: 'USD/oz',
          nameTextStyle: { fontSize: 10 },
          scale: true,
          axisLabel: { fontSize: 10 },
          splitLine: { show: false }
        }
      ],
      series: [
        {
          name: 'CNY/克',
          type: 'line',
          smooth: true,
          showSymbol: false,
          yAxisIndex: 0,
          data: cny,
          lineStyle: { color: '#c9a35c', width: 2 },
          itemStyle: { color: '#c9a35c' }
        },
        {
          name: 'USD/盎司',
          type: 'line',
          smooth: true,
          showSymbol: false,
          yAxisIndex: 1,
          data: usd,
          lineStyle: { color: '#5b8ff9', width: 2 },
          itemStyle: { color: '#5b8ff9' }
        }
      ]
    };
  },

  onShareAppMessage() {
    return { title: '金价走势 - Au99.99 与 伦敦金实时报价', path: '/pages/index/index' };
  }
});
