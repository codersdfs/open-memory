# 记忆系统研究笔记：open-memory 现状、六个业界系统与增强方案排名

日期：2026-07-11 前后（笔记整理日 2026-11-07）
范围：open-memory（@franklinww/open-memory）现状盘点；TencentDB Agent Memory、OpenViking、Mem0、Zep/Graphiti、Letta (MemGPT)、MemOS 六个业界系统的调研与独立核实结论；八条增强方案的排名与第三轮独立评审意见。

**引用与核实约定**：本笔记的原始材料由本次调研流程的 ask 提供（盘点 JSON、六份调研笔记及其核实报告、方案排名 JSON、评审 JSON）。撰写本文件时，我在本会话对工作区内可核的引用做了逐条抽查，全部命中；抽查命令与结果记录在文末附录 A。凡引用标注「本地可核」的（bench 下的 OpenViking 克隆、vendored mem0、本仓源码与 ADR），我已或可在本工作区直接读到；凡标注「笔记级核实」的（TencentCloud、graphiti、letta、MemOS 等外部仓库源码，以及各核实员在其会话中的 fetch/clone 操作），是核实员报告的结论，本会话未复跑，存疑处按核实原文如实标明。

---

## 1. open-memory 现状与薄弱点

### 1.1 定位与骨架

本地优先 agent 记忆系统：单文件 node:sqlite，零运行时依赖（package.json dependencies 为 `{}`，本会话核实）。README 实测 LoCoMo 69.1%（README.md:18,374）、暖检索 ~9ms。写入走分级门，检索为混合确定性 Smart Search + 800 token 硬预算，全程无 LLM。

- **写路径**：所有写口汇入 `saveDetailed`（src/core/memoryService.ts:119）：解析分区/项目/kind → 正则策展 9 类（含 secret 拒写，src/core/write/curation.ts:159-167 的 SECRET_PATTERNS，本会话核实，在 embed 前，ADR-0040）→ 可选 LLM write gate（keep/scaffold 一问一趟、fail-open，ADR-0041）→ embed → reconcile：同 (namespace,project,type) 5 近邻定 insert/reinforce/supersede（pinned/episodic/extractor 不可删，reconciler.ts:143-157）。`saveMany` 批量默认绕过全部三道门（memoryService.ts:337-383，本会话核实）。
- **读路径**：读扇出（本层+shared+legacy，scope.ts:124-142）；每分区候选 = vector top ∪ 词项倒排（ADR-0012），打分 0.6·BM25+0.25·recency+0.15·strength（真 embedder 加 0.6·vector、pin+0.3），过相关门（阈值 0.72、coverage≥0.75）；跨分区合并后按 idf 加权 coverage 排序 → MMR λ0.6 → 800 token 硬预算（整行优先、溢出成摘要，tokens.ts:41-114）→ 截到 k 并 reinforce 命中；空结果带 diagnostics（hybrid.ts:687-783）。

### 1.2 强项（来自盘点，逐条有出处）

1. **确定性且可解释**：检索零模型调用，?explain 给分数分解；空结果携带阈值/各分区行数/nearMisses 与三种下一步（hybrid.ts:392-406,687-783，ADR-0037/0039）。
2. **硬 token 预算诚实**：budgetEnforce skip-不停止、投影只花在装不下整行的剩余空间（tokens.ts:59-113）；CJK 逐字估 token 让 800 是真 800（tokens.ts:3-14）。
3. **写侧治理分级清晰、拒之有路**：正则策展含 secrets 拦截（curation.ts:159-167，本会话核实规则确在），拒绝均带一条 next move。
4. **生命周期有设计**：archive-first 可逆（decay.ts:92-123），kind 定保留窗且 decision/convention/gotcha 永不因年龄归档（decay.ts:110 `isDurableKind` 跳过，本会话核实；ADR-0021）；strength 与 importance 分列。
5. **测量文化扎实**：McNemar p=0.0003 双重验证（README:385）；int8/PRF/FTS5/图索引四个负面结果建了再回滚并写进 ADR（ADR-0026/0028/0031）。
6. **真本地优先**：单文件 SQLite WAL，80 req/s 零 drop（README:409-424）。

### 1.3 薄弱点（gap 编号沿用材料，后文方案以 gapN 引用）

