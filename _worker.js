<body>

<div class="toast-wrap" id="toastWrap"></div>

<div id="optModal" class="modal-mask hidden" onclick="if(event.target===this)closeOptModal()" onkeydown="if(event.key==='Escape')closeOptModal()">
  <div class="modal-card">
    <div class="modal-head">
      <div class="modal-title" id="optModalTitle">⚡ 优选节点选择 (默认优先香港 IP)</div>
      <div class="btn-flow" style="width:auto;">
        <button type="button" class="btn btn-sm" id="btnRefreshOptModal" onclick="loadOptModalList(true)">实时刷新</button>
        <button type="button" class="btn btn-danger btn-sm" onclick="closeOptModal()">关闭</button>
      </div>
    </div>

    <div class="btn-flow" id="optModalModeTabs">
      <button type="button" class="btn btn-sm btn-tab-active" id="tabOptIp" onclick="switchOptModalTab('ip')">优选IP</button>
      <button type="button" class="btn btn-sm" id="tabOptDomain" onclick="switchOptModalTab('domain')">优选域名</button>
    </div>

    <div class="wrap-text" id="optModalHint" style="font-size:12.5px; color:var(--text-muted);">
      按 6 个地区分组展示实时测速延迟（已自动去除端口），点击任意节点立即选用：
    </div>

    <div class="opt-rank-list" id="optRankList">
      <div class="wrap-text" style="text-align:center; padding:20px; color:var(--text-muted); font-size:13px;">正在采集节点数据...</div>
    </div>
  </div>
</div>

<div id="conflictModal" class="modal-mask hidden" onclick="if(event.target===this)closeConflictModal()" onkeydown="if(event.key==='Escape')closeConflictModal()">
  <div class="modal-card" style="border-color:var(--warn);">
    <div class="modal-head">
      <div class="modal-title" style="color:var(--warn);">⚠️ 前缀 / 域名占用冲突提醒</div>
      <button type="button" class="btn btn-sm" onclick="closeConflictModal()">关闭</button>
    </div>
    <div class="wrap-text" style="font-size:13.5px; color:var(--text-bright); line-height:1.65;" id="conflictModalBody"></div>
    <div class="wrap-text" style="padding:10px 12px; border-radius:6px; background:var(--danger-soft); border:1px solid rgba(244,63,94,0.4); color:#FDA4AF; font-size:12.5px;">
      继续执行后，原绑定项目上的该域名配置将立即失效并自动卸载，流量将独立切换至当前选中的项目。
    </div>
    <div class="btn-flow">
      <button type="button" class="btn" onclick="closeConflictModal()">取消操作</button>
      <button type="button" class="btn btn-warn" id="btnConfirmConflict">继续并自动卸载旧绑定</button>
    </div>
  </div>
</div>

<div id="providerModal" class="modal-mask hidden" onclick="if(event.target===this)closeProviderModal()" onkeydown="if(event.key==='Escape')closeProviderModal()">
  <div class="modal-card">
    <div class="modal-head">
      <div class="modal-title">☁️ 添加 / 配置云解析服务商</div>
      <button type="button" class="btn btn-sm" onclick="closeProviderModal()">关闭</button>
    </div>
    <div class="btn-flow" id="modalProvTabs">
      <button type="button" class="btn btn-sm prov-tab active" data-prov="huawei" onclick="selectModalProvider('huawei')">华为云 DNS</button>
      <button type="button" class="btn btn-sm prov-tab" data-prov="tencent" onclick="selectModalProvider('tencent')">腾讯云 DNSPod</button>
      <button type="button" class="btn btn-sm prov-tab" data-prov="aliyun" onclick="selectModalProvider('aliyun')">阿里云 DNS</button>
    </div>
    <div class="field">
      <div class="field-head">
        <label id="modalAkLabel">Access Key Id (AK)</label>
        <a id="modalTokenLink" href="https://console.huaweicloud.com/iam/#/mine/accessKey" target="_blank" class="doc-link" style="font-size:12px;">获取密钥 ↗</a>
      </div>
      <input type="text" id="modalDnsAk" placeholder="输入对应云厂商 AK / SecretId" />
    </div>
    <div class="field">
      <label id="modalSkLabel">Secret Access Key (SK)</label>
      <input type="password" id="modalDnsSk" placeholder="输入对应云厂商 SK / SecretKey" />
    </div>
    <div class="field">
      <label>默认主域名 (可选，留空自动加载第一个域名)</label>
      <input type="text" id="modalDefaultDomain" placeholder="例如: example.com" />
    </div>
    <div class="btn-flow">
      <button type="button" class="btn btn-primary" id="btnSaveModalProv" onclick="saveModalProvider()">验证密钥并启用该服务商</button>
    </div>
  </div>
</div>

<div id="d1GuideStage" class="center-stage hidden">
  <div class="stage-card">
    <div class="step-indicator">
      <span class="step-tag current">01 安装初始化引导</span>
      <span class="step-tag">02 双云参数配置</span>
      <span class="step-tag">03 安全解锁</span>
      <span class="step-tag">04 拓扑控制台</span>
    </div>
    <div class="stage-title">绑定名称为 CFWUYA 的 D1 数据库</div>
    <div class="stage-sub">系统仅将加密凭据、已启用云服务商与管理密码保存在私有 D1 数据库中，日常加速与巡检零数据库写入损耗。</div>

    <div id="d1EnvAlert" class="env-alert pages"></div>

    <div class="d1-step-list">
      <div class="d1-step">
        <b>步骤 1 · 创建 D1 数据库</b><br />
        登录 Cloudflare 控制台 → 左侧菜单进入 <b>存储和数据库 → D1 SQL 数据库</b> → 点击「创建数据库」，数据库名称建议填写 <span class="code-chip">CFWUYA</span>。
      </div>
      <div class="d1-step">
        <b>步骤 2 · 绑定变量名称为 CFWUYA（必须完全一致）</b><br />
        进入当前部署的 <b>Workers 或 Pages 项目 → 设置 → 绑定 (Bindings)</b> → 添加 <b>D1 数据库</b>：<br />
        • <b>变量名称 (Variable name)</b>：严格填写大写 <span class="code-chip">CFWUYA</span><br />
        • <b>D1 数据库</b>：选择刚创建的数据库并保存。
      </div>
      <div class="d1-step">
        <b>步骤 3 · 刷新进入参数配置</b><br />
        完成绑定（Pages 项目需点击重新部署）后，点击下方按钮检测绑定状态并进入下一步参数配置。
      </div>
    </div>

    <div class="btn-flow">
      <button type="button" class="btn btn-primary" onclick="window.location.reload()">我已完成 CFWUYA 绑定，立即检测并进入下一步</button>
    </div>
  </div>
</div>

<div id="installStage" class="center-stage hidden">
  <div class="stage-card">
    <div class="step-indicator">
      <span class="step-tag">01 安装引导</span>
      <span class="step-tag current">02 双云参数配置</span>
      <span class="step-tag">03 安全解锁</span>
      <span class="step-tag">04 拓扑控制台</span>
    </div>
    <div class="stage-title">配置 Cloudflare 与主力云解析服务商</div>
    <div class="stage-sub">参数将安全加密写入 <span class="code-chip">CFWUYA</span> 数据库。先启用一家主力云服务商即可进入控制台，后续可随时新增其他服务商。</div>

    <div class="grid-2" style="margin-bottom:14px;">
      <div class="field">
        <div class="field-head">
          <label>Cloudflare 邮箱 (使用 Token 可留空)</label>
          <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" class="doc-link" style="font-size:12px;">获取密钥 ↗</a>
        </div>
        <input type="email" id="setupCfEmail" placeholder="Global Key 填邮箱，Token 留空" />
      </div>
      <div class="field">
        <label>Cloudflare API Key / Token *</label>
        <input type="password" id="setupCfKey" placeholder="输入 Cloudflare 密钥" />
      </div>
      <div class="field">
        <label>CF 默认中转回源域名 (可选)</label>
        <input type="text" id="setupCfDomain" placeholder="留空默认选账号第一个域名" />
      </div>
      <div class="field">
        <label>设置控制台管理密码 *</label>
        <input type="password" id="setupAdminPass" placeholder="设置后台解锁密码" />
      </div>
    </div>

    <div class="field" style="margin-bottom:14px;">
      <label>选择主力 DNS 云解析服务商：</label>
      <div class="btn-flow" id="setupProvTabs">
        <button type="button" class="btn btn-sm prov-tab active" data-prov="huawei" onclick="selectSetupProvider('huawei')">华为云 DNS</button>
        <button type="button" class="btn btn-sm prov-tab" data-prov="tencent" onclick="selectSetupProvider('tencent')">腾讯云 DNSPod</button>
        <button type="button" class="btn btn-sm prov-tab" data-prov="aliyun" onclick="selectSetupProvider('aliyun')">阿里云 DNS</button>
      </div>
    </div>

    <div class="grid-2" style="margin-bottom:18px;">
      <div class="field">
        <div class="field-head">
          <label id="setupAkLabel">华为云 Access Key Id (AK) *</label>
          <a id="setupTokenLink" href="https://console.huaweicloud.com/iam/#/mine/accessKey" target="_blank" class="doc-link" style="font-size:12px;">获取密钥 ↗</a>
        </div>
        <input type="text" id="setupDnsAk" placeholder="输入云解析 AK / SecretId" />
      </div>
      <div class="field">
        <label id="setupSkLabel">华为云 Secret Access Key (SK) *</label>
        <input type="password" id="setupDnsSk" placeholder="输入云解析 SK / SecretKey" />
      </div>
      <div class="field">
        <label id="setupDomainLabel">华为云默认访问主域 (可选)</label>
        <input type="text" id="setupDnsDomain" placeholder="留空默认显示第一个域名" />
      </div>
      <div class="field">
        <label>默认优选节点 (留空自动取香港第 1 个 IP)</label>
        <input type="text" id="setupOptDomain" value="" placeholder="留空自动使用香港第 1 个优选 IP" />
      </div>
    </div>

    <div class="btn-flow">
      <button type="button" class="btn btn-primary" id="btnFinishInstall" onclick="submitInstallWizard()">验证双云凭据并保存进入控制台</button>
    </div>
  </div>
</div>

<div id="lockStage" class="center-stage hidden">
  <div class="stage-card narrow">
    <div class="stage-title" style="text-align:center; margin-bottom:16px;">SaaS 智能优选管理</div>
    <div class="field" style="margin-bottom:14px;">
      <input type="password" id="loginPassInput" placeholder="输入管理密码" onkeydown="if(event.key==='Enter')unlockConsole()" />
    </div>
    <div class="btn-flow">
      <button type="button" class="btn btn-primary" id="btnLogin" onclick="unlockConsole()">解锁进入</button>
    </div>
    <div class="wrap-text" id="loginErrText" style="color:var(--warn); font-size:12.5px; margin-top:10px; min-height:18px; text-align:center;"></div>
  </div>
</div>

