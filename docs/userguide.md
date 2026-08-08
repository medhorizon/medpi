# MedPi User Guide

MedPi 是一个基于 Pi `0.84.1` 和可编辑 pi-web `v0.8.6` 的本地科研工作区。本指南面向第一次运行 MedPi 的研究者、开发者和评审者，覆盖安装、模型配置、项目信任、会话使用以及当前科研工具。

> **当前状态：development baseline。** 本版本适合 loopback、单用户、trusted project 的本地开发和研究验证，不是公开生产服务。Project trust 不是 OS/container sandbox。可用 `science_run` / `science_rollback` 做带审计的项目内命令执行（默认无沙箱，Linux 可选 bwrap）；R kernel、notebook UI、MCP sidecar、Research Graph/GEPA、subagent scheduler 和重型 scientific viewer 当前未启用。

## 1. 你可以用 MedPi 做什么

当前可用能力包括：

- 使用 Pi 的 AgentSession、JSONL session tree、branch/fork、compaction、steer/follow-up 和模型/Provider 能力；
- 在一个研究项目内对话、读取和编辑文件、执行 shell 命令、查看附件和导出会话；
- 使用 8 个公开、免密的科学数据库 connector；
- 对常见科学文件做有界格式识别和预览；
- 用 branch-local Stage 记录研究阶段，并在 gated stage 完成前请求人工批准；
- 用轻量 provenance DAG 记录 source、run、artifact、claim 及 supports/refutes review finding；
- 使用 `science-review` prompt 检查 citation mismatch、untraceable number 和 figure/stat mismatch；
- 用 `science_run` 在项目内执行命令（默认 host/`none` 沙箱，可选 Linux `bwrap`），并留下 provenance 与 `.medpi/runs/` 日志；用 `science_rollback` 回到运行前 git 存档点。

当前没有专用科研结果面板。科研 tool 的文本和 `details` 会通过普通 Pi tool-result UI 展示。

## 2. 环境要求

| 项目 | 要求 |
|---|---|
| Node.js | `>=22.19.0`；当前验证环境为 `v22.20.0` |
| npm | 当前 lockfile 使用 npm `10.9.3` |
| Git | `science_run` 默认 checkpoint / `science_rollback` 需要项目已是 git 仓库；Git worktree 功能也需要 |
| 浏览器 | 支持现代 EventSource/SSE、文件选择和基础 Web APIs 的浏览器 |
| 模型凭据 | 至少配置一个可用的 API-key、OAuth 或本地 OpenAI-compatible provider |

安装开发依赖时必须包含 dev dependencies。若环境设置了 `NODE_ENV=production` 或 npm omit 配置，仍然显式使用 `--include=dev`。

## 3. 安装和启动

### 3.1 安装依赖

```bash
cd /home/wei/medpi
npm ci --include=dev --registry=https://registry.npmjs.org
```

如果你修改了依赖声明或 lockfile，使用：

```bash
npm install --include=dev --registry=https://registry.npmjs.org
```

不要提交以下内容：

- `node_modules/`
- `.next/`
- `dist/`、build、coverage
- `.env` 和任何凭据
- Pi session、`.medpi/` runtime data 和缓存

### 3.2 启动本地 Web UI

```bash
npm run dev
```

默认只监听 loopback：

```text
http://127.0.0.1:30141
```

如果默认端口已被占用，可以使用其它端口：

```bash
npm --workspace @medpi/web run dev -- -p 30142
```

开发期间不要运行 `next build`；仓库的开发约定要求使用 `next dev`。

### 3.3 可选的 Basic Auth

如果需要给本机或受控 LAN 使用加一层认证，在启动进程前设置 `PI_WEB_PASSWORD`：

```bash
export PI_WEB_PASSWORD='use-a-new-long-secret'
npm run dev
```

Basic Auth 用户名固定为 `pi`。密码应通过受控环境变量、secret manager 或 shell 注入，不要写进仓库、截图、聊天记录或启动日志。