| # | gap | 关键证据 |
|---|-----|---------|
| gap1 | **遗忘没有自动触发器**：decay/archive 只有手动 POST /decay（server.ts:493-499，本会话核实）与 CLI；本会话复跑 `grep -rnE "setInterval\|cron\|schedule" src` 确认无调度器，唯一命中是 decay.ts:39 的注释本身——它防的那个「scheduled job」并不存在。ADR-0040 审计表（docs/adr/0040-writes-are-curated.md:22，本会话核实）：459 行（89%）从未被检索 |
| gap2 | **隔离是名字式、无认证**：身份=env/OS 用户名（scope.ts:58-77），HTTP 面只有 loopback+Origin 两层门（server.ts:237-255,904-932）；本机任意进程传任意 namespace 即读他人分区；无 at-rest 加密，README:278 自认 0600 在 Windows 是摆设 |
| gap3 | **冲突消解局限一个窗口**：supersede 候选只有同 (namespace,project,type) 5 近邻（memoryService.ts:228-240）；无 judge key 时语义矛盾直接 model-unavailable→insert（reconciler.ts:162）；ADR-0040:120,135 明写 No retroactive curation（本会话核实），门只管增量 |
| gap4 | **记忆间没有关系结构**：跨记忆链接只有 supersedesId 与 tag facets；multi-hop 是最弱类目 34%、gold 证据仅 13% 进过上下文（README:375,391-392，本会话核实）；本会话 grep 确认 hybrid.ts 无任何 tag/facet 候选引用——facets 写时算好（facets.ts:144 deriveFacets，本会话核实）却没人读 |
| gap5 | **语义能力与规模双天花板**：默认 hash embedder 非语义（README:264）；向量臂全分区扫描，4k 行 62ms、10^5 行外推 ~2s/1.3GB（README:530,534） |
| gap6 | **写门与批量路径不对称**：saveMany/import 默认绕开三道门（memoryService.ts:337-383，本会话核实；ADR-0041「No batch pricing」）；judge 挂掉静默 fail-open（judge.ts:176-179）。另本会话发现 src/migrate/import.ts:13-14 注释自称「走正常 save、近重复会折叠」，与 saveMany 实现相反 |

---

## 2. 六个业界记忆系统

### 2.1 TencentDB Agent Memory（腾讯云）

**设计要点**：企业级记忆引擎，2026-05 开源（MIT，github.com/TencentCloud/TencentDB-Agent-Memory）。云版底座 TCVDB+文件存储；开源版默认本地 SQLite+sqlite-vec（可选 TCVDB）。长期记忆为 L0 原始对话→L1 原子记忆→L2 场景→L3 核心/Persona 金字塔，跨层 refs 溯源；作用域链 team_id>user_id>agent_id>session_id，task_id 正交。写入治理靠 extraction.enableDedup 与 capture.l0l1RetentionDays 保留天数 GC。检索 BM25+向量+RRF，默认注入 L2/L3、需精确事实回退 L1/L0；召回护栏四件套（maxResults=5、单条字符上限、总字符预算、timeoutMs=5000 超时跳过注入）。窗口压缩按占用比分级卸载（50% 轻度/85% 激进，工具日志卸外部文件，窗口留 Mermaid 任务图，按 node_id 可回原文）。

**借鉴价值**：分层注入（默认喂高密度层、深挖留路径）；召回护栏做成 API 一等参数且检索永不阻塞对话；阈值式短期压缩天然适配本地文件；SQLite+可读 Markdown 双形态与本项目同栈；写入期去重+保留天数 GC 是可落地的整理下限。

**核实结论**：holds=true，confidence=high（核实员克隆仓库 commit 2002196 后逐条 grep；本会话未复跑外部克隆）。config.ts:582 storeBackend 默认 "sqlite"、:63 enableDedup 默认 true、:47-49 l0l1RetentionDays 默认 0=不清理、召回护栏与 offload 阈值（mildOffloadRatio 0.5/aggressiveCompressRatio 0.85/mmdMaxTokenRatio 0.2）均命中。
**修正意见（3 点）**：
1. ⚠️「官方文档与 README 均未描述合并算法」**易误导**——开源代码完整公开了 merge 机制：l1-dedup.ts（LLM 批量冲突判定、候选 hybrid+RRF）与 l1-writer.ts:10,76,114（DedupAction = store|update|merge|skip，版本号单调递增）。真正不存在的只有 decay（全仓 grep 零命中）。「idea5 前提：官方未公开的合并算法」不准确。
2. ⚠️「2026-05 开源，含 OpenClaw 插件、Proxy、TS/Python SDK」**时序含混**：Proxy 与官方 SDK 是 v2.0.0（2026-08-03）才发布；2026-05 首发时不含（GitHub created_at 实为 2026-04-07）。
3. 小补充：v2.0.2 起有试验性 MongoDB 后端（默认关）；开源版隔离表述为「v3 数据面强制 team+agent+user 三元组隔离」。

### 2.2 OpenViking（字节跳动火山引擎）

**设计要点**：「自演化 Agent 上下文数据库」，统一 Memory/知识 RAG/Skills；AGPL-3.0（子组件 Apache-2.0/MIT）。一切皆 viking:// URI 的目录式虚拟文件系统（VikingFS），双层：RAGFS 内容层（Rust）+ 向量索引层（dense+sparse，int8，parent_uri 树）。检索：可选 LLM 意图分析产出 TypedQuery → 全局向量搜索 → rerank；L0(≤256字符) abstract / L1(≤4000字符) overview / L2 全文三层分级，L0 供召回、L1 供重排、L2 按需加载。写入无直接 add API，session commit 异步抽取（SessionCompressorV3→ExtractLoop→MemoryUpdater→SemanticQueue），产出 memory_diff.json（adds/updates/deletes）；整理靠手动 `ov compile memory`（仅明确同一实体才合并、保留全部原子事实、冲突只报告不覆盖）。衰减公式源码可查：score = sigmoid(log1p(active_count)) × exp(-ln2·age_days/7)，半衰期默认 7 天。

**借鉴价值**：三层分级+可配置字符预算直接对应 token 预算；自底向上聚合摘要的新鲜度传播（子层未变不刷、pending/total≥10% 批刷）是 SQLite 派生摘要列的增量维护范本；热度公式一个 SQL 可算；memory_diff 让写入可观察、可审计、可回滚；内容与索引分离天然同构 SQLite 主表+FTS。

