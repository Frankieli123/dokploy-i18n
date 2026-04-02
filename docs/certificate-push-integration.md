# Dokploy 证书推送集成说明（准确版）

## 1. 结论

当前项目里，外部证书接入有两条路：

1. **走项目内置证书接口**：`POST /api/certificates.create`
   - 会写数据库
   - 会尝试把证书文件写到 Traefik dynamic 目录下的子目录
   - 证书会出现在 Dokploy 证书列表
   - 但当前实现有几个限制：
     - 没有 update 接口
     - `autoRenew` 只是展示字段，没有自动续期任务
     - 远程 `serverId` 场景下，接口成功返回不等于远端文件已经写完
     - 子目录热加载存在不稳定风险

2. **直接写 Traefik dynamic 文件**：`POST /api/settings.updateTraefikFile`
   - 推荐把 `crt / key / yml` **平铺写到** `/etc/dokploy/traefik/dynamic` 顶层
   - 更适合外部证书签发/续期系统做幂等覆盖
   - 不依赖随机 `certificatePath`
   - 但不会进入 Dokploy 证书表

如果你的目标是：
- **让证书显示在 Dokploy 证书页**：走 `certificates.create`
- **让外部续期系统稳定接管证书落盘**：走 `settings.updateTraefikFile` 顶层平铺方案

---

## 2. 代码定位

- 证书创建入口：`apps/dokploy/server/api/routers/certificate.ts`
- 证书写盘实现：`packages/server/src/services/certificate.ts`
- 证书 schema：`packages/server/src/db/schema/certificate.ts`
- Traefik 路径定义：`packages/server/src/constants/index.ts`
- Traefik 主配置生成：`packages/server/src/setup/traefik-setup.ts`
- Traefik 文件读写接口：`apps/dokploy/server/api/routers/settings.ts`
- Traefik 文件写入实现：`packages/server/src/utils/traefik/application.ts`
- 域名 router 规则（文件路由）：`packages/server/src/utils/traefik/domain.ts`
- 域名 router 规则（compose / labels）：`packages/server/src/utils/docker/domain.ts`
- 域名创建/更新服务：`packages/server/src/services/domain.ts`
- API Key 鉴权：`packages/server/src/lib/auth.ts`

---

## 3. 当前项目内置证书机制

### 3.1 创建接口

- 路径：`POST /api/certificates.create`
- 鉴权头：`x-api-key`
- 权限：**owner only**
  - 该接口使用 `adminProcedure`
  - 当前实现里 `adminProcedure` 实际只允许 `ctx.user.role === "owner"`

### 3.2 请求体

按当前实现，外部调用建议传：

```json
{
  "name": "example.com",
  "certificateData": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
  "privateKey": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----",
  "organizationId": "",
  "autoRenew": false,
  "serverId": "optional-remote-server-id"
}
```

说明：

- `name`：任意非空字符串，通常填主域名
- `certificateData`：非空字符串；**建议传 PEM fullchain**
- `privateKey`：非空字符串；**建议传 PEM 私钥**
- `organizationId`：**当前 schema 仍要求有这个字段**，但业务上会被后端用当前会话的 `activeOrganizationId` 覆盖；前端当前也是传空字符串占位
- `autoRenew`：可选；当前仅作为记录字段显示
- `serverId`：
  - 自托管：可不传，默认写 Dokploy 所在机器
  - 云环境：必须传

### 3.3 落盘结果

后端会把证书写到：

```text
/etc/dokploy/traefik/dynamic/certificates/<certificatePath>/
├─ chain.crt
├─ privkey.key
└─ certificate.yml
```

其中 `certificate.yml` 等价于：

```yaml
tls:
  certificates:
    - certFile: /etc/dokploy/traefik/dynamic/certificates/<certificatePath>/chain.crt
      keyFile: /etc/dokploy/traefik/dynamic/certificates/<certificatePath>/privkey.key
```

### 3.4 当前实现的几个关键事实

1. **没有证书 update 接口**
   - 当前 router 只有 `create / one / all / remove`
   - 想原位覆盖续期，需要你自己删后重建，或绕开它直接写 Traefik 文件

