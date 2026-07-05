# 万能导入智能下单系统设计

## 1. 目标

基于考试要求，将当前项目从“简化版 Excel 导入页”升级为一套可扩展的“多格式智能导入下单系统”，满足以下核心目标：

1. 支持 `Excel / Word / PDF` 文件上传与解析。
2. 解析能力不能依赖“给某个文件写死 if-else”，而要基于可配置规则。
3. 支持用大模型先分析文件结构，再生成“解析规则建议”，由用户确认后生效。
4. 解析结果进入可编辑预览表格，完成校验、去重、修正、导出、提交。
5. 提交结果持久化到数据库，并支持历史查询。
6. UI 风格与当前冷链后台风格保持一致。
7. 满足 1000 行数据导入、预览、渲染的性能要求。

## 2. 系统定位

系统不是“解析 9 个样例文件”的演示页，而是一个可持续扩展的新格式接入平台。

设计原则：

1. 代码只实现“规则引擎 + 文件标准化 + 执行器”，不针对具体样例文件写特殊分支。
2. 新格式接入时，优先新增一条规则，不改业务代码。
3. AI 负责生成规则建议，不直接作为最终可信数据源。
4. 解析结果统一落到标准运单结构，后续校验、编辑、导出、提交全部复用。

## 3. 标准业务对象

### 3.1 运单头

- `externalCode`
- `receiverStore`
- `receiverName`
- `receiverPhone`
- `receiverAddress`
- `note`

### 3.2 运单明细

- `skuCode`
- `skuName`
- `skuQuantity`
- `skuSpec`

### 3.3 规则校验

收货信息按题目要求支持两组模式：

1. A 组：`receiverStore`
2. B 组：`receiverName + receiverPhone + receiverAddress`

校验规则：

1. A/B 两组至少一组完整。
2. `externalCode` 必填，并作为聚合与去重主键。
3. `skuCode`、`skuName`、`skuQuantity` 必填。
4. `skuQuantity` 必须为正整数。

## 4. 功能模块设计

### 4.1 模块一：规则管理中心

功能：

1. 规则列表：查看、搜索、复制、编辑、删除、启停。
2. 新建规则：手动配置解析规则。
3. AI 生成规则：上传文件后让模型输出规则建议。
4. 规则试解析：保存前对样例文件执行预览。
5. 规则版本：每次修改形成版本快照，支持回滚。

页面建议：

1. `规则列表页`
2. `规则编辑页`
3. `规则测试抽屉/弹窗`
4. `AI 建议对比面板`

### 4.2 模块二：文件导入与解析执行

流程：

1. 上传文件
2. 手动选择已有规则，或点击“新建规则”
3. 若新建规则，先调用 AI 生成规则建议
4. 用户确认或微调规则
5. 执行解析
6. 进入预览编辑页

要求：

1. 支持拖拽上传、点击上传。
2. 支持显示实时进度。
3. 解析失败时保留原文件摘要、错误信息、建议操作入口。

### 4.3 模块三：数据预览与在线编辑

功能：

1. 类 Excel 表格预览
2. 单元格直接编辑
3. 行内实时校验
4. 一次性展示全部错误
5. 批量删除、插入空行
6. 导出修正后的 Excel
7. 外部编码重复提示

建议：

1. 预览层展示“运单头 + SKU 明细”的扁平行。
2. 同一 `externalCode` 的多行高亮归组，方便用户理解聚合关系。

### 4.4 模块四：提交下单

功能：

1. 阻止含错误数据提交
2. 提交进度反馈
3. 数据持久化
4. 返回成功/失败汇总

建议：

1. 提交前先生成 `importBatch`
2. 再批量写入 `importShipment` 和 `importShipmentItem`
3. 保留原始解析结果与最终提交结果，便于审计

### 4.5 模块五：已导入运单列表

功能：

1. 历史记录查询
2. 按外部编码、收件人、提交时间搜索
3. 分页
4. 查看批次详情
5. 查看某批次对应规则版本与原文件

## 5. 规则引擎设计

### 5.1 设计目标

规则引擎需要表达以下复杂场景：

1. 跳过头部说明行
2. 从尾部文本区提取收货信息
3. 跨行聚合
4. 矩阵转置
5. 多 Sheet 合并
6. 卡片区域拆分
7. Word 纯文本解析
8. PDF 多单拆分
9. 复合单元格拆分

### 5.2 三层执行模型

建议采用三层结构：

1. `Document Loader`
   - 将 Excel / Word / PDF 转成统一的中间文档结构
2. `Rule Engine`
   - 根据规则执行分段、表头识别、字段提取、记录展开、聚合
3. `Normalizer`
   - 将结果映射为标准运单结构并输出校验结果

### 5.3 中间文档结构

统一抽象为：

```ts
type ParsedDocument = {
  fileType: "excel" | "word" | "pdf";
  sheets: ParsedSheet[];
  textBlocks: ParsedTextBlock[];
  tables: ParsedTable[];
};

type ParsedSheet = {
  name: string;
  rows: string[][];
};

type ParsedTable = {
  source: string;
  rows: string[][];
  page?: number;
};

type ParsedTextBlock = {
  source: string;
  text: string;
  page?: number;
};
```

