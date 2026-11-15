# live-rec-hinas

原 [live-rec](https://github.com/TokyoTF/live-rec)（Electron 桌面版）的 **HiNAS 盒子版**：跑在海纳思系统（Hi3798MV300 等 ARM 盒子）上，全部设置通过**网页**完成 —— 盒子上打开 `http://127.0.0.1:7788`，局域网内任何设备（手机/电脑）打开 `http://盒子IP:7788` 都能操作。

## 一键安装（一条命令）

```sh
curl -fsSL https://raw.githubusercontent.com/kain1999/live-rec-hinas/main/install.sh | sudo sh -s -- --dir /opt/live-rec-hinas
```

- GitHub 直连慢/不通时走镜像：

```sh
curl -fsSL https://ghproxy.net/https://raw.githubusercontent.com/kain1999/live-rec-hinas/main/install.sh | sudo sh -s -- --dir /opt/live-rec-hinas --mirror ghproxy
```

- 自动下载源码 → 安装 Node.js 20 + ffmpeg（自动识别 aarch64/armv7l/x64，国内镜像优先）→ 可加 `--service` 顺带注册 systemd 开机自启。

支持站点（与原版扩展一致，自动轮询 → 开播自动录制 → 私播暂停 → 下播停止并合并分段）：

| 站点 | 说明 |
| --- | --- |
| chaturbate | 走本地 CBProxy，token 过期自动换新地址，录制不断流 |
| stripchat | 走本地 StripchatProxy，处理 MOUFLON 反盗录（psch/pkey），绕过 6 秒广告流 |
| bongacams | API 直解（装 impit 可过 Cloudflare，见「常见问题」） |
| cam4 | API 直解 |
| camsoda | 走本地 CamsodaProxy（fmp4→mp4 改写） |
| dreamcam | API 直解 |

---

## 一、安装（盒子上 3 步）

1. **把整个 `live-rec-hinas` 文件夹传到盒子上**，比如 `/opt/live-rec-hinas`
   - 电脑装了 WinSCP/SMB 共享 → 直接拖过去；
   - 或 U 盘拷贝后挂载复制：`cp -r /mnt/udisk*/live-rec-hinas /opt/`
   - 或 scp：`scp -r live-rec-hinas root@盒子IP:/opt/`

2. **跑环境安装脚本**（自动装 Node.js 20 和 ffmpeg，优先国内镜像，装在自带 runtime 目录，不动系统）：

   ```sh
   cd /opt/live-rec-hinas
   chmod +x setup.sh
   sudo ./setup.sh
   ```

3. **启动**：

   ```sh
   ./start.sh
   ```

   看到 `listening on http://0.0.0.0:7788` 即成功。**保持这个 SSH 窗口开着**（或用下面的「开机自启」后台跑）。

> 盒子自身浏览器打开 `http://127.0.0.1:7788`，局域网手机/电脑打开 `http://盒子IP:7788`。

## 二、网页使用

界面共 4 个标签页：

### ① 监控（主页）
- 顶部输入框粘贴直播间地址（如 `https://chaturbate.com/xxxx/`、`https://stripchat.com/xxxx`、`https://www.bongacams.com/xxxx` 等，支持站点域名下任意房间链接），点 **添加监控**；
- 不确定地址对不对就先点 **测试解析**：会显示识别到的站点、房间名、在线状态、清晰度列表；
- 任务卡片显示实时状态：
  - `● 录制中`（绿色呼吸灯）→ 正在写文件，显示已录时长 / 大小 / 分辨率 / 码率 / 当前文件名；
  - `‖ 已暂停(私播)` → 主播进私播，自动暂停，回公开后**自动接着录**（新分段，停止时自动合并）；
  - `● 在线` → 开播了，正在起录；
  - `离线` → 低频轮询（默认 2 分钟一次）；
  - `⚠ 错误信息` → 显示最近一次失败原因；
- 卡片开关 = 启用/停用监控；**停止录制** = 停用并结束当前录制；**立即检测** = 马上跑一轮。

### ② 文件
- 列出每次录像：文件名（**点开直接播放/下载**）、站点/房间、大小、时长、结束原因、是否多分段合并；
- 想拷走：直接浏览器下载，或 SMB/U盘取 `/opt/live-rec-hinas/recordings`（或你自定义的目录）。

### ③ 设置（改完点「保存设置」，除端口外即时生效）

| 分组 | 配置 | 默认 | 说明 |
| --- | --- | --- | --- |
| Web | 监听端口 | 7788 | 改后需重启服务 |
| Web | 访问密码 | 空 | 建议设一个（局域网公开端口时） |
| 路径 | 录像保存目录 | `<安装目录>/recordings` | **建议改成 USB 硬盘挂载点**（如 `/mnt/sda1/recordings`），别写满系统分区 |
| 路径 | ffmpeg 路径 | 空(PATH) | setup.sh 自动写好 |
| 录制 | 录像格式 | mkv | 推荐 `mkv`（断电不损坏）；也支持 ts/mp4/flv |
| 录制 | 文件名格式 | `model-site-dd-MM-yyyy_hh-mm-ss` | `model`=房间名 `site`=站点名 |
| 录制 | 按日期/房间建子目录 | 开 | `recordings/2025-06-01/chaturbate - room/` |
| 录制 | 单文件大小上限 | 0(不切) | MB，超过自动分段 |
| 录制 | 单文件时长上限 | 0(不切) | 秒 |
| 录制 | 私播时暂停 | 开 | 关 = 私播直接停止录制 |
| 录制 | 停止后合并分段 | 开 | ffmpeg concat 无损拼接（mkv 可选 mkvmerge） |
| 录制 | 磁盘最低剩余空间 | 1024MB | 低于自动停全部录制，防写满 |
| 轮询 | 在线/录制中检测间隔 | 50 秒 | |
| 轮询 | 离线检测间隔 | 120 秒 | |
| 轮询 | 启动重试间隔 | 15 秒 | |
| 轮询 | 同时录制上限 | 0(不限) | 盒子性能有限建议 ≤3 |
| 高级 | User-Agent / 代理列表 / 代理尝试次数 | | 一般不用动 |

### ④ 日志
实时滚动服务日志（等效 `data/log.txt`），ffmpeg 起录命令、重连、合并都有记录，排查问题先看这里。

## 三、开机自启（推荐）

编辑 `live-rec.service`，把里面的 `/opt/live-rec-hinas` 改成你的实际目录，然后：

```sh
sudo cp live-rec.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now live-rec
```

常用命令：`systemctl status live-rec` / `journalctl -u live-rec -f` / `systemctl restart live-rec`

（不用 systemd 也可以：`nohup ./start.sh >/dev/null 2>&1 &`，或加进 hinas 的自定义启动项。）

## 四、常见问题

- **bongacams 一直“获取直播地址失败”**：它有 Cloudflare 防护。在盒子上 `cd /opt/live-rec-hinas && npm i impit`（有 linux-arm64 预编译包，约 30MB），重启服务即可启用浏览器 TLS 指纹伪装。日志里若显示 `impit not installed` 即未装。
- **camsoda 解析失败**：同样可能被 Cloudflare 拦。开启日志看 `res:status` 报错；多试几次或换网络环境。CDN 媒体节点本身一般不拦。
- **FAT32 分区单文件 4GB 上限**：保存目录请用 ext4/exFAT 格式的硬盘，或开启「单文件大小上限」分段。
- **忘记密码**：改 `config.json` 里 `"password": ""` 后重启服务。
- **端口被占用 / 想换端口**：改网页设置里的端口（保存后提示重启），或 `PORT=8080 ./start.sh`。
- **扩展失效（网站改版）**：`extensions/` 目录下每个站点一个文件，接口与原版 live-rec 完全兼容 —— 原版更新的扩展文件直接覆盖过来，然后 `systemctl restart live-rec` 重启一次服务即可。
- **录制卡顿/CPU 高**：录制是 `-c copy` 直存不转码，正常占用很低；若盒子上同时录 3 路以上卡顿，设置里限制「同时录制上限」。

## 五、目录结构

```
live-rec-hinas/
├── server.js            # HTTP 服务 + API（0.0.0.0 监听）
├── core/                # 调度器 / ffmpeg 录制管理 / 配置 / 日志 / 抓取层
├── lib/                 # 三个本地 HLS 代理（CBProxy/StripchatProxy/CamsodaProxy）
├── extensions/          # 6 个站点扩展（与原版 live-rec 扩展格式一致）
├── public/              # 网页 UI（原生 JS，无构建）
├── data/                # tasks.json / log.txt（运行后生成）
├── recordings/          # 默认录像目录（运行后生成）
├── runtime/             # setup.sh 装的 node/ffmpeg（运行后生成）
├── config.json          # 配置（setup.sh / 网页生成）
├── setup.sh             # 环境安装（Node + ffmpeg）
├── start.sh             # 启动
└── live-rec.service     # systemd 自启模板
```

## 六、零依赖说明

核心功能只用 Node.js ≥18 内置模块（http/fetch/FormData/child_process），**不联网装任何 npm 包也能跑**。两个可选增强：
- `npm i impit` → bongacams 的 Cloudflare 过检（浏览器 TLS 指纹）；
- `npm i undici` → 启用「代理列表」功能。