> Basic Auth 必须配合 TLS/reverse proxy 才适合网络传输。`PI_WEB_PASSWORD` 不是多用户权限系统，也不能替代 OS/container 隔离。

### 3.4 LAN 模式警告

仓库提供：

```bash
npm run dev:lan
```

它会监听 `0.0.0.0:30141`。这只适合临时、受控的 trusted LAN 调试；不要直接把它暴露到公网。公开部署前还需要 TLS、出站网络策略、认证限流、全局安全 headers、文件边界和资源配额。

## 4. 第一次打开：选择项目并建立信任

### 4.1 选择工作目录

1. 打开 Web UI。
2. 在左侧 session sidebar 的项目选择器中选择最近使用的项目。
3. 如果没有历史项目，可以选择默认目录，系统会创建：
   ```text
   ~/pi-cwd-YYYYMMDD
   ```
4. 也可以选择自定义路径，在目录选择器中输入绝对路径或 `~/...` 路径，然后先点击 **Go** 加载目录，再点击 **Select this folder**。
5. 点击左侧 **New** 创建一个新会话；新会话在发送第一条消息时才真正创建 Pi session。

建议选择一个专用研究目录或具体仓库目录，不要随意选择 `/`、整个 home 目录、`/tmp` 或包含凭据的目录。当前选择目录会将其加入 Web 文件访问 allow-list。

### 4.2 Project trust

如果项目包含需要加载的 `.pi` resources、package、extension、skill 或 prompt，顶部会出现项目资源未加载/信任提示。

只有在你确认以下内容可信时才点击 **Trust project**：

- 项目目录来源可信；
- `.pi/settings.json`、`.pi/agent/`、`.agents/skills/` 和相关 package 内容已审阅；
- 你理解 extension、plugin 和 shell tool 会以当前宿主用户权限运行。

信任项目后，MedPi 才会加载项目资源；现有 session 可能会被重新加载。拒绝信任时，普通聊天仍可能可用，但 project-scoped skill/plugin、`science_inspect` 和 provenance 文件操作会被拒绝。

> **重要：** Project trust 只决定 Pi 是否加载/使用项目资源，不是沙箱。恶意 extension、plugin、skill、模型输出或 shell command 仍可能请求宿主权限范围内的操作。

### 4.3 当前项目如何加载科研 package

仓库根目录的 [`.pi/settings.json`](../.pi/settings.json) 指向：

```text
../packages/science
```

因此在 `/home/wei/medpi` 作为 trusted project 运行时，Pi 会加载 `@medpi/science` 的 extension 和 `science-review` prompt。

如果你从另一个项目目录使用 Web UI，不能假设该项目自动拥有 MedPi 科研 package。请按 Pi package 机制在目标项目中显式安装或配置本地 package；不要修改 Pi core，也不要复制整个 MedHorizon runtime。

## 5. 配置模型和 Provider

点击左侧底部的 **Models** 打开模型配置窗口。配置分为托管认证 Provider 和自定义 Provider 两类。

### 5.1 OAuth 或设备码登录

1. 打开 **Models**。
2. 点击 **Add provider**。
3. 在 OAuth 区域选择目标 Provider。
4. 点击 **Login**。
5. 按页面提示完成浏览器登录、设备码验证或账户选择。
6. 如果出现手动回调输入框，将浏览器地址栏中的 redirect URL 或页面要求的代码粘贴回 MedPi。
7. 看到 **Connected successfully** 后关闭窗口。

登出时在已连接 Provider 详情中点击 **Disconnect**。OAuth credential 由 Pi 的 `AuthStorage` 管理；状态接口不会返回原始 token。

### 5.2 API-key Provider

1. 在 **Models → Add provider** 中选择 API Key Provider。
2. 输入 API key，点击 **Save**。
3. 连接状态显示为 configured 后，可以在聊天模型选择器中使用该 Provider 的模型。
4. 更换 key 时重新输入新值；删除时点击 **Disconnect**。

