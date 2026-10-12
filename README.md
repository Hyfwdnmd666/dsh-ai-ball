# dsh-ai-ball

> 给 agent 一张嘴：让它通过 [ai-ball](https://github.com/Hyfwdnmd666/ai-ball) 那颗悬浮球说话、做表情、听你打字。

ai-ball 是一个 Windows 悬浮球 —— 它把自己追加到 `monologue.log` 的文字逐字"说"出来、
按 `status.json` 里的 mood 变色、把你打进输入框的话追加到 `input.log`。
**球本身是哑的，它只认文件。**

所以这个插件很薄：它不去操作球的窗口，也不 spawn Python，**它只写球已经在看的那些文件**。
这也是为什么任何进程都能当球的"大脑"。

## 你需要什么

1. **ai-ball 本体**（一个 Python 3.10+ 的目录，里面有 `ball.py`）
2. 把它跑起来（双击 `start.bat`，或 `python ball.py`）

插件本身不包含球，也不会替你安装它。

## 安装

```sh
dsh plugin --profile web add link:/path/to/dsh-ai-ball
```

或者从市场里装。

## 配置

挂在 profile 的 `cordis.patch.yml` 里：

```yaml
- id: dsh-ai-ball
  name: dsh-ai-ball
  config:
    ballDir: C:\tools\ai-ball        # 必填：放着 ball.py 的那个目录
    startCommand: C:\tools\ai-ball\start.bat   # 可选：ball_launch 用
    cps: 50                          # 可选：球的打字速度，用来估算 wait
    heartbeatMs: 3000                # 可选：心跳间隔，必须小于球那边的 stale_s
    files:                           # 可选：和球自己的 config.json 对齐
      monologue: monologue.log
      input: input.log
      status: status.json
```

也可以走环境变量 `AIBALL_DIR` / `AIBALL_START`。

**`ballDir` 故意没有默认值。** 猜别人把球解压到哪儿了，正是插件往错目录里写文件的方式 ——
所以它宁可报一个说清楚哪里不对的错。

## 六个工具

| 工具 | 作用 |
|---|---|
| `ball_say` | 说话。追加到 `monologue.log`，球逐字念出来。`clear=true` 先清屏 |
| `ball_mood` | 改球的脸：`idle` / `thinking` / `nervous` / `smug` / `broken` |
| `ball_panel` | 显示 / 收起独白面板 |
| `ball_listen` | 读你在球里打的字（`input.log`），只返回新的 |
| `ball_status` | 报告接线情况：文件大小、最后说了什么、心跳多旧、有没有在心跳 |
| `ball_launch` | 按配置的 `startCommand` 把球拉起来 |

## 两个会让你浪费一下午的坑

### 1. 心跳不是可选项 —— 插件会自己接管它

球把**过期的心跳**读成"大脑死了"并渲染成灰色，而那会**盖掉 mood**。

所以 `ball_mood` 不只是写一次 mood：它同时启动一个心跳，**在插件加载期间一直刷**。
这有两个后果：

- 第一次调 `ball_mood` 之后，球就再也不会因为你没在做事而变灰了（这是对的：
  插件活着 = harness 活着）
- 插件被卸载/重载时心跳会停（挂在 cordis 的 dispose 上，不会泄漏定时器）

一个只写一次 `mood`、不管心跳的实现，看起来像成功了，然后 20 秒后静默失效。

### 2. 如果 `brain.py` 在跑，它每三秒会把你的 mood 踩回 `idle`

`brain.py` 每隔几秒重写整个 `status.json`（心跳是它的）。
两个写者抢同一个文件，后写的赢。

想自己拥有球的脸，在 `brain.json` 里设：

```json
{ "write_mood": false }
```

那样它只刷心跳，文件里现有的 `mood` 原样保留 —— 两个写者就能共存了。

### 3. `ball_panel` 为什么带一个序号

`status.json` 里的 `panel` **不是"当前该是什么状态"，是一条命令**，`panel_seq` 是它的序号。
球只在**序号变化**时动一次。

不这么做的话，插件每几秒重写一次文件，就等于和你抢面板开关：
你收起面板，它下一拍又打开。

带序号之后：

- 你手动开关面板**一直算数**（插件没改变主意，序号没变）
- 插件改变主意时把序号加一，球再执行一次
- **每次调 `ball_panel` 都是新请求**（序号加一），所以"你关掉了，我要它再显示"
  是有效的，不会变成空操作

（球那边没有 `panel_seq` 的 `panel` 一律不执行 —— 没有序号就无法区分"你刚关掉"和
"它一直这么说"，照做就是抢开关。）

## `ball_listen` 为什么不会切坏中文

读游标按**字节**记，而且只推进到**最后一个换行**。

写入方可能被撞见写到一半：游标如果按字符算、或者用替换字符解码尾部，
那半个 UTF-8 序列会变成 U+FFFD **并且永久留在游标后面** —— 内容就再也读不出来了。
停在最后一个换行，残缺的尾巴下次会重新读一遍，这是简单正确的做法。

（同一个 bug、同一个修法，ai-ball 的 Python 侧也有一份。）

## 它不做的事

- **不判断球在不在跑。** `ball_status` 报的是文件状态，不是窗口状态 —— 严格来说，一个没在跑的球
  和一个在跑但没人写的球，看起来是一样的。
- **不会只启动一颗球。** `ball_launch` 是只写的，重复调用会得到两颗球。
- **不渲染 Markdown。** 球是嘴，不是文档。`**强调**` 会原样显示出来。
- **不会替你记住要开面板。** `ball_say` 不会自动显示面板 —— 面板收着的时候它照样写成功，
  只是没人看得见。要保证被看到，先 `ball_panel(true)`。

## 许可

[MIT](LICENSE)
