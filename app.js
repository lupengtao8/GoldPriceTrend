App({
  onLaunch() {
    if (!wx.cloud) {
      console.error('基础库版本过低，请使用 2.2.3 或以上');
      return;
    }
    wx.cloud.init({
      env: 'cloud1-d8g7deeklb23dcab6',
      traceUser: true
    });
  },
  globalData: {}
});
