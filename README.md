# Cloudflare SaaS 智能优选控制台

基于 Cloudflare Workers / Pages 与 D1 数据库构建的单文件全栈边缘网络控制台，用于将部署在 Cloudflare Pages 或 Workers 上的业务服务通过 **Cloudflare SaaS 自定义主机名** 接入自有域名，并联动国内主流云解析服务商实现**境内优选加速 + 境外自动回源**的双线智能调度。

---

## 核心功能与用途

- **双线智能分流与 SaaS 边缘中继**
  - 自动创建 `saas-origin.<中转域>` 回退源锚点并部署独立分流中继 Worker（`saas-origin-router`）。
  - 支持单个中转域名同时挂载多个独立的 Pages 项目或 Workers 脚本，互不冲突。
  - 自动在云解析端配置双线记录：**境内 / 三网线路**指向优选 IP 或优选 CNAME，**默认 / 境外线路**指向 SaaS 回退源以完成 HTTPS 边缘证书自动签发与回源。
- **多云 DNS 统一管理**
  - 原生集成 **华为云 DNS**、**腾讯云 DNSPod**、**阿里云云解析 DNS** 签名算法，支持多云厂商凭据托管与一键热切换。
- **实时优选节点采集与调度**
  - **六地区优选 IP 池**：实时采集香港（HK）、台湾（TW）、日本（JP）、韩国（KR）、新加坡（SG）、美国（US）节点延迟（自动剥离端口号），默认优先选用香港最优 IP。
  - **近 24 小时优选域名榜**：实时同步三网综合评分最高的 CNAME 优选域名。
- **三网分项遥测与全链路自检**
  - 内置中国电信、中国联通、中国移动三网并发遥测，直观展示各运营商平均延迟。
  - 提供一键全面自检与修复引擎，自动清理残留主机名与冲突 CAA 记录，重构边缘路由映射并轮询 SSL 证书状态。
- **零外部依赖单文件架构**
  - 全部后端 API、密码学签名（HMAC-SHA256 / HMAC-SHA1）及前端响应式拓扑控制台均封装于单个 `_worker.js` 文件中，支持桌面端 12 栏栅格与移动端单栏流式自适应展示。

---

## 部署指南

### 1. 创建 D1 数据库
1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)，进入 **存储和数据库 → D1 SQL 数据库**。
2. 点击 **创建数据库**，建议命名为 `CFWUYA`。

### 2. 部署代码（支持 Workers 或 Pages）
- **方式 A：Cloudflare Workers 部署**
  1. 新建 Worker 项目，将 `_worker.js` 完整代码粘贴覆盖默认代码并部署。
  2. 进入 Worker 的 **设置 → 绑定 (Bindings)**，添加 **D1 数据库** 绑定：
     - **变量名称 (Variable name)**：`CFWUYA`（必须严格大写）
     - **D1 数据库**：选择已创建的数据库。
  3. 绑定保存后立即生效，访问 Worker 域名进入安装配置向导。

- **方式 B：Cloudflare Pages 部署**
  1. 将 `_worker.js` 推送至 Git 仓库并关联新建的 Cloudflare Pages 项目（或使用 Direct Upload 上传）。
  2. 进入 Pages 项目的 **设置 → 绑定 (Bindings)**，添加 **D1 数据库** 绑定，变量名称同样严格填写 `CFWUYA`。
  3. **关键步骤**：前往 Pages 的 **部署 (Deployments)** 页面，点击最新一条部署记录右侧的 **Retry deployment（重新部署）**，使 D1 绑定正式生效。

### 3. 初始化配置
首次打开部署域名时，页面将自动引导完成以下配置并加密存储至 D1：
1. **Cloudflare 凭据**：填写 Global API Key（需配合登录邮箱）或具备 `区域:读取`、`DNS:编辑`、`SSL和证书:编辑`、`Worker路由:编辑`、`Worker脚本:编辑`、`Cloudflare Pages:编辑` 权限的 API Token（邮箱留空）。
2. **中转域名准备**：确保所选 Cloudflare 中转域已在 **SSL/TLS → 自定义主机名** 中激活 SaaS 功能。
3. **云解析服务商密钥**：填写华为云、腾讯云或阿里云的 AK/SK 凭据并设置后台管理密码。

---

## 定时自动更新优选 IP

- **Cloudflare Workers 模式**：进入 Worker **设置 → 触发器 → Cron 触发器**，添加以下定时表达式（推荐每 12 小时执行一次）：

      0 */12 * * *

- **Cloudflare Pages 模式**：通过外部监控或定时任务请求以下接口（触发后自动抓取香港最新优选 IP 并批量更新全部已激活 SaaS 节点）：

      GET https://<你的部署域名>/api/auto-update-opt?token=<你的管理密码>

---

## API 凭据获取参考

| 平台 | 控制台地址 | 密钥获取地址 |
| :--- | :--- | :--- |
| **Cloudflare** | https://dash.cloudflare.com/ | https://dash.cloudflare.com/profile/api-tokens |
| **华为云 DNS** | https://console.huaweicloud.com/dns/ | https://console.huaweicloud.com/iam/#/mine/accessKey |
| **腾讯云 DNSPod** | https://console.cloud.tencent.com/cns | https://console.cloud.tencent.com/cam/capi |
| **阿里云 DNS** | https://dns.console.aliyun.com/ | https://ram.console.aliyun.com/manage/ak |