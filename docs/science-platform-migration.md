# MedPi 科学研究平台最小迁移审阅

> 状态：**可加载、可测试且完整/production dependency audit 均为零的最小 Pi 科研 package；尚不是完整科研产品，也未完成公开部署验证。**  
> 审阅基线：MedHorizon `v0.3.21` (`1d36548ca35f4e8430bc03ce54feb1268b5b15e6`)、pi-web `v0.8.6` (`dfab5853b8d2f717df259e7ebc94f49a3c2e43e7`)、Pi `v0.84.1` (`53fa77ccd8a279eb87e92294ef3687b03ff80112`)。  
> 本文是本仓库的科研迁移事实源；不能据此宣称 Worker/Gateway、专用 React viewer 或真实模型浏览器链路已经完成。面向使用者的安装和操作步骤见 [`docs/userguide.md`](userguide.md)。

## 1. 结论

MedHorizon 相对原生 Pi + pi-web 最有价值的优势，不是另一套 agent/session/UI runtime，而是以下科研领域能力：

1. 面向公共科学数据库的统一连接器；
2. 科学文件格式识别、风险分级和专用 viewer 路由；
3. 可审计的 Research Stage 与人工审批门；
4. source/run/artifact/claim provenance 与证据审查；
5. Python/R notebook kernel；
6. Research Graph/GEPA、科研 reviewer、专家代理和大量科研 skills。

本次只迁移前四项中已有直接 Pi 消费方、依赖闭包小且安全边界可以独立成立的最小部分：

- 8 个公开、免密科学数据库；
- 22 种已知科学格式加 `unknown` 的有界识别/预览；
- 基于 Pi JSONL 当前分支自定义事件的 Stage/HITL；
- 项目内轻量、内容寻址的 provenance DAG 和 reviewer prompt。

没有复制旧 MedHorizon CLI、agent/session/server、Solid/Atlas UI、Research Graph sidecar、kernel、MCP、账户/计费、完整 skills 或重型 viewer。它们目前没有 MedPi 消费方，或者缺少独立 sandbox/permission owner；复制只会形成第二套事实源和不可维护的依赖闭包。

## 2. 两端优势与边界

### 2.1 Pi + pi-web 应继续作为平台主干

| 能力 | Pi + pi-web 的现有优势 | 迁移结论 |
|---|---|---|
| Agent runtime | Pi `AgentSession`、模型切换、thinking、compaction、steer/follow-up、SDK/RPC/JSON 模式 | 不复制 MedHorizon agent/session runtime |
| Session | JSONL v3 树、branch/fork/clone、当前分支上下文 | Stage 只写 Pi 自定义 entry，不建立第二个 session store |
| 扩展生态 | TypeScript extensions、tools、commands、events、prompt templates、skills、packages、themes | 科研能力实现为普通 Pi package，不 fork Pi core |
| Web 工作区 | React/Next.js、session sidebar、SSE 状态、模型/Provider、Skills/Plugins、worktree、文件预览、附件、diff | `apps/web` 作为唯一 Web 壳；不复制 Solid/Atlas 壳 |
| 项目信任 | pi-web project trust 与同源/API 安全检查 | 项目文件和 provenance 工具额外检查 `ctx.isProjectTrusted()` |
| 上游升级 | Pi 与 pi-web 可按明确基线更新 | 科研领域代码与 Pi 类型隔离，仅 extension glue 依赖 Pi API |

### 2.2 MedHorizon 更强的科研模块

以下结论基于固定 commit 的静态源码审计；未在本次迁移中重新声明所有旧功能都已通过浏览器端到端验证。