**核实结论**：holds=true，confidence=high（核实员在 main@1bee7385 逐条核对；L0 层级的语义在本地 bench 克隆 hierarchical_retriever.py:116 本会话外可核，衰减公式在 bench/OpenViking/openviking/retrieve/memory_lifecycle.py:15/:28/:47 本会话核实命中）。
**修正意见（4 点）**：
1. ⚠️「README 递归下钻宣传与官方文档矛盾」**不准确**：当前 README 的 TrieHI「resolve directory scopes before vector ranking」与 docs「不逐层遍历」口径一致；真实落差在产品 docs 与 TrieHI 论文摘要之间。且 TrieHI 归属 ICDE 系 README 自述，「树清单+Roaring bitmap」在 arXiv 摘要未出现、**未证实**。
2. ⚠️「无 TTL/自动淘汰」**已过时**：main 含 openviking/ttl/（Redis 目录 TTL，默认禁用，软 TTL）；长期记忆才确无自动淘汰。
3. 「未见 patterns」**不准**：core/directories.py 预设 memories 树中存在 patterns 目录，只是不在 builtin 启用类型清单里。
4. 衰减公式与 FAQ **并非矛盾**：hotness_score 只被 stats_aggregator.py 用于健康统计、本就不参与排序——「版本/路径分歧」应改述为「两条不同路径」。
另注：「无直接 add API」依据为 SDK 无 add_memory 与独立 extract 端点已删，但 FS/MCP write 可否直接写 memories 文件**未单独验证**。

### 2.3 Mem0

**设计要点**：开源 agent 记忆层（mem0ai），add/search/update/delete API，user/session/agent 三级作用域；论文 arXiv:2504.19413。v3 三存储：SQL 事实（真相源）+ 向量库 + {collection}_entities 实体集合；OSS 默认 SQLite ~/.mem0/history.db。论文版另有 Mem0g 图变体（Neo4j），v3 已从 OSS 移除外部 graph 驱动。生命周期：论文两阶段（抽取：摘要 S + 最近 m=10 条消息为上下文；更新：每条候选与 top s=10 旧记忆比对，LLM tool call 选 ADD/UPDATE/DELETE/NOOP）；v3 改单遍 ADD-only（top-10 预检索作去重上下文、MD5 防完全重复、批量写入；矛盾不再写时消解）。检索：semantic+BM25+entity boost（平台再加 temporal），OSS 默认 top_k=20；README 称 LoCoMo 71.4→92.5。

**借鉴价值**：两阶段 prompt 组装法（摘要+最近 10 条做指代消解）可照搬；写时四操作是唯一的主动矛盾消解方案；**v3 反例本身是教训**——放弃写时合并改 append-only 后基准分大涨，支持「本地优先默认廉价 ADD-only」；history 审计表与本地同栈；三信号融合是混合检索直接参照；~7k vs ~26k tokens/对话、p95 降 91% 给预算裁剪量化基线。

**核实结论**：holds=true，confidence=high（核实员独立 fetch README/main.py/configs/base.py/storage.py/论文 HTML/两份 docs，逐字命中；history 表形状与实体集合名在本地 bench/.venv-mem0 storage.py:108-119、main.py:424/:707 本会话核实命中）。
**修正意见（5 点，均为限定而非推翻）**：
1. ⚠️「论文（v2）」的**版本标签是调研员推断**：论文未自称 v2，v2/v3 来自迁移指南；且论文自报 LoCoMo 66.88（Mem0g 68.44）≠ README「old」基线 71.4——**别把 71.4→92.5 说成论文数字**。
2. OSS 的 BM25 存在**文档内不一致**：迁移指南说 OSS v3 检索含 BM25（sparse vectors，需装 fastembed），how-it-works 页只提 vector+entity boost；实际取决于所用 vector store。
3. ⚠️「矛盾靠检索排序让新信息胜出」偏乐观：temporal 排序是**平台能力**，OSS 场景更保守的表述是主要靠显式 update()/delete()。
4. p95 降 91% 出自摘要，正文另有 92% 表述，取 91% 不算错。
5. refs 的 storage.py 撑不起「~/.mem0/history.db 默认」（该文件默认 ':memory:'），应补 configs/base.py。
**效果注记**：mem0 实体链接在本仓 bench 实测仅 14.5% 总准确率、multi-hop 6%（bench/REPORT.md:13,26，本会话核实）——entity boost 不能作卖点。

### 2.4 Zep / Graphiti

**设计要点**：时间知识图谱引擎（graphiti-core，Apache-2.0；论文 arXiv:2501.13956）。三层子图：episode（无损原文+参考时间）→语义实体/fact→community 摘要。边 bi-temporal：valid_at/invalid_at（事实有效期）与 created_at/expired_at（系统期）四时间戳并存。矛盾时旧边只标失效不删（invalid_at=新边 valid_at）；后端 Neo4j/FalkorDB/Neptune。检索三路并行（cosine/BM25/图 BFS）×四 scope，reranker 可选 RRF/MMR/cross-encoder/图距离/episode 提及频率，默认查询期不调 LLM；时间不硬过滤，随结果输出 Date range 供消费方判断。