不要把 API key 放入 prompt、`models.json` 的截图、Git、issue 或 provenance evidence。API-key route 使用 Pi 的认证存储来保存和删除 key。

### 5.3 自定义 Provider

在 **Models → Add provider → Custom provider** 中填写：

| 字段 | 说明 |
|---|---|
| Provider name | MedPi/Pi 内部使用的唯一名称，例如 `local-openai` |
| Base URL | Provider 的 API 根地址，例如 `https://api.example.com/v1` |
| API | `openai-completions`、`openai-responses`、`anthropic-messages` 或 `google-generative-ai` |
| API Key | 可使用环境变量名、`!shell-command` 或 literal key；优先使用环境变量/secret manager |
| Model ID | Provider 返回或文档中的模型 ID |
| Name | UI 中显示的可读名称 |

可选操作：

- 点击 **Fetch models** 从 Provider 的 model-list endpoint 发现模型；
- 选择发现结果并加入当前 Provider；
- 对具体模型点击 **Test**，检查延迟、HTTP 状态和简短响应；
- 使用模型 catalog 填充 context window、max tokens、reasoning、cost 等空字段；
- 最后点击配置窗口底部的 **Save**。

配置文件位于：

```text
~/.pi/agent/models.json
```

> 自定义 Provider 的 `baseUrl` 会由服务端访问。loopback/local endpoint 适合本地开发，但在共享或公网部署前必须先配置 SSRF/egress policy；不要把任意用户输入的 URL 当作安全地址。

### 5.4 选择模型

配置保存后：

1. 打开一个新 session，或在当前 session 的模型选择器中选择 Provider/Model；
2. 根据模型能力选择 thinking level；
3. 如果模型列表为空，先检查 Provider key/OAuth、model ID 和配置是否已保存；
4. 如果看到 `enabledModels` scope warning，检查 Pi settings 中的模型匹配模式是否真的匹配 `provider/modelId`。

`GET /api/models` 返回的 `modelList` 为空只表示当前没有解析出可用模型，不代表科研 connector 出错。

## 6. 基本聊天操作

### 6.1 发送普通 prompt

在底部输入框输入问题，按 **Enter** 或点击发送按钮。使用 **Shift+Enter** 插入多行内容。

示例：

```text
请先列出当前可用的科学数据库，然后说明你准备使用哪些来源回答问题。
```

模型、thinking level 和 tool preset 会显示在输入框附近。当前 session 的 token/context 使用量和运行状态会显示在顶部区域。

### 6.2 Tool preset

输入框中的工具菜单有三个级别：

| 选项 | 启用内容 |
|---|---|
| `off` | 关闭所有 builtin 和 extension tools |
| `default` | `read`、`bash`、`edit`、`write`，以及已加载的 extension/package tools |
| `full` | `bash`、`read`、`edit`、`write`、`grep`、`find`、`ls`，以及已加载的 extension/package tools |

要使用 `science_search`、`science_inspect`、Stage 或 provenance，至少选择 `default`。选择 `off` 后，科研 tools 也会被禁用。

### 6.3 Thinking、compact 和 abort

- **Thinking level**：在模型支持时选择 `auto`、`off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`；不同 Provider 支持的级别可能不同。
- **Compact**：上下文较长时点击 compact，或输入 `/compact`，让 Pi 压缩历史上下文；压缩不会创建第二个 session store。
- **Abort**：运行中点击停止按钮，或按 `Esc`；同样可中止 bash/compaction 的当前操作。
- 浏览器刷新后，如果 session 仍在 streaming，pi-web 会尝试重新连接 SSE。

### 6.4 Steering 和 follow-up

Agent 运行期间可以输入追加消息：

- **Steer**：中断/引导当前运行，让 agent 尽快转向新的指令；
- **Follow-up**：排队到当前运行结束后再发送。

带图片的消息不能作为运行中的 steer/follow-up 排队。发送前确认当前模型支持图像输入。

### 6.5 Shell command 模式

如果输入框内容以单个 `!` 开头，MedPi 会把后续内容作为 shell command 直接执行，而不是发送给模型：

