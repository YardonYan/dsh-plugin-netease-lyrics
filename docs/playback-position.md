# 播放进度：四条获取路径与取舍

适用范围：Windows 10 / Windows 11 宿主，桌面版网易云音乐。本文讨论的是怎么拿到"当前播放到第几秒"，不涉及歌名、歌手、播放状态，那三项 Windows 的 SMTC 已经给得很准。

## 1. 现在的做法与缺口

插件目前的链路是：

```
SMTC 元数据（歌名 / 歌手 / 播放状态）
        ↓
Host 端秒表：切歌归零、暂停停表、恢复续走
        ↓
位置 = 基准秒数 + 自上次开始播放以来的墙钟差值
```

秒表能覆盖的：正常播放、暂停、恢复、切歌。

秒表覆盖不了的：

| 场景 | 现象 | 原因 |
| --- | --- | --- |
| 拖动进度条 | 歌词整体偏移，越拖越远 | 秒表不知道用户跳到了哪里 |
| 单曲循环 | 播到歌尾后秒表继续走 | 秒表不知道歌曲总时长 |
| 系统休眠后恢复 | 恢复瞬间跳到歌尾 | 墙钟在休眠期间照走 |

三个场景的共同点：缺的是**位置**，不是元数据。方案的目标只有一个，找到比秒表更权威的位置来源。

## 2. 四条路径

### 2.1 问 Windows：SMTC 时间轴

Windows 10 起，`GlobalSystemMediaTransportControlsSession` 除了元数据，还有一个 `GetTimelineProperties()`。这个对象一共只有六个属性：

| 字段 | 含义 |
| --- | --- |
| `Position` | 当前播放位置，`TimeSpan` |
| `StartTime` | 时间轴起点，通常是 0 |
| `EndTime` | 歌曲总时长 |
| `LastUpdatedTime` | 上一次时间轴更新的时刻 |
| `MinSeekTime` | 允许拖动的最小位置 |
| `MaxSeekTime` | 允许拖动的最大位置 |

时间字段允许为 null，表示播放器没有上报。

这是最省事的一条路：播放器把值填进来，插件直接读，不需要登录、不需要窗口、不碰客户端内部。

关键问题是**网易云客户端到底填没填**。仓库里的 `scripts/smtc-probe.ps1` 就是为这个问题准备的，本机实测过一个反例与一个待测项：

- 反例（可用）：Edge 播放 B 站视频时，`PositionSec=4.6`、`Duration=879`、`LastUpdated` 均有值，说明接口链路本身是通的
- 待测（未定）：网易云客户端。未在播放状态下复测，不能下结论

这里有一段需要交代的历史：这个探针原本引用了 `PositionUpdateTime`，而该属性在上述六个之外并不存在，取值恒为 null，随即在 `.ToString()` 上抛异常，每次运行都会打印一行错误。也就是说，此前"网易云不上报进度"的判断建立在一个会抛异常的探针上，理由不够硬，值得用修好的版本复测一次。

如果填了，改动量约 15 行：worker 多读两个字段，host 把秒表降级为兜底。漂移、单曲循环、休眠三个问题一并消失，因为每秒都在被权威值覆盖。

如果没填，`Position` 会是 0 或 `null`，`TimelineUsable` 判定为 false，转下一节。

### 2.2 问客户端界面：UI Automation

思路是绕开媒体接口，直接读网易云窗口里那根进度条的值。Windows 的 UIA 提供 `RangeValuePattern`，滑块类控件的当前值可以直接读。

前置条件：

- 主窗口必须存在。最小化到托盘后窗口销毁，读不到
- 客户端的界面框架要把进度条暴露成 UIA 控件。不是所有桌面客户端都会这么做，需要实测枚举

代价是稳定性：客户端换版、换皮肤、改布局都可能让取数失效，而且失效时是静默的，不会报错。

判定方法：写一个 UIA 探针，枚举网易云窗口的控件树，看有没有 `RangeValuePattern` 且取值范围接近 `[0, 歌曲时长]` 的节点。有就是可行，没有就放弃。

### 2.3 问服务端：登录态 Web API

网易云的公开接口能给：歌曲 id、时长、歌词正文。按 id 取歌词，比现在按"歌名 + 歌手"搜索取首个匹配要准得多，README 里"歌词搜索偶尔对不上歌"那条限制会一并解决。

但服务端拿不到实时进度。它只知道播放记录（听完哪首、什么时候），不知道你此刻拖到了第几秒。所以这条路解决的是匹配精度，不解决位置。

代价还有一条：登录。现在插件的隐私承诺是不读账号、不读 Cookie、不需要登录，走这条路要破这个承诺，或者改成可选的增强模式（用户自愿扫码）。

### 2.4 旁路：回环录音加音频指纹

抓系统输出的声音（WASAPI loopback），算音频指纹（Chromaprint 一类），和本地指纹库比对，得出正在放哪首歌。