| 科研模块 | MedHorizon 证据与优势 | 原生 Pi + pi-web 差距 | 本次决策 |
|---|---|---|---|
| 科学数据库连接器 | `backend/cli/src/science/connectors/` 有 41 个具体实现，覆盖文献、化学、基因组、蛋白、通路和 omics；统一 search/fetch contract | Pi 可调用通用网络工具，但没有这套领域归一化、来源目录和限流语义 | **迁移最小 8 个** |
| 科学文件路由 | `backend/cli/src/file/science.ts` 有格式 manifest、magic/extension 判定和 read policy | pi-web 有通用文件 viewer，但不理解 HDF5/H5AD、FASTQ、VCF、PDB 等科学语义 | **迁移识别与有界文本预览** |
| 专用科学 viewer | `frontend/workspace/src/science/renderers/` 含 Sequence/MSA、GenomeTrack、RDKit 2D、Mol* protein、LaTeX、PDF 等 | pi-web 的通用 image/PDF/text/markdown 预览不能替代结构、生信和化学可视化 | **暂不复制**；没有 React 消费方和性能预算 |
| Python/R notebook | `science/kernel/*`、`tool/notebook.ts`、`tool/rkernel.ts` 具有生命周期和工具入口 | Pi 的 bash 能执行程序，但不是 notebook kernel、安全沙箱或资源治理层 | **不复制旧实现**；已建最小沙箱闭环（`science_run`/`science_rollback`，任意代码可执行）；notebook UI 等真实需求出现时再按 `science_run` 边界加 |
| Research Stage/HITL | `session/stage.ts` 与旧 StagesPanel 支持研究阶段、审批和落地 | Pi 有通用交互/UI hooks，但没有科研阶段状态机 | **迁移状态语义**，UI 先用普通 tool result |
| Provenance | `science/provenance/store.ts`、`review.ts`、`tool/provenance.ts` 建模 source/run/artifact/claim 和 evidence edges | Pi session 能记录 tool call，但不等于跨工件科研 lineage | **迁移轻量项目 DAG** |
| 科研审查 | reviewer prompt、Aletheia/专家代理与 evidence-oriented workflows | Pi 有 prompt/skill 机制，但没有 MedHorizon 的科研审查内容 | **迁移一个最小 reviewer prompt**；不复制代理 runtime |
| Research Graph/GEPA | 独立 `research-graph/` 包含 FastAPI/SQLite、图 API、实验、GEPA、embedding、前端 canvas 和 sidecar | Pi session tree 不是科研知识图，也不提供 GEPA 实验管理 | **推迟**；当前本地 DAG 足以服务 3 个 provenance tools |
| 科研 skills/专家代理 | 旧仓库有 293 个 `SKILL.md`，并有文献综述、评价和实验 critic | Pi 的 skills 生态更通用、分发更好，但未内置该领域内容 | **不整目录复制**；按真实研究任务逐个引入 |
| 科研安全策略 | `PermissionNext`、process policy/redaction、Question、MCP、sidecar supervisor 等形成较完整旧 runtime 边界 | Pi 有 project trust 与扩展机制，但 Stage 不是进程/网络权限系统 | **不复制第二套 runtime**；本 package 只承担自身文件/网络边界 |
| 项目 Artifact/Evidence UI | MedHorizon 有 artifact、Research Graph 和 science artifact UI 的多处实现 | pi-web 未有同等科研 evidence projection | **推迟**；先冻结唯一 provenance/artifact 事实源 |
| 账户、GPU、计费、Atlas managed UI | MedHorizon 集成了托管产品能力 | 与本地科研 package 无关 | **明确排除** |

## 3. 本次选择的最小垂直切片

### 3.1 唯一运行链

```text
trusted project
  └─ .pi/settings.json
      └─ @medpi/science Pi package
          ├─ extension tools
          │   ├─ curated connector registry ──HTTPS──> 7 exact public hosts
          │   ├─ bounded project-file inspector
          │   ├─ branch-local Pi custom stage entries
          │   └─ .medpi/provenance.json
          └─ prompts/science-review.md

apps/web (editable pi-web source)
  └─ existing Pi runtime/resource loader/tool-result UI
```

没有 Browser → 旧 Bun Gateway → 旧 MedHorizon session 的并行链路。`packages/science/src` 不导入 Pi；所有 Pi 类型和注册行为仅位于 `packages/science/extensions/index.ts`。

### 3.2 当前 8 个工具

| Tool | 当前消费的实现 | 输出/副作用 |
|---|---|---|
| `science_list_dbs` | connector registry | 列出固定目录，无网络 |
| `science_search` | 8 个 connector + bounded HTTP | 归一化、裁剪后的 hit；不保留 source-specific `extra` |
| `science_fetch` | connector fetch | 单条来源记录，tool 文本最多 30,000 字符，details 最多 8,000 字符 |
| `science_inspect` | `ScienceFile.inspect/preview` | 仅 trusted project；有界文件读取 |
| `science_stage` | Pi branch custom entries + `deriveStages` | append-only session entry；审批使用 `ctx.ui.confirm` |
| `provenance_record` | `ProvenanceStore` | trusted project 内原子更新 `.medpi/provenance.json` |
| `provenance_query` | `ProvenanceStore.query` | tool 层最多返回 200 nodes + 200 edges |
| `provenance_review` | `ProvenanceStore.review` | 追加 supports/refutes finding 和 edge |

`prompts/science-review.md` 由 Pi prompt loader 消费，不额外注册 agent 或 scheduler。

### 3.3 数据源选择

| ID | 领域 | Host | 选择理由 |
|---|---|---|---|
| `arxiv` | 文献/预印本 | `export.arxiv.org` | 开放、免 key；覆盖物理、数学、CS、quantitative biology |
| `crossref` | DOI 元数据 | `api.crossref.org` | 跨出版社基础元数据；移除了旧产品联系邮箱 |
| `pubmed` | 生物医学文献 | `eutils.ncbi.nlm.nih.gov` | PMID/abstract 的基础入口 |
| `pubchem` | 化学 | `pubchem.ncbi.nlm.nih.gov` | compound ID、结构和属性 |
| `ensembl` | 基因组 | `rest.ensembl.org` | symbol/stable ID 查询 |
| `uniprot` | 蛋白 | `rest.uniprot.org` | 蛋白序列与功能注释 |
| `reactome` | 通路 | `reactome.org` | curated pathway/reaction |
| `geo` | omics | `eutils.ncbi.nlm.nih.gov` | GEO Series/DataSet/Platform |