<div id="mainAppShell" class="console-shell hidden">

  <header class="topbar">
    <div class="topbar-head">
      <div class="brand-block">
        <div class="brand-mark">⚡</div>
        <div class="topbar-title">Cloudflare SaaS 智能优选</div>
      </div>
      <div class="topbar-status-strip">
        <span class="pill ok">D1: CFWUYA</span>
        <span class="pill info" id="currentProviderBadge">华为云 DNS</span>
        <button type="button" class="btn btn-xs" onclick="logoutConsole()">锁定退出</button>
      </div>
    </div>

    <div class="provider-action-bar" id="activeProviderBar"></div>
  </header>

  <div class="dashboard-grid">

    <aside class="col-sidebar panel">
      <div class="panel-head">
        <div class="panel-title"><span class="badge-num">NAV</span> 功能导航</div>
      </div>
      <nav class="nav-stack" id="sidebarNavList">
        <button type="button" class="nav-btn active" data-view="deploy" onclick="switchWorkspaceView('deploy')">🚀 域名与部署 (Domains)</button>
        <button type="button" class="nav-btn" data-view="matrix" onclick="switchWorkspaceView('matrix')">🌐 加速矩阵 (DNS Records)</button>
        <button type="button" class="nav-btn" data-view="nodes" onclick="switchWorkspaceView('nodes')">⚡ 优选节点 (Nodes)</button>
        <button type="button" class="nav-btn" data-view="settings" onclick="switchWorkspaceView('settings')">⚙️ 系统设置 (Settings)</button>
        <button type="button" class="nav-btn" data-view="guide" onclick="switchWorkspaceView('guide')">📖 使用说明 (Guide)</button>
        <button type="button" class="nav-btn" onclick="scrollToLogs()">📜 实时日志 (Logs)</button>
      </nav>
    </aside>

    <main class="col-center">

      <section class="panel">
        <div class="panel-head">
          <div class="panel-title"><span class="badge-num">TOPO</span> 实时链路拓扑视图</div>
          <span class="pill info" id="topoOverallTag">就绪待命</span>
        </div>

        <div class="topo-canvas">
          <div class="topo-flow">
            <div class="topo-node">
              <div class="topo-node-top">
                <span class="topo-node-role">01 · DOMAIN SOURCE</span>
                <span class="pill" id="topoDomainTag">待选域名</span>
              </div>
              <div class="topo-node-val" id="topoDomainVal">未选择访问域名</div>
              <div class="topo-node-sub" id="topoDomainSub">访客终端 HTTPS 访问入口</div>
            </div>

            <div class="topo-link">
              <div class="topo-line-h"></div>
              <span class="topo-link-tag">双线智能解析</span>
            </div>

            <div class="topo-node">
              <div class="topo-node-top">
                <span class="topo-node-role">02 · DNS RESOLVER</span>
                <span class="pill info" id="topoDnsTag">双线分流</span>
              </div>
              <div class="topo-node-val" id="topoDnsVal">加载香港首选 IP...</div>
              <div class="topo-node-sub" id="topoDnsSub">境内走优选节点 · 境外走回退源</div>
            </div>

            <div class="topo-link">
              <div class="topo-line-h"></div>
              <span class="topo-link-tag">SaaS 边缘中继</span>
            </div>

            <div class="topo-node">
              <div class="topo-node-top">
                <span class="topo-node-role">03 · ACCEL NODE</span>
                <span class="pill" id="topoOriginTag">源站锚点</span>
              </div>
              <div class="topo-node-val" id="topoOriginVal">saas-origin.---</div>
              <div class="topo-node-sub" id="topoOriginSub">独立中继映射至 Pages / Workers</div>
            </div>
          </div>
        </div>
      </section>

      <section id="view-deploy" class="ws-view panel">
        <div class="panel-head">
          <div class="panel-title"><span class="badge-num">01</span> 部署与切换 SaaS 优选加速</div>
          <span class="pill" id="deployStepHint">默认香港首选 IP</span>
        </div>

        <div class="grid-2">
          <div class="field">
            <label>加速项目类型</label>
            <div class="switch-box">
              <button type="button" class="switch-btn active" id="swPages" onclick="switchTargetType('pages')">Pages 项目</button>
              <button type="button" class="switch-btn" id="swWorkers" onclick="switchTargetType('workers')">Workers 脚本</button>
            </div>
          </div>

          <div class="field">
            <label id="projectLabel">选择 Pages 项目</label>
            <select id="projectSelect" onchange="onProjectChange()">
              <option value="">等待同步项目...</option>
            </select>
          </div>

          <div class="field">
            <div class="field-head">
              <label>CF 中转回源域</label>
              <button type="button" class="btn btn-xs" onclick="setCurrentCfAsDefault()">设为默认</button>
            </div>
            <select id="cfZoneSelect" onchange="onZoneChange()">
              <option value="">等待同步域名...</option>
            </select>
          </div>

          <div class="field">
            <label>国内优选 IP 或优选域名</label>
            <div class="input-flow">
              <input type="text" id="preferredTarget" placeholder="默认香港第1个IP，可点击自动获取" oninput="updateTopologyCanvas()" />
              <button type="button" class="btn btn-sm" onclick="openOptModalForDeploy()">⚡ 自动获取</button>
            </div>
          </div>
        </div>

        <div class="detect-box" id="detectBox">
          <div class="detect-title" id="detectTitle">⚪ 等待同步项目加速状态...</div>

          <div class="btn-flow">
            <button type="button" class="btn btn-sm" id="btnReinspect" onclick="refreshInspection()">重新检测</button>
            <a id="detectOpenLink" href="#" target="_blank" class="btn btn-ok btn-sm hidden">打开域名</a>
          </div>

          <div class="detect-lines" id="detectLines">
            <div class="detect-line-item">同步资源后，系统将自动识别所选项目是否已绑定 SaaS 优选加速。</div>
          </div>
        </div>

        <div class="prefix-glow-wrap" id="prefixGlowWrap">
          <div class="field-head">
            <label style="color:var(--text-bright); font-weight:700;" id="prefixBoxLabel">最终访问域名 (前缀 + 云主域)</label>
            <div class="btn-flow" style="width:auto;">
              <button type="button" class="btn btn-xs" onclick="genRandomPrefix()">随机前缀</button>
              <button type="button" class="btn btn-xs" onclick="setCurrentDnsAsDefault()">设为默认主域</button>
            </div>
          </div>
          <div class="domain-compose">
            <input type="text" id="prefixInput" value="" placeholder="前缀 (留空用主域)" oninput="onPrefixInput()" />
            <span class="dot">.</span>
            <select id="dnsZoneSelect" onchange="onZoneChange()">
              <option value="">加载中...</option>
            </select>
          </div>
          <div class="replace-opt hidden" id="replaceOptBox">
            <input type="checkbox" id="chkCleanupOld" checked />
            <label for="chkCleanupOld" style="color:var(--text-bright); cursor:pointer;" id="replaceOptText">更换域名时同步清理旧域名记录</label>
          </div>
        </div>

        <div class="preview-bar">
          <span>最终访客访问地址：</span>
          <strong id="previewUrl">等待选择域名...</strong>
        </div>

        <div class="btn-flow" style="margin-top:14px;">
          <button type="button" class="btn btn-primary" id="btnActivate" onclick="handleTriggerAction('activate')">一键激活 SaaS 优选加速</button>
          <button type="button" class="btn btn-ok" id="btnSelfCheck" onclick="handleTriggerAction('selfcheck')">一键全面自检与修复证书</button>
        </div>
      </section>

      <section id="view-matrix" class="ws-view panel hidden">
        <div class="panel-head">
          <div class="panel-title"><span class="badge-num">02</span> 已激活 SaaS 加速矩阵资产</div>
          <span class="pill info" id="matrixCount">共 0 个节点</span>
        </div>

        <div class="btn-flow" style="margin-bottom:12px;">
          <button type="button" class="btn btn-ok btn-sm" id="btnUpdateAllBest" onclick="updateAllToBestOpt()">一键更新全部最优</button>
          <button type="button" class="btn btn-warn btn-sm" id="btnRepairOrigins" onclick="repairAllOrigins()">一键修复回源错误</button>
        </div>

        <div class="matrix-list" id="matrixList">
          <div class="wrap-text" style="text-align:center; padding:20px; color:var(--text-muted); font-size:13px;">正在等待同步加速域名资产...</div>
        </div>
      </section>

      <section id="view-nodes" class="ws-view panel hidden">
        <div class="panel-head">
          <div class="panel-title"><span class="badge-num">03</span> 实时优选节点池 (6 地区 IP & 优选域名)</div>
          <button type="button" class="btn btn-sm" id="btnRefreshInlineNodes" onclick="loadInlineOptNodes(true)">实时刷新</button>
        </div>
        <div class="btn-flow" style="margin-bottom:10px;">
          <button type="button" class="btn btn-sm btn-tab-active" id="inlineTabIp" onclick="switchInlineNodeTab('ip')">优选IP</button>
          <button type="button" class="btn btn-sm" id="inlineTabDomain" onclick="switchInlineNodeTab('domain')">优选域名</button>
        </div>
        <div class="opt-rank-list" id="inlineOptRankList" style="max-height:none;">
          <div class="wrap-text" style="text-align:center; padding:20px; color:var(--text-muted);">正在采集节点数据...</div>
        </div>
      </section>

      <section id="view-settings" class="ws-view panel hidden">
        <div class="panel-head">
          <div class="panel-title"><span class="badge-num">04</span> 已启用云解析服务商管理</div>
          <button type="button" class="btn btn-sm" onclick="openProviderModal()">+ 添加 / 配置服务商</button>
        </div>
        <div id="enabledProvidersList" style="display:flex; flex-direction:column; gap:10px; margin-bottom:16px;"></div>

        <div class="panel-head">
          <div class="panel-title"><span class="badge-num">CF</span> Cloudflare 凭据与安全设置</div>
        </div>
        <div class="grid-2">
          <div class="field">
            <label>Cloudflare 邮箱 (使用 Token 留空)</label>
            <input type="email" id="setCfEmail" placeholder="name@example.com" />
          </div>
          <div class="field">
            <label>Cloudflare Key / Token (留空保持不变)</label>
            <input type="password" id="setCfKey" placeholder="输入新密钥以更新" />
          </div>
          <div class="field">
            <label>默认 Cloudflare 中转主域</label>
            <input type="text" id="setDefaultCfDomain" placeholder="例如: transit.com" />
          </div>
          <div class="field">
            <label>修改控制台管理密码 (留空保持不变)</label>
            <input type="password" id="setAdminPass" placeholder="输入新管理密码" />
          </div>
        </div>
        <div class="btn-flow" style="margin-top:14px;">
          <button type="button" class="btn btn-primary" id="btnSaveGlobalSet" onclick="saveGlobalSettings()">保存全局设置至 D1</button>
        </div>
      </section>

      <section id="view-guide" class="ws-view panel hidden">
        <div class="panel-head">
          <div class="panel-title"><span class="badge-num">DOC</span> 多云 SaaS 部署与 API 获取说明书</div>
        </div>

        <div class="doc-step">
          <h3>一、CFWUYA D1 数据库绑定规范</h3>
          <ul>
            <li>在 Cloudflare 控制台创建一个 D1 数据库，并在项目的 <b>设置 → 绑定 (Bindings)</b> 中添加 D1 绑定，<b>变量名必须严格大写为</b> <span class="code-chip">CFWUYA</span>。</li>
            <li><b>Cloudflare Pages 部署特别注意</b>：在 Pages 后台绑定 <span class="code-chip">CFWUYA</span> 后，必须前往 <b>Deployments（部署）</b> 页面点击最新一条记录右侧的 <b>Retry deployment（重新部署）</b>，否则 Pages 边缘实例无法读取新绑定的数据库。Workers 部署则保存后立即生效。</li>
          </ul>
        </div>

        <div class="doc-step">
          <h3>二、Cloudflare 中转域准备与 API 获取步骤</h3>
          <p>官方令牌管理地址：<a class="doc-link" href="https://dash.cloudflare.com/profile/api-tokens" target="_blank">https://dash.cloudflare.com/profile/api-tokens</a></p>
          <ul>
            <li><b>1. 开启 SaaS 自定义主机名</b>：将中转域名接入 Cloudflare → 进入「SSL/TLS」→「自定义主机名」按提示激活（免费额度含 100 个自定义主机名）。</li>
            <li><b>2. 获取 Global API Key（推荐）</b>：打开上方链接，在页面底部找到 <b>Global API Key</b> 点击查看并复制，同时填写您的 Cloudflare 登录邮箱。</li>
            <li><b>3. 或使用自定义 API Token</b>：若使用 Token，请赋予 <span class="code-chip">区域:读取</span>、<span class="code-chip">DNS:编辑</span>、<span class="code-chip">SSL和证书:编辑</span>、<span class="code-chip">Worker路由:编辑</span>、<span class="code-chip">Worker脚本:编辑</span>、<span class="code-chip">Cloudflare Pages:编辑</span> 权限，此时邮箱栏留空。</li>
          </ul>
        </div>

        <div class="doc-step">
          <h3>三、三大云解析服务商密钥获取地址</h3>
          <ul>
            <li><b>1. 华为云 DNS（中国大陆 / 三网智能线路）</b>：<br />
              • 控制台：<a class="doc-link" href="https://console.huaweicloud.com/dns/" target="_blank">https://console.huaweicloud.com/dns/</a><br />
              • AK/SK：<a class="doc-link" href="https://console.huaweicloud.com/iam/#/mine/accessKey" target="_blank">https://console.huaweicloud.com/iam/#/mine/accessKey</a>
            </li>
            <li><b>2. 腾讯云 DNSPod（境内 / 电信联通移动分流线路）</b>：<br />
              • 控制台：<a class="doc-link" href="https://console.cloud.tencent.com/cns" target="_blank">https://console.cloud.tencent.com/cns</a><br />
              • SecretId/Key：<a class="doc-link" href="https://console.cloud.tencent.com/cam/capi" target="_blank">https://console.cloud.tencent.com/cam/capi</a>
            </li>
            <li><b>3. 阿里云云解析 DNS（中国大陆 / 三网智能线路）</b>：<br />
              • 控制台：<a class="doc-link" href="https://dns.console.aliyun.com/" target="_blank">https://dns.console.aliyun.com/</a><br />
              • AccessKey：<a class="doc-link" href="https://ram.console.aliyun.com/manage/ak" target="_blank">https://ram.console.aliyun.com/manage/ak</a>
            </li>
          </ul>
        </div>
      </section>

    </main>

    <aside class="col-right">
      <section class="panel">
        <div class="panel-head">
          <div class="panel-title"><span class="badge-num">SSL</span> 证书与主机名详情</div>
          <span class="pill" id="rightMatrixBadge">0 节点在线</span>
        </div>

        <div class="detect-lines" style="margin-bottom:12px;">
          <div class="detect-line-item">当前选中源站：<code id="detailSourceName">未选择</code></div>
          <div class="detect-line-item">中转回退锚点：<code id="detailFallbackOrigin">saas-origin.---</code></div>
          <div class="detect-line-item">SaaS 主机名状态：<span class="pill" id="pillHost">待检测</span></div>
          <div class="detect-line-item">边缘 SSL 证书：<span class="pill" id="pillSsl">待检测</span></div>
        </div>

        <div class="btn-flow">
          <button type="button" class="btn btn-sm" onclick="checkCertStatus(false)">刷新证书状态</button>
          <a id="openLink" href="#" target="_blank" class="btn btn-ok btn-sm">立即打开站点</a>
          <button type="button" class="btn btn-sm" onclick="switchWorkspaceView('matrix')">管理矩阵资产</button>
        </div>

        <div class="check-report hidden" id="checkReport">
          <div style="font-size:13px; font-weight:700; color:#34D399;">全链路自检与修复诊断报告</div>
          <div id="checkList"></div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div class="panel-title"><span class="badge-num">AUTO</span> 定时优选更新引擎</div>
        </div>
        <div id="autoSyncBox"></div>
      </section>
    </aside>

    <section class="col-logs panel" id="logPanelAnchor">
      <div class="panel-head">
        <div class="panel-title"><span class="badge-num">LOG</span> 实时执行与链路审计日志（完整自动换行）</div>
        <div class="btn-flow" style="width:auto;">
          <button type="button" class="btn btn-xs" onclick="clearLogs()">清空日志</button>
        </div>
      </div>
      <div class="log-box" id="logBox">
        <div class="log-item"><span class="log-ok">[就绪]</span><span>多云 SaaS 优选拓扑控制台已启动，默认优选节点已锁定香港第 1 个优选 IP...</span></div>
      </div>
    </section>

  </div>