```text
!git status --short
!python --version
```

以 `!!` 开头时，命令输出会标记为不加入后续 agent context：

```text
!!git diff --stat
```

Shell command 以当前宿主用户权限运行。它没有内置 OS sandbox；不要执行来源不明的命令，不要把 secrets 作为命令参数，不要在共享服务上把它当作安全隔离机制。

### 6.6 Slash commands

在输入框输入 `/` 打开命令菜单。当前内置命令包括：

| 命令 | 用途 |
|---|---|
| `/compact [instructions]` | 压缩当前 session context，可附加压缩指导 |
| `/reload` | 重新加载当前 session 的 runtime/resources |
| `/name <name>` | 设置或修改 session 名称 |
| `/session` | 打开当前 session 的统计信息面板 |
| `/copy` | 复制最后一条 assistant message |
| `/science-review` | 调用科研证据审阅 prompt（项目资源已加载时） |

Extension、prompt 和 skill 也可能提供额外 slash command。输入部分名称后，用方向键、Tab 或 Enter 选择。

### 6.7 文件引用和图片

#### `@` 文件引用

在输入框中输入 `@`，可以从当前工作目录的文件索引中选择文件或目录：

```text
请检查 @data/results.csv，并比较其中的 control 和 treatment。
请阅读 @src/analysis.py:10-25，解释这段统计代码。
请查看 @"data/my experiment.csv"。
```

规则：

- `@` 必须位于行首或空白之后；
- 文件路径相对于当前 session cwd；
- 含空格的路径使用 `@"..."`；
- 选择目录后可以继续输入路径进行 drill-down；
- 只有允许访问的项目根/工作目录才会出现在索引中。

#### 图片附件

可以点击回形针/图片按钮、拖拽图片到输入区域，或从剪贴板添加图片。当前限制为：

- 每条消息最多 10 张图片；
- 单张图片不超过 10 MiB；
- 最终限制仍取决于 Provider 的图像能力和 context window。

## 7. 科研工具使用

科研 tools 通常通过自然语言让 agent 调用。为了减少歧义，建议明确写出工具名称和数据库 ID。

### 7.1 可用数据库

`science_list_dbs` 不访问网络，只列出当前 package 注册的来源：

| ID | 领域 |
|---|---|
| `arxiv` | 预印本/文献 |
| `crossref` | DOI 元数据 |
| `pubmed` | 生物医学文献 |
| `pubchem` | 化学 compound/性质 |
| `ensembl` | 基因组 |
| `uniprot` | 蛋白 |
| `reactome` | 通路 |
| `geo` | omics/GEO |

示例 prompt：

```text
请调用 science_list_dbs，列出可用数据库和适用领域。
```

### 7.2 `science_search`

用于搜索一个已列出的公共数据库。

主要参数：

| 参数 | 要求 |
|---|---|
| `database` | 上表中的一个 ID |
| `query` | 1–2,000 字符 |
| `limit` | 1–25，默认 10 |
| `organism` | 可选，最多 200 字符 |

示例：

```text
使用 science_search 在 pubmed 搜索 "single-cell RNA sequencing tumor microenvironment"，返回 10 条结果。
使用 science_search 在 uniprot 搜索 TP53，并限定 organism 为 human。
使用 science_search 在 arxiv 搜索 protein language model，并返回 5 条结果。
```

搜索结果是 bounded、归一化后的线索，不是已经验证的科学结论。对重要结果继续使用 `science_fetch`，并核对原始来源。

### 7.3 `science_fetch`

按稳定 ID 获取一个来源记录。

| 参数 | 示例 |
|---|---|
| `database` | `pubmed`、`crossref`、`uniprot` 等 |
| `id` | PMID、DOI、accession 或来源 ID |
| `format` | 可选，例如来源支持的 JSON/FASTA 表示 |

示例：