**借鉴价值**：bi-temporal 在 SQLite 里只是 4 个 timestamp 列，成本极低；标记失效而非删除+双向时间校验；去重比较限定候选子集（O(|E_uv|)）无需图数据库；两步去重（廉价召回+LLM 只在候选集判一次）正好对应本地向量+FTS5；检索不调 LLM、提及频率作 rerank 信号；时间作上下文而非硬过滤。

**核实结论**：holds=true，confidence=high（核实员论文+main 分支 depth-1 克隆逐条核对；**核实员自述未跑任何运行时验证，全部静态核对**）。bi-temporal 四时间戳（edges.py:54/:271/:274/:281）、失效不删（edge_operations.py:779-780）、五种 reranker（search_config.py:32-77）、默认 RRF 不调 LLM、全库 grep decay/evict/ttl 零命中均属实。
**修正意见（5 点，时代/实现位置更正）**：
1. ⚠️「矛盾比较限同一实体对」**已过时**：现 main 仅去重候选限同对（edge_operations.py:521-543），失效候选改为按 fact 全组 hybrid 搜索（:555-572）。
2. ⚠️「前 4 条上下文+reflexion」是**论文时点数字**（n=4）：现码取 RELEVANT_SCHEMA_LIMIT=10，且 'reflexion' 在当前代码库 grep 零命中。
3. 「label propagation 增量归簇+定期全量刷新」描述的是**论文中 Zep 生产侧**：OSS main 的 build_communities 为全量重建。
4. 「FACT (Date range: from–to)」逐字存在于**论文（服务侧提示词格式）**，不在 graphiti-core 输出代码；「时间不硬过滤」应注明是默认——现码 SearchFilters 提供可选硬过滤（search_filters.py:62-65）。
5. ⚠️「graphiti-core 是其 agent 记忆层核心」为论文（2025-01）表述：现 README 已改称 Zep 企业层用自研 Konig 图数据库，Graphiti 定位为自带数据库的开源框架；help.getzep.com/concepts 已无三层/bi-temporal 细节。

### 2.5 Letta（前身 MemGPT）

**设计要点**：UC Berkeley MemGPT 演化的有状态 agent 平台：上下文窗口当 RAM、外部存储当磁盘，agent 用工具自编辑记忆。分层：in-context（instructions+可读写 memory blocks（label/description/value/limit）+FIFO 队列）与 out-of-context（recall=消息库、archival=向量库）。队列 ~70% 注入 memory pressure 警告，满则驱逐消息+递归摘要；V1 compaction 四模式（sliding_window 默认留 ~70% 原文）。整理靠 sleep-time/dreaming 后台 agent 周期性重写 blocks；无内建 TTL。archival_memory_search 语义检索+tags 过滤；blocks 常驻 prompt 免检索，metadata 暴露 chars_current/limit。新代 letta-code 将全部上下文收进 git 管理的文件系统 MemFS。

**借鉴价值**：带 limit 的常驻记忆块+预算元数据渲染进 prompt，agent 可自我调节；两级压力信号留出主动整理窗口；递归摘要 O(增量) 不随历史重算；记忆编辑剥离到异步后台 agent，主路径只读；MemFS git 版本化让自编辑误写可审计可撤销，契合本地优先同步需求。

**核实结论**：holds=true，confidence=high（核实员源码 letta 0.16.8+docs+论文直引复查；70% 压力警告、四模式 compaction、block 四字段、无 TTL 负面核验均通过）。
**修正意见（7 点，多为过时/精度）**：
1. ⚠️「SQLite+Chroma 为 pip 默认」**半过时**：SQLite 默认属实（settings.py:493），但现行 V1 源码已无 Chroma（SQLite 走向量走自定义列 CommonVector）；「Chroma」只见于 ~0.6.x 旧 PyPI 页。
2. ⚠️「cosine」**无一手证据**：官方 docs/源码只说 semantic similarity；且 v0.12.1 起 Letta Cloud archival 已支持 hybrid+时间过滤，笔记写成纯向量偏旧。recall 实为 hybrid（text+semantic）+时间过滤，笔记漏了语义半。
3. heartbeat 属实但属 **legacy MemGPT-style agent**：v0.12.1 起推荐的 letta_v1_agent 明确「No heartbeat system」，笔记未注时代限定。
4. ⚠️ 语境更新：letta-ai/letta main 现为 stub，V1 server 已退役（archive 分支），当前源码迁至 letta-ai/letta-code——「V1 时代」描述应标退役状态。
5. 「驱逐 ~50% 消息」是近似转述：论文原文是释放约一半上下文窗口的具体条数。
6. 「dreaming」出自 letta-code（/sleeptime、/dream），sleep-time-compute 博客只用 sleep-time agents，两者是不同产品层。

### 2.6 MemOS（记忆张量 / Memory Tensor）

**设计要点**：记忆操作系统（Apache-2.0，论文 arXiv:2507.03724，记忆张量(上海)+上海交大等）。核心容器 MemCube 含明文/激活/参数三类记忆+溯源版本元数据；三层：接口(MemReader)/操作(MemScheduler、MemLifecycle)/基础设施(MemGovernance、MemVault)。自托管 Neo4j+Qdrant，2026 本地插件转 local-first SQLite（FTS5+向量双路）。生命周期状态机 Generated→Activated→Merged→Archived（另有 Frozen）；治理层论文设计含 TTL 与按访问频次 GC；检索为符号过滤+向量+图遍历混合，topic–concept–fact 路由决定 what/where/order。