</div>

<script>
  var BOOT = ${safeBootJson};
  var STORAGE_PASS_KEY = 'cfwuya_admin_pass_v2';
  var STORAGE_VIEW_KEY = 'cfwuya_active_view_v2';
  var state = {
    adminPass: '',
    setupProvider: 'huawei',
    modalProvider: 'huawei',
    activeProvider: (BOOT.summary && BOOT.summary.activeProvider) ? BOOT.summary.activeProvider : 'huawei',
    summary: BOOT.summary || {},
    targetType: 'pages',
    pagesProjects: [],
    workerScripts: [],
    cfZones: [],
    dnsZones: [],
    inspectionByPair: {},
    currentProjectBoundHosts: [],
    optDomainsCache: [],
    optIpPoolCache: null,
    defaultHkIp: '',
    optModalTab: 'ip',
    optModalTargetHost: '',
    inlineNodeTab: 'ip',
    lastCfZoneId: '',
    lastCustomHostnameId: '',
    pollTimer: null,
    busy: false,
    pendingAction: null
  };

  function showToast(msg, type) {
    var wrap = document.getElementById('toastWrap');
    if (!wrap) return;
    var el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(function() {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 3200);
  }

  function addLog(text, isErr) {
    var box = document.getElementById('logBox');
    if (!box) return;
    var row = document.createElement('div');
    row.className = 'log-item';
    var tag = document.createElement('span');
    tag.className = isErr ? 'log-err' : 'log-ok';
    tag.textContent = isErr ? '[告警]' : '[执行]';
    var msg = document.createElement('span');
    msg.textContent = text;
    row.appendChild(tag);
    row.appendChild(msg);
    box.appendChild(row);
    box.scrollTop = box.scrollHeight;
  }

  function clearLogs() {
    var box = document.getElementById('logBox');
    if (box) box.innerHTML = '';
    addLog('日志面板已清空');
  }

  function scrollToLogs() {
    var el = document.getElementById('logPanelAnchor');
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  }

  function getAuthHeaders() {
    var headers = { 'Content-Type': 'application/json' };
    if (state.adminPass) headers['X-Admin-Pass'] = state.adminPass;
    return headers;
  }

  function copyUrl(url) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function() {
        showToast('已复制: ' + url, 'ok');
      }).catch(function() {
        showToast('复制失败，请手动复制', 'err');
      });
    } else {
      showToast('已选中: ' + url, 'ok');
    }
  }

  function copyByDataId(btn) {
    var targetId = btn ? btn.getAttribute('data-copy-id') : '';
    var el = targetId ? document.getElementById(targetId) : null;
    if (el) copyUrl(el.textContent.trim());
  }

  function openOptModalForDeploy() {
    state.optModalTargetHost = '';
    state.optModalTab = 'ip';
    document.getElementById('optModalTitle').textContent = '⚡ 选择优选节点 (默认优先香港 IP)';
    updateOptModalTabButtons();
    document.getElementById('optModal').classList.remove('hidden');
    loadOptModalList(false);
  }

  function openOptModalForMatrix(hostname) {
    state.optModalTargetHost = hostname;
    state.optModalTab = 'ip';
    document.getElementById('optModalTitle').textContent = '⚡ 切换 [' + hostname + '] 优选节点';
    updateOptModalTabButtons();
    document.getElementById('optModal').classList.remove('hidden');
    loadOptModalList(false);
  }

  function closeOptModal() {
    document.getElementById('optModal').classList.add('hidden');
  }

  function updateOptModalTabButtons() {
    var tabIp = document.getElementById('tabOptIp');
    var tabDom = document.getElementById('tabOptDomain');
    var hintEl = document.getElementById('optModalHint');
    if (tabIp) tabIp.className = state.optModalTab === 'ip' ? 'btn btn-sm btn-tab-active' : 'btn btn-sm';
    if (tabDom) tabDom.className = state.optModalTab === 'domain' ? 'btn btn-sm btn-tab-active' : 'btn btn-sm';
    if (hintEl) {
      hintEl.textContent = state.optModalTab === 'ip'
        ? '按 6 个地区分组展示实时测速延迟（已自动去除端口），点击任意节点立即选用：'
        : '同步近 24 小时高分优选域名与评分（已过滤纯 IP），点击立即选用：';
    }
  }

  function switchOptModalTab(tab) {
    if (state.optModalTab === tab) return;
    state.optModalTab = tab;
    updateOptModalTabButtons();
    loadOptModalList(false);
  }

  function handleSelectOptCandidate(targetValue) {
    if (state.optModalTargetHost) {
      var targetHost = state.optModalTargetHost;
      closeOptModal();
      quickSwitchOpt(targetHost, targetValue, null);
      return;
    }
    document.getElementById('preferredTarget').value = targetValue;
    updateTopologyCanvas();
    closeOptModal();
    showToast('已选用优选节点: ' + targetValue, 'ok');
  }

  function renderIpRegionsList(ipPool, containerId, clickableForModal) {
    var container = document.getElementById(containerId);
    if (!container) return;
    var regions = (ipPool && Array.isArray(ipPool.regions)) ? ipPool.regions : [];
    var currentVal = (document.getElementById('preferredTarget').value || '').trim().toLowerCase();
    container.innerHTML = '';

    var hasAny = false;
    for (var rIdx = 0; rIdx < regions.length; rIdx++) {
      var reg = regions[rIdx];
      var items = Array.isArray(reg.items) ? reg.items : [];
      if (items.length > 0) hasAny = true;

      var block = document.createElement('div');
      block.className = 'region-block';

      var head = document.createElement('div');
      head.className = 'region-head';
      head.innerHTML =
        '<span class="region-title">' + reg.label + '</span>' +
        '<span class="pill info">' + items.length + ' 个节点</span>';
      block.appendChild(head);

      if (!items.length) {
        var emptyTip = document.createElement('div');
        emptyTip.style.cssText = 'font-size:12px; color:var(--text-muted); padding:4px 2px;';
        emptyTip.textContent = '该地区暂无可用节点';
        block.appendChild(emptyTip);
      } else {
        for (var i = 0; i < items.length; i++) {
          (function(it, idx) {
            var row = document.createElement('div');
            var isSel = currentVal === String(it.ip).toLowerCase();
            row.className = 'opt-rank-row' + (isSel ? ' selected' : '');
            row.onclick = function() {
              if (clickableForModal) {
                handleSelectOptCandidate(it.ip);
              } else {
                document.getElementById('preferredTarget').value = it.ip;
                updateTopologyCanvas();
                renderIpRegionsList(ipPool, containerId, false);
                showToast('已选用优选 IP: ' + it.ip, 'ok');
              }
            };

            var left = document.createElement('div');
            left.className = 'opt-rank-left';

            var num = document.createElement('span');
            num.className = 'opt-rank-num';
            num.textContent = '#' + String(idx + 1);

            var hostSpan = document.createElement('span');
            hostSpan.className = 'opt-rank-host';
            hostSpan.textContent = it.ip;

            left.appendChild(num);
            left.appendChild(hostSpan);

            var latBadge = document.createElement('span');
            latBadge.className = 'opt-rank-score';
            latBadge.textContent = it.latency || '优选';

            row.appendChild(left);
            row.appendChild(latBadge);
            block.appendChild(row);
          })(items[i], i);
        }
      }

      container.appendChild(block);
    }

    if (!hasAny) {
      container.innerHTML = '<div class="wrap-text" style="text-align:center; padding:20px; color:var(--warn); font-size:13px;">暂未获取到优选 IP，请点击「实时刷新」重试</div>';
    }
  }

  function renderOptDomainList(list, containerId, clickableForModal) {
    var container = document.getElementById(containerId);
    if (!container) return;
    var currentVal = (document.getElementById('preferredTarget').value || '').trim().toLowerCase();
    container.innerHTML = '';

    for (var i = 0; i < list.length; i++) {
      (function(item, idx) {
        var row = document.createElement('div');
        var isSel = currentVal === String(item.host).toLowerCase();
        row.className = 'opt-rank-row' + (isSel ? ' selected' : '');
        row.onclick = function() {
          if (clickableForModal) {
            handleSelectOptCandidate(item.host);
          } else {
            document.getElementById('preferredTarget').value = item.host;
            updateTopologyCanvas();
            renderOptDomainList(list, containerId, false);
            showToast('已选用优选域名: ' + item.host, 'ok');
          }
        };

        var left = document.createElement('div');
        left.className = 'opt-rank-left';

        var num = document.createElement('span');
        num.className = 'opt-rank-num';
        num.textContent = '#' + String(idx + 1);

        var hostSpan = document.createElement('span');
        hostSpan.className = 'opt-rank-host';
        hostSpan.textContent = item.host;

        left.appendChild(num);
        left.appendChild(hostSpan);

        var scoreBadge = document.createElement('span');
        scoreBadge.className = 'opt-rank-score';
        scoreBadge.textContent = (item.score !== null && item.score !== undefined && item.score !== '')
          ? (item.score + ' 分')
          : '优选';

        row.appendChild(left);
        row.appendChild(scoreBadge);
        container.appendChild(row);
      })(list[i], i);
    }
  }

  function loadOptModalList(forceRefresh) {
    var btn = document.getElementById('btnRefreshOptModal');
    var container = document.getElementById('optRankList');

    if (state.optModalTab === 'ip') {
      if (!forceRefresh && state.optIpPoolCache) {
        renderIpRegionsList(state.optIpPoolCache, 'optRankList', true);
        return;
      }
      if (btn) { btn.disabled = true; btn.textContent = '采集中...'; }
      if (container) {
        container.innerHTML = '<div class="wrap-text" style="text-align:center; padding:20px; color:var(--text-muted); font-size:13px;">正在实时采集 6 地区优选 IP...</div>';
      }
      fetch('/api/opt-ips', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ force: Boolean(forceRefresh) })
      })
      .then(function(r) { return r.json(); })
      .then(function(res) {
        if (!res.ok) throw new Error(res.error || '获取优选 IP 失败');
        state.optIpPoolCache = res.data;
        if (res.data && res.data.firstHkIp) state.defaultHkIp = res.data.firstHkIp;
        renderIpRegionsList(res.data, 'optRankList', true);
        if (forceRefresh) showToast('已刷新 6 地区优选 IP', 'ok');
      })
      .catch(function(err) {
        if (container) container.innerHTML = '<div class="wrap-text" style="text-align:center; padding:20px; color:var(--warn); font-size:13px;">' + err.message + '</div>';
        showToast(err.message, 'err');
      })
      .finally(function() {
        if (btn) { btn.disabled = false; btn.textContent = '实时刷新'; }
      });
      return;
    }

    if (!forceRefresh && state.optDomainsCache.length > 0) {
      renderOptDomainList(state.optDomainsCache, 'optRankList', true);
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = '采集中...'; }
    if (container) {
      container.innerHTML = '<div class="wrap-text" style="text-align:center; padding:20px; color:var(--text-muted); font-size:13px;">正在同步近 24 小时优选域名与评分...</div>';
    }
    fetch('/api/opt-domains', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ force: Boolean(forceRefresh) })
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (!res.ok) throw new Error(res.error || '获取失败');
      var list = Array.isArray(res.data) ? res.data : [];
      state.optDomainsCache = list;
      renderOptDomainList(list, 'optRankList', true);
      if (forceRefresh) showToast('已刷新 ' + list.length + ' 条优选域名', 'ok');
    })
    .catch(function(err) {
      if (container) container.innerHTML = '<div class="wrap-text" style="text-align:center; padding:20px; color:var(--warn); font-size:13px;">' + err.message + '</div>';
      showToast(err.message, 'err');
    })
    .finally(function() {
      if (btn) { btn.disabled = false; btn.textContent = '实时刷新'; }
    });
  }

  function switchInlineNodeTab(tab) {
    state.inlineNodeTab = tab;
    document.getElementById('inlineTabIp').className = tab === 'ip' ? 'btn btn-sm btn-tab-active' : 'btn btn-sm';
    document.getElementById('inlineTabDomain').className = tab === 'domain' ? 'btn btn-sm btn-tab-active' : 'btn btn-sm';
    loadInlineOptNodes(false);
  }

  function loadInlineOptNodes(forceRefresh) {
    var btn = document.getElementById('btnRefreshInlineNodes');
    var container = document.getElementById('inlineOptRankList');
    if (state.inlineNodeTab === 'ip') {
      if (!forceRefresh && state.optIpPoolCache) {
        renderIpRegionsList(state.optIpPoolCache, 'inlineOptRankList', false);
        return;
      }
      if (btn) { btn.disabled = true; btn.textContent = '采集中...'; }
      if (container) container.innerHTML = '<div class="wrap-text" style="text-align:center; padding:20px; color:var(--text-muted);">正在实时采集 6 地区优选 IP...</div>';
      fetch('/api/opt-ips', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ force: Boolean(forceRefresh) })
      })
      .then(function(r) { return r.json(); })
      .then(function(res) {
        if (!res.ok) throw new Error(res.error || '获取失败');
        state.optIpPoolCache = res.data;
        renderIpRegionsList(res.data, 'inlineOptRankList', false);
        if (forceRefresh) showToast('已更新 6 地区优选 IP', 'ok');
      })
      .catch(function(err) {
        if (container) container.innerHTML = '<div class="wrap-text" style="text-align:center; padding:20px; color:var(--warn);">' + err.message + '</div>';
      })
      .finally(function() {
        if (btn) { btn.disabled = false; btn.textContent = '实时刷新'; }
      });
      return;
    }

    if (!forceRefresh && state.optDomainsCache.length > 0) {
      renderOptDomainList(state.optDomainsCache, 'inlineOptRankList', false);
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = '采集中...'; }
    if (container) container.innerHTML = '<div class="wrap-text" style="text-align:center; padding:20px; color:var(--text-muted);">正在同步优选域名与评分...</div>';
    fetch('/api/opt-domains', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ force: Boolean(forceRefresh) })
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (!res.ok) throw new Error(res.error || '获取失败');
      state.optDomainsCache = Array.isArray(res.data) ? res.data : [];
      renderOptDomainList(state.optDomainsCache, 'inlineOptRankList', false);
      if (forceRefresh) showToast('已更新优选域名榜单', 'ok');
    })
    .catch(function(err) {
      if (container) container.innerHTML = '<div class="wrap-text" style="text-align:center; padding:20px; color:var(--warn);">' + err.message + '</div>';
    })
    .finally(function() {
      if (btn) { btn.disabled = false; btn.textContent = '实时刷新'; }
    });
  }

  function switchWorkspaceView(viewId) {
    try { localStorage.setItem(STORAGE_VIEW_KEY, viewId); } catch (e) {}
    var navs = document.querySelectorAll('#sidebarNavList .nav-btn');
    for (var i = 0; i < navs.length; i++) {
      var n = navs[i];
      if (n.getAttribute('data-view') === viewId) n.classList.add('active');
      else n.classList.remove('active');
    }
    var views = document.querySelectorAll('.ws-view');
    for (var j = 0; j < views.length; j++) {
      var v = views[j];
      if (v.id === 'view-' + viewId) v.classList.remove('hidden');
      else v.classList.add('hidden');
    }
    if (viewId === 'settings') renderSettingsView();
    if (viewId === 'nodes') loadInlineOptNodes(false);
  }

  function selectSetupProvider(prov) {
    state.setupProvider = prov;
    var tabs = document.querySelectorAll('#setupProvTabs .prov-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-prov') === prov);
    }
    var meta = BOOT.providersMeta[prov];
    document.getElementById('setupAkLabel').textContent = meta.shortName + ' ' + meta.akLabel + ' *';
    document.getElementById('setupSkLabel').textContent = meta.shortName + ' ' + meta.skLabel + ' *';
    document.getElementById('setupDomainLabel').textContent = meta.shortName + '默认访问主域 (可选)';
    document.getElementById('setupTokenLink').href = meta.tokenUrl;
  }

  function submitInstallWizard() {
    var cfEmail = document.getElementById('setupCfEmail').value.trim();
    var cfKey = document.getElementById('setupCfKey').value.trim();
    var defaultCfDomain = document.getElementById('setupCfDomain').value.trim();
    var adminPass = document.getElementById('setupAdminPass').value.trim();
    var dnsAk = document.getElementById('setupDnsAk').value.trim();
    var dnsSk = document.getElementById('setupDnsSk').value.trim();
    var defaultDnsDomain = document.getElementById('setupDnsDomain').value.trim();
    var defaultOptDomain = document.getElementById('setupOptDomain').value.trim();

    if (!cfKey) { showToast('请填写 Cloudflare API 密钥', 'err'); return; }
    if (!adminPass) { showToast('请设置控制台管理密码', 'err'); return; }
    if (!dnsAk || !dnsSk) { showToast('请填写所选云服务商的密钥', 'err'); return; }

    var btn = document.getElementById('btnFinishInstall');
    btn.disabled = true;
    btn.textContent = '正在验证双云 API 凭据并保存...';

    fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        adminPass: adminPass,
        cfEmail: cfEmail,
        cfKey: cfKey,
        defaultCfDomain: defaultCfDomain,
        defaultOptDomain: defaultOptDomain,
        provider: state.setupProvider,
        dnsAk: dnsAk,
        dnsSk: dnsSk,
        defaultDnsDomain: defaultDnsDomain,
        setActive: true
      })
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (!res.ok) throw new Error(res.error || '初始化安装失败');
      state.adminPass = adminPass;
      try { localStorage.setItem(STORAGE_PASS_KEY, adminPass); } catch (e) {}
      state.summary = res.data;
      state.activeProvider = state.summary.activeProvider;
      showToast('安装成功！配置已保存至 CFWUYA', 'ok');
      enterMainConsole();
    })
    .catch(function(err) {
      showToast(err.message, 'err');
    })
    .finally(function() {
      btn.disabled = false;
      btn.textContent = '验证双云凭据并保存进入控制台';
    });
  }

  function unlockConsole(savedPass) {
    var input = document.getElementById('loginPassInput');
    var pass = typeof savedPass === 'string' ? savedPass : (input ? input.value.trim() : '');
    var errEl = document.getElementById('loginErrText');
    var btn = document.getElementById('btnLogin');
    if (!pass) {
      if (errEl) errEl.textContent = '请输入管理密码';
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = '验证中...'; }
    if (errEl) errEl.textContent = '';

    fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Pass': pass }
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (!res.ok) throw new Error(res.error || '密码错误');
      state.adminPass = pass;
      try { localStorage.setItem(STORAGE_PASS_KEY, pass); } catch (e) {}
      enterMainConsole();
    })
    .catch(function(err) {
      try { localStorage.removeItem(STORAGE_PASS_KEY); } catch (e) {}
      if (errEl) errEl.textContent = err.message;
    })
    .finally(function() {
      if (btn) { btn.disabled = false; btn.textContent = '解锁进入'; }
    });
  }

  function logoutConsole() {
    state.adminPass = '';
    if (state.pollTimer) clearInterval(state.pollTimer);
    try { localStorage.removeItem(STORAGE_PASS_KEY); } catch (e) {}
    document.getElementById('mainAppShell').classList.add('hidden');
    document.getElementById('loginPassInput').value = '';
    document.getElementById('lockStage').classList.remove('hidden');
  }

  function enterMainConsole() {
    document.getElementById('d1GuideStage').classList.add('hidden');
    document.getElementById('installStage').classList.add('hidden');
    document.getElementById('lockStage').classList.add('hidden');
    document.getElementById('mainAppShell').classList.remove('hidden');

    if (state.summary.defaultOptDomain) {
      document.getElementById('preferredTarget').value = state.summary.defaultOptDomain;
    }
    var savedView = '';
    try { savedView = localStorage.getItem(STORAGE_VIEW_KEY) || ''; } catch (e) {}
    if (savedView && document.getElementById('view-' + savedView)) {
      switchWorkspaceView(savedView);
    }
    renderTopProviderBar();
    renderAutoSyncBox();
    loadResources(true);
  }

  function renderTopProviderBar() {
    var bar = document.getElementById('activeProviderBar');
    if (!bar) return;
    bar.innerHTML = '';
    var enabledList = state.summary.enabledProviders || [];
    var provMap = state.summary.providers || {};

    for (var i = 0; i < enabledList.length; i++) {
      (function(pid) {
        var p = provMap[pid];
        if (!p) return;
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'prov-chip' + (state.activeProvider === pid ? ' active' : '');
        chip.textContent = (state.activeProvider === pid ? '● ' : '○ ') + p.name;
        chip.onclick = function() {
          if (state.activeProvider === pid) return;
          switchActiveProvider(pid);
        };
        bar.appendChild(chip);
      })(enabledList[i]);
    }

    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'prov-chip add-btn';
    addBtn.textContent = '+ 添加云厂商';
    addBtn.onclick = function() { openProviderModal(); };
    bar.appendChild(addBtn);

    var refBtn = document.createElement('button');
    refBtn.type = 'button';
    refBtn.id = 'btnRefreshAll';
    refBtn.className = 'prov-chip refresh-btn';
    refBtn.textContent = '↻ 刷新资产';
    refBtn.onclick = function() { loadResources(true); };
    bar.appendChild(refBtn);

    var curMeta = provMap[state.activeProvider] || BOOT.providersMeta[state.activeProvider];
    if (curMeta) {
      document.getElementById('currentProviderBadge').textContent = curMeta.name;
      document.getElementById('prefixBoxLabel').textContent = '最终访问域名 (前缀 + ' + curMeta.shortName + '主域)';
    }
  }

  function renderAutoSyncBox() {
    var box = document.getElementById('autoSyncBox');
    if (!box) return;
    var isPages = BOOT.deployEnv === 'pages';
    var apiBase = window.location.origin + '/api/auto-update-opt';
    var fullApiUrl = state.adminPass ? (apiBase + '?token=' + encodeURIComponent(state.adminPass)) : apiBase;

    if (isPages) {
      box.innerHTML =
        '<div class="detect-lines">' +
          '<div class="detect-line-item" style="color:#34D399; font-weight:700;">⚡ Pages 定时优选触发接口</div>' +
          '<div class="detect-line-item">外部监控或定时任务访问下方 API 即可自动将全部矩阵切换至香港首选 IP：</div>' +
          '<div class="detect-line-item"><code id="autoUpdateApiText">' + fullApiUrl + '</code></div>' +
        '</div>' +
        '<div class="btn-flow" style="margin-top:10px;">' +
          '<button type="button" class="btn btn-sm" data-copy-id="autoUpdateApiText" onclick="copyByDataId(this)">复制定时更新 API</button>' +
        '</div>';
    } else {
      box.innerHTML =
        '<div class="detect-lines">' +
          '<div class="detect-line-item" style="color:#34D399; font-weight:700;">⚡ Workers Cron 自动巡检</div>' +
          '<div class="detect-line-item">在 Workers 设置 → 触发器中添加 Cron 表达式（建议每 12 小时更新为香港首选 IP）：</div>' +
          '<div class="detect-line-item"><code id="cronExprText">0 */12 * * *</code></div>' +
        '</div>' +
        '<div class="btn-flow" style="margin-top:10px;">' +
          '<button type="button" class="btn btn-sm" data-copy-id="cronExprText" onclick="copyByDataId(this)">复制 Cron 表达式</button>' +
        '</div>';
    }
  }

  function switchActiveProvider(newProv) {
    addLog('正在切换云解析服务商: ' + BOOT.providersMeta[newProv].name);
    fetch('/api/provider-switch', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ activeProvider: newProv })
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (!res.ok) throw new Error(res.error || '切换失败');
      state.summary = res.data;
      state.activeProvider = state.summary.activeProvider;
      renderTopProviderBar();
      renderSettingsView();
      loadResources(true);
      showToast('已切换至 ' + BOOT.providersMeta[newProv].name, 'ok');
    })
    .catch(function(err) { showToast(err.message, 'err'); });
  }

  function openProviderModal(defaultProv) {
    var target = defaultProv || 'tencent';
    if (state.activeProvider === 'tencent' && !defaultProv) target = 'huawei';
    selectModalProvider(target);
    document.getElementById('providerModal').classList.remove('hidden');
  }

  function closeProviderModal() {
    document.getElementById('providerModal').classList.add('hidden');
  }

  function selectModalProvider(prov) {
    state.modalProvider = prov;
    var tabs = document.querySelectorAll('#modalProvTabs .prov-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-prov') === prov);
    }
    var meta = BOOT.providersMeta[prov];
    var savedProv = (state.summary.providers && state.summary.providers[prov]) ? state.summary.providers[prov] : {};
    document.getElementById('modalAkLabel').textContent = meta.shortName + ' ' + meta.akLabel;
    document.getElementById('modalSkLabel').textContent = meta.shortName + ' ' + meta.skLabel;
    document.getElementById('modalTokenLink').href = meta.tokenUrl;
    document.getElementById('modalDnsAk').value = '';
    document.getElementById('modalDnsAk').placeholder = savedProv.maskedAk ? ('已保存 (' + savedProv.maskedAk + ')，留空保持不变') : ('输入 ' + meta.akLabel);
    document.getElementById('modalDnsSk').value = '';
    document.getElementById('modalDnsSk').placeholder = savedProv.hasCredentials ? '已保存，留空保持不变' : ('输入 ' + meta.skLabel);
    document.getElementById('modalDefaultDomain').value = savedProv.defaultDomain || '';
  }

  function saveModalProvider() {
    var prov = state.modalProvider;
    var ak = document.getElementById('modalDnsAk').value.trim();
    var sk = document.getElementById('modalDnsSk').value.trim();
    var defDom = document.getElementById('modalDefaultDomain').value.trim();
    var savedProv = (state.summary.providers && state.summary.providers[prov]) ? state.summary.providers[prov] : {};

    if (!savedProv.hasCredentials && (!ak || !sk)) {
      showToast('首次启用该服务商需填写完整密钥', 'err');
      return;
    }

    var btn = document.getElementById('btnSaveModalProv');
    btn.disabled = true;
    btn.textContent = '正在校验密钥并保存...';

    fetch('/api/setup', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        provider: prov,
        dnsAk: ak,
        dnsSk: sk,
        defaultDnsDomain: defDom,
        enabled: true,
        setActive: true
      })
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (!res.ok) throw new Error(res.error || '保存失败');
      state.summary = res.data;
      state.activeProvider = state.summary.activeProvider;
      closeProviderModal();
      renderTopProviderBar();
      renderSettingsView();
      loadResources(true);
      showToast('已启用并切换至 ' + BOOT.providersMeta[prov].name, 'ok');
    })
    .catch(function(err) { showToast(err.message, 'err'); })
    .finally(function() {
      btn.disabled = false;
      btn.textContent = '验证密钥并启用该服务商';
    });
  }

  function renderSettingsView() {
    var listEl = document.getElementById('enabledProvidersList');
    if (!listEl) return;
    listEl.innerHTML = '';
    var enabledList = state.summary.enabledProviders || [];
    var provMap = state.summary.providers || {};

    for (var i = 0; i < enabledList.length; i++) {
      (function(pid) {
        var p = provMap[pid];
        if (!p) return;
        var row = document.createElement('div');
        row.className = 'matrix-item';
        var isCur = state.activeProvider === pid;

        var top = document.createElement('div');
        top.className = 'matrix-top';
        top.innerHTML =
          '<span class="matrix-domain" style="color:var(--text-bright);">' + p.name + '</span>' +
          '<span class="pill ' + (isCur ? 'ok' : 'info') + '">' + (isCur ? '当前使用中' : '已启用') + '</span>';

        var meta = document.createElement('div');
        meta.className = 'matrix-meta';
        meta.innerHTML =
          '<span>已存密钥: <b>' + (p.maskedAk || '已托管') + '</b></span>' +
          '<span>默认主域: <b>' + (p.defaultDomain || '自动选第一个域名') + '</b></span>';

        var btnGroup = document.createElement('div');
        btnGroup.className = 'btn-flow';
        if (!isCur) {
          var bSw = document.createElement('button');
          bSw.type = 'button';
          bSw.className = 'btn btn-ok btn-sm';
          bSw.textContent = '切换使用';
          bSw.onclick = function() { switchActiveProvider(pid); };
          btnGroup.appendChild(bSw);
        }
        var bEdit = document.createElement('button');
        bEdit.type = 'button';
        bEdit.className = 'btn btn-sm';
        bEdit.textContent = '修改配置';
        bEdit.onclick = function() { openProviderModal(pid); };
        btnGroup.appendChild(bEdit);

        if (enabledList.length > 1) {
          var bDis = document.createElement('button');
          bDis.type = 'button';
          bDis.className = 'btn btn-danger btn-sm';
          bDis.textContent = '停用';
          bDis.onclick = function() { disableProvider(pid); };
          btnGroup.appendChild(bDis);
        }

        row.appendChild(top);
        row.appendChild(meta);
        row.appendChild(btnGroup);
        listEl.appendChild(row);
      })(enabledList[i]);
    }

    document.getElementById('setCfEmail').value = state.summary.cfEmail || '';
    document.getElementById('setCfKey').value = '';
    document.getElementById('setCfKey').placeholder = state.summary.maskedCfKey ? ('已保存 (' + state.summary.maskedCfKey + ')，不修改留空') : '输入新密钥';
    document.getElementById('setDefaultCfDomain').value = state.summary.defaultCfDomain || '';
    document.getElementById('setAdminPass').value = '';
  }

  function disableProvider(pid) {
    if (!confirm('确认停用 ' + BOOT.providersMeta[pid].name + ' 吗？')) return;
    fetch('/api/provider-switch', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ disableProvider: pid })
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (!res.ok) throw new Error(res.error || '操作失败');
      state.summary = res.data;
      state.activeProvider = state.summary.activeProvider;
      renderTopProviderBar();
      renderSettingsView();
      loadResources(true);
      showToast('已停用该服务商', 'ok');
    })
    .catch(function(err) { showToast(err.message, 'err'); });
  }

  function saveGlobalSettings() {
    var cfEmail = document.getElementById('setCfEmail').value.trim();
    var cfKey = document.getElementById('setCfKey').value.trim();
    var defCf = document.getElementById('setDefaultCfDomain').value.trim();
    var newPass = document.getElementById('setAdminPass').value.trim();
    var btn = document.getElementById('btnSaveGlobalSet');
    btn.disabled = true;
    btn.textContent = '正在保存...';

    fetch('/api/setup', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        cfEmail: cfEmail,
        cfKey: cfKey,
        defaultCfDomain: defCf,
        adminPass: newPass,
        provider: state.activeProvider,
        setActive: false
      })
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (!res.ok) throw new Error(res.error || '保存失败');
      if (newPass) {
        state.adminPass = newPass;
        try { localStorage.setItem(STORAGE_PASS_KEY, newPass); } catch (e) {}
      }
      state.summary = res.data;
      renderAutoSyncBox();
      renderSettingsView();
      loadResources(true);
      showToast('全局设置已保存至 D1', 'ok');
    })
    .catch(function(err) { showToast(err.message, 'err'); })
    .finally(function() {
      btn.disabled = false;
      btn.textContent = '保存全局设置至 D1';
    });
  }

  function setCurrentCfAsDefault() {
    var cf = getActiveCfZone();
    if (!cf.name) return;
    fetch('/api/provider-switch', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ defaultCfDomain: cf.name })
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (!res.ok) throw new Error(res.error || '设置失败');
      state.summary = res.data;
      showToast('已将 ' + cf.name + ' 设为默认 CF 中转域', 'ok');
    })
    .catch(function(err) { showToast(err.message, 'err'); });
  }

  function setCurrentDnsAsDefault() {
    var dz = getActiveDnsZone();
    if (!dz.name) return;
    fetch('/api/provider-switch', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ provider: state.activeProvider, defaultDnsDomain: dz.name })
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (!res.ok) throw new Error(res.error || '设置失败');
      state.summary = res.data;
      showToast('已将 ' + dz.name + ' 设为默认主域', 'ok');
    })
    .catch(function(err) { showToast(err.message, 'err'); });
  }

  function getActiveDnsZone() {
    var sel = document.getElementById('dnsZoneSelect');
    if (!sel || !sel.value) return { id: '', name: '' };
    var opt = sel.options[sel.selectedIndex];
    return {
      id: sel.value,
      name: opt ? (opt.getAttribute('data-domain') || opt.textContent).trim().toLowerCase() : ''
    };
  }

  function getActiveCfZone() {
    var sel = document.getElementById('cfZoneSelect');
    if (!sel || !sel.value) return { id: '', name: '' };
    var opt = sel.options[sel.selectedIndex];
    return {
      id: sel.value,
      name: opt ? (opt.getAttribute('data-domain') || opt.textContent).trim().toLowerCase() : ''
    };
  }

  function getPairKey(cfId, dnsId) {
    return state.activeProvider + '::' + (cfId || '') + '::' + (dnsId || '');
  }

  function genRandomPrefix() {
    var chars = 'abcdefghijkmnpqrstuvwxyz23456789';
    var out = 'edge-';
    for (var i = 0; i < 4; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
    document.getElementById('prefixInput').value = out;
    onPrefixInput();
    showToast('已生成随机前缀: ' + out, 'ok');
  }

  function getCurrentFullDomain() {
    var dz = getActiveDnsZone();
    if (!dz.name) return '';
    var raw = document.getElementById('prefixInput').value.trim();
    var prefix = raw.split('.').filter(Boolean).join('.');
    return (!prefix || prefix === '@') ? dz.name : (prefix + '.' + dz.name);
  }

  function updateTopologyCanvas() {
    var fullDomain = getCurrentFullDomain();
    var cf = getActiveCfZone();
    var pref = (document.getElementById('preferredTarget').value || '').trim();
    var meta = getSelectedProjectMeta();
    var fallbackStr = cf.name ? ('saas-origin.' + cf.name) : 'saas-origin.---';
    var targetLabel = meta.projName
      ? ('[' + (state.targetType === 'pages' ? 'Pages' : 'Worker') + '] ' + meta.projName)
      : '未选择源站项目';

    document.getElementById('topoDomainVal').textContent = fullDomain || '未选择访问域名';
    document.getElementById('topoDnsVal').textContent = pref || state.defaultHkIp || '未填写优选目标';
    document.getElementById('topoOriginVal').textContent = fallbackStr;
    document.getElementById('topoOriginSub').textContent = '边缘中继指向: ' + targetLabel;

    document.getElementById('detailSourceName').textContent = targetLabel;
    document.getElementById('detailFallbackOrigin').textContent = fallbackStr;
    if (fullDomain) {
      document.getElementById('openLink').href = 'https://' + fullDomain;
    }

    var domainTag = document.getElementById('topoDomainTag');
    var originTag = document.getElementById('topoOriginTag');
    var overallTag = document.getElementById('topoOverallTag');

    if (state.currentProjectBoundHosts.length > 0) {
      var activeHost = state.currentProjectBoundHosts[0];
      var isReady = activeHost.status === 'active' && activeHost.sslStatus === 'active' && activeHost.dnsReady;
      domainTag.className = isReady ? 'pill ok' : 'pill warn';
      domainTag.textContent = isReady ? '已加速' : '签发中';
      originTag.className = 'pill ok';
      originTag.textContent = '中继已绑定';
      overallTag.className = isReady ? 'pill ok' : 'pill warn';
      overallTag.textContent = isReady ? '全链路已激活' : '证书验证中';
    } else {
      domainTag.className = 'pill';
      domainTag.textContent = fullDomain ? '待部署' : '待选域名';
      originTag.className = 'pill';
      originTag.textContent = '待绑定';
      overallTag.className = 'pill info';
      overallTag.textContent = '等待激活';
    }
  }

  function updatePreview() {
    var full = getCurrentFullDomain();
    document.getElementById('previewUrl').textContent = full ? ('https://' + full) : '等待选择域名...';
    updateTopologyCanvas();
  }

  function onPrefixInput() {
    updatePreview();
    evaluateAccelerationStatus();
  }

  function getProjectAcceleratedHosts(type, projName, projDomain, insp) {
    if (!projName || !insp) return [];
    var allHosts = Array.isArray(insp.acceleratedHosts) ? insp.acceleratedHosts : [];
    if (type === 'pages') {
      var expectedHost = (projDomain || (projName + '.pages.dev')).toLowerCase();
      return allHosts.filter(function(h) {
        return h.targetType === 'pages' ? h.targetName === expectedHost : h.mappedTarget === expectedHost;
      });
    }
    return allHosts.filter(function(h) {
      return h.targetType === 'worker' ? h.targetName === projName : h.mappedTarget === projName;
    });
  }

  function getSelectedProjectMeta() {
    var projSel = document.getElementById('projectSelect');
    var cf = getActiveCfZone();
    var dz = getActiveDnsZone();
    var projName = projSel ? projSel.value : '';
    var opt = (projSel && projSel.options[projSel.selectedIndex]) ? projSel.options[projSel.selectedIndex] : null;
    var projDomain = opt ? (opt.getAttribute('data-domain') || '') : '';
    var rawDoms = opt ? (opt.getAttribute('data-bound-domains') || '') : '';
    var boundDomains = rawDoms ? rawDoms.split(',').filter(Boolean) : [];
    var insp = (cf.id && dz.id) ? state.inspectionByPair[getPairKey(cf.id, dz.id)] : null;
    return {
      projName: projName,
      projDomain: projDomain,
      boundDomains: boundDomains,
      cfZoneId: cf.id,
      cfZoneName: cf.name,
      dnsZoneId: dz.id,
      dnsZoneName: dz.name,
      insp: insp
    };
  }

  function detectDomainConflict() {
    var meta = getSelectedProjectMeta();
    var fullDomain = getCurrentFullDomain().toLowerCase();
    if (!fullDomain || !meta.projName) return null;

    var expectedTarget = state.targetType === 'pages'
      ? (meta.projDomain || (meta.projName + '.pages.dev')).toLowerCase()
      : meta.projName;
    var expectedType = state.targetType === 'workers' ? 'worker' : 'pages';

    if (meta.insp && Array.isArray(meta.insp.acceleratedHosts)) {
      var matchedHost = meta.insp.acceleratedHosts.find(function(h) { return h.hostname === fullDomain; });
      if (matchedHost) {
        if (!matchedHost.targetName) {
          return { hostname: fullDomain, conflictOwner: '未独立映射的存量节点' };
        }
        if (matchedHost.targetType !== expectedType || matchedHost.targetName.toLowerCase() !== expectedTarget) {
          var label = (matchedHost.targetType === 'worker' ? '[Worker] ' : '[Pages] ') + matchedHost.targetName;
          return { hostname: fullDomain, conflictOwner: label };
        }
      }
    }

    for (var i = 0; i < state.pagesProjects.length; i++) {
      var p = state.pagesProjects[i];
      if (state.targetType === 'pages' && p.name === meta.projName) continue;
      if (Array.isArray(p.domains) && p.domains.indexOf(fullDomain) !== -1) {
        return { hostname: fullDomain, conflictOwner: '[Pages] ' + p.name };
      }
    }
    return null;
  }

  function syncPrefixFromSelectedProject() {
    var meta = getSelectedProjectMeta();
    var accHosts = getProjectAcceleratedHosts(state.targetType, meta.projName, meta.projDomain, meta.insp);
    state.currentProjectBoundHosts = accHosts;
    var prefixInput = document.getElementById('prefixInput');

    if (accHosts.length > 0) {
      var primary = accHosts[0];
      prefixInput.value = primary.prefix === '@' ? '' : primary.prefix;
      if (primary.preferredTarget) {
        document.getElementById('preferredTarget').value = primary.preferredTarget;
      } else if (state.defaultHkIp) {
        document.getElementById('preferredTarget').value = state.defaultHkIp;
      }
      state.lastCfZoneId = meta.cfZoneId;
      state.lastCustomHostnameId = primary.id;
      updateStatusPills(primary.status, primary.sslStatus);
    } else {
      var dnsDomain = meta.dnsZoneName;
      var matchedDomain = dnsDomain ? meta.boundDomains.find(function(d) {
        return d === dnsDomain || d.endsWith('.' + dnsDomain);
      }) : '';
      if (matchedDomain) {
        prefixInput.value = matchedDomain === dnsDomain ? '' : matchedDomain.slice(0, -(dnsDomain.length + 1));
      } else {
        prefixInput.value = '';
      }
      if (state.defaultHkIp) {
        document.getElementById('preferredTarget').value = state.defaultHkIp;
      }
      updateStatusPills('未激活', '未签发');
    }
    updatePreview();
  }

  function switchTargetType(type) {
    state.targetType = type;
    document.getElementById('swPages').className = type === 'pages' ? 'switch-btn active' : 'switch-btn';
    document.getElementById('swWorkers').className = type === 'workers' ? 'switch-btn active' : 'switch-btn';
    document.getElementById('projectLabel').textContent = type === 'pages' ? '选择 Pages 项目' : '选择 Workers 脚本';
    renderProjectOptions();
    syncPrefixFromSelectedProject();
    evaluateAccelerationStatus();
  }

  function onProjectChange() {
    syncPrefixFromSelectedProject();
    evaluateAccelerationStatus();
  }

  function renderProjectOptions() {
    var sel = document.getElementById('projectSelect');
    var prevVal = sel.value;
    sel.innerHTML = '';
    var list = state.targetType === 'pages' ? state.pagesProjects : state.workerScripts;
    if (!list.length) {
      var opt = document.createElement('option');
      opt.value = '';
      opt.textContent = state.targetType === 'pages' ? '未检测到 Pages 项目' : '未检测到 Workers 脚本';
      sel.appendChild(opt);
      return;
    }

    var cf = getActiveCfZone();
    var dz = getActiveDnsZone();
    var insp = (cf.id && dz.id) ? state.inspectionByPair[getPairKey(cf.id, dz.id)] : null;

    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      var opt = document.createElement('option');
      opt.value = item.name;
      opt.setAttribute('data-domain', item.subdomain || '');
      opt.setAttribute('data-bound-domains', (item.domains || []).join(','));
      var accHosts = getProjectAcceleratedHosts(state.targetType, item.name, item.subdomain, insp);
      var baseText = item.subdomain ? (item.name + ' (' + item.subdomain + ')') : item.name;
      opt.textContent = accHosts.length > 0 ? ('✅ [' + accHosts[0].hostname + '] ' + baseText) : baseText;
      sel.appendChild(opt);
    }
    if (prevVal && list.some(function(x) { return x.name === prevVal; })) sel.value = prevVal;
  }

  function evaluateAccelerationStatus() {
    var box = document.getElementById('detectBox');
    var titleEl = document.getElementById('detectTitle');
    var linesEl = document.getElementById('detectLines');
    var openEl = document.getElementById('detectOpenLink');
    var btnAct = document.getElementById('btnActivate');
    var replaceBox = document.getElementById('replaceOptBox');
    var replaceText = document.getElementById('replaceOptText');
    var glowWrap = document.getElementById('prefixGlowWrap');

    var meta = getSelectedProjectMeta();
    var projName = meta.projName;
    var insp = meta.insp;

    openEl.className = 'btn btn-ok btn-sm hidden';
    replaceBox.className = 'replace-opt hidden';
    glowWrap.className = 'prefix-glow-wrap';

    if (!projName || !insp || !meta.dnsZoneName) {
      box.className = 'detect-box';
      titleEl.textContent = '⚪ 等待检测项目加速状态';
      linesEl.innerHTML = '<div class="detect-line-item">点击顶部「刷新资产」或上方「重新检测」获取项目的 SaaS 绑定状态。</div>';
      btnAct.textContent = '一键激活 SaaS 优选加速';
      updateTopologyCanvas();
      return;
    }

    var projectAccHosts = getProjectAcceleratedHosts(state.targetType, projName, meta.projDomain, insp);
    state.currentProjectBoundHosts = projectAccHosts;

    var rawPrefix = document.getElementById('prefixInput').value.trim();
    var currentHost = getCurrentFullDomain().toLowerCase();
    var conflict = detectDomainConflict();

    if (conflict) {
      glowWrap.className = 'prefix-glow-wrap conflict-glow';
      box.className = 'detect-box pending';
      titleEl.textContent = '⚠️ 冲突警告：' + conflict.hostname + ' 已绑定 ' + conflict.conflictOwner;
      linesEl.innerHTML =
        '<div class="detect-line-item">占用说明：' + (rawPrefix ? ('当前前缀 <code>' + rawPrefix + '</code>') : '当前主域名（未填前缀）') + ' 已被 <code>' + conflict.conflictOwner + '</code> 占用</div>' +
        '<div class="detect-line-item">操作提示：点击下方按钮确认覆盖后，旧绑定将自动卸载失效</div>';
      openEl.href = 'https://' + conflict.hostname;
      openEl.className = 'btn btn-ok btn-sm';
      btnAct.textContent = '覆盖迁移并绑定 ' + conflict.hostname;
      updateTopologyCanvas();
      return;
    }

    if (projectAccHosts.length > 0) {
      var matchedCurrent = projectAccHosts.find(function(h) { return h.hostname === currentHost; }) || null;
      var activeHost = matchedCurrent || projectAccHosts[0];
      var isAllActive = activeHost.status === 'active' && activeHost.sslStatus === 'active' && activeHost.dnsReady;

      box.className = isAllActive ? 'detect-box accelerated' : 'detect-box pending';
      titleEl.textContent = isAllActive
        ? ('✅ 项目 [' + projName + '] 已开启 SaaS 加速（' + activeHost.hostname + '）')
        : ('⏳ 项目 [' + projName + '] 已配置 SaaS（证书签发中：' + activeHost.hostname + '）');

      var line3Tip = !matchedCurrent
        ? ('已修改为 ' + currentHost + '，点击下方按钮更换域名')
        : '修改下方发光框前缀可更换域名';

      linesEl.innerHTML =
        '<div class="detect-line-item">回退源: <code>' + insp.fallbackOrigin + '</code></div>' +
        '<div class="detect-line-item">优选目标: <code>' + (activeHost.preferredTarget || '未设置') + '</code></div>' +
        '<div class="detect-line-item">' + line3Tip + '</div>';

      openEl.href = 'https://' + activeHost.hostname;
      openEl.className = 'btn btn-ok btn-sm';

      if (!matchedCurrent) {
        replaceBox.className = 'replace-opt';
        replaceText.textContent = '更换为 ' + currentHost + ' 时，自动清理原加速域名 ' + projectAccHosts[0].hostname + ' 的旧记录';
        btnAct.textContent = '更换加速域名为 ' + currentHost;
      } else {
        btnAct.textContent = '更新 / 重新同步当前 SaaS 配置';
      }
      updateTopologyCanvas();
      return;
    }

    box.className = 'detect-box';
    titleEl.textContent = '⚪ 当前项目 [' + projName + '] 尚未绑定 SaaS 加速';
    linesEl.innerHTML =
      '<div class="detect-line-item">回退源: <code>' + insp.fallbackOrigin + '</code></div>' +
      '<div class="detect-line-item">优选目标: <code>' + ((document.getElementById('preferredTarget').value || '').trim() || state.defaultHkIp || '未设置') + '</code></div>' +
      '<div class="detect-line-item">' + (rawPrefix ? ('准备将 ' + currentHost + ' 绑定至 [' + projName + ']，点击下方按钮一键激活') : '修改下方发光框前缀可自定义子域名，留空则直接使用主域名') + '</div>';
    btnAct.textContent = '一键激活 SaaS 优选加速';
    updateTopologyCanvas();
  }

  function closeConflictModal() {
    document.getElementById('conflictModal').classList.add('hidden');
    state.pendingAction = null;
  }

  function handleTriggerAction(actionType) {
    if (state.busy) return;
    var conflict = detectDomainConflict();
    if (conflict) {
      var rawPrefix = document.getElementById('prefixInput').value.trim();
      var prefixLabel = rawPrefix ? ('前缀「' + rawPrefix + '」(' + conflict.hostname + ')') : ('主域名「' + conflict.hostname + '」（未输入前缀）');
      document.getElementById('conflictModalBody').innerHTML = '当前 <b>' + prefixLabel + '</b> 已经绑定了 <b>' + conflict.conflictOwner + '</b> 项目，是否继续？';
      state.pendingAction = actionType;
      document.getElementById('btnConfirmConflict').onclick = function() {
        var act = state.pendingAction;
        closeConflictModal();
        if (act === 'selfcheck') runSelfCheck();
        else activateSaas();
      };
      document.getElementById('conflictModal').classList.remove('hidden');
      return;
    }
    if (actionType === 'selfcheck') runSelfCheck();
    else activateSaas();
  }

  function buildTargetOptionsForSelect(selectEl, currentType, currentTargetName) {
    selectEl.innerHTML = '';
    var optDefault = document.createElement('option');
    optDefault.value = '';
    optDefault.textContent = '选择目标项目重绑...';
    selectEl.appendChild(optDefault);

    if (state.pagesProjects.length > 0) {
      var grpPages = document.createElement('optgroup');
      grpPages.label = 'Pages 项目';
      for (var i = 0; i < state.pagesProjects.length; i++) {
        var p = state.pagesProjects[i];
        var sub = (p.subdomain || (p.name + '.pages.dev')).toLowerCase();
        var o = document.createElement('option');
        o.value = 'pages::' + p.name + '::' + sub;
        o.textContent = '[Pages] ' + p.name;
        if (currentType === 'pages' && currentTargetName === sub) o.selected = true;
        grpPages.appendChild(o);
      }
      selectEl.appendChild(grpPages);
    }
    if (state.workerScripts.length > 0) {
      var grpWorkers = document.createElement('optgroup');
      grpWorkers.label = 'Workers 脚本';
      for (var j = 0; j < state.workerScripts.length; j++) {
        var w = state.workerScripts[j];
        var ow = document.createElement('option');
        ow.value = 'workers::' + w.name + '::';
        ow.textContent = '[Worker] ' + w.name;
        if (currentType === 'worker' && currentTargetName === w.name) ow.selected = true;
        grpWorkers.appendChild(ow);
      }
      selectEl.appendChild(grpWorkers);
    }
  }

  function renderMatrixList() {
    var listEl = document.getElementById('matrixList');
    var countEl = document.getElementById('matrixCount');
    var rightBadge = document.getElementById('rightMatrixBadge');
    var cf = getActiveCfZone();
    var dz = getActiveDnsZone();
    var insp = (cf.id && dz.id) ? state.inspectionByPair[getPairKey(cf.id, dz.id)] : null;
    var hosts = (insp && Array.isArray(insp.acceleratedHosts)) ? insp.acceleratedHosts : [];

    countEl.textContent = '共 ' + hosts.length + ' 个节点';
    if (rightBadge) rightBadge.textContent = hosts.length + ' 节点在线';
    listEl.innerHTML = '';

    if (!hosts.length) {
      var empty = document.createElement('div');
      empty.className = 'wrap-text';
      empty.style.cssText = 'text-align:center; padding:20px; font-size:13px; color:var(--text-muted);';
      empty.textContent = '当前云服务商与域名组合下暂无已激活的 SaaS 节点，请在「域名与部署」中配置。';
      listEl.appendChild(empty);
      return;
    }

    for (var i = 0; i < hosts.length; i++) {
      (function(h) {
        var item = document.createElement('div');
        item.className = h.hasRoutingError ? 'matrix-item err-card' : 'matrix-item';

        var top = document.createElement('div');
        top.className = 'matrix-top';

        var domSpan = document.createElement('span');
        domSpan.className = 'matrix-domain';
        domSpan.textContent = 'https://' + h.hostname;

        var badges = document.createElement('div');
        badges.style.cssText = 'display:flex; flex-wrap:wrap; gap:6px;';

        if (h.hasRoutingError) {
          var bRoute = document.createElement('span');
          bRoute.className = 'pill warn';
          bRoute.textContent = '回源待校准';
          badges.appendChild(bRoute);
        }

        var bHost = document.createElement('span');
        bHost.className = 'pill ' + (h.status === 'active' ? 'ok' : 'warn');
        bHost.textContent = '主机名: ' + (h.status === 'active' ? '已激活' : h.status);

        var bSsl = document.createElement('span');
        bSsl.className = 'pill ' + (h.sslStatus === 'active' ? 'ok' : 'warn');
        bSsl.textContent = 'SSL: ' + (h.sslStatus === 'active' ? '已生效' : h.sslStatus);

        badges.appendChild(bHost);
        badges.appendChild(bSsl);
        top.appendChild(domSpan);
        top.appendChild(badges);

        var meta = document.createElement('div');
        meta.className = 'matrix-meta';
        var typeBadge = h.targetType === 'worker' ? '[Worker] ' : (h.targetType === 'pages' ? '[Pages] ' : '');
        meta.innerHTML =
          '<span>独立回源源站: <b>' + typeBadge + (h.targetName || '未独立绑定') + '</b></span>' +
          '<span>境内优选目标: <b>' + (h.preferredTarget || '未设置') + '</b></span>';

        var rebindRow = document.createElement('div');
        rebindRow.className = 'quick-opt-row';
        var targetSel = document.createElement('select');
        buildTargetOptionsForSelect(targetSel, h.targetType, h.targetName);
        var btnRebind = document.createElement('button');
        btnRebind.type = 'button';
        btnRebind.className = 'btn btn-sm';
        btnRebind.textContent = '重绑回源';
        btnRebind.onclick = function() { rebindCardOrigin(h.hostname, targetSel.value, btnRebind); };
        rebindRow.appendChild(targetSel);
        rebindRow.appendChild(btnRebind);

        var optRow = document.createElement('div');
        optRow.className = 'quick-opt-row';
        var optInput = document.createElement('input');
        optInput.type = 'text';
        optInput.readOnly = true;
        optInput.style.cursor = 'pointer';
        optInput.value = h.preferredTarget || '';
        optInput.placeholder = '点击选择优选 IP / 优选域名';
        optInput.onclick = function() { openOptModalForMatrix(h.hostname); };

        var btnSaveOpt = document.createElement('button');
        btnSaveOpt.type = 'button';
        btnSaveOpt.className = 'btn btn-sm';
        btnSaveOpt.textContent = '切换优选';
        btnSaveOpt.onclick = function() { openOptModalForMatrix(h.hostname); };
        optRow.appendChild(optInput);
        optRow.appendChild(btnSaveOpt);

        var carrierRow = document.createElement('div');
        carrierRow.className = 'carrier-probe-row hidden';

        var btns = document.createElement('div');
        btns.className = 'btn-flow';

        var btnProbe = document.createElement('button');
        btnProbe.type = 'button';
        btnProbe.className = 'btn btn-sm';
        btnProbe.textContent = '延迟测速';
        btnProbe.onclick = function() { probeHostname(h.preferredTarget || h.hostname, h.hostname, btnProbe, carrierRow); };

        var btnCopy = document.createElement('button');
        btnCopy.type = 'button';
        btnCopy.className = 'btn btn-sm';
        btnCopy.textContent = '复制地址';
        btnCopy.onclick = function() { copyUrl('https://' + h.hostname); };

        var btnOpen = document.createElement('a');
        btnOpen.href = 'https://' + h.hostname;
        btnOpen.target = '_blank';
        btnOpen.className = 'btn btn-ok btn-sm';
        btnOpen.textContent = '打开站点';

        var delWrap = document.createElement('div');
        delWrap.className = 'btn-flow';
        var btnDel = document.createElement('button');
        btnDel.type = 'button';
        btnDel.className = 'btn btn-danger btn-sm';
        btnDel.textContent = '彻底卸载';
        btnDel.onclick = function() { deleteHostnameAsset(h.hostname, cf.id, cf.name, btnDel); };
        delWrap.appendChild(btnDel);

        btns.appendChild(btnProbe);
        btns.appendChild(btnCopy);
        btns.appendChild(btnOpen);

        item.appendChild(top);
        item.appendChild(meta);
        item.appendChild(rebindRow);
        item.appendChild(optRow);
        item.appendChild(btns);
        item.appendChild(carrierRow);
        item.appendChild(delWrap);
        listEl.appendChild(item);
      })(hosts[i]);
    }
  }

  function applyResourceData(d) {
    if (d.configSummary) {
      state.summary = d.configSummary;
      state.activeProvider = state.summary.activeProvider;
      renderTopProviderBar();
    }
    if (d.ipPool) {
      state.optIpPoolCache = d.ipPool;
    }
    if (d.defaultOptIp) {
      state.defaultHkIp = d.defaultOptIp;
      var prefEl = document.getElementById('preferredTarget');
      if (prefEl && !prefEl.value.trim()) {
        prefEl.value = d.defaultOptIp;
      }
    }
    state.pagesProjects = d.pagesProjects || [];
    state.workerScripts = d.workerScripts || [];
    state.cfZones = d.cfZones || [];
    state.dnsZones = d.dnsZones || [];

    var cfSel = document.getElementById('cfZoneSelect');
    cfSel.innerHTML = '';
    for (var i = 0; i < state.cfZones.length; i++) {
      var z = state.cfZones[i];
      var opt = document.createElement('option');
      opt.value = z.id;
      opt.setAttribute('data-domain', z.name);
      opt.textContent = z.name;
      cfSel.appendChild(opt);
    }

    var dnsSel = document.getElementById('dnsZoneSelect');
    dnsSel.innerHTML = '';
    if (state.dnsZones.length > 0) {
      for (var j = 0; j < state.dnsZones.length; j++) {
        var dz = state.dnsZones[j];
        var dopt = document.createElement('option');
        dopt.value = dz.id;
        dopt.setAttribute('data-domain', dz.name);
        dopt.textContent = dz.name;
        dnsSel.appendChild(dopt);
      }
    } else {
      var emptyOpt = document.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = '未检测到域名';
      dnsSel.appendChild(emptyOpt);
    }

    if (d.inspection && state.cfZones.length > 0 && state.dnsZones.length > 0) {
      state.inspectionByPair[getPairKey(state.cfZones[0].id, state.dnsZones[0].id)] = d.inspection;
    }

    renderProjectOptions();
    syncPrefixFromSelectedProject();
    if (d.warnings && d.warnings.length) {
      for (var w = 0; w < d.warnings.length; w++) addLog(d.warnings[w], true);
    }
    evaluateAccelerationStatus();
    renderMatrixList();
    addLog('同步完成：' + state.pagesProjects.length + ' 个 Pages、' + state.workerScripts.length + ' 个 Workers、' + state.dnsZones.length + ' 个 ' + (d.providerMeta ? d.providerMeta.shortName : '') + ' 域名（香港首选 IP: ' + (state.defaultHkIp || '-') + '）。');
  }

  function loadResources(forceRefresh) {
    var btn = document.getElementById('btnRefreshAll');
    if (btn) { btn.disabled = true; btn.textContent = '同步中...'; }
    addLog('正在同步 Cloudflare 与 ' + BOOT.providersMeta[state.activeProvider].name + ' 资产...');

    fetch('/api/resources', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ provider: state.activeProvider })
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (!res.ok) throw new Error(res.error || '同步失败');
      applyResourceData(res.data);
      if (forceRefresh) showToast('云资产同步成功', 'ok');
    })
    .catch(function(err) {
      addLog(err.message, true);
      showToast(err.message, 'err');
    })
    .finally(function() {
      var refBtn = document.getElementById('btnRefreshAll');
      if (refBtn) { refBtn.disabled = false; refBtn.textContent = '↻ 刷新资产'; }
    });
  }

  function onZoneChange() {
    var cf = getActiveCfZone();
    var dz = getActiveDnsZone();
    updatePreview();
    if (!cf.id || !dz.id) return;
    var key = getPairKey(cf.id, dz.id);
    if (state.inspectionByPair[key]) {
      renderProjectOptions();
      syncPrefixFromSelectedProject();
      evaluateAccelerationStatus();
      renderMatrixList();
      return;
    }
    refreshInspection();
  }

  function refreshInspection() {
    var cf = getActiveCfZone();
    var dz = getActiveDnsZone();
    var btn = document.getElementById('btnReinspect');
    if (!cf.id || !dz.id) return;
    if (btn) { btn.disabled = true; btn.textContent = '检测中...'; }

    fetch('/api/inspect', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        provider: state.activeProvider,
        cfZoneId: cf.id,
        cfZoneName: cf.name,
        dnsZoneId: dz.id,
        dnsZoneName: dz.name
      })
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (!res.ok) throw new Error(res.error || '检测失败');
      state.inspectionByPair[getPairKey(cf.id, dz.id)] = res.data;
      renderProjectOptions();
      syncPrefixFromSelectedProject();
      evaluateAccelerationStatus();
      renderMatrixList();
      showToast('状态已刷新', 'ok');
    })
    .catch(function(err) { addLog(err.message, true); })
    .finally(function() {
      if (btn) { btn.disabled = false; btn.textContent = '重新检测'; }
    });
  }

  function collectFormPayload() {
    var projSel = document.getElementById('projectSelect');
    var cf = getActiveCfZone();
    var dz = getActiveDnsZone();
    var currentHost = getCurrentFullDomain().toLowerCase();
    var replaceOld = '';
    var chkCleanup = document.getElementById('chkCleanupOld');
    if (chkCleanup && chkCleanup.checked && state.currentProjectBoundHosts.length > 0) {
      var oldOne = state.currentProjectBoundHosts[0].hostname;
      if (oldOne && oldOne !== currentHost) replaceOld = oldOne;
    }
    var prefVal = document.getElementById('preferredTarget').value.trim() || state.defaultHkIp || '';
    return {
      provider: state.activeProvider,
      targetType: state.targetType,
      projectName: projSel.value,
      projectDomain: projSel.options[projSel.selectedIndex] ? projSel.options[projSel.selectedIndex].getAttribute('data-domain') : '',
      cfZoneId: cf.id,
      cfZoneName: cf.name,
      dnsZoneId: dz.id,
      dnsZoneName: dz.name,
      prefix: document.getElementById('prefixInput').value.trim(),
      preferredTarget: prefVal,
      replaceOldHostname: replaceOld
    };
  }

  function activateSaas() {
    if (state.busy) return;
    state.busy = true;
    var btn = document.getElementById('btnActivate');
    var btnCheck = document.getElementById('btnSelfCheck');
    var payload = collectFormPayload();

    btn.disabled = true;
    btnCheck.disabled = true;
    btn.textContent = '正在部署中继与双线解析...';
    addLog('开始执行一键 SaaS 激活流程...');

    fetch('/api/activate', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload)
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (!res.ok) throw new Error(res.error || '激活失败');
      var d = res.data;
      if (d.logs) for (var i = 0; i < d.logs.length; i++) addLog(d.logs[i]);
      state.lastCfZoneId = d.cfZoneId;
      state.lastCustomHostnameId = d.customHostnameId;
      if (d.inspection && d.cfZoneId && payload.dnsZoneId) {
        state.inspectionByPair[getPairKey(d.cfZoneId, payload.dnsZoneId)] = d.inspection;
        renderProjectOptions();
        evaluateAccelerationStatus();
        renderMatrixList();
      }
      document.getElementById('openLink').href = 'https://' + d.customHostname;
      updateStatusPills(d.status, d.sslStatus);
      showToast('配置下发成功: ' + d.customHostname, 'ok');
      if (d.sslStatus !== 'active') startCertPolling();
    })
    .catch(function(err) {
      addLog(err.message, true);
      showToast(err.message, 'err');
    })
    .finally(function() {
      state.busy = false;
      btn.disabled = false;
      btnCheck.disabled = false;
      evaluateAccelerationStatus();
    });
  }

  function runSelfCheck() {
    if (state.busy) return;
    state.busy = true;
    var btn = document.getElementById('btnActivate');
    var btnCheck = document.getElementById('btnSelfCheck');
    var payload = collectFormPayload();

    btn.disabled = true;
    btnCheck.disabled = true;
    btnCheck.textContent = '正在执行自检与修复...';

    fetch('/api/selfcheck', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload)
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (!res.ok) throw new Error(res.error || '自检失败');
      var d = res.data;
      if (d.logs) for (var i = 0; i < d.logs.length; i++) addLog(d.logs[i]);
      if (d.checks) {
        var list = document.getElementById('checkList');
        list.innerHTML = '';
        for (var j = 0; j < d.checks.length; j++) {
          var c = d.checks[j];
          var row = document.createElement('div');
          row.className = 'check-row';
          row.innerHTML =
            '<div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:6px; font-weight:700; color:var(--text-bright);">' +
              '<span>' + c.step + '</span>' +
              '<span class="pill ok">' + (c.status === 'fixed' ? '已修复' : '正常') + '</span>' +
            '</div>' +
            '<div class="wrap-text" style="color:var(--text-muted); margin-top:3px;">' + c.detail + '</div>';
          list.appendChild(row);
        }
        document.getElementById('checkReport').classList.remove('hidden');
      }
      state.lastCfZoneId = d.cfZoneId;
      state.lastCustomHostnameId = d.customHostnameId;
      if (d.inspection && d.cfZoneId && payload.dnsZoneId) {
        state.inspectionByPair[getPairKey(d.cfZoneId, payload.dnsZoneId)] = d.inspection;
        renderProjectOptions();
        evaluateAccelerationStatus();
        renderMatrixList();
      }
      document.getElementById('openLink').href = 'https://' + d.customHostname;
      updateStatusPills(d.status, d.sslStatus);
      showToast('全链路自检与修复完成', 'ok');
      if (d.sslStatus !== 'active') startCertPolling();
    })
    .catch(function(err) {
      addLog(err.message, true);
      showToast(err.message, 'err');
    })
    .finally(function() {
      state.busy = false;
      btn.disabled = false;
      btnCheck.disabled = false;
      btnCheck.textContent = '一键全面自检与修复证书';
    });
  }

  function rebindCardOrigin(hostname, packedVal, btn) {
    if (!packedVal) { showToast('请先选择目标项目', 'err'); return; }
    var parts = packedVal.split('::');
    var cf = getActiveCfZone();
    var dz = getActiveDnsZone();
    btn.disabled = true;
    btn.textContent = '绑定中...';

    fetch('/api/rebind', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        provider: state.activeProvider,
        hostname: hostname,
        targetType: parts[0],
        projectName: parts[1],
        projectDomain: parts[2] || '',
        cfZoneId: cf.id,
        cfZoneName: cf.name,
        dnsZoneId: dz.id,
        dnsZoneName: dz.name
      })
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (!res.ok) throw new Error(res.error || '重绑失败');
      var d = res.data;
      if (d.logs) for (var i = 0; i < d.logs.length; i++) addLog(d.logs[i]);
      if (d.inspection && cf.id && dz.id) {
        state.inspectionByPair[getPairKey(cf.id, dz.id)] = d.inspection;
        renderProjectOptions();
        evaluateAccelerationStatus();
        renderMatrixList();
      }
      showToast('已重绑独立回源: ' + hostname, 'ok');
    })
    .catch(function(err) { showToast(err.message, 'err'); })
    .finally(function() { btn.disabled = false; btn.textContent = '重绑回源'; });
  }

  function repairAllOrigins() {
    var cf = getActiveCfZone();
    var dz = getActiveDnsZone();
    if (!cf.id || !dz.id) return;
    var btn = document.getElementById('btnRepairOrigins');
    btn.disabled = true;
    btn.textContent = '修复中...';

    fetch('/api/repair-origins', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        provider: state.activeProvider,
        cfZoneId: cf.id,
        cfZoneName: cf.name,
        dnsZoneId: dz.id,
        dnsZoneName: dz.name
      })
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (!res.ok) throw new Error(res.error || '修复失败');
      var d = res.data;
      if (d.logs) for (var i = 0; i < d.logs.length; i++) addLog(d.logs[i]);
      if (d.bestHkIp) {
        state.defaultHkIp = d.bestHkIp;
        document.getElementById('preferredTarget').value = d.bestHkIp;
      }
      if (d.inspection) {
        state.inspectionByPair[getPairKey(cf.id, dz.id)] = d.inspection;
        renderProjectOptions();
        syncPrefixFromSelectedProject();
        evaluateAccelerationStatus();
        renderMatrixList();
      }
      showToast('已修复 ' + (d.fixedCount || 0) + ' 个节点并切换香港首选 IP: ' + (d.bestHkIp || ''), 'ok');
    })
    .catch(function(err) { showToast(err.message, 'err'); })
    .finally(function() { btn.disabled = false; btn.textContent = '一键修复回源错误'; });
  }

  function updateAllToBestOpt() {
    var cf = getActiveCfZone();
    var dz = getActiveDnsZone();
    var btn = document.getElementById('btnUpdateAllBest');
    btn.disabled = true;
    btn.textContent = '更新中...';

    fetch('/api/auto-update-opt', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        provider: state.activeProvider,
        cfZoneId: cf.id,
        cfZoneName: cf.name,
        dnsZoneId: dz.id,
        dnsZoneName: dz.name
      })
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (!res.ok) throw new Error(res.error || '更新失败');
      var d = res.data;
      if (d.logs) for (var i = 0; i < d.logs.length; i++) addLog(d.logs[i]);
      if (d.bestDomain) {
        state.defaultHkIp = d.bestDomain;
        document.getElementById('preferredTarget').value = d.bestDomain;
      }
      if (d.inspection && cf.id && dz.id) {
        state.inspectionByPair[getPairKey(cf.id, dz.id)] = d.inspection;
        renderMatrixList();
        evaluateAccelerationStatus();
      }
      showToast('已更新 ' + (d.updatedCount || 0) + ' 个节点为香港首选 IP ' + d.bestDomain, 'ok');
    })
    .catch(function(err) { showToast(err.message, 'err'); })
    .finally(function() { btn.disabled = false; btn.textContent = '一键更新全部最优'; });
  }

  function quickSwitchOpt(hostname, newOpt, btn) {
    if (!newOpt) { showToast('请选择优选 IP 或优选域名', 'err'); return; }
    var cf = getActiveCfZone();
    var dz = getActiveDnsZone();
    if (btn) { btn.disabled = true; btn.textContent = '切换中...'; }
    addLog('正在切换 [' + hostname + '] 优选节点为: ' + newOpt);

    fetch('/api/update-opt', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        provider: state.activeProvider,
        hostname: hostname,
        preferredTarget: newOpt,
        cfZoneId: cf.id,
        cfZoneName: cf.name,
        dnsZoneId: dz.id,
        dnsZoneName: dz.name
      })
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (!res.ok) throw new Error(res.error || '切换失败');
      var d = res.data;
      if (d.logs) for (var i = 0; i < d.logs.length; i++) addLog(d.logs[i]);
      if (d.inspection && cf.id && dz.id) {
        state.inspectionByPair[getPairKey(cf.id, dz.id)] = d.inspection;
        renderMatrixList();
        evaluateAccelerationStatus();
      } else {
        refreshInspection();
      }
      showToast('已切换 [' + hostname + '] 为 ' + newOpt, 'ok');
    })
    .catch(function(err) { showToast(err.message, 'err'); })
    .finally(function() {
      if (btn) { btn.disabled = false; btn.textContent = '切换优选'; }
    });
  }

  function probeHostname(targetNode, displayHost, btn, carrierRow) {
    btn.disabled = true;
    btn.textContent = '测速中...';
    fetch('/api/probe', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ target: targetNode })
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (!res.ok) throw new Error(res.error || '测速失败');
      var d = res.data;
      var lineText = '电信: ' + d.ct + '    联通: ' + d.cu + '    移动: ' + d.cm;
      if (carrierRow) {
        carrierRow.innerHTML =
          '<span>电信: ' + d.ct + '</span>' +
          '<span>联通: ' + d.cu + '</span>' +
          '<span>移动: ' + d.cm + '</span>';
        carrierRow.classList.remove('hidden');
      }
      addLog('三网遥测 [' + displayHost + ' -> ' + d.target + '] ' + lineText);
      showToast(lineText, 'ok');
    })
    .catch(function(err) { showToast('测速失败: ' + err.message, 'err'); })
    .finally(function() { btn.disabled = false; btn.textContent = '延迟测速'; });
  }

  function deleteHostnameAsset(hostname, cfZoneId, cfZoneName, btn) {
    if (!confirm('确认彻底卸载 ' + hostname + ' 吗？')) return;
    var dz = getActiveDnsZone();
    btn.disabled = true;
    btn.textContent = '卸载中...';

    fetch('/api/delete', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        provider: state.activeProvider,
        hostname: hostname,
        cfZoneId: cfZoneId,
        cfZoneName: cfZoneName,
        dnsZoneId: dz.id,
        dnsZoneName: dz.name
      })
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (!res.ok) throw new Error(res.error || '卸载失败');
      var d = res.data;
      if (d.logs) for (var i = 0; i < d.logs.length; i++) addLog(d.logs[i]);
      if (d.inspection && cfZoneId && dz.id) {
        state.inspectionByPair[getPairKey(cfZoneId, dz.id)] = d.inspection;
        renderProjectOptions();
        syncPrefixFromSelectedProject();
        evaluateAccelerationStatus();
        renderMatrixList();
      }
      showToast('已彻底卸载: ' + hostname, 'ok');
    })
    .catch(function(err) { showToast(err.message, 'err'); })
    .finally(function() { btn.disabled = false; btn.textContent = '彻底卸载'; });
  }

  function updateStatusPills(hostSt, sslSt) {
    var p1 = document.getElementById('pillHost');
    var p2 = document.getElementById('pillSsl');
    if (!p1 || !p2) return;
    p1.textContent = hostSt === 'active' ? '已激活' : hostSt;
    p2.textContent = sslSt === 'active' ? '已生效' : sslSt;
    p1.className = hostSt === 'active' ? 'pill ok' : 'pill';
    p2.className = sslSt === 'active' ? 'pill ok' : 'pill';
  }

  function startCertPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    var attempts = 0;
    state.pollTimer = setInterval(function() {
      attempts++;
      if (attempts > 10) { clearInterval(state.pollTimer); state.pollTimer = null; return; }
      checkCertStatus(true);
    }, 5000);
  }

  function checkCertStatus(silent) {
    if (!state.lastCfZoneId || !state.lastCustomHostnameId) {
      if (!silent) showToast('当前暂无待轮询的自定义主机名', 'err');
      return;
    }
    fetch('/api/status', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        provider: state.activeProvider,
        cfZoneId: state.lastCfZoneId,
        customHostnameId: state.lastCustomHostnameId
      })
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (!res.ok) return;
      var d = res.data;
      updateStatusPills(d.status, d.sslStatus);
      if (d.status === 'active' && d.sslStatus === 'active') {
        if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
        showToast('证书已生效: https://' + d.hostname, 'ok');
        refreshInspection();
      } else if (!silent) {
        addLog('证书轮询状态 -> 主机名: ' + d.status + ' | SSL: ' + d.sslStatus);
      }
    });
  }

  function bootstrapConsoleApp() {
    if (!BOOT || !BOOT.d1Bound) {
      var alertEl = document.getElementById('d1EnvAlert');
      if (alertEl) {
        if (BOOT && BOOT.deployEnv === 'pages') {
          alertEl.className = 'env-alert pages';
          alertEl.innerHTML = '⚠️ <b>当前运行环境检测为：Cloudflare Pages</b><br />在 Pages 设置中绑定名称为 <b>CFWUYA</b> 的 D1 数据库后，<b>必须前往「部署 (Deployments)」页面重新部署 (Redeploy) 一次代码</b>，绑定才会正式生效！';
        } else {
          alertEl.className = 'env-alert worker';
          alertEl.innerHTML = '✅ <b>当前运行环境检测为：Cloudflare Workers</b><br />在 Workers 设置 → 绑定中添加名称为 <b>CFWUYA</b> 的 D1 数据库后无需重新部署，直接刷新本页面即可立即进入参数配置页。';
        }
      }
      document.getElementById('d1GuideStage').classList.remove('hidden');
      return;
    }

    if (!BOOT.summary || !BOOT.summary.installed) {
      selectSetupProvider('huawei');
      document.getElementById('installStage').classList.remove('hidden');
      return;
    }

    if (!BOOT.summary.requirePass) {
      enterMainConsole();
      return;
    }

    var saved = '';
    try { saved = localStorage.getItem(STORAGE_PASS_KEY) || ''; } catch (e) {}
    document.getElementById('lockStage').classList.remove('hidden');
    if (saved) {
      unlockConsole(saved);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrapConsoleApp);
  } else {
    bootstrapConsoleApp();
  }