2. **`autoRenew` 只是字段**
   - 当前仓库中没有基于 `autoRenew` 的调度、续期或回写逻辑
   - UI 里“已启用自动续期”只是展示文案，不代表系统真会续期

3. **证书和域名没有 `certificateId` 绑定关系**
   - `domain` 表没有 `certificateId`
   - Dokploy 不是 `domain -> certificateId -> cert file` 这种显式绑定
   - 实际上仍是 Traefik 按 SNI / 已加载证书集去匹配

4. **远程 `serverId` 场景下写盘不是严格同步确认**
   - `createCertificate()` 插库后调用 `createCertificateFiles(cer)`，但没有 `await`
   - 本地分支因为使用同步 `fs.writeFileSync`，通常问题不大
   - 远程分支依赖 `execAsyncRemote(...)`，接口成功返回时，远端写盘可能仍在进行中

5. **子目录热加载存在风险**
   - Dokploy 当前把证书 yml 写到 `dynamic/certificates/<子目录>/certificate.yml`
   - Traefik 当前监听的是 `directory: /etc/dokploy/traefik/dynamic`
   - 按 Traefik 官方 file provider 文档的 fsnotify 限制说明，以及历史 issue，子目录动态监听/热更新并不适合作为稳定生产假设
   - 因此：`/api/certificates.create` 更适合“录入到 Dokploy 证书列表”，不适合作为外部续期系统的唯一稳定落盘链路

---

## 4. 域名如何真正消费证书

## 4.1 先区分两类域名

### A. application / preview 域名

这类域名走 Dokploy 写 Traefik 文件路由：

- 创建 application 域名时，会立即调用 `manageDomain(...)`
- 更新 application 域名时，也会立即重写对应 Traefik 文件

因此：
- 如果域名已经存在并且 `https` 配置正确，后续你只更新证书文件，Traefik 有机会自动吃到

### B. compose 域名

这类域名不是立即改 Traefik file，而是把域名规则写进 compose labels：

- create / update 域名只是改数据库
- 真正的 labels 是在部署 / 重部署 compose 时由 `writeDomainsToCompose(...)` 写入 compose 文件后生效

因此：
- **compose 项目第一次启用 `https` / 修改 `certificateType` 后，通常需要 redeploy 一次**
- 之后如果只是续期覆盖静态证书文件，则不需要每次 redeploy

## 4.2 仅有“证书文件已存在”还不够

证书想真正被访问流量命中，至少要同时满足：

1. Traefik 已加载该证书文件
2. 该域名已经有 HTTPS router（即能进 `websecure`）
3. 请求的 SNI 与证书匹配

## 4.3 `certificateType = "none"` 的准确含义

这点最容易被误解。

它**不等于**“Dokploy 一定只会使用你上传的静态证书”。

它真正表示的是：

- 在 **文件路由模式** 下，Dokploy 不再给该 router 显式写 `router.tls.certResolver`
- 在 **compose / Docker labels 模式** 下，Dokploy 仍会写 `tls=true`，但不再额外写 `tls.certresolver=...`

但是，Dokploy 默认生成的 Traefik 主配置里，`websecure` entryPoint 本身还配置了：

```yaml
entryPoints:
  websecure:
    http:
      tls:
        certResolver: letsencrypt
```

这意味着：

- `certificateType = "none"` 只能保证“**路由级**不再额外指定 certResolver”
- **不能仅凭 Dokploy 代码就推出：Traefik 一定完全不会再碰 Let’s Encrypt resolver**

所以更准确的建议是：

- 如果你想让 Dokploy 不再给该域名写“路由级 resolver”，配 `https=true + certificateType=none`
- 如果你想要“只依赖 file provider 静态证书”这一语义更加确定，最好再检查/调整 Traefik 主配置里的 entryPoint 默认 `certResolver`

## 4.4 `certificateType` 三种值的真实效果

- `certificateType = "letsencrypt"`
  - Dokploy 会给域名 router 显式写 `letsencrypt` resolver
- `certificateType = "custom"`
  - Dokploy 会给域名 router 显式写 `customCertResolver`
- `certificateType = "none"`
  - Dokploy 不再给该域名 router 显式写 resolver
  - 但 entryPoint 默认 resolver 是否仍生效，要看当前 Traefik 主配置

---