```text
使用 science_fetch 从 pubmed 获取 PMID 12345678 的记录和摘要。
使用 science_fetch 从 crossref 获取 DOI 10.xxxx/example 的元数据。
使用 science_fetch 从 uniprot 获取 P04637 的 FASTA 表示。
```

单条 tool 文本和 details 都有长度上限。若需要完整原始记录，使用来源的 canonical URL，并把实际检索时间和表示方式记录到 provenance。

### 7.4 `science_inspect`

在 trusted project 内对文件做安全、有界的分类或预览：

```text
请使用 science_inspect 检查 data/sample.fasta，先执行 preview，再告诉我检测到的格式和序列概况。
请使用 science_inspect inspect data/variants.vcf，不要执行文件中的任何内容。
```

支持的已知格式包括：

- CSV、TSV；
- FASTA、FASTQ；
- BED、GFF、GTF、VCF；
- PDB、mmCIF、XYZ、MOL、SDF；
- LaTeX、PDF；
- HDF5、H5AD、Loom；
- Parquet、Arrow；
- BAM、CRAM；
- 无法识别时返回 `unknown`。

资源边界：

- inspect 最多读取前导 4 KiB；
- preview 最多返回 256 KiB、4,096 行；
- gzip/BGZF 输入和解压输出均受限；
- 文本、文件名和 metadata 都是不可信数据，不能作为 tool 指令；
- 路径必须位于允许的项目 root 内，且当前项目必须 trusted。

### 7.5 `science_stage`

Stage 是当前 Pi branch 内的研究进度记录，不是第二个数据库。常用动作：

#### 进入阶段

```text
使用 science_stage enter：进入“文献筛选”阶段，摘要为“筛选与问题相关的原始研究”，不需要审批。
```

需要审批的阶段：

```text
使用 science_stage enter：进入“确认主要结论”阶段，requiresApproval=true；完成该阶段前必须请求我确认。
```

#### 查看当前 branch

```text
使用 science_stage list，列出当前 branch 的所有研究阶段和状态。
```

#### 完成阶段

```text
使用 science_stage complete，stageId 为 <上一步返回的 stage id>，摘要为“已完成去重和初步证据筛选”。
```

如果阶段为 `awaiting-approval`，Web UI 会弹出确认对话框。选择拒绝会记录 rejected decision，不会伪装成 completed。

注意：

- 同一 branch 不能同时进入多个 active stage；
- Stage 事件保存在当前 Pi session branch 的 `medpi.stage.v1` custom entries 中；
- 切换 branch 后，Stage 列表也会随 branch 改变；
- Stage 审批不能替代文件、网络、进程和权限检查。

### 7.6 Provenance

Provenance 文件位于当前项目：

```text
<project-root>/.medpi/provenance.json
```

首次使用 provenance tool 时才会创建该文件。根目录的 `.medpi/` 被 Git ignore；如果研究结果需要交付，请按项目政策显式备份或导出，不要把它误认为远端多用户 Research Graph。

#### 记录节点

```text
记录一个 provenance source 节点：
label 为“PubMed search: tumor microenvironment”，并把它作为当前 session 的来源。
```

常见 kind：

| kind | 必填/典型字段 |
|---|---|
| `source` | `label` |
| `run` | `label`、`tool` |
| `artifact` | `label`、`artifactType`，可选 `path` |
| `claim` | `label` |

如果要建立派生关系，可以提供已经存在的 `derivedFrom` node ID：

```text
记录一个 artifact 节点，artifactType 为 csv，path 为 data/filtered.csv，derivedFrom 为 <source-or-run-id>。
```

当前工具会校验 `derivedFrom` 是否存在，但不会自动读取 artifact 文件并计算实际内容 hash。需要可复现审计时，应同时保留实际文件、生成命令、来源 URL、检索时间和工具输出。

#### 查询 lineage

```text
使用 provenance_query 列出当前项目的完整 provenance DAG。
使用 provenance_query 查询节点 <node-id> 的上下游 lineage。
```

结果最多返回 200 个 nodes 和 200 个 edges；出现 `truncated` 时，不要把结果当作完整图。