**借鉴价值**：写入前相似检索+LLM 关系分类再决定合并/覆盖，把去重变成写路径上的分类决策；结构化元数据（来源/版本/TTL/访问频次/敏感度）给衰减与淘汰显式依据；冷热分档出热检索集、命中再激活；跨形态转换按访问频率分层放置；版本化+快照回滚防单点错误永久污染（Time Machine 设计）。

**核实结论**：holds=true，confidence=high（核实员克隆 HEAD d326a64 + 论文 v4 + 官方文档逐项检查）。三类记忆、状态机、topic–concept–fact 原文、冷热迁移、跨形态转换、本地插件均属实。
**修正意见（4 点，含一处硬伤）**：
1. 🔴 **硬伤**：「Update API 版本感知，支持 append/merge/overwrite」**不成立**（开源侧）——HTTP 路由无 update 端点；托管客户端 update_memory 无任何 mode 参数（client.py:665-683）；MOSCore.update() 对主用的 tree_text 后端直接警告「does not support update memory」（core.py:1031-1033）。笔记把内部自动语义（MERGED_TO 边、smart-dedup 的 DUPLICATE/UPDATE/NEW 判定）串位成了用户可选项。「版本感知」属实但受 memory_version_switch 门控、默认 "off"。
2. ⚠️ idea1 的分类标签与代码枚举**不符**：实为 history update_type = conflict/duplicate/extract/unrelated/feedback（item.py:72）、LLM prompt 输出 ADD/UPDATE/NONE、本地插件 DUPLICATE/UPDATE/NEW——笔记沿用了审计转述。
3. 第三方审计（somnigraph，2026-03）「未实现 TTL/Time Machine/冻结、LoRA 仅占位」在 2026-11 HEAD **复核仍成立**（lora.py 写 b"Placeholder"、无 frozen 状态）；但审计个别行号级细节已过时。
4. 小简化：机构为 10 家（记忆张量第 1 单位、上交大之一）；三层漏了 MemOperator（混合检索与路由挂在它名下）；Neo4j 主路径向量走原生索引、Qdrant 用于 general/preference 等路径，非均等双库。

---

## 3. 增强方案排名清单

排序依据（材料原文）：「召回/写入质量影响 ÷ 成本」。P5 依赖 P4、P8 大的一半依赖 P2。每条注明灵感来源的证据级别：**本地可核**=工作区源码/文档可读；**笔记级**=调研核实员在其会话验证、本会话不可复跑。

### P1 批量写入口补上零成本确定门 — effort: medium / risk: low / impact: high

- **灵感来源**：Mem0 v3 单遍 ADD-only 的 MD5 完全重复抑制（**本地可核**：bench/.venv-mem0 main.py seen/existing hashes，本会话定位）；腾讯 L1 enableDedup「写入期治理下限」（**笔记级**）。
- **针对 gap**：gap6（saveMany 绕三门，memoryService.ts:337-383，本会话核实；一次 5000 行导入把策展拒掉的含 secret junk 整库放回）。本会话另核实：ADR-0040:103 原句「`saveMany` keeps curation off」是要被推翻的既有决定；migrate/import.ts:13-14 注释与实现相反。
- **改动点**：embedBatch 前加整批一次的 curate()（零网络）：reject 行不 embed、计入 skipped 并逐条回 index+reason；新增 text_hash 派生列与 store.findExistingHashes；{raw:true}/--no-curate 逃生门（secret 类不给）；同步修 import.ts 注释与 ADR-0018/0040 取舍段。
- **评审最终意见**：approved，无 blocking。属三门中先补零成本确定门的正确次序。

### P2 给遗忘装上自动触发器（附真计数） — effort: medium / risk: medium / impact: medium

- **灵感来源**：OpenViking 热度公式（**本地可核**：bench/OpenViking memory_lifecycle.py:15 半衰期 7.0、:28 score 公式、:47 freq——本会话核实命中）；腾讯 l0l1RetentionDays（**笔记级**）。
- **针对 gap**：gap1（本会话复跑 grep 确认 src 无调度器；且无 active_count 对应物——strength 每次 +0.02 且 MIN(0.95) 饱和（sqlite.ts:1771-1773，本会话核实），lastUsedAt 只有二值）。
- **改动点**：memories 加 use_count，reinforce 两库 +1；archiveStale 二值判据换为热度 log1p(use_count)×exp(-ln2·age/按 kind 取现窗)；daemon 入口挂 MEMORY_MAINTAIN_HOURS（默认 24h，0=关）只调 runDecayDetailed，hard 档对调度器不可达；store_meta 记 last_maintenance_at、开库过期就后台补跑不阻塞；结果进 stats.decayCandidates 与 console。
- **评审最终意见**：approved，附实施修正（本会话核实依据）：**换热度判据时必须保留 decay.ts:110 的 durable-kind 跳过与 :117 的 importance 地板**（decay.ts:105-120 实读，两行俱在）——否则 decision/convention/gotcha 会被年龄规则误伤，违反 ADR-0021。

