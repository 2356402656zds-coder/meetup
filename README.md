# Poker Clock Pro · Android TV

独立离线运行的德州扑克升盲计时器。电视用遥控器控制，盲注等级和比赛名称保存在电视本机。不需要 Mac 本地服务器、电脑后台、手机控制、互联网或客户资料。

## 构建 APK

GitHub Actions 配置在 `.github/workflows/apk.yml`。提交后会自动构建，也可从 GitHub 仓库 **Actions（操作）→ 构建电视 APK → Run workflow（运行工作流）** 手动启动。构建成功后下载 **PokerClockPro-APK** artifact 并解压，得到 `app-debug.apk`。

如果沿用现有 GitHub 仓库，请把更新后的项目文件按原目录结构上传并提交。确保这些路径已更新：

- `.github/workflows/apk.yml`
- `android-tv/app/src/main/assets/tv.html`
- `android-tv/app/src/main/AndroidManifest.xml`
- `android-tv/app/src/main/java/club/poker/tv/MainActivity.java`

## 安装和使用

将 APK 拷到 U 盘，在电视文件管理器打开 APK 安装。如被拦截，在 **Settings（设置）→ Security / Install unknown apps（安全 / 安装未知应用）** 中允许文件管理器安装。

打开应用即可使用。方向键移动焦点，OK 确认。支持开始/暂停/继续、前后等级、重置本级、编辑盲注 SB/BB/Ante 和时长、添加/删除等级、比赛命名、恢复默认规则。规则保存在电视本机。

默认盲注结构为 100/200、200/400、300/600/Ante 100、500/1000/Ante 100，各 20 分钟，随后休息 10 分钟。到时自动升至下一级；最后一级结束后停止。

## 验收限制

开发环境没有 Android SDK、Gradle 和 Java Runtime，尚未本机生成 APK 或在目标电视验收。请在电视上检查 D-pad 焦点、OK 键、横屏、常亮和重启恢复。`server/` 目录是先前扩展赛事后台留下的独立实验代码，与电视单机版无关，可以忽略。