这条路能解决跨播放器的问题：不管 QQ 音乐、Spotify 还是网页播放器，只要出声就能认。但它是四条路里最重的，原生音频依赖、指纹库体积、常驻 CPU，而且认出来的是"哪首歌"，位置仍然要靠秒表推算。

适合放进长期规划（README 里"适配其他音乐平台"那条），不适合现在做。

## 3. 对比

| 路径 | 能拿到位置 | 能拿到时长 | 侵入性 | 稳定性 | 改动量 | 是否要登录 |
| --- | --- | --- | --- | --- | --- | --- |
| 2.1 SMTC 时间轴 | 取决于客户端是否填 | 取决于客户端是否填 | 无 | 高（系统接口） | 小 | 否 |
| 2.2 UI Automation | 是 | 是 | 低（需窗口） | 低（随界面变化） | 中 | 否 |
| 2.3 登录态 API | 否 | 是 | 中（破隐私承诺） | 高 | 中 | 是 |
| 2.4 音频指纹 | 否 | 是 | 高（原生依赖） | 中 | 大 | 否 |

## 4. 推荐路线

分三步，前一步的结论决定下一步走不走。

**第一步：复测 2.1（十分钟）**

开着网易云放一首歌，运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smtc-probe.ps1
```

看网易云那行的三个值：

- `PositionSec` 随播放增长、`Duration` 等于歌曲时长 → 走第二步
- `PositionSec` 恒为 0 或 null、`TimelineUsable=false` → 跳第三步

**第二步：时间轴可用，替换秒表**

worker 增加两个字段，host 改为权威值优先、秒表兜底。每秒覆盖一次，拖动进度条的偏移最多存在一秒。

**第三步：时间轴不可用，做 2.2 的可行性探针**

枚举网易云窗口的 UIA 控件树，找带 `RangeValuePattern` 的滑块。找得到就按 2.2 实现；找不到就维持现状，把"切歌重新对齐"从隐式行为改成显式提示——现在用户不知道歌词漂了要切歌，这是产品问题，不是技术问题。

## 5. 代码改动草案

### 5.1 worker：多读两个字段

```powershell
$tl = $smtc.GetTimelineProperties()
$pos = if ($null -ne $tl.Position) { $tl.Position.TotalSeconds } else { -1 }
$duration = if ($null -ne $tl.EndTime) { $tl.EndTime.TotalSeconds } else { 0 }
```

写进 JSON 时保留两位小数。`Position` 为 null 时用 -1 表示"没有"，不要用 0，否则与"真的在 0 秒"无法区分。

### 5.2 host：权威值优先

```js
function positionSeconds() {
  // 客户端上报了时间轴就以它为准，每秒刷新一次，同时覆盖拖动进度条的情况
  if (state.timeline && state.timeline.position >= 0) {
    if (!state.smtc.playing) return state.timeline.position;
    return state.timeline.position + (Date.now() - state.timeline.at) / 1000;
  }
  // 没有时间轴，退回秒表
  if (!state.playingSince) return state.positionBase;
  return state.positionBase + (Date.now() - state.playingSince) / 1000;
}
```

### 5.3 client：不需要改

现有 `/resync` 接口已经能让客户端主动上报位置。时间轴接入后它仍然有用，作为兜底对齐手段保留。

### 5.4 调用落在哪一层

Host 端跑在 Node 里，调不了 WinRT，所以取数只能放在子进程。现在这个子进程是 PowerShell worker，也可以换成常驻的 C# 助手或原生扩展，但对本方案没有影响：换的是取数容器，不是取数逻辑。

本插件目前只用到 DSH 的两类接口，路由与插槽。改动集中在 worker 与 host 两个文件，不涉及宿主本身，也不要求 DSH 提供额外能力。

## 6. 边界

以下做法不采纳，写在这里避免以后反复讨论：

- 读客户端进程内存或注入 DLL：稳定性、安全性、合规性都不可接受
- 要求用户登录才能用歌词：破坏当前"零登录"的设计
- 常驻抓取系统音频：CPU 与隐私代价过高，除非为了跨平台适配

## 附录：本机实测记录

2026-11-04，Windows，Edge 播放网页视频：

```json
{"AppId":"MSEdge","Title":"iPad mini 8 评测：为什么没有高刷新率？_哔哩哔哩_bilibili","Artist":"","Album":"",
 "Status":"Paused","PositionSec":4.6,"Duration":879,
 "LastUpdated":"2026-11-04T22:11:28.6842791+08:00","TimelineUsable":true}
```

同一轮里用 `Get-Member` 列过时间轴对象的属性，结果只有 `EndTime, LastUpdatedTime, MaxSeekTime, MinSeekTime, Position, StartTime` 六项。两点结论：接口可用；原探针引用的 `PositionUpdateTime` 并不存在，探测脚本必须做空值保护，否则会在那一行抛异常。
