# xiangwriter-node（想写）— AI 漫剧批量生成节点包

让 ComfyUI 按目录结构**全自动**批量生成漫剧：读取每一集的剧本与参考图，
由内置 **LLM agent** 自动把参考图分配到 image1..image9 槽位、把剧本注入提示词节点、
按剧情需要**忽略（bypass）多余的节点**，跑完一集自动进入下一集。

本版同时提供“一体化导演节点”和三个可组合模块。旧工作流继续使用
`XWComicDirector`；新工作流推荐使用 Source → Planner → Loader，便于单独排查目录、
LLM 和图片加载问题。

## 功能一览

| 需求 | 实现 |
|---|---|
| 自动读取指定路径的集目录内容 | 导演节点按 `root_dir + episode_index` 扫描 `第一集/第二集/…`，自动读剧本和参考图 |
| 按剧本把图片放到对应的加载位置 | agent 读剧本 + 看参考图（多模态），输出槽位映射，节点把图加载到 `image_1..image_9` 输出端口 |
| 剧本自动加载到提示词窗口 | `script` / `agent_prompt` 文本输出；前端按钮还可把提示词直接写入工作流中的 CLIPTextEncode 节点 |
| 参考图自动扩张（最多 9 张） | 固定 9 个 IMAGE 输出槽位（agent 决定用几张）+ `images_batch` 批量输出 |
| 忽略节点（n 张变 n−1 张，n=1..9） | 前端按每段实际 `slots` 自动追踪未使用输出口的下游独占分支，并在**入队前**设为 bypass(mode=4)；适用于 9→8、8→7……1→0。LLM 的 `ignored` 列表作为附加规则 |
| 自动运行 + 逐集连播 | 节点上的「▶ 运行本集 / ⏭ 连播剩余所有集」按钮；跑完一集自动回到系列根目录读下一集 |
| 图像输出直接接下游 | 输出类型为标准 `IMAGE`，与 LoadImage 完全一致，可直接接 ControlNet / IPAdapter / 图生图等任意 IMAGE 输入；节点上直接显示参考图预览 |

## 兼容性（ComfyUI 0.30.0 及以上）

- **自动双轨适配**：检测到新版 ComfyUI 的 V3 API（`comfy_api.latest`）→ 自动注册 V3 节点
  （新版 ComfyUI 已开始移除 V1 旧接口，插件跟随官方方向）；
  其它 0.30.0+ 版本（含秋叶整合包等各类发行版）→ 自动注册 V1 经典节点。
- 两种节点共用同一套 agent 逻辑与前端扩展，行为完全一致，无需任何手工切换。
- 前端连线读取同时兼容旧版 LiteGraph 普通对象和新版 `Map` 结构，适用于
  ComfyUI 0.30.0 之后不同版本的 `comfyui_frontend_package`。
- 完整运行条件见 `环境要求.txt`。

## 安装

1. 把整个 `xiangwriter-node` 文件夹复制到 ComfyUI 的 `custom_nodes` 目录下；
2. **重启 ComfyUI**；
3. 右键画布 → 搜索「**xiangwriter-node**」→ 添加节点（分类 `xiangwriter-node/漫剧`）。

## 目录结构约定

一个"系列根目录"下放若干集目录。**两种模式**：

**整集模式**（segment_mode 关）：每集目录内直接放参考图 + 一个剧本文本。

**分段模式**（segment_mode 开，推荐，用于视频生成）：视频生成通常只支持 15 秒/段，
一集 1~2 分钟需要切成多段 —— 每集目录下放 1-1、1-2... 子目录，**每段各自有剧本和参考图**：

~~~text
D:/漫剧/目录1/
├── 第一集/                    ← 集目录（1~2 分钟的一集）
│   ├── 1-1/                   ← 段目录（每段 ≤15 秒视频）
│   │   ├── 剧本.txt           ← 本段剧本（UTF-8/GBK 均可自动识别）
│   │   ├── 角色A.png          ← 本段参考图（数量不限，最多用 9 张）
│   │   └── 场景1.png
│   ├── 1-2/
│   │   ├── 剧本.txt
│   │   └── ...
│   └── 1-3/ ...
├── 第二集/
│   ├── 1-1/ ...
│   └── 1-2/ ...
└── 第三集/ ...
~~~