## 5. 鉴权方式

## 5.1 实际可用请求头

实际运行时认证读取的是：

```http
x-api-key: <YOUR_API_KEY>
```

运行时代码见：`packages/server/src/lib/auth.ts`

## 5.2 两个接口的权限差异

### `/api/certificates.create`

- 必须登录/带 API Key
- 且当前用户角色必须是 **owner**

### `/api/settings.updateTraefikFile`

- 只要求 `protectedProcedure`
- 即：有合法 session / API Key 即可进入
- 但如果用户角色是 `member`，还必须有 `canAccessToTraefikFiles`
- `owner / admin` 默认可用

因此：
- 对外部证书系统来说，最简单还是直接用 **owner 的 API Key**

---

## 6. 推荐对接方案

## 6.1 方案 A：沿用项目现有证书接口

适用：

- 你希望证书出现在 Dokploy 证书列表
- 你能接受当前实现限制

流程：

1. 外部证书系统申请/续期成功
2. `POST /api/certificates.create`
3. 域名具备 HTTPS router
   - application / preview：更新域名时会即时改 Traefik 文件
   - compose：首次改 HTTPS 相关配置后需要 redeploy 一次

示例：

```bash
curl -X POST 'https://your-dokploy-host/api/certificates.create' \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: YOUR_API_KEY' \
  -d '{
    "name": "example.com",
    "certificateData": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
    "privateKey": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----",
    "organizationId": "",
    "autoRenew": false
  }'
```

限制：

- 没有 update
- `autoRenew` 不会自动执行
- 远程写盘不是严格同步确认
- 子目录热加载存在风险

## 6.2 方案 B：外部项目直接平铺写 Traefik dynamic 文件（推荐）

适用：

- 你要稳定可控
- 你要支持幂等续期覆盖
- 你不依赖 Dokploy 证书列表做状态管理

建议写到：

```text
/etc/dokploy/traefik/dynamic/
├─ cert-example.com.crt
├─ cert-example.com.key
└─ cert-example.com.yml
```

其中：

```yaml
tls:
  certificates:
    - certFile: /etc/dokploy/traefik/dynamic/cert-example.com.crt
      keyFile: /etc/dokploy/traefik/dynamic/cert-example.com.key
```

建议顺序：

1. 写 `.crt`
2. 写 `.key`
3. 最后写 `.yml`

### 6.2.1 最稳定写入方式（避免“必须重启 Traefik 才生效”）

Traefik 的 file provider 监听的是 **dynamic 配置文件变更**（`.yml/.toml`），而不是保证会可靠地因为 `certFile/keyFile` 内容变化就立刻重载证书。

因此，外部系统想做到尽量“无感生效”，推荐按下面的稳定规则写入：

1) **固定写入目录（顶层）**

- 只写 `/etc/dokploy/traefik/dynamic/*`
- 不要把证书 yml 写到子目录（例如 `dynamic/certificates/**`）

2) **固定命名（幂等覆盖）**

以主域名作为文件名前缀（SAN 多域名证书也适用）：

```text
/etc/dokploy/traefik/dynamic/
├─ mm.slee.cc.crt
├─ mm.slee.cc.key
└─ mm.slee.cc.yml
```

> SAN 证书覆盖哪些域名，取决于证书里的 `Subject Alternative Name`，不取决于文件名。只要 Traefik 已加载该证书，SNI 匹配到任意 SAN 域名都会使用它。

3) **严格写入顺序（核心）**

- 先写 `.crt`（建议 fullchain）
- 再写 `.key`
- **最后写 `.yml`**（让 `.yml` 作为“触发重载”的信号）

4) **确保 `.yml` 每次都会变更**

如果你续期后 `.yml` 内容完全一样，某些环境下可能出现监听不触发/触发不稳定。
最稳做法是每次写 `.yml` 时追加一个更新时间注释（只影响文件内容，不影响 Traefik 解析）：

```yaml
tls:
  certificates:
    - certFile: /etc/dokploy/traefik/dynamic/mm.slee.cc.crt
      keyFile: /etc/dokploy/traefik/dynamic/mm.slee.cc.key
# updatedAt: 2026-04-02T16:00:00+08:00
```

5) **写完后验证（一定要带 SNI）**

