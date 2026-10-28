AerialS2T 项目页源码
对应线上页面：https://motcream.github.io/AerialS2T/

index.html          页面
cover_*_v7.mp4      首页四段循环视频
figures/            配图、Logo、Dataset Viewer 图片和 data.json
figures/teaser.pdf  任务总览原图（网页预览为 teaser.png）
figures/model.pdf   方法原图（网页预览为 model.png）
figures/dataset.pdf 数据集原图（网页预览为 dataset.png）
figures/logo.png    项目 Logo
.nojekyll           静态托管用，本地预览可忽略

本地预览：
  python3 -m http.server 8765
浏览器打开 http://127.0.0.1:8765

figures/anu-logo.svg 澳洲国立大学官网 Logo：https://d1blp3aor2iuhp.cloudfront.net/images/logos/logo-ANU-black.svg

figures/whu-badge.png 武汉大学官网标准双色校徽，来自：https://www.whu.edu.cn/xxgk/wdbs.htm
官方素材包：https://www.whu.edu.cn/new2024/wdbsxz/xiaohui.zip

figures/trajectory.js  三维轨迹与录制视频同步回放组件
figures/scenes.json    六个演示场景的轨迹、姿态和阶段数据
fly_01_town01.mp4 至 fly_06_town10.mp4  六个场景的录制视频
首页背景与 Trajectory 演示按场景完整时长同步轮换；手动操作轨迹会停止自动换场景。