### P3 存量回填整理：一次 triage 先出 diff — effort: medium / risk: medium / impact: high

- **灵感来源**：OpenViking level 语义（**本地可核**：hierarchical_retriever.py:116）；`ov compile memory`「仅明确同一实体才合并、保留原子事实、冲突只报告不覆盖」（**笔记级**，docs 页面，核实员未复核其实现）。
- **针对 gap**：gap1+gap3 的存量半（ADR-0040:120,135 明写 No retroactive curation，本会话核实；而同一 ADR:22 审计 459/515=89% 行从未被检索，本会话核实）。前置缺口（材料称本次核实）：updateMeta 的 patch 不含 importance；ADR-0041 规定未判/降级「stores unjudged, untagged」，今天事后无法区分「判过但低分」与「judge 挂了」。
- **改动点**：新 src/core/lifecycle/triage.ts + `ai-memory triage [--apply]`：分页扫全库，junk→archive、低价值→降 importance、同 entity 且 normalizeText 相同→只列 merge；默认 dry-run 出 adds/updates/deletes diff，--apply 才写，**永不 hard-delete**；两库补 importance patch 并沿用 noteChange 失效分区缓存；judge 失败只做进程内计数，是否落 tag 列为 ADR-0041 待决 amendment。
- **评审最终意见**：approved。diff-first + 永不 hard-delete 与 ADR-0011:11「nothing is unrecoverable」的既有承诺一致。

### P4 实体连接层：facet 索引与第三候选臂 — effort: large / risk: medium / impact: high

- **灵感来源**：mem0 实体链接（**本地可核**：main.py:424 {collection}_entities、:707 _link_entities_for_memory——本会话核实命中；但**其效果在本仓 bench 是 14.5%、multi-hop 6%**（REPORT.md:12,26，本会话核实），故 boost 不作卖点、只作候选来源先例）；Zep 图遍历作第三路召回（**笔记级**）。
- **针对 gap**：gap4（本会话核实：facets.ts:144/:200-210 写时算好落 tags 列，hybrid.ts grep 零处引用 tag/facet——结构写了没人读；multi-hop 34%、gold 13%，README:375,391-392 本会话核实；ADR-0011:27 Stage C 从未实现）。
- **改动点**：新表 memory_facets 与 memory_terms 同事务，并覆盖 facets 会变的全部路径（insert/insertMany/updateEmbedding/updateMeta 改 tags/启动回填自愈——本轮修订补齐了后两条维护路径）+「facet 计数==行 tags facet 数」不变量测试；searchOne 加第三候选臂（query 走同一 deriveFacets），仍过同一相关门不给免费通道；w.entity 默认 0 且进 breakdown；**默认 MEMORY_LINKS=off**，先量 multi-hop n=32 与 evidence ruler，净负照 ADR-0026/0028 先例留在 flag。
- **评审最终意见**：approved。默认关+负面结果也写 ADR 的纪律与测量文化一致；P5 是它的下游。

### P5 矛盾判定扩窗，判不出就标记 — effort: medium / risk: medium / impact: high

- **灵感来源**：Zep 两步去重与失效候选按 fact 全组 hybrid 搜索（**笔记级**，本会话无本地源不可复核）。本仓对应物已存在：hybrid 两臂（hybrid.ts:188-240）与 P4 的 facet 臂。
- **针对 gap**：gap3（supersede 候选只有同 (namespace,project,type) 向量 top-5，memoryService.ts:228-240；judge 缺席时 reconciler.ts:162 静默双写。落地缺口（材料核实）：list/vectorSearch/lexicalCandidates 无 tag/facet 参数——「同 entity 的行」必须等 P4 的 store 能力先行，**P5 是 P4 的消费者**）。
- **改动点**：MemoryFilter 加 facet 字段（两库同实现）；neighbours 扩成 ≤10 三路并集：向量 top-5 ∪ 同 entity ∪ 同 (namespace,project) 跨 type；reconcile 四道不可删守卫原样保留；judge 缺席而「同主语不同谓语」成立时不再静默并存，改打 conflict:<entity> facet——注意它走 updateMeta 改 tags，**必须走 P4 列出的 facet 维护路径**否则索引漂移；并计 stats、console 加待裁决面板。
- **评审最终意见**：approved。顺序依赖（P4 先行）与上轮硬伤修正均已落地。

### P6 写史表 + 双时间线 + 沿链回查 — effort: medium / risk: medium / impact: medium

- **灵感来源**：mem0 history 表形状（**本地可核**：storage.py:108-119，本会话核实逐列命中：id/memory_id/old_memory/new_memory/event/is_deleted/actor_id/role）；OpenViking 按需加载层（**本地可核** :116）；Zep bi-temporal 与 edge_operations.py:779-780（**笔记级**）。
- **针对 gap**：gap3 可审计半 + gap4 第二半（ADR-0011:27 Stage C「over supersede chains」无人做：superseded 行检索从不沿链取，只在 console 有链走法 ui/src/lib/supersede.ts。前提修正（材料核实）：deleteSoft 只置 is_deleted=1、restore 可复活、ADR-0011:11 明写 nothing is unrecoverable——缺的不是「不可逆」，而是改判原因只有一行 console.warn、purgeDeleted 会连 text 硬删（sqlite.ts:1833-1850）、日期混在 text 的 (at:…) 里而非列（ADR-0015））。
- **改动点**：可见性零改动，失效仍走 tombstone，只在同一 UPDATE 并置 invalid_at=now 并调 noteChange（否则复刻 ADR-0034/0035 缓存返死行）；新 append-only memory_events 记 insert/reinforce/supersede/archive 的 old/new/reason/model；purgeDeleted 硬删前先导出该 id 历史；valid_at 从 (at:…) 回填成列；Stage C 链半：命中行沿 supersedesId 附一行「前身(日期): 摘要」指针，只花预算剩余空间不占整行名额（照 tokens.ts:41-114 投影规矩），整链靠显式 ?drill/--history，不往候选池加行（PRF 挤预算的教训）。
- **评审最终意见**：approved。前提从「补不可逆审计」更正为「补进程间不丢的历史」是上轮修正的要点，本轮已落地。