集目录按"自然排序"识别（第2集 < 第10集），段目录同样自然排序（1-2 < 1-10）。
参考图文件名建议带上角色/场景名，方便文本模型理解。

## 快速开始（图形界面）

### 推荐：模块化工作流

添加并连接三个节点：

~~~text
想写·剧集素材读取 (XWSeriesSource)
  source_json ──┬──> 想写·Agent 规划 (XWAgentPlanner) ── plan ──┐
               └───────────────────────────────────────────────┼──> 想写·参考图槽位加载 (XWReferenceLoader)
                                                               └──> prompt 接提示词节点
~~~

| 节点 | 单一职责 |
|---|---|
| 想写·剧集素材读取 | 选择集/段，读取剧本、参考图清单和数量信息 |
| 想写·Agent 规划 | 可选调用 LLM，输出选图 plan、prompt 和 ignored；不配 LLM 时返回可执行的文件名顺序方案 |
| 想写·参考图槽位加载 | 校验 plan 是否属于当前集/段，并加载 `image_1..image_9` 与预览 |

模块化方式正常排队即可运行；`prompt` 可直接连接转成输入端口的提示词节点。
「想写·剧集素材读取」节点也提供分析、运行、连播和停止按钮；它会读取相连规划器的配置，
并从相连的参考图槽位加载器追踪未使用图片分支、自动设置或恢复 bypass。一体节点行为相同。

### 兼容：一体化导演节点

1. 添加「xiangwriter-node」节点，填写 `root_dir`（如 `D:/漫剧/目录1`）；
2. 把 `image_1..image_9`（或 `images_batch`）接到你的工作流（ControlNet/IPAdapter/图生图等）；
3. 把 `script` 或 `agent_prompt` 接到提示词节点（需先把 CLIPTextEncode 的 text 右键转成输入）；
4. 配置 LLM（见下节）；
5. 点击节点上的按钮：

| 按钮 | 作用 |
|---|---|
| 🔍 分析当前段/集（agent） | 只分析：生成槽位规划 JSON（写入 `plan` 文本框），不运行 |
| ▶ 运行当前段/集 | 分析 → 写入提示词 → 忽略多余节点 → 入队运行 |
| ⏭ 连播剩余全部（段/集） | 分段模式：段跑完自动进下一段，段跑完进下一集；整集模式：逐集推进。全部跑完自动停止 |
| ⏸ 停止连播 | 中断连播 |

**分段模式关键参数**：`segment_mode`（开 = 集下有 1-1/1-2... 子目录）、`segment_index`（当前第几段）。连播时插件自动推进 `segment_index`，段的序号用完后自动 +1 集并把段重置为 1。`episode_name` 输出为集名，`segment_name` 输出为段名（整集模式下为空）。

> ⚠️ ComfyUI 的 bypass/mute 属于**图层面的设置**，必须在入队前生效。
> 一体节点或「剧集素材读取」模块上的「运行/连播」按钮会先分析当前段的实际槽位，
> 再从未使用的 `image_1..image_9`
> 输出连线向下追踪：独占分支全部 bypass；遇到同时属于有效图片链路的汇合节点时，
> 忽略该缺图边界节点后停止继续向下，避免误伤共享保存节点。下一段图片变多时，
> 插件会恢复它此前自动忽略的节点，并保留用户原本手工设置的 bypass 状态。
> KJNodes Use Everywhere 的 `SetNode` 可随缺图槽位跳过，但 `GetNode` 保持启用，
> 由 Use Everywhere 在 API Prompt 转换阶段安全解析，避免切断公共生成链；
> `SaveImage`、`PreviewImage`、`VHS_VideoCombine` 等输出节点始终受到保护。
> 每次入队前还会检查至少存在一个启用的输出节点，避免后端报
> `prompt_no_outputs / Prompt has no outputs`。

数量变化不是 `3→2→3` 的固定流程。每次切换段落时都重新读取当前段实际槽位：
若上一段有 n 张、下一段有 n−1 张（n 为 1～9 的整数），下一段会继续保留
前 n−1 路，只跳过新减少的第 n 路以及本来就为空的更高槽位；即使降到 0 张，
保存/预览/视频输出节点也不会被关闭。

## 配置 LLM（agent）

