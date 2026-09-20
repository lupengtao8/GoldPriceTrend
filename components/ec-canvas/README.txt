此目录需要放置 echarts.js（ECharts 官方为微信小程序打包的版本）。

下载方式（任选其一）：

1. 官方仓库：https://github.com/ecomfe/echarts-for-weixin
   下载后把仓库根目录下的 ec-canvas/echarts.js 复制到本目录，
   并将本目录下已存在的 ec-canvas.js/.json/.wxml/.wxss 替换为官方版
   （本项目已提供最小可用版本，如需交互事件支持建议使用官方版本）。

2. CDN 单文件：
   https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js
   下载后重命名为 echarts.js 放到本目录。

放置完成后目录结构应为：
components/ec-canvas/
  ├── echarts.js       （需自行下载）
  ├── ec-canvas.js
  ├── ec-canvas.json
  ├── ec-canvas.wxml
  └── ec-canvas.wxss