这样规则执行器只面对统一结构，不感知原始文件格式差异。

### 5.4 规则 DSL

规则建议拆成以下几段：

```ts
type ImportRule = {
  id: string;
  name: string;
  version: number;
  fileType: "excel" | "word" | "pdf";
  inputScope: InputScopeConfig;
  segmentation: SegmentationConfig;
  tableDetection: TableDetectionConfig;
  extraction: ExtractionConfig;
  transforms: TransformConfig[];
  grouping: GroupingConfig;
  validationHints: ValidationHintConfig[];
};
```

关键段说明：

1. `inputScope`
   - 指定读取首个 sheet、全部 sheet、某页范围、全文本区等
2. `segmentation`
   - 定义按哪些标记拆文档，如“分隔线”“调拨记录 #N”“页边界”
3. `tableDetection`
   - 定义表头识别、数据起止、忽略合计行
4. `extraction`
   - 定义字段从哪里取值：列映射、正则、静态值、区域定位
5. `transforms`
   - 定义转置、拆分多值单元格、跨行继承、填充空值、多 sheet 合并
6. `grouping`
   - 定义按 `externalCode` 聚合成一个运单

### 5.5 示例能力

规则执行器至少内置这些通用 transform：

1. `skip_rows`
2. `pick_header_row`
3. `slice_rows`
4. `extract_by_column`
5. `extract_by_regex`
6. `inherit_previous_value`
7. `group_by_field`
8. `pivot_matrix`
9. `split_multiline_cell`
10. `iterate_sheets`
11. `split_cards_by_marker`
12. `split_pdf_orders_by_separator`
13. `ignore_summary_rows`

这些是“通用动作”，不是针对某个 demo 的硬编码。

## 6. AI 辅助规则生成设计

### 6.1 AI 的职责

AI 不直接输出最终运单数据，而是输出：

1. 文件结构摘要
2. 推荐的规则 DSL
3. 每个字段映射的置信度
4. 待人工确认的风险点

### 6.2 AI 处理流程

1. 服务端先把文件转换成轻量结构摘要
2. 将摘要、标准字段定义、规则 DSL Schema 一起发给大模型
3. 要求模型输出 JSON
4. 服务端做 JSON Schema 校验
5. 前端用“建议规则面板”展示 AI 结果
6. 用户确认后才保存为正式规则

### 6.3 Prompt 约束

Prompt 要强调：

1. 只能输出规则，不能伪造业务数据
2. 不确定的字段必须标记 `confidence < 0.8`
3. 对跨行、矩阵、卡片、尾部文本等结构必须单独说明

### 6.4 风险控制

1. AI 输出必须经过 schema 校验
2. AI 规则必须经过“试解析预览”
3. AI 建议项要高亮“推测”字段
4. 规则保存前必须人工确认

## 7. 页面与交互设计

### 7.1 页面结构

建议在当前 `/universal-import` 下拆为 3 个主标签页：

1. `导入中心`
2. `规则管理`
3. `历史运单`

### 7.2 导入中心

区域划分：

1. 上传区
2. 规则选择区
3. AI 建议区
4. 解析状态区
5. 预览表格区
6. 错误汇总区
7. 提交操作区

### 7.3 规则编辑页

建议使用“左侧配置 + 右侧试解析结果”的工作台布局：

1. 左侧编辑规则
2. 右侧立即显示解析样例
3. 底部显示 AI 建议与人工修改差异

### 7.4 风格要求

沿用当前仓库已建立的冷链后台视觉语言：

1. 主色 `#0fc6c2`
2. 圆角卡片
3. 浅青绿色层次
4. 顶部导航 + 左侧菜单 + 内容工作台

## 8. 数据模型设计

当前仓库已有 `UniversalImportTemplate / Batch / Record` 雏形，但字段结构仍是 V1 版本，不足以支撑考试题的“运单头 + SKU 明细 + 规则版本 + 多格式解析”。

建议升级为以下模型。

### 8.1 规则相关

```prisma
model ImportRule {
  id              String   @id @default(cuid())
  name            String   @db.VarChar(64)
  fileType        String   @db.VarChar(16)
  status          String   @db.VarChar(16)
  version         Int
  ruleDsl         Json
  sourceSample    Json?
  createdBy       String   @db.VarChar(32)
  updatedBy       String   @db.VarChar(32)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}
```

### 8.2 批次相关

```prisma
model ImportBatch {
  id                String   @id @default(cuid())
  batchName         String   @db.VarChar(64)
  originalFileName  String   @db.VarChar(128)
  fileType          String   @db.VarChar(16)
  ruleId            String?
  ruleVersion       Int?
  status            String   @db.VarChar(24)
  parseSummary      Json?
  createdBy         String   @db.VarChar(32)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
}
```

### 8.3 运单相关