这 8 个源覆盖首轮 literature → entity → pathway/omics 研究链，全部可匿名 HTTPS 访问。其余 33 个旧 connector 没有当前 tool/UI 的新增需求，不复制。尤其没有在缺少临床验证、许可审阅或 API credential owner 时迁移临床/商业数据源。

## 4. 精确迁移清单与当前消费方

### 4.1 运行时代码

| MedPi 文件 | MedHorizon 来源 | 主要适配 | 当前消费方 |
|---|---|---|---|
| `packages/science/extensions/index.ts` | 新 MedPi glue；参考 Pi extension API | 注册 10 tools；输入上限、project trust、branch events、HITL、sandbox run/rollback 和输出裁剪 | Pi `DefaultResourceLoader`、`.pi/settings.json` |
| `packages/science/src/files.ts` | `backend/cli/src/file/science.ts` | 去除旧 server/UI 依赖；改为 Node file handle；realpath root、`O_NOFOLLOW`、gzip 输出上限 | `science_inspect` |
| `packages/science/src/workflow.ts` | `backend/cli/src/session/stage.ts` | 去除旧 Session/Bus/Snapshot；用 Pi custom entry 纯推导；强化 gate/terminal invariant | `science_stage` |
| `packages/science/src/provenance.ts` | `science/provenance/store.ts` + `science/provenance/review.ts` | 合并为单文件本地 store；完整 SHA-256 ID；大小上限；0600 原子写 | 3 个 `provenance_*` tools |
| `packages/science/src/connectors/types.ts` | `science/connectors/types.ts` | contract 缩到已选领域；移除无消费方 params/extra/registry API | registry 与 8 connectors |
| `packages/science/src/connectors/http.ts` | `science/connectors/http.ts`；参考 `server/host-guard.ts` | 去旧 settings；固定 host、HTTPS、GET-only、禁止 redirect、timeout/abort/retry、响应和 cache 上限、NCBI 限流 | 所有 connectors |
| `packages/science/src/connectors/json.ts` | 新的防御性适配层 | `unknown` JSON 的 record/array/string/number narrowing；不使用 `any` | Crossref、PubMed、PubChem、Ensembl、GEO、Reactome、UniProt |
| `packages/science/src/connectors/index.ts` | `science/connectors/index.ts` | 只注册选中的 8 个实现 | `science_list_dbs/search/fetch` |
| `packages/science/src/connectors/literature/arxiv.ts` | 同名来源 | 保留 Atom 解析与 3 秒 source rate limit；输出裁剪 | registry |
| `packages/science/src/connectors/literature/crossref.ts` | 同名来源 | 防御性 JSON；删除旧 MedHorizon 产品邮箱；search 只请求所需字段 | registry |
| `packages/science/src/connectors/literature/pubmed.ts` | 同名来源 | 防御性 JSON；NCBI 350ms/单并发；仅 404 可退化为无 abstract | registry |
| `packages/science/src/connectors/literature/shared.ts` | 同名来源 | 只保留 arXiv/Crossref 实际使用的 XML/text helpers | arXiv、Crossref |
| `packages/science/src/connectors/chemistry/pubchem.ts` | 同名来源 | 防御性 JSON；NCBI 限流；只保留归一化 hit 字段 | registry |
| `packages/science/src/connectors/genomics/ensembl.ts` | 同名来源 + 原 genomics util 的少量语义 | 404 才 fallback；abort/5xx 不再伪装成空结果 | registry |
| `packages/science/src/connectors/omics/geo.ts` | 同名来源 | 防御性 JSON；NCBI 限流；source failure 向 tool 暴露 | registry |
| `packages/science/src/connectors/pathways/reactome.ts` | 同名来源 | 防御性 JSON；只在 404 时返回空值 | registry |
| `packages/science/src/connectors/pathways/util.ts` | 同名来源 | 仅保留 Reactome 所需 clamp/text/tag helpers | Reactome |
| `packages/science/src/connectors/proteins/uniprot.ts` | 同名来源 | 防御性 JSON；组织过滤整体 URL encode；只保留 hit 所需字段 | registry |
| `packages/science/src/connectors/proteins/util.ts` | 同名来源 | 删除 structure connector 与 opaque extra 所需 helper | UniProt |
| `packages/science/src/sandbox/index.ts` | 新；设计见 `docs/plan/00-sandbox.md` | 沙箱公共导出 | `science_run` / `science_rollback` |
| `packages/science/src/sandbox/types.ts` | 新 | provider 契约 | sandbox 实现 |
| `packages/science/src/sandbox/process.ts` | 新 | 进程组 spawn/abort + 日志落盘 | `none` / `bwrap` |
| `packages/science/src/sandbox/none.ts` | 新 | 默认无沙箱提供方（宿主权限） | `createSandbox("none")` |
| `packages/science/src/sandbox/bwrap.ts` | 新 | Linux 可选 bwrap；全盘只读 + 项目/环境可写 | `createSandbox("bwrap")` |
| `packages/science/src/sandbox/run-dir.ts` | 新 | `.medpi/runs/<id>/` 隔离目录 | runner / rollback |
| `packages/science/src/sandbox/runner.ts` | 新 | 编排 checkpoint → spawn → provenance audit | `science_run` |
| `packages/science/src/sandbox/rollback.ts` | 新 | git 存档点 + `git reset --hard` + 清隔离目录 | `science_rollback` |
| `packages/science/src/sandbox/permission.ts` | 新 | 唯一 permission owner；默认 auto-allow，可切 confirm | `science_run` |
| `packages/science/src/sandbox/factory.ts` | 新 | provider 工厂 | `science_run` |