### P7 本机隔离：principal 令牌 + 每账户分库 — effort: large / risk: high / impact: medium

- **灵感来源**：腾讯 v3「数据面强制三元组、不听调用方自报」原则（**笔记级**：v3-api-memorycore-doc.md:55，本工作区无源不可复核；机制全按本仓现实设计——README:278 自认 0600 在 Windows 无效、dependencies {} 本会话核实）。
- **针对 gap**：gap2（身份=OS 用户名，HTTP 只有 loopback+Origin，另一个本地进程报名字即读别人分区）。**威胁模型先讲清（上轮意见成立，本笔记如实保留）**：同账户进程能读 key 也能直接开 SQLite 文件，任何 token 都挡不住；持有唯一 secret 的共享 daemon 只能挡跨 principal、挡不住它自己声称要防的场景——所以「单 daemon 多 principal」模型本身放弃。
- **改动点**：零改名第一步：daemon 绑定唯一 principal（key 文件 POSIX 0600 / Windows 靠 %APPDATA% 继承 ACL），请求须带 token，server 用 principal 覆写 namespace 的 user 段、越界 403；namespace 文本不改，存量行与既有测试原样可读。多账户机器改为每账户各自 db 文件与端口；跨 principal 共享走显式导出。同账户进程不防、整库 at-rest 加密零依赖下不做——两条写进新 ADR 的「不做什么」；日后匿名化成 HMAC id 走 principal_id 列+namespace_aliases 双读再批量 UPDATE（照 sqlite.ts:1194 改名形制）；key 丢失用 `principal recover --from-db` 反推重置。
- **评审最终意见**：approved，但评审在 missing 中明确指出：**gap2 的 at-rest 加密一半仍未真正关闭**（P7 明文宣布不做，只把边界写进 ADR/README）；同 OS 账户攻击面明确不防——声明诚实，但盘点原文「无 at-rest 加密」这条是**划出边界而非解决**。

### P8 本地 embedder 预设 + 桶摘要预筛 — effort: large / risk: high / impact: medium

- **灵感来源**：OpenViking 增量刷新阈值（**本地可核**：abstract_over.py:680 与 freshness_policy.py:36 refresh_ratio=0.10 默认，核实于其会话）；腾讯 L2/L3 先注入（**笔记级**，云文档）。
- **针对 gap**：gap5 两半。意译半：embedding/index.ts:45-48 硬性要求非空 key、openai.ts:56 恒发 Bearer 头，本地 Ollama/LM Studio 端点进不来，hash embedder 下 vector 权重为 0。规模半：向量臂全分区暴力扫，4k 行 62ms、10^5 行外推 ~2s/1.3GB（README:530,534）。
- **改动点**：小的一半（低成本）：加 key 可为空的本地 OpenAI 兼容 preset，健康卡/KEY_ENVS/console 校验跟上，切换仍走 ADR-0009 settings+restart+reembedAll，依赖仍为零。大的一半（默认关）：新桶摘要表（namespace/project 级 abstract+embedding+pending/total），由 P2 维护作业按 ≥10% 阈值增量刷新；向量臂先在桶摘要上选 top-b 再只扫命中桶；与 ADR-0029「分桶曾丢 56% vector top-5」直接冲突，故硬验收线：预筛后 top-20 与全扫描一致率 ≥99%、evidence-all 不低于基线 66%、scale-bench p50 与 10^5 行外推 <700ms；不达标默认关并把负面结果写进 ADR。
- **评审最终意见**：approved，附实施修正：**验收基线应取现行 10.3ms 而非 28.6ms**（本会话核实：docs/adr/0029*:82 表格行「| search p50 | 28.6 ms | **10.3 ms** | 2.8x |」——28.6 是旧值，方案照抄会被过时基线放水）。评审 missing 同时指出：不达标则回退为一份负面结果 ADR，**10^5 行 ~2s/1.3GB 上限原样存在**（有 ADR-0025/0026 先例背书，属可接受的诚实半覆盖）。

---

## 4. 下一步建议（按先易后难）

