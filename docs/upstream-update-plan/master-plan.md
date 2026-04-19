# 总计划：逐步吸收 Dokploy 上游更新

## 1. 目标

在**不丢失本地定制功能**的前提下，尽可能把项目主干结构、路由、接口和关键行为向 Dokploy upstream 靠拢。

---

## 2. 当前判断

- 当前分叉版本：`v0.28.8-i18n`
- 对应上游基线：`v0.27.0`
- 已逐步审查并吸收到：`v0.28.8`

已经完成的主线版本：
- `v0.27.1`
- `v0.28.0`
- `v0.28.1`
- `v0.28.2`
- `v0.28.3`
- `v0.28.4`
- `v0.28.5`
- `v0.28.6`
- `v0.28.7`
- `v0.28.8`

---

## 3. 不可违反的约束

### 3.1 功能主权
以下本地能力必须保留：
- AI / MCP / AI 面板
- Git 独有设置与相关增强
- 备份增强
- 项目卡片快捷域名入口
- i18n

### 3.2 冲突处理
如果上游改动会：
- 覆盖本地定制功能
- 改变现有数据语义
- 让用户已有能力被削弱

则不能机械合并，必须改成兼容迁移或保留本地薄兼容层。

### 3.3 实施边界
- 不直接 `merge upstream/main`
- 以逐版本、逐专题方式推进
- 优先做低风险高价值同步
- 对高冲突项先专题审查，再决定是否落地

---

## 4. 每个小版本的标准流程

1. 看 release note / compare
2. 列出上游变更点
3. 对照本地热改区
4. 分成：
   - 必吸收
   - 建议吸收
   - 本地已覆盖
   - 暂不机械吸收
5. 如有必要，拆成专题
6. 实施后做验证
7. 回填文档

---

## 5. 当前阶段性结果

### 5.1 已深度对齐的主干
- 大依赖升级底座
- permissions / custom roles / audit logs
- SSO / trusted origins / trusted providers
- Search API / UI 主干
- Deployments Dashboard / Queue 主干
- `project.all` / `projects.show` 第一轮瘦身
- `custom-role / sso` 目录与 router 结构上游化

### 5.2 已完成的专题
- `backup / restore 路径语义` 第一阶段兼容迁移
- `rollback / deployment cleanup` 专题审查与低风险项收口

### 5.3 当前剩余差异的主要类型
1. 必须保留的本地定制层
2. 值得继续同步的结构性细节
3. 可接受的微小视觉/交互差异

详见：
- `docs/upstream-update-plan/current-diff-review.md`

---

## 6. 后续优先顺序

当前更值得继续投入的是：

1. `deployments` 视觉与交互精修
2. `search` UI 细节精修
3. `project.all / projects.show` 最后一点结构与交互收口

补充：
- `deployments` 页面 SSR 权限检查已继续向 upstream 对齐

不建议优先继续投入的是：

1. rollback 架构策略继续硬并
2. 备份路径语义第二阶段硬迁移
3. 为了结构一致而收紧 enterprise / license gate

---

## 7. 交付标准

某一轮工作只有在以下条件满足时才算完成：

- 已完成代码或专题审查
- 已明确保留/同步/跳过原因
- 未破坏本地定制功能
- 已通过必要验证：
  - `pnpm --filter=server run typecheck`
  - `pnpm --filter=dokploy run typecheck`
  - `pnpm --filter=dokploy run generate:openapi`

---

## 8. 当前建议

当前主干已经比较接近 upstream。  
下一步最合理的方向不是继续啃高风险专题，而是：

### 继续收口结构细节
- `project.all / projects.show`
- `deployments`
- `search`

这样能进一步降低后续跟 upstream 的成本，同时不动坏本地定制功能。

## ???? 2026-04-18
- ????? Search UI????????????
- ???????????1) deployments ???? 2) search ???? 3) project ???????

- `project.all` ????? upstream ?????`organizationId / env`??

- `environment.isDefault` ????????????