### 4.2 Prompt、配置和测试

| MedPi 文件 | 来源/性质 | 当前消费方 |
|---|---|---|
| `packages/science/prompts/science-review.md` | 从 `agent/prompt/reviewer.txt` 最小改写 | Pi prompt loader |
| `packages/science/package.json` | 新 package manifest | npm workspace、Pi package loader |
| `packages/science/tsconfig.json` | 新 | `npm run typecheck` |
| `packages/science/LICENSE` | Apache-2.0 | 许可证边界 |
| `packages/science/test/connectors.test.mjs` | 新；行为参考旧 HTTP tests | Node test runner；真实本地 HTTP transport |
| `packages/science/test/extension.test.mjs` | 新 | 真实 Pi `DefaultResourceLoader` |
| `packages/science/test/files.test.mjs` | 新 | 文件 magic/budget/symlink/gzip 行为 |
| `packages/science/test/provenance.test.mjs` | 新 | 实际临时目录和真实文件 store |
| `packages/science/test/workflow.test.mjs` | 新 | branch event 状态机和 gate invariant |
| `packages/science/test/sandbox.test.mjs` | 新；真实 FS/进程，不 mock | none/audit/abort/rollback/permission；bwrap 不可用时 skip |
| `docs/plan/00-sandbox.md` | 新；已确认决策 | 实现与验收依据 |

### 4.3 已主动删除的无消费方内容

为满足“不要复制无消费方代码”，审阅期间又删除了：

- `packages/science/src/index.ts` 和 package library exports：当前唯一入口是 Pi package，不伪造未使用的公共 SDK；
- file manifest 中未被 inspector 返回的 MIME metadata；
- 未使用的 tail-read、record/DOM/browser budgets 和无效的 post-hoc parse deadline；
- connector 的 opaque `extra`、未使用 params、domain 和 registry methods；
- 通用任意 `RequestInit`/POST API、公开 raw response wrapper 和无消费方 cache clear；
- search 中不再输出的 source-specific raw payload。

当前每个迁移 runtime 文件都能追溯到 extension、registry 或其直接依赖；测试和配置分别由根级质量命令消费。

## 5. 科学文件最小能力

已知格式：CSV、TSV、FASTA、FASTQ、BED、GFF、GTF、VCF、PDB、mmCIF、XYZ、MOL、SDF、LaTeX、PDF、HDF5、H5AD、Loom、Parquet、Arrow、BAM、CRAM；此外有 `unknown` fail-safe。

当前不是深度 parser 或 viewer：

- magic 优先于 extension；当前 magic 覆盖 HDF5、PDF、Parquet、Arrow、CRAM；
- H5AD/Loom 只确认 HDF5 container，明确警告没有 deep parse；
- BAM/CRAM、HDF5、Parquet、Arrow 等 binary 返回 metadata-only；
- genome/structure/sequence text 只返回 bounded text，不宣称已有 IGV/Mol*/RDKit/MSA React viewer；
- inspect 读取最多 4 KiB leading bytes；preview 最多读取/返回 256 KiB、4096 行；
- gzip/BGZF 只处理有界输入，解压输出达到 256 KiB 后立即销毁 stream；
- 路径必须 realpath 落在 trusted project root 内，final file open 使用 `O_NOFOLLOW`；
- magic 不认识且含 NUL 的内容 fail closed 为 binary metadata。

## 6. Stage 与 provenance 事实源

### 6.1 Stage

- event type 固定为 `medpi.stage.v1`；
- 状态只由 Pi 当前 branch 的 custom entries 推导，不另建数据库；
- `entered`、`decision`、`completed` append-only；
- gated stage 未出现 approved decision 时，伪造/乱序 `completed` 会被忽略；
- completed/rejected 是 terminal，后续 event 不得改写；
- 用户拒绝保留为 terminal evidence；
- Stage 只是研究流程语义，**不是** path/network/process/tool permission boundary。

### 6.2 Provenance

- 文件：`<project>/.medpi/provenance.json`（被 `.gitignore` 排除）；
- node：`source | run | artifact | claim`；
- edge：`produced | consumed | derived-from | supports | refutes`；
- ID：canonical payload 的完整 SHA-256（64 hex）；
- node/edge 输入分别限制为 64 KiB/16 KiB；graph load 上限 16 MiB；
- tool query 限制为 200 nodes + 200 edges；
- 保存使用同目录临时文件、`0600` 和 rename；同一进程内写操作串行；
- reviewer finding 被记录为 claim node，再连到 target。