| 输入项 | 说明 |
|---|---|
| llm_api_base | OpenAI 兼容地址，如 `https://api.deepseek.com/v1`、`https://api.openai.com/v1`、本地 Ollama `http://127.0.0.1:11434/v1` |
| llm_api_key | 密钥（留空则按文件名顺序加载） |
| llm_model | 如 `deepseek-chat`、`gpt-4o`、`qwen-vl-max`（多模态需支持图片输入） |
| llm_vision | 开：把参考图压缩后发给模型看图；关：只发文件名 |
| llm_system_prompt | 自定义提示词（留空用内置模板，模板会把 max_images、剧本、图列表、工作流节点清单发给模型） |

密钥不想写进工作流时，可在启动 ComfyUI 前设置环境变量
`XW_LLM_BASE`、`XW_LLM_KEY`、`XW_LLM_MODEL`，节点对应输入留空即可。

**不配置 LLM 也能用**：分析接口、模块节点和无头脚本都会返回可执行的降级方案，
按文件名顺序把参考图填满槽位，剧本原文作为提示词。

agent 返回的 `plan`（JSON）会写入节点上的 `plan` 文本框，内容示例：

~~~json
{
  "ok": true,
  "llm_used": true,
  "episode_name": "第一集",
  "episode_index_actual": 1,
  "episode_count": 3,
  "slots": [
    { "slot": 1, "image": "角色A.png", "reason": "主角" },
    { "slot": 2, "image": "角色B.png", "reason": "配角" },
    { "slot": 3, "image": "场景1.png", "reason": "主要场景" }
  ],
  "prompt": "……根据剧本生成的提示词……",
  "ignored": ["IPAdapter_4", "IPAdapter_5"]
}
~~~

手动改了 `episode_index` 后请重新点「分析」生成新 plan。规划中带有集/段上下文，
与当前单位不一致或只部分有效时会整体降级为文件名顺序，不会复用上一集提示词。

## 无头批量模式（可选，不需要浏览器）

ComfyUI 里导出工作流的 **API 格式 JSON**（菜单 Save (API Format)），然后：

~~~text
python scripts/run_series.py --workflow wf_api.json --root "D:/漫剧/目录1" ^
    --llm-base https://api.deepseek.com/v1 --llm-key sk-xxx --llm-model deepseek-chat
~~~

工作流可以包含兼容一体的 `XWComicDirector`，也可以包含
`XWSeriesSource + XWReferenceLoader` 模块组合；`XWAgentPlanner` 可选。

逐集：agent 分析 → 更新一体节点或模块节点参数 → **切除未用槽位的链路**
（等效忽略，级联移除失去全部输入的被忽略节点）→ 排队 → 轮询结果 → 下一集。
每集历史结果存到 `--out` 目录。

## 常见问题

- **节点不执行 / 一直用旧图**：导演节点带缓存，目录内容变化或切换集数后会自动重跑（按目录文件时间戳指纹）；若 plan 变了也会自动重跑。
- **LLM 调用失败**：自动降级为文件名顺序加载，不会中断工作流。
- **vision 模型看图很慢/很大**：插件会自动把图压缩到最长边 1024px 的 JPEG 再发送。
- **连播中途停止**：点「⏸ 停止连播」，或刷新页面。
- **Prompt has no outputs**：确认工作流至少手动启用了一个保存、预览或视频合成节点。
  插件不会再自动 bypass 输出节点；如果所有输出节点原本就是用户手动关闭的，插件会停止入队并给出中文提示。
- **V3 节点找不到**：说明你的 ComfyUI 版本较旧，已自动注册 V1 节点，功能一致。

## 目录结构

~~~text
xiangwriter-node/
├── __init__.py            # 节点注册（V3/V1 自适应）+ /xiangwriter/analyze 路由
├── py/
│   ├── agent.py           # 目录扫描 + LLM 调用 + 槽位规划（核心逻辑）
│   ├── common.py          # 图片张量、预览和 plan 校验共用逻辑
│   ├── modular.py         # V1 三个可组合节点
│   ├── modular_v3.py      # V3 三个可组合节点
│   ├── director.py        # V1 导演节点
│   └── director_v3.py     # V3 导演节点（新版 ComfyUI 自动启用）
├── js/
│   ├── director.js        # 前端扩展：分析/忽略/连播/剧本注入
│   └── slot_ignore.js     # 未使用图片槽位连线追踪 + bypass 状态恢复
├── scripts/
│   └── run_series.py      # 无头批量运行器
└── README.md
~~~
