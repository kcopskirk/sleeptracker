# 睡眠追踪（iPhone Web App）

本地单页应用：按睡前 / 起床后时段记录，自然周生成周报。数据存在浏览器 `localStorage`。

## 在 iPhone 上用

1. 同一局域网内，在电脑项目目录启动静态服务，例如：

```bash
cd "/Users/heweiqi/Library/Mobile Documents/com~apple~CloudDocs/Ikiprojects/sleepmonitor_01"
python3 -m http.server 8080
```

2. iPhone Safari 打开：`http://<电脑局域网IP>:8080`
3. 分享 → **添加到主屏幕**，即可全屏当 Web App 用

也可把整个文件夹部署到任意静态托管（GitHub Pages、Cloudflare Pages 等），用 HTTPS 访问更稳。

## 已实现规则摘要

- 睡前窗感：`[21:30, 03:00)` → Aset；起床后：`[03:00, 21:30)` → Bset
- Aset / Bset 均可写至该夜次日 `21:30`；自然周下周一 `21:30` 上锁
- 白天若缺睡前，可点「补填睡前」
- 周报：完整度、评分折线、在床时长 / 夜醒比例、相关因素（完整 ≥4）

## 几天数据怎么测（调试模式）

打开：

```text
http://127.0.0.1:8080/?debug=1
```

底部会出现调试面板：

1. **灌入上周演示数据**：一键写入 7 夜完整记录，并把时钟跳到周锁后，直接看周报  
2. **应用时间 / 今晚睡前 / 今早起床后 / +1 天**：伪造当前时间，手动走睡前→起床→跨天流程  
3. **恢复真机时间 / 清空全部数据**

也可直接带时间：`?debug=1&now=2026-08-05T22:00`

## 开发说明

纯静态：`index.html` + `styles.css` + `app.js`。无构建步骤。
