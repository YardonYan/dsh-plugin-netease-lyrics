# dsh-plugin-netease-lyrics

DeepSeek Harness（DSH）摸鱼歌词插件：桌面网易云音乐在放什么，DSH 输入框上方的「深度求索中，用时 X 秒 …」状态行右边就同步浮现当前那句歌词——同字体、同字号、同颜色，看起来只是那句话有点长。

> 灵感：工作时要听歌，但把网易云切出来看歌词太张扬。不如让歌词藏进 DSH 自己的状态行里。

## 效果预览

DSH 里的样子——歌词贴在「深度求索中」右边，一模一样的橙色小字：

![歌词贴行效果](docs/demo-lyrics-1.png)

![歌词贴行效果 2](docs/demo-lyrics-2.png)

此时网易云里正在放的歌（对应上面两张图）：

![正在播放 1](docs/demo-song-1.png)

![正在播放 2](docs/demo-song-2.png)

不仔细看，只会觉得这句状态话有点长——只有你知道那是歌词。

## 工作原理

```
桌面网易云音乐 ──播放──▶ Windows SMTC 系统媒体接口（歌名 / 歌手 / 播放状态）
                                   │
                                   ▼
                   插件 Host 端（DSH 宿主进程内）
                    ├─ 常驻 PowerShell worker 每秒读一次 SMTC
                    ├─ Host 秒表推算播放进度*（见"已知限制"）
                    └─ 拉取网易云歌词 API（LRC + 翻译，7 天缓存）
                                   │  同源 HTTP 路由 /plugin/netease-lyrics/*
                                   ▼
                   Client 端（浏览器 bundle）
                    └─ 每秒轮询，把当前歌词行以 fixed 定位
                       贴在「深度求索中」状态行右侧，
                       computed style 现场克隆其字体字号颜色
```

\* 网易云 PC 客户端不通过 SMTC 上报播放进度，所以插件自己跑秒表：切歌归零、暂停停表、恢复续走。

## 安装

### 环境要求

- DeepSeek Harness（**Windows 宿主**；SMTC 是 Windows 独占 API，其他平台插件保持静默不报错）
- 桌面版网易云音乐，且已在 **设置 → 播放** 打开「系统媒体控件」类开关（不开的话 SMTC 读不到播放状态，这是最容易踩的坑）

### 步骤

```powershell
# 在 DSH 会话中直接安装（<路径> 换成仓库克隆位置）
dsh plugin --profile web add "<路径>/dsh-plugin-netease-lyrics" --save-exact
```

或在 DSH 的插件管理里以本地目录 bundle 方式安装。安装后**重启 `dsh web`**（Host 端需要加载进程），刷新页面。

### 使用

1. 打开桌面网易云放一首歌
2. 在 DSH 里随便发一条消息让 AI 转起来
3. 「深度求索中」状态行右边会出现同样式的歌词，跟着演唱进度换行
4. 鼠标悬停歌词可看完整句和翻译（如果有）

## 必读：注意事项与已知限制

| 限制 | 原因 | 缓解办法 |
| --- | --- | --- |
| **歌词不显示的第一排查项** | 网易云没开「系统媒体控件」 | 网易云 → 设置 → 播放 → 打开系统媒体控件开关，切一次歌生效 |
| 拖动网易云进度条后歌词漂移 | SMTC 不上报 seek，秒表感知不到 | 换一首歌再换回来，即重新对齐 |
| 单曲循环时秒表会走出歌尾 | 秒表不知道歌曲总长 | 同上 |
| 仅适配中文界面 | 锚点匹配「深度求索中，用时」文案 | 在插件配置里改 `anchorText`（见下） |
| AI 空闲时歌词不显示 | 设计行为：状态行不在 = 歌词隐藏（隐蔽优先） | 想常显需自行改 client.js 的 stealth 判断 |
| 仅本机访问 | 路由只响应 loopback + Origin 校验 | 这是安全特性，不开放外露 |
| 歌词搜索偶尔对不上歌 | 按「歌名 + 歌手」搜索取首个精确匹配 | 少见；纯音乐/翻唱版本多时可能取错 |

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖该插件行：

```yaml
- override:
    id: netease-lyrics
    config:
      anchorText: "深度求索中，用时"   # 换成你的宿主状态行文案（英文界面等）
```

## 隐私与安全

- 插件不读取网易云账号、Cookie 或任何客户端数据，只读 Windows 系统媒体会话的公开快照（歌名/歌手/状态）
- 歌词经 `music.163.com` 公开接口按歌名搜索，无需登录
- HTTP 路由仅接受本机回环地址，带 Origin 校验，防 DNS rebinding

## 目录结构

```
dsh-plugin-netease-lyrics/
├── package.json          # 插件清单（dsh.bundle.patch + dsh.client）
├── cordis.patch.yml      # Loader 补丁
├── index.js              # Host 端：SMTC worker 监管 + 歌词代理路由
├── client.js             # 浏览器端：锚点定位 + 歌词渲染
├── smtc-worker.ps1       # Windows SMTC 探测 worker（ASCII-only，PS 5.1 兼容）
├── docs/                 # 效果截图
├── locale/               # 展示名称与描述（en / zh）
└── icon.svg              # 插件图标
```

## 排障速查

**歌词完全不出现？**
1. 网易云在放吗？→ 放着才有效
2. 网易云系统媒体控件开了吗？→ 设置 → 播放
3. AI 在转吗（「深度求索中」行存在）？→ 空闲时按设计隐藏
4. 浏览器 F12 控制台有没有 `[netease-lyrics]` 警告？→ worker 挂了会在这里提示

**歌词突然卡住不走？**
网易云被暂停又恢复过、或拖动过进度条 → 切一首歌再切回来。

**颜色/位置不对？**
歌词样式是从状态行现场克隆的，若 DSH 更新改了状态行实现，重新刷新页面即可。

## 致谢

- [NeteaseCloudMusicApi 社区](https://github.com/Binaryify/NeteaseCloudMusicApi) 摸清的公开歌词接口参数
- [JasonCHTT/dsh-netease-music](https://github.com/JasonCHTT/dsh-netease-music) 的 README 提供了 DSH 插件挂载点参考

## 许可证

[MIT](LICENSE)
