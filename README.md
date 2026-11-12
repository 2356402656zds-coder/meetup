# Poker Clock Pro

Poker Clock Pro 是一套门店局域网德州扑克赛事管理系统：Mac 运行本地服务端和电脑后台；每台 Android TV 连接到 Mac 的赛事状态；每张牌桌独立保存比赛和统计数据。

## 当前可运行部分

- Node 26 + SQLite 3.51 的本地服务端，不依赖公网服务器。
- 四张示例牌桌 A01–A04，独立比赛状态和独立权威倒计时。
- SQLite 数据文件：`server/data/poker-clock-pro.sqlite`。
- 电脑后台：`http://Mac局域网IP:8787/`。
- 创建比赛、选择盲注模板、开始/暂停/恢复、前后等级、结束比赛。
- 报名人数、剩余人数、买入、Re-entry、Rebuy、Add-on 的独立统计字段。
- 自动升盲、Break、比赛结束、操作日志和重启后的状态恢复。
- `GET /api/tv/state?tableId=A01` 给电视端读取单桌状态；`POST /api/tournaments/:id/action` 执行真实操作；`/api/events` 提供局域网 SSE，`/ws?tableId=A01` 提供无第三方依赖的 WebSocket 实时广播。
- Android TV 工程位于 `android-tv/`，当前环境没有 Android SDK/Gradle/Java Runtime，不能在本机生成 APK；其中 `.github/workflows/apk.yml` 可在 GitHub Actions 上构建 Debug APK。

## 启动 Mac 服务端

要求 Node.js 22 或更高版本。执行：

```sh
cd PokerClockPro
./scripts/start.sh
```

然后在电脑打开 `http://127.0.0.1:8787/`。电视和电脑连接同一路由器，电视使用 Mac 的局域网 IP，例如 `http://192.168.1.23:8787`。

## 恢复策略

服务端用 `ends_at` 和 `remaining_ms` 作为权威时间来源。暂停会保存剩余毫秒数；服务端重启后，运行中的比赛按保存的结束时间继续并自动补齐到期等级，不会因为电视断线而重置整级。电视重新连接只获取服务器快照，不在本地自行推进比赛。

## Android TV 构建限制

本机器检查到 Node 和 SQLite 可用，但没有 Android SDK、Gradle 和 Java Runtime，因此没有生成可安装 APK，也没有进行真机兼容性验收。GitHub Actions 工作流会安装 JDK 17、Android SDK 和 Gradle 8.9，然后产出 `app-debug.apk`。APK 安装包必须在真实 Android TV 上验收遥控器焦点、横屏、常亮和开机恢复。

## 数据边界

系统只记录单场赛事统计，不创建玩家个人档案、会员 CRM、支付和手机遥控功能。生产部署建议固定 Mac 局域网 IP，不做端口映射，不把 HTTP 服务暴露到公网；正式营业前应增加后台登录、设备绑定码轮换和 HTTPS。