它是本地、单进程、轻量 DAG，不是密码学签名账本，也不是 Research Graph sidecar 的多用户/搜索/embedding/GEPA 替代品。多进程并发锁、fsync durability、签名和远端复制仍未实现。

## 7. 安全审阅

### 7.1 威胁模型

| 边界/攻击面 | 控制 | 剩余风险 |
|---|---|---|
| 模型生成的 database/query/id | TypeBox enum、长度和整数上限；connector 只拼接 `encodeURIComponent`/`URLSearchParams` | 公共来源可返回错误或恶意科研文本；结果只是 data，不应视作 agent 指令 |
| SSRF/redirect | 7 个 exact `URL.host` allow-list；生产 source 仅 HTTPS；HTTP 仅测试 loopback；redirect=`error` | DNS/上游基础设施仍在来源运营方控制；没有独立 egress proxy |
| 大响应/慢响应 | 30s 整体 timeout（含排队/重试）、AbortSignal、最多 2 retries、4 MiB body、16 MiB 总 cache 上限、只缓存 ≤256 KiB entry | 一次允许的 4 MiB fetch 仍会进入内存；没有跨进程配额 |
| 来源限流 | arXiv 3s；NCBI/PubChem 350ms 且单并发；per-host scheduler | 其他来源只依赖 timeout/retry，没有集中式配额服务 |
| 缓存混淆 | cache key 包含 URL 和 Accept；404/5xx 不缓存；redirect 不跟随 | 仅进程内 FIFO cache，不是可验证数据快照 |
| 外部 schema 漂移 | JSON 从 `unknown` 防御性 narrowing；非 JSON 明确报错；5xx 不伪装成“0 results” | 字段缺失会产生较少 metadata；尚无 live source contract CI |
| 项目文件 path traversal/symlink | tool 要求 project trust；realpath root containment；final open `O_NOFOLLOW`；有界读取 | trusted project 内有写权限的并发进程仍可能制造目录级 TOCTOU；不是 OS sandbox |
| gzip bomb | compressed input 和 decompressed output 双重上限；到上限销毁 zlib stream | 本地 zlib/Node 漏洞仍属于依赖/运行时风险 |
| Provenance 磁盘 DoS/篡改 | payload/graph/query 上限、0600、原子 rename、同进程串行 | 项目用户可直接编辑文件；无签名、fsync 和跨进程 lock；`.medpi` 目录不应指向不受信路径 |
| Stage gate bypass | schema bounds、approved-before-complete、terminal invariant、interactive confirm | 不能限制 Pi 的其他 tools；恶意 extension 仍属于 trusted code |
| Prompt injection | tool guideline 明确把 source text 视作 untrusted data；review prompt 要求引用 evidence | LLM guideline 不是强隔离；高风险行动仍需独立 permission owner |
| 凭据 | 8 个源均免 key；仓库不含 `.env`、auth/session/runtime data；Crossref 不冒用旧项目邮箱 | pi-web/Provider 凭据仍由 Pi 自己管理，不属于 science package |
| Web 暴露 | 继承 pi-web same-origin、Host/DNS-rebinding、project trust 和可选密码保护 | 不应无密码暴露到 LAN/Internet；本次未做 TLS/reverse-proxy 部署验证 |

### 7.2 依赖审计结果：已修复

执行：

```bash
npm audit --registry=https://registry.npmjs.org --include=dev
npm audit --registry=https://registry.npmjs.org --omit=dev
npm audit signatures --registry=https://registry.npmjs.org
```

结果：完整依赖和 production 依赖均为 `found 0 vulnerabilities`；显式 `--include=dev` 的当前安装中 1,311 个包通过 registry signature 验证，其中 249 个有 provenance attestation。`npm ci --include=dev --registry=https://registry.npmjs.org` 也已完成干净安装。

修复将四个直接 Pi runtime package 一致升级为 `0.84.1`：

- `@earendil-works/pi-agent-core`；
- `@earendil-works/pi-ai`；
- `@earendil-works/pi-coding-agent`；
- `@earendil-works/pi-tui`。

Pi `0.84.1` 官方 changelog 明确将 packaged `undici` 更新到 `8.9.0`、`brace-expansion` 更新到 `5.0.9`，覆盖此前 audit 报告的 advisories。来源：[`v0.84.1` changelog](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/CHANGELOG.md)。当前 lock 中不再存在 Pi `0.83.0` entry。

升级暴露并修复了两个真实兼容点：

1. Pi AI 的 normalized provider login interaction 现在要求 concrete `AbortSignal`；API-key route 传入 `req.signal`，使客户端取消可以传播到 provider login。来源：[`ProviderAuthInteraction`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/ai/src/auth/types.ts)；
2. `Theme` constructor 新增 fullscreen scrollbar background fallback；pi-web 的 headless plain-text theme 现在提供空的 `selectedBg`，同时继续覆盖所有 ANSI 渲染方法。

同时保留并验证：

- pi-web 直接 `undici`：`8.10.0`；
- Next `postcss` override：`8.5.26`；
- Next `sharp` override：`0.35.3`。