</script>
</body>
</html>`;
}

async function handleMainFetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
        return jsonResponse({ ok: true });
    }

    const deployEnv = detectDeployEnv(request, env);
    const { d1Bound, config } = await loadSystemConfig(env);
    const summary = buildPublicConfigSummary(config);

    if (path === '/' && request.method === 'GET') {
        const bootState = {
            d1Bound,
            deployEnv,
            summary,
            providersMeta: PROVIDER_META
        };
        return new Response(renderAppHtml(bootState), {
            status: 200,
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store'
            }
        });
    }

    if (path === '/api/auto-update-opt' && request.method === 'GET') {
        if (!d1Bound) {
            return jsonResponse({ ok: false, error: `尚未绑定 ${D1_BINDING_NAME} D1 数据库` }, 400);
        }
        if (config.adminPass) {
            const reqPass = (
                request.headers.get('X-Admin-Pass') ||
                url.searchParams.get('token') ||
                url.searchParams.get('pass') ||
                ''
            ).trim();
            if (reqPass !== config.adminPass) {
                return jsonResponse({ ok: false, error: '访问密钥错误，请在 URL 后附带 ?token=您的管理密码' }, 401);
            }
        }
        try {
            const data = await handleUpdateAllBestOpt(env, {});
            return jsonResponse({
                ok: true,
                deployEnv,
                bestDomain: data.bestDomain,
                updatedCount: data.updatedCount,
                updatedHosts: data.updatedHosts,
                logs: data.logs
            });
        } catch (err) {
            return jsonResponse({ ok: false, error: err.message || String(err) }, 400);
        }
    }

    if (path.startsWith('/api/') && request.method === 'POST') {
        if (!d1Bound) {
            return jsonResponse({ ok: false, error: `请先绑定名称为 ${D1_BINDING_NAME} 的 D1 数据库` }, 400);
        }

        if (path === '/api/setup' && !config.installed) {
            try {
                const body = await request.json().catch(() => ({}));
                const data = await handleSetupAndSaveConfig(env, body);
                return jsonResponse({ ok: true, data });
            } catch (err) {
                return jsonResponse({ ok: false, error: err.message || String(err) }, 400);
            }
        }

        if (config.adminPass) {
            const reqPass = (request.headers.get('X-Admin-Pass') || '').trim();
            if (reqPass !== config.adminPass) {
                return jsonResponse({ ok: false, error: '管理密码验证失败' }, 401);
            }
        }

        if (path === '/api/auth') {
            return jsonResponse({ ok: true, data: summary });
        }

        try {
            const body = await request.json().catch(() => ({}));
            if (path === '/api/setup') {
                const data = await handleSetupAndSaveConfig(env, body);
                return jsonResponse({ ok: true, data });
            }
            if (path === '/api/provider-switch') {
                const data = await handleSwitchProviderOrDefaults(env, body);
                return jsonResponse({ ok: true, data });
            }
            if (path === '/api/opt-ips') {
                const data = await collectPreferredIpsByRegion(Boolean(body.force));
                return jsonResponse({ ok: true, data });
            }
            if (path === '/api/opt-domains') {
                const list = await collectPreferredDomains(Boolean(body.force));
                return jsonResponse({ ok: true, data: list.slice(0, 15) });
            }
            if (path === '/api/auto-update-opt') {
                const data = await handleUpdateAllBestOpt(env, body);
                return jsonResponse({ ok: true, data });
            }
            if (path === '/api/resources') {
                const data = await handleGetResources(env, body);
                return jsonResponse({ ok: true, data });
            }
            if (path === '/api/inspect') {
                const data = await handleInspect(env, body);
                return jsonResponse({ ok: true, data });
            }
            if (path === '/api/activate') {
                const data = await handleActivateSaas(env, body);
                return jsonResponse({ ok: true, data });
            }
            if (path === '/api/rebind') {
                const data = await handleRebindOrigin(env, body);
                return jsonResponse({ ok: true, data });
            }
            if (path === '/api/repair-origins') {
                const data = await handleRepairAllOrigins(env, body);
                return jsonResponse({ ok: true, data });
            }
            if (path === '/api/update-opt') {
                const data = await handleUpdatePreferredTarget(env, body);
                return jsonResponse({ ok: true, data });
            }
            if (path === '/api/delete') {
                const data = await handleDeleteHostname(env, body);
                return jsonResponse({ ok: true, data });
            }
            if (path === '/api/selfcheck') {
                const data = await handleSelfCheckAndRepair(env, body);
                return jsonResponse({ ok: true, data });
            }
            if (path === '/api/status') {
                const data = await handleCheckStatus(env, body);
                return jsonResponse({ ok: true, data });
            }
            if (path === '/api/probe') {
                const data = await handleProbeUrl(body);
                return jsonResponse({ ok: true, data });
            }

            return jsonResponse({ ok: false, error: '未知接口' }, 404);
        } catch (err) {
            return jsonResponse({ ok: false, error: err.message || String(err) }, 400);
        }
    }

    return new Response('Not Found', { status: 404 });
}

export function onRequest(context) {
    return handleMainFetch(context.request, context.env);
}

export default {
    async fetch(request, env) {
        return handleMainFetch(request, env);
    },

    async scheduled(event, env, ctx) {
        ctx.waitUntil(handleUpdateAllBestOpt(env, {}).catch(() => null));
    }
};
