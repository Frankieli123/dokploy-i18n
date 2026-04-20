# 上游更新吸收计划

本目录用于管理 `dokploy-i18n` 吸收 Dokploy 上游更新的计划与执行记录。

## 当前基线

- 我们当前版本：`v0.28.8-i18n.10`
- 对应上游基线：`v0.27.0`
- 当前原则：**不直接整体跟随 `upstream/main`，只按小版本逐个审查、逐个决定是否吸收**

## 目录结构

- `master-plan.md`：总计划，定义目标、约束、优先级、流程
- `versions/TEMPLATE.md`：单个小版本详细计划模板
- `versions/*.md`：每个小版本的详细对比、取舍、执行与验证记录

## 硬性原则

1. **不能删除或削弱我们项目已新增的功能**
2. **如果上游变更与本地新增功能冲突，必须先整理冲突点并询问，再决定如何处理**
3. 优先吸收：
   - 安全修复
   - 数据一致性修复
   - 部署/备份/回滚稳定性修复
   - 与我们现有能力直接相关的通用增强
4. 谨慎吸收：
   - Enterprise / Pricing / License 强绑定功能
   - 会大范围冲击本地 AI / MCP / i18n / Volume Backup / Domains 改造的更新

## 版本队列

- [v0.27.1](./versions/v0.27.1.md)
- [v0.28.0](./versions/v0.28.0.md)
- [v0.28.1](./versions/v0.28.1.md)
- [v0.28.2](./versions/v0.28.2.md)
- [v0.28.3](./versions/v0.28.3.md)
- [v0.28.4](./versions/v0.28.4.md)
- [v0.28.5](./versions/v0.28.5.md)
- [v0.28.6](./versions/v0.28.6.md)
- [v0.28.7](./versions/v0.28.7.md)
- [v0.28.8](./versions/v0.28.8.md)

## 使用方式

每次只推进一个小版本：

1. 先阅读该版本详细计划
2. 补充受影响文件与冲突点
3. 决定 `吸收 / 部分吸收 / 暂缓 / 跳过`
4. 若涉及本地新增功能冲突，停止实施并先询问
5. 实施后回填验证结果
- `final-sync-summary.md`????????????
- `topics/environment-is-default-alignment.md`???????? upstream `isDefault` ?????????