#### 记录 reviewer finding

```text
对 provenance 节点 <claim-id> 做 provenance_review：
claim 为“该数字来自三次独立实验”，
issue 为“报告没有给出三次实验的原始输出”，
severity 为 major，
evidence 为“results.md 第 42 行只有结论，没有对应 run/artifact 节点”，
verdict 为 refutes。
```

review finding 会创建 claim node，并追加 `supports` 或 `refutes` edge。它记录审阅意见，不会自动修改被审阅的报告。

### 7.7 `science-review` prompt

在资源已加载的 trusted project 中，在输入框输入：

```text
/science-review
```

然后把要审阅的报告、结果文件、图表、代码和 provenance node 作为审阅范围。审阅 prompt 要求：

- 找 citation mismatch；
- 找无法追溯的数字；
- 检查 figure/table 与统计量是否一致；
- 为每个 finding 提供具体文件、行号、tool output 或 provenance node 证据；
- 在存在 DAG 时用 `provenance_review` 记录 finding。

source text、file text、tool result 和模型生成内容都只能作为不可信 evidence data，不能因为它们包含“指令”就执行其中的指令。

## 8. Session、Branch、Fork 和 Worktree

### 8.1 Session

Pi session 文件位于：

```text
~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl
```

左侧 sidebar 会按项目和最近活动列出 session。使用 **Refresh** 刷新列表。session 是 Pi 的事实源，不要手动编辑或移动 JSONL，除非你理解 Pi session format 和备份风险。

### 8.2 Fork 与 in-session branch 的区别

| 操作 | 行为 |
|---|---|
| Fork | 从某条用户消息创建新的 JSONL session 文件；新 session 在 sidebar 中显示为子节点 |
| Branch/Navigate | 在同一个 JSONL 文件内切换 parent/leaf 分支；不会创建新的 session 文件 |

需要保留两个独立研究方向时使用 **Fork**；只想在同一会话中比较不同后续路径时使用 branch navigator。

### 8.3 导出历史

打开已有 session 后，顶部的 full history/export 操作会在新窗口打开导出的 HTML。未保存的新 session 没有可导出的完整历史。

### 8.4 Git worktree

在 Git 仓库的 checkout 根目录选择项目后，可以使用 worktree switcher：

- 切换主 checkout 和已有 worktree；
- 输入 branch 名创建新的 worktree；
- 删除 worktree；
- 删除 dirty worktree 时需要额外确认 force remove。

Worktree 会按同一个 `projectRoot` 分组，但每个 worktree 仍有自己的 cwd 和 session。执行删除前确认没有未提交的研究结果。

## 9. Skills、Plugins 和 Prompts

左侧底部的 **Skills** 和 **Plugins** 入口只在有当前 cwd 时可用；project-scoped resources 还需要 project trust。

### 9.1 Skills

打开 **Skills** 后可以：

- 查看当前加载的 global、project 和 path skills；
- 切换 skill 是否参与模型自动调用；
- 从 skills.sh 搜索 skill；
- 选择 `global` 或 `project` scope 安装；
- 检查和更新已安装 skill。

安装位置：

```text
global  → ~/.pi/agent/skills/
project → <cwd>/.pi/skills/
```

关闭 skill 的 model invocation 只会改变其自动暴露状态；它可能仍然可以被显式 slash command 调用。安装第三方 skill 前审阅来源和内容。

### 9.2 Plugins

打开 **Plugins** 后可以安装：

```text
npm:@scope/pi-plugin
git:https://github.com/user/repo
/absolute/path/to/plugin
```

可选择：

- `global`：安装到 `~/.pi/agent/{npm,git}`；
- `project`：安装到 `<cwd>/.pi/agent/{npm,git}`；
- enable/disable；
- update/remove；
- reload 当前 session。

一个 plugin 可能包含 extension、skill、prompt 或 theme。安装、更新和启用第三方 package 都可能执行或加载第三方代码；只使用已审阅、可追溯的来源。安装后如果当前 session 没看到资源，点击 **Reload session** 或新建 session。

