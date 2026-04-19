# Environment `isDefault` 对齐专题

## 当前状态
- 状态：第一阶段已完成
- 目标：将环境默认语义从 `name === "production"` 逐步对齐到 upstream 的 `isDefault`

## 本轮已落地

### 1. Schema 与 migration
- `packages/server/src/db/schema/environment.ts`
  - 新增 `isDefault: boolean("isDefault").notNull().default(false)`
- `apps/dokploy/drizzle/0156_environment_is_default.sql`
  - 新增字段
  - 优先将现有 `production` 环境回填为默认环境
  - 对没有默认环境的项目回退到最早创建的环境

### 2. 服务层兼容
- `packages/server/src/services/environment.ts`
  - 查询结果包含 `isDefault`
  - 删除默认环境时改为基于 `isDefault` 判断
  - 同时保留 `name === "production"` fallback
  - 自动创建生产环境时写入 `isDefault = true`
  - duplicate 环境显式写入 `isDefault = false`

### 3. Router / UI 收口
- `apps/dokploy/server/api/routers/environment.ts`
  - 默认环境禁止重命名
  - 非默认环境仍禁止直接改名为 `production`
- `apps/dokploy/server/api/routers/project.ts`
  - `project.all` / `allForPermissions` / `search` 补出环境的 `isDefault`
- `apps/dokploy/components/dashboard/projects/show.tsx`
  - 环境选择优先 `isDefault`，回退 `production`
- `apps/dokploy/components/dashboard/search-command.tsx`
  - 项目结果环境选择优先 `isDefault`
- `apps/dokploy/components/dashboard/project/advanced-environment-selector.tsx`
  - 默认环境识别改为 `isDefault` 优先
  - 删除后跳转默认环境时也优先 `isDefault`

## 兼容策略
- 旧数据仍可依赖 `production` 名称回退
- 新数据开始显式依赖 `isDefault`
- 不是一次性硬切，而是“有字段优先、旧语义兜底”

## 影响评估
- 不影响 AI 面板
- 不影响 Git 独有设置
- 不影响备份增强
- 对项目/搜索/环境切换是正向结构对齐

## 已验证
- `pnpm --filter=server run typecheck`
- `pnpm --filter=dokploy run typecheck`
- `pnpm --filter=dokploy run generate:openapi`

## 后续可选
如果以后继续追求更彻底对齐，可再做：
- 逐步减少代码里对 `name === "production"` 的 fallback
- 增加“切换默认环境”能力（如果未来 upstream 引入更明确的环境默认管理）