依赖漏洞阻塞已经解除，但 Pi 官方安全说明明确 project trust 不是 sandbox，extensions 和 built-in tools 仍以宿主用户权限运行。来源：[`Pi Security — No Built-in Sandbox`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/docs/security.md#no-built-in-sandbox)。公开或无人值守运行仍需 OS/container 隔离、最小凭据和网络策略。

### 7.3 当前复核仍遗留的问题

以下项目不是当前本地开发切片的失败项，但在 hostile、共享或公开部署前必须处理：

| 等级 | 遗留项 | 当前判断与处理方向 |
|---|---|---|
| P0（公开部署） | 自定义 Provider 的 SSRF/egress 边界 | `/api/models-config/discover` 和 `/api/models-config/test` 为支持用户自定义模型而接受任意 `baseUrl`；它们不是科学 connector 的 exact-host policy，服务端可能访问内网地址或跟随上游 redirect。公开部署前必须采用显式 egress allow-list/DNS 解析与私网拒绝/固定 IP 或隔离代理；否则应关闭这两个功能。 |
| P0（公开部署） | Web 暴露和权限模型 | 当前只有可选 Basic Auth、Host/Origin 检查和 project trust；没有 TLS/reverse-proxy、全局安全 headers、认证限流、租户隔离或 OS sandbox。Pi 官方的 project trust 不是 sandbox；`dev:lan` 不能视为生产部署方案。 |
| P0（公开部署） | 文件 API 的 session-reference 兼容路径与 TOCTOU | 为显示会话中引用的附件，`/api/files` 允许 session-referenced path 越过普通 allowed-root 检查；在单用户本地假设下是兼容行为，在 hostile/public 环境可能变成任意可读文件泄露，且 stat/open 之间仍有 symlink race。公开部署前应限制到 session cwd/project root 或单独确认并使用 descriptor-based open。 |

> **P0 搁置说明（2026-08-08）**：当前 MedPi 的部署形态为**各台电脑本地单机部署**——单用户、单进程、仅本机访问，不暴露到局域网或公网。因此以上三条 P0 项（自定义 Provider 的 SSRF/egress 边界、Web 暴露与权限模型、文件 API 的 session-reference 兼容路径与 TOCTOU）在本地场景下不构成实际攻击面，**暂时搁置（deferred）**，现阶段不处理。触发重新评估的硬条件：一旦出现公网/局域网（含 `dev:lan`）暴露、多用户共享、无人值守运行，或把服务部署到他人机器的需求，三条 P0 必须在上线前逐条解决。P1/P2/P3 不受本说明影响，仍按各自优先级推进（P1 的部分搁置见下方说明）。
| P1 | 请求体、错误和流资源治理 | 多个 Web JSON route 仍没有统一 body cap、错误 redaction 或认证 rate limit；SSE/OAuth/file-watch 需要 browser disconnect、重复 cleanup 和异常 enqueue 的行为测试；OAuth callback token 仍应改为 crypto-random 并增加 TTL/max-entry。应先建立统一 request budget、generic client error + server-side redacted log 和连接配额。 |
| P1 | 多进程/横向扩展 | AgentSession registry、running broadcaster、connector cache/rate limiter 和 provenance queue 都是单 Node 进程内状态；多 worker/容器需要 sticky ownership 或独立 session/queue/lock 服务，不能直接水平扩容。 |
| P1 | 可重复交付 | 当前 `git ls-files` 仍为 0、没有 CI/branch protection，也没有 production build 验证；首个受审 baseline、`npm ci`、版本一致性、audit、secret scan 和（允许时）release build 应成为 CI gate。 |
| P1 | 真实来源与模型验证 | 当前已验证真实本地 HTTP transport 和本地 OpenAI-compatible fake-provider vertical smoke，但尚未验证真实模型凭据、真实 429/schema drift、Chrome DOM/console/network/SSE reconnect/accessibility。 |

> **P1 部分搁置说明（2026-08-08）**：本应用面向**个人用户**——单用户、单进程、本地使用，不暴露给其他请求方。因此以下两条 P1 项**暂时搁置（deferred）**，现阶段不处理：
>
> - **P1-1 请求体、错误和流资源治理**：统一 body cap、错误 redaction、认证 rate limit、连接配额以及 OAuth/SSE/file-watch 的 disconnect/cleanup 行为测试，主要防御的是 hostile/共享/多用户环境下的滥用与资源耗尽；个人本地单用户使用没有恶意或并发请求源，不构成实际风险，可随真实需求出现再补。
> - **P1-2 多进程/横向扩展**：个人单进程使用不存在多 worker/容器水平扩容需求；AgentSession registry、running broadcaster、connector cache/rate limiter 与 provenance queue 的单进程约束在可见范围内不构成问题。
>
> 触发重新评估的硬条件：出现多用户共享、服务化部署（把应用放到服务器/容器供他人访问），或对 Web 接口健壮性提出明确要求时，两条 P1 应恢复推进。**P1-3（可重复交付：git 建档 + CI）与 P1-4（真实来源与模型验证）不受本说明影响，仍建议按原优先级推进**——前者保护个人代码资产不丢失，后者在开始真实使用模型与数据源时自然需要。
| P2 | 科研产品消费层 | 目前 tool details 没有专用 React renderer；科学文件仍主要是 bounded text/metadata，binary 格式没有 deep parser/viewer。只有真实用例证明需要时再逐个添加 renderer，并冻结 bundle/WASM/worker/large-file 预算。 |
| P2 | Provenance durability | 当前 DAG 是单进程原子 JSON 文件；仍无多进程 lock、fsync、签名、远端备份、快照/回放和版本迁移。规模或审计要求出现前不要引入第二个 graph store。 |
| P3 | 任意代码与重型编排 | 最小沙箱闭环已落地（`science_run`/`science_rollback`：默认 none、可选 bwrap、permission owner、audit、abort、rollback；资源无限；redaction 按方案跳过）。R kernel、notebook UI、MCP sidecar、Research Graph/GEPA 和 subagent scheduler 仍禁用；勿复制旧 MedHorizon kernel 目录。 |

另外，任何曾在本地日志或会话输出中暴露的 Web/API 凭据都必须按已泄露处理并轮换；仓库和本文不记录凭据值。

## 8. pi-web 源码边界

`apps/web` 是 pi-web `v0.8.6` 的可编辑 MIT 源码基线，不是 MedHorizon 迁移代码。保留的是运行 Web UI 所需的 `app/`、`components/`、`hooks/`、`lib/`、`public/` 和配置。

未复制：

- npm 发布 launcher `bin/`；
- 上游 `.git`、README/翻译、release docs、截图（本仓以 `UPSTREAM.md` 记录来源）；
- 上游 lockfile/Bun lock；根 `package-lock.json` 是 MedPi 自己的唯一 npm lock；
- `.next`、build、cache、`node_modules`；
- 仅验证发布 launcher 的 `lib/node-version.test.mjs` 和 `lib/pi-web-options.test.mjs`。

有意修改：

1. package 改名为 private `@medpi/web`，删除 publish/release/build 命令，增加 test/typecheck；
2. 四个 direct Pi runtime package 从 `0.83.0` 一致升级到 `0.84.1`，并适配 provider-login signal 与 headless Theme constructor；
3. direct `undici` 升到 `8.10.0`；HTTP proxy test 随新版合法的 HTTP forward-proxy 语义更新，同时保留 HTTPS CONNECT 与 NO_PROXY 断言；
4. newer React compiler lint 无法保留上游手工 memoization 时，只关闭对应单条规则，不改运行逻辑；
5. 增加 `UPSTREAM.md` 记录 commit、偏差和许可证。

遵循 `apps/web/AGENTS.md`：开发验证使用 `npm run dev`，没有执行 `next build`。

## 9. 明确未迁移的代码

| 排除项 | 排除原因 | 重新评估触发条件 |
|---|---|---|
| `backend/cli` agent/session/server/runtime | 会与 Pi 建立第二套 session/tool/permission 事实源 | 不重新引入；能力应通过 Pi API/extension 适配 |
| Solid/Atlas workspace UI | pi-web 是唯一 Web 壳，框架与状态模型不兼容 | 只按需求重写薄 React 组件，不复制旧壳 |
| 33 个其余 connectors | 没有当前 consumer；部分涉及 key、许可、临床或更复杂 schema | 真实研究用例、host policy、contract test 同时存在 |
| Mol*/RDKit/IGV/MSA/Sequence viewer | bundle、WASM/worker、DOM 和大文件预算尚未设计 | 先有明确文件/tool consumer，再逐个迁移 |
| Python/R kernel、notebook UI | 最小沙箱闭环已有；不做旧 kernel/notebook 整目录迁移 | 真实 notebook UI 需求出现，且继续走 `science_run` 边界 |
| Research Graph FastAPI/Vite sidecar | 引入 Python/SQLite/embedding/第二个图 store；当前 3 tools 无需它 | 本地 DAG 达到规模/查询瓶颈，且唯一图事实源迁移方案完成 |
| GEPA/orchestrator/subagent scheduler | 依赖稳定的 permission、session、artifact 和 evaluation contract | 最小 agent/tool/browser 链路稳定后 |
| MCP 实现 | Pi 已有扩展/package 能力，复制旧 MCP 会重复认证和工具事实源 | 确认 Pi 缺失的具体 MCP transport/auth 用例 |
| 293 个 skills | 大量无当前消费方内容与上下文成本 | 每个 skill 单独审阅、测试、安装 |
| PermissionNext/process supervisor | 旧 runtime 专用；直接复制无法约束 Pi built-ins | 在 Pi/Gateway 唯一 permission owner 上重新设计 |
| 账户、wallet、billing、managed GPU | 与本地科学工具无关，且增加凭据/合规面 | 不属于 MedPi 本地科研 package 范围 |
| 离线/原生发行 | 不是首个科学垂直切片的依赖 | 产品化阶段，依赖审计清零后 |

## 10. 验证证据

已完成：

| 命令/检查 | 结果 |
|---|---|
| `npm --workspace @medpi/science test` | 27/27 通过；真实临时文件、本地 HTTP server、Pi loader，不 mock fetch/文件系统/Pi loader |
| `npm --workspace @medpi/web test` | 230/230 通过 |
| `npm test` | science + web 共 257 tests 通过 |
| `npm run typecheck` | science 与 web 通过 |
| `npm run lint` | web ESLint 通过 |
| `npm ci --include=dev` + `npm ls --depth=0` | registry clean install 通过；lockfile 可重放且无 extraneous top-level package |
| Pi loader integration | 只加载本文列出的 8 tools 和 `science-review` prompt；untrusted project 文件/provenance 被拒绝 |
| local provider vertical smoke | 实际 Next/Pi AgentSession、SSE、project trust 和 `science_list_dbs` tool call 通过；使用隔离本地 OpenAI-compatible transport，不等同于真实模型凭据验证 |
| dev smoke | `next dev` 在隔离 HOME/loopback 启动；主页、cwd validate、project trust `false → true`、models endpoint shape 均通过；未执行 production build |
| secret/build-output scan | 未发现提交候选中的凭据、`.env`、session/runtime data；生成目录由 ignore 排除 |
| full dependency audit/signatures | **通过：0 vulnerabilities**（显式 `--include=dev`）；1,311 packages signatures、249 attestations 通过；见 §7.2 |

尚未完成，因此不能声称已经完成全链路：

- 使用真实模型凭据执行 browser → prompt → streamed tool call → tool result；
- Chrome DevTools/Playwright 的 DOM、console、network、abort/reconnect 和 accessibility 验证；
- 8 个公共 source 的 live contract CI（当前 HTTP 安全测试使用真实本地 transport，避免外部 flaky test）；
- 专用 Stage/provenance/scientific viewer React UI；
- 多进程 provenance、notebook kernel UI、Research Graph sidecar。

## 11. 下一步：只按消费方增加

### 已完成：Pi 依赖修复门

- 四个 direct Pi package 已一致升级到 `0.84.1`；
- 257 tests、typecheck、lint、project trust、session/resource loader 和 HTTP proxy tests 已通过；
- 完整 `npm audit` 与 `npm audit --omit=dev` 均已清零；registry signatures/attestations 也已验证。

### P0：浏览器、出站网络与部署门

1. 在开放自定义 Provider 前完成 baseUrl 的 egress policy：私网/loopback/metadata 拒绝、redirect 策略、DNS rebinding 防护或隔离出站代理；
2. 用真实 Chrome 验证 prompt/stream/abort/reconnect/session branch 和 extension dialog；
3. 使用隔离测试凭据完成 browser → model → science tool → streamed result 垂直切片；
4. 对公开部署验证 TLS/reverse proxy、密码策略、Host allow-list、全局安全 headers、认证限流、资源配额、文件访问边界和日志 redaction；
5. 将 production audit、signature/lockfile 校验、一致 Pi 版本和 release build（在允许执行 production build 的独立 pipeline 中）加入 CI。

### P1：验证当前科研切片，而不是扩功能数量

1. trusted project 中执行 8 个 tools 的真实模型垂直切片；
2. 为 source 失败、429、schema drift 增加可选 live contract job；
3. 为 Web JSON/SSE/OAuth route 增加统一 body/connection budget、错误 redaction 和 disconnect cleanup 测试；
4. 验证 Stage 审批在 pi-web extension dialog 中的可见性和拒绝路径；
5. 验证 provenance 文件刷新、session branch 和项目切换不串状态，并明确单进程部署约束。

### P2：有需求才加 UI

- 先做通用 tool-result renderer：database hits、Stage 状态、provenance node/edge table；
- 每个 renderer 必须只消费现有 tool details，不能建立第二个 store；
- 只有真实 FASTA/PDB/SDF/VCF 用例证明 bounded text 不够时，才逐个引入 Sequence/Mol*/RDKit/Genome viewer，并同时增加 bundle、WASM、worker cleanup、DOM、large-file 和 browser tests。

### P3：高风险能力

最小沙箱闭环见 `docs/plan/00-sandbox.md` 与 `packages/science/src/sandbox/*`（`science_run` / `science_rollback`）。仍不要迁移旧 MedHorizon kernel/notebook/MCP/Research Graph/GEPA/subagent 实现文件；新能力必须复用现有 sandbox + permission owner，并由真实消费方驱动。

## 12. 审阅判定

本次迁移符合“最小且有消费方”的目标：科研代码集中在一个 Pi package，领域模块不依赖 Pi，Web 壳保持上游可比对，旧 runtime/UI/sidecar 没有被整目录带入。

当前可以接受的声明是：

> MedPi 已有一个经过单元、集成和静态检查的最小 Pi 科研 package，提供 8 个科学数据源、科学文件有界检查、branch-local Stage/HITL、轻量 provenance、reviewer prompt，以及极宽松沙箱最小闭环（`science_run`/`science_rollback`）。

当前不可以接受的声明是：

> MedPi 已完成 MedHorizon 全功能重构、已具备 notebook kernel/Research Graph/科学 viewer，或已可安全公开生产部署。