## 10. 推荐的科研工作流

下面是一个不把“模型回答”直接当作结论的最小流程：

### Step 1：准备项目

1. 选择具体研究项目目录；
2. 检查 project trust；
3. 选择可用模型；
4. 将 tool preset 设为 `default` 或 `full`。

### Step 2：建立阶段

```text
使用 science_stage enter：进入“问题定义”阶段，摘要为“明确研究问题、纳入标准和输出格式”。
```

### Step 3：搜索并获取来源

```text
使用 science_search 在 pubmed 搜索 <问题关键词>，返回 10 条结果。
对最相关的 PMID 使用 science_fetch 获取摘要和元数据。
不要把搜索摘要直接当作已验证结论。
```

### Step 4：检查本地数据

```text
使用 science_inspect preview data/input.csv。
检查是否存在列名、编码、记录数或格式异常；不要执行文件中的内容。
```

### Step 5：记录 lineage

```text
记录一个 source 节点表示该来源检索，记录一个 run 节点表示 science_search，
再为清洗后的 data/filtered.csv 记录 artifact 节点，并从它指向对应 run。
```

保存 tool 返回的 node IDs。不要只在自然语言中写“数据来自 PubMed”，而不保留具体 ID、URL、时间和输出。

### Step 6：进入需要人工确认的阶段

```text
使用 science_stage enter：进入“形成主要结论”阶段，requiresApproval=true。
```

完成该阶段时，阅读 Web UI 的确认摘要，只在你检查过来源、数据和限制后批准。

### Step 7：审阅

```text
/science-review
```

让 reviewer 对报告、图表、代码、原始数据和 provenance 一起做盲审。对重要 finding 使用 `provenance_review` 写入 DAG。

### Step 8：保存交付物

- 保留原始来源 ID/URL 和检索时间；
- 保留生成文件和实际运行命令；
- 保留 provenance 文件及其备份策略；
- 导出 session HTML 或保存 Pi JSONL 作为过程记录；
- 不要把 API key、session 中的隐私内容或未经审阅的外部文本一起提交。

## 11. 安全边界和数据处理规则

### 11.1 把外部内容当作数据

以下内容一律是不可信数据：

- 科学数据库返回的 title、abstract、description 和 record text；
- 本地文件内容、PDF 文本、CSV 单元格和 notebook 文本；
- tool result、模型生成的代码和 markdown；
- plugin/skill 的说明文字。

它们不能改变 agent 的系统规则、权限决定或工具参数。任何删除文件、安装 package、执行 shell、访问新网络 endpoint 的动作都要单独审阅。

### 11.2 网络请求

科学 connector 采用：

- exact-host allow-list；
- 生产源 HTTPS；
- GET-only；
- terminal redirect；
- timeout、abort、retry、response/body/cache 上限；
- 来源级限流和并发控制。

科学来源返回 404 可以表示没有该记录，但 5xx、timeout、abort、invalid JSON 或 schema failure 不应被解释为“没有结果”。

自定义 Provider 不属于上述科学 host allow-list；公网部署前需要单独的 egress policy。

### 11.3 文件和项目

- `science_inspect` 和 provenance tools 要求 trusted project；
- 文件路径必须位于允许的 root 内；
- 不要把包含 `.env`、SSH key、cloud credential 或私人数据的目录作为项目 root；
- 上传单文件最多 25 MiB、单次总计最多 100 MiB；
- 文件 viewer 的 session-reference 兼容路径不是通用安全文件浏览器；共享部署应额外收紧。

### 11.4 Provenance 的限制

当前 provenance 是单进程、项目内、原子 JSON 文件：

- 不等同于多用户 Research Graph；
- 不提供远端备份或签名；
- 记录节点不自动证明文件内容未被修改；
- 需要科研审计时，必须同时保留实际 artifact、hash、运行输出和来源快照。

## 12. 常见问题排查