```prisma
model ImportShipment {
  id               String   @id @default(cuid())
  batchId          String
  externalCode     String   @db.VarChar(64)
  receiverStore    String?  @db.VarChar(128)
  receiverName     String?  @db.VarChar(64)
  receiverPhone    String?  @db.VarChar(32)
  receiverAddress  String?  @db.VarChar(256)
  note             String?  @db.VarChar(256)
  rawPayload       Json
  createdAt        DateTime @default(now())
}

model ImportShipmentItem {
  id            String   @id @default(cuid())
  shipmentId    String
  skuCode       String   @db.VarChar(64)
  skuName       String   @db.VarChar(128)
  skuQuantity   Int
  skuSpec       String?  @db.VarChar(128)
  rawPayload    Json?
  createdAt     DateTime @default(now())
}
```

### 8.4 解析调试与审计

```prisma
model ImportParseTrace {
  id            String   @id @default(cuid())
  batchId       String
  stage         String   @db.VarChar(32)
  inputSnapshot Json?
  outputSnapshot Json?
  message       String?  @db.VarChar(256)
  createdAt     DateTime @default(now())
}
```

## 9. 接口设计

### 9.1 规则管理

- `GET /api/import-rules`
- `POST /api/import-rules`
- `GET /api/import-rules/:id`
- `PUT /api/import-rules/:id`
- `DELETE /api/import-rules/:id`
- `POST /api/import-rules/:id/test`

### 9.2 AI 规则生成

- `POST /api/import-rules/ai-suggest`

输入：

1. 文件摘要
2. 文件类型
3. 标准字段定义

输出：

1. `documentSummary`
2. `suggestedRule`
3. `confidenceReport`
4. `riskNotes`

### 9.3 导入与提交

- `POST /api/import-batches/parse`
- `POST /api/import-batches/submit`
- `GET /api/import-batches`
- `GET /api/import-batches/:id`
- `GET /api/import-shipments`

## 10. 性能设计

### 10.1 前端

1. 1000 行预览表格使用虚拟滚动。
2. 解析与校验放到 Web Worker，避免阻塞主线程。
3. 导入过程按阶段显示进度：读取文件、结构提取、规则执行、校验完成。
4. 错误列表与表格渲染分离，避免联动重渲染过大。

### 10.2 服务端

1. 规则测试与正式解析共用执行器。
2. 提交采用事务批量写入。
3. 历史查询加分页和索引。
4. AI 调用和规则执行分离，AI 耗时不计入本地解析主链路。

### 10.3 数据库索引

建议至少建立：

1. `ImportShipment.externalCode`
2. `ImportBatch.createdAt`
3. `ImportBatch.ruleId`
4. `ImportRule.fileType + status`

## 11. 与当前仓库的差距分析

当前项目已有能力：

1. 登录态
2. 后台风格 UI 框架
3. `/universal-import` 页面入口
4. Excel 表头自动映射
5. 本地预览编辑
6. 基础历史记录查询
7. 基础模板缓存

当前主要缺口：

1. 只支持 Excel，不支持 Word / PDF
2. 模板仍是“列映射”，不是规则 DSL
3. 没有 AI 规则生成功能
4. 数据模型还是旧版“寄件/收件/重量/温层”结构，不符合本次考试字段
5. 没有运单头和 SKU 明细聚合模型
6. 没有规则测试工作台
7. 没有多 Sheet、矩阵转置、卡片拆分、纯文本解析等通用 transform
8. 预览大表格尚未做虚拟化优化

## 12. 推荐实施顺序

### 第一阶段：重构数据结构

1. 改 Prisma 模型
2. 把标准对象切到“运单头 + SKU 明细”
3. 改历史查询接口

### 第二阶段：抽象规则引擎

1. 建立统一文档结构
2. 建立规则 DSL
3. 把现有 Excel 列映射迁移为 DSL 的一个最简单子集

### 第三阶段：完成规则管理 UI

1. 规则列表
2. 新建/编辑规则
3. 样例试解析

### 第四阶段：接入 AI 规则建议

1. 文件摘要器
2. AI 接口
3. JSON schema 校验
4. 建议规则对比 UI

### 第五阶段：补齐复杂格式能力

1. 多 Sheet
2. 尾部文本提取
3. 跨行聚合
4. 矩阵转置
5. 卡片拆分
6. Word 文本解析
7. PDF 多单拆分

### 第六阶段：性能与验收

1. 虚拟表格
2. Worker 化解析
3. 1000 行压测
4. Vercel 部署验收

## 13. 考试答辩可直接使用的系统描述

可以把系统一句话概括为：

“这是一个基于规则引擎的多格式智能导入下单系统。系统先把 Excel、Word、PDF 转成统一文档结构，再通过可配置规则完成分段、表头识别、字段提取、转置、聚合和校验；对于新文件格式，系统支持用大模型先生成规则建议，再由人工确认生效，因此新增格式时只需要新增规则，不需要改业务代码。”

## 14. 结论

按考试要求，最关键的不是做出一个能跑的导入页，而是证明系统具备：

1. 通用规则抽象能力
2. AI 生成规则而非硬编码解析的能力
3. 多格式统一处理能力
4. 大数据量下的可编辑预览能力
5. 可追溯、可持久化、可扩展的工程设计

当前仓库适合作为这个系统的前端后台壳与基础登录框架，但需要对 `universal-import` 模块做一次面向考试目标的架构升级。