1. **P1 批量写入口补确定门**——三门中只有它是零网络、低风险；同时顺手修 import.ts 注释错误。可立即开工，无需拍板。
2. **P2 自动触发遗忘（附 use_count）**——工作量中等、风险集中在判据替换；开工前落实评审修正：保留 durable-kind 跳过与 importance 地板。MEMORY_MAINTAIN_HOURS 默认 24h 属可配置项，不必拍板。
3. **P3 存量 triage（先 dry-run）**——只在有 P1 之后做才有意义（增量门先补上，避免边清边灌）；89% 从未检索的存量 junk 是唯一直接收益证据。⚖️ **需用户拍板**：是否推翻 ADR-0040「No retroactive curation」的既有决定（P1 同时推翻 :103 那句，两件事可打包为一个 ADR amendment）。
4. **P6 写史表+双时间线**——纯加列/加表、可见性零改动，P3/P5 的裁决理由落库后才有审计价值，可与其并行。
5. **P4 facet 索引与第三候选臂（默认 MEMORY_LINKS=off）**——large effort 但 P5 依赖它；验收靠 multi-hop n=32 + evidence ruler 实测。⚖️ **需用户拍板**：large 工作量是否现在投入；若实测净负，按 ADR-0026/0028 先例留 flag 的止损决定。
6. **P5 矛盾扩窗+conflict 标记**——P4 落地后顺次开工；judge 失败是否落 tag 一项 ⚖️ **待决**（ADR-0041 amendment，材料明确列为待用户裁决）。
7. **P8 小的一半（本地 embedder preset）**——成本低、解锁意译检索，可独立于大的一半先做。⚖️ **需用户拍板（仅大的一半）**：桶摘要预筛与 ADR-0029 正面冲突，默认关+硬验收线（基线按评审修正取 10.3ms）；不达标即停。
8. **P7 本机隔离**——large/high risk，且只解决跨 principal 半、明文放弃同账户攻击面与 at-rest 加密。⚖️ **需用户拍板，且是产品定位问题**：威胁模型「单 daemon 单 principal + 每账户分库」是否成立、README:278 的说法改成什么。评审已把它列为「声明诚实但未关闭 gap2」——要不要做、做到哪一步只能由用户定。

总原则沿用材料：先零成本确定门（P1）后模型调用；先建增量（P3 依赖 P1）后清存量；默认全走 flag/dry-run，负面结果照 ADR 先例写进文档。

---

## 附录 A：本会话抽查记录

以下为本笔记撰写会话中实际执行的命令与结果（其余引用沿用材料出处，未复验者已在正文标注「笔记级」或「材料称」）：

| 检查 | 命令 | 结果 |
|------|------|------|
| 无调度器（gap1） | `grep -rnE "setInterval\|cron\|schedule" C:\memory\src` | 命中全部为注释/无关文本（facets.ts 的 acronym、bench/realtime.ts 注释、decay.ts:39 的 "scheduled job" 注释本身）——确认无调度器 ✅ |
| saveMany 绕门（gap6/P1） | 读 src/core/memoryService.ts:330-383 | saveMany 注释与实现确认 curation/reconcile 默认 off ✅ |
| /decay 手动（gap1/P2） | 读 src/api/server.ts:490-500 | POST /decay → runDecayDetailed 逐行命中 ✅ |
| secret 拒写（P1） | 读 src/core/write/curation.ts:155-170 | SECRET_PATTERNS 确在 :159-167 ✅ |
| README 数字 | grep README.md | :18/:374 69.1%；:375 multi-hop 34%；:391-392 gold 13% ✅ |
| ADR-0040 | 读 docs/adr/0040-writes-are-curated.md | :103 「`saveMany` keeps curation off」、:120/:135 No retroactive curation、:22 459 (89%) 全部逐字命中 ✅（注意：文件名实为 0040-writes-are-curated.md，材料部分处写作 0040-curation-gate-before-embed.md，以实文为准） |
| P2 评审修正依据 | 读 decay.ts:105-120、sqlite.ts:1768-1776 | :110 isDurableKind 跳过、:117 importance 地板、strength +0.02 且 MIN(0.95) 饱和 ✅ |
| P8 评审修正依据 | grep "28.6\|10.3" docs/adr/0029* | :82 「28.6 ms → 10.3 ms」——验收基线应取 10.3ms ✅ |
| hybrid 无 facet 臂（P4） | grep tag\|facet src/core/retrieval/hybrid.ts | 命中均为无关注释，无候选臂引用 ✅ |
| facets 写侧（P4） | 读 src/core/write/facets.ts:142-146,200-211 | :144 deriveFacets、:200 buildTags ✅ |
| import.ts 注释矛盾（P1） | 读 src/migrate/import.ts:11-16 | 「走正常 save、近重复会折叠」与 saveMany 实现相反 ✅ |
| 本地 bench 源 | 读 bench/OpenViking/.../memory_lifecycle.py:13-49；bench/.venv-mem0/.../storage.py:106-120、main.py:422-426,705-709；bench/REPORT.md | 半衰期 7.0/score 公式/freq；history 表 10 列；_entity_collection_name/_link_entities_for_memory；mem0 14.5%、multi-hop 6% ✅ |

**未能复跑、按笔记级采信的项**：各核实员对外部仓库（TencentDB commit 2002196、OpenViking main@1bee7385、graphiti main、letta 0.16.8、MemOS d326a64）的克隆与 grep、对云厂商文档页的 fetch——本会话仅确认其引用形状与本工作区本地克隆一致处（OpenViking、mem0 两处命中），远程页面内容未重取。Graphiti 核实员自述「未跑任何运行时验证，全部静态核对」。