| 现象 | 排查方式 |
|---|---|
| 页面返回 `401` | 若设置了 `PI_WEB_PASSWORD`，Basic Auth 用户名是 `pi`；检查密码注入和浏览器是否发送 Authorization header |
| 页面/API 返回 `403 Untrusted request` | 使用 `127.0.0.1` 或受允许的 Host/Origin 打开页面；不要从未知跨域页面调用 API |
| 侧边栏没有项目 | 选择已有项目、Use default directory，或在 Custom path 中输入路径并先点击 Go |
| 科研 tools 不出现 | 确认项目 trusted、tool preset 不是 `off`、当前 session 已 reload/新建，并检查 package 是否从 `/home/wei/medpi/.pi/settings.json` 加载 |
| `/science-review` 不在菜单 | 先完成 project trust，再 reload session；确认当前项目加载了 `packages/science/prompts/science-review.md` |
| `science_inspect` 或 provenance 返回 forbidden | 当前项目必须 trusted，路径必须在当前允许的 project root 内 |
| 模型列表为空 | 在 Models 中配置 OAuth/API key 或 custom provider，添加至少一个 model，点击 Test 后 Save；再刷新或新建 session |
| 模型 Test 失败 | 检查 Base URL、API 类型、model ID、key 来源和 Provider 的网络可达性；不要把任意错误文本当作科学结论 |
| 端口 `30141` 已占用 | 使用 `npm --workspace @medpi/web run dev -- -p 30142`，不要直接杀掉不属于本次运行的 `next-server` |
| `npm test` 报找不到 `jiti`/`tsc`/`eslint` | 删除不完整依赖后运行 `npm ci --include=dev --registry=https://registry.npmjs.org` |
| 项目级 skill/plugin 选项不可用 | 选择有效 cwd 并完成 project trust；global scope 不需要项目资源加载 |
| 安装 plugin 后当前对话看不到它 | 在 Plugins 中点击 **Reload session**，或创建新 session；同时检查 package diagnostics |
| 文件上传被拒绝 | 确认目标目录是允许 root、文件名不包含路径分隔符、单文件/总大小没有超限 |
| 外部来源返回 503/timeout | 保留错误信息并稍后重试；不要把暂时失败解释成零结果，可使用 canonical source URL 复核 |
| session 刷新后状态不完整 | 等待 SSE reconnect 和状态 reconciliation；侧边栏点击 Refresh，必要时从历史 session 重新打开 |

## 13. 验证和维护命令

在仓库根目录运行：

```bash
# 全部测试
npm test

# 分开运行
npm run test:science
npm run test:web

# 类型和 lint
npm run typecheck
npm run lint

# 开发依赖和生产依赖审计
npm audit --include=dev
npm run audit
```

当前根级测试、typecheck、lint 和 audit 是本地开发质量门。真实模型、真实浏览器、live connector contract 和 production deployment 仍需单独验证。

## 14. 相关文档

- [README](../README.md)：安装、命令和项目定位；
- [科研迁移审阅](science-platform-migration.md)：能力边界、来源清单、威胁模型、排除项和后续路线；
- [MedPi Agent Notes](../AGENTS.md)：开发约束；
- [pi-web upstream boundary](../apps/web/UPSTREAM.md)：pi-web `v0.8.6` 来源和 MedPi 偏差；
- Pi 官方文档：[`packages`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/docs/packages.md)、[`extensions`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/docs/extensions.md)、[`security`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/docs/security.md)。

## 15. 当前不建议做的事情

- 直接把 `dev:lan` 暴露到公网；
- 让任意用户配置任意 Provider URL；
- 把整个 home 或根文件系统加入项目访问范围；
- 安装未经审阅的 plugin/skill；
- 把外部 source text 当作操作指令；
- 绕过 `science_run` 新增未审计的代码执行入口，或复制旧 MedHorizon kernel/notebook 目录；
- 重新引入 R kernel、notebook UI、MCP、Research Graph 或 subagent scheduler；
- 为了功能数量复制第二套 session、tool、permission、artifact 或 provenance runtime。