不要用 IP 去看证书（会拿到 Traefik default cert）。用域名 + SNI 验证：

```bash
echo | openssl s_client -connect mm.slee.cc:443 -servername mm.slee.cc 2>/dev/null \
  | openssl x509 -noout -subject -dates -ext subjectAltName
```

6) **兜底（要 100% 立即生效）**

如果你业务上要求“写完立刻 100% 生效”，可以在写完 `.yml` 后调用一次：

`POST /api/settings.reloadTraefik`（owner 权限；可选 `serverId`）

它会重载/重启 Traefik 服务作为兜底（代价是短暂连接抖动）。

如果目标是远程 server，则每次请求都额外带：

```json
{
  "serverId": "target-server-id"
}
```

### 1) 写 crt

```bash
curl -X POST 'https://your-dokploy-host/api/settings.updateTraefikFile' \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: YOUR_API_KEY' \
  -d '{
    "path": "/etc/dokploy/traefik/dynamic/cert-example.com.crt",
    "traefikConfig": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"
  }'
```

### 2) 写 key

```bash
curl -X POST 'https://your-dokploy-host/api/settings.updateTraefikFile' \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: YOUR_API_KEY' \
  -d '{
    "path": "/etc/dokploy/traefik/dynamic/cert-example.com.key",
    "traefikConfig": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
  }'
```

### 3) 写顶层 yml

```bash
curl -X POST 'https://your-dokploy-host/api/settings.updateTraefikFile' \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: YOUR_API_KEY' \
  -d '{
    "path": "/etc/dokploy/traefik/dynamic/cert-example.com.yml",
    "traefikConfig": "tls:\n  certificates:\n    - certFile: /etc/dokploy/traefik/dynamic/cert-example.com.crt\n      keyFile: /etc/dokploy/traefik/dynamic/cert-example.com.key\n"
  }'
```

优点：

- 可重复覆盖
- 不依赖随机 `certificatePath`
- 更符合 Traefik `directory` watch 的使用方式
- 更适合作为外部续期系统落盘链路

注意：

- 该接口当前不会帮你校验 YAML / 证书内容是否合法
- `path` 当前也没有像 `readTraefikFile` 那样做路径白名单约束
- 因此外部系统应**只写自己约定的 `/etc/dokploy/traefik/dynamic/*` 文件**

---

## 7. 推荐落地策略

推荐外部证书系统维护：

```json
{
  "domain": "example.com",
  "targetDokployUrl": "https://your-dokploy-host",
  "targetServerId": null,
  "mode": "flat-files",
  "crtPath": "/etc/dokploy/traefik/dynamic/cert-example.com.crt",
  "keyPath": "/etc/dokploy/traefik/dynamic/cert-example.com.key",
  "ymlPath": "/etc/dokploy/traefik/dynamic/cert-example.com.yml"
}
```

推荐流程：

1. 先把域名在 Dokploy 里配好 HTTPS
2. 如果是 compose 域名，首次启用 HTTPS / 修改 `certificateType` 后做一次 redeploy
3. 外部续期成功后，只覆盖 `crt / key / yml`
4. 不依赖 Dokploy 证书表维护续期状态

---

## 8. 这份文档与旧版相比，修正了什么

本版特意修正了以下容易误导的点：

1. `organizationId` 在当前 `certificates.create` schema 下仍需要传占位值
2. `certificateType = none` 不等于“Traefik 一定只使用静态证书”
3. 远程 `serverId` 场景下，`certificates.create` 不是严格同步写盘确认
4. compose 域名与 application 域名的生效链路不同，compose 首次改 HTTPS 相关配置通常要 redeploy
5. 子目录 watch 风险保留为“生产上不宜依赖的风险提示”，而不是绝对结论

---

## 9. 外部参考

- Traefik File provider：<https://doc.traefik.io/traefik/providers/file/>
- Traefik EntryPoints：<https://doc.traefik.io/traefik/reference/install-configuration/entrypoints>
- Traefik TLS certificates：<https://doc.traefik.io/traefik/reference/routing-configuration/http/tls/tls-certificates/>
- Traefik 历史 issue（子目录动态加载）：<https://github.com/traefik/traefik/issues/3986>
