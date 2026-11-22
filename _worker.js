const RELAY_WORKER_NAME = 'saas-origin-router';
const D1_BINDING_NAME = 'CFWUYA';
const encoder = new TextEncoder();

const PROVIDER_META = {
    huawei: {
        id: 'huawei',
        name: '华为云 DNS',
        shortName: '华为云',
        akLabel: 'Access Key Id (AK)',
        skLabel: 'Secret Access Key (SK)',
        consoleUrl: 'https://console.huaweicloud.com/dns/',
        tokenUrl: 'https://console.huaweicloud.com/iam/#/mine/accessKey'
    },
    tencent: {
        id: 'tencent',
        name: '腾讯云 DNSPod',
        shortName: '腾讯云',
        akLabel: 'SecretId',
        skLabel: 'SecretKey',
        consoleUrl: 'https://console.cloud.tencent.com/cns',
        tokenUrl: 'https://console.cloud.tencent.com/cam/capi'
    },
    aliyun: {
        id: 'aliyun',
        name: '阿里云云解析 DNS',
        shortName: '阿里云',
        akLabel: 'AccessKey ID',
        skLabel: 'AccessKey Secret',
        consoleUrl: 'https://dns.console.aliyun.com/',
        tokenUrl: 'https://ram.console.aliyun.com/manage/ak'
    }
};

const IP_REGION_ORDER = [
    { code: 'HK', label: '香港 (HK)', match: /香港|\(HK\)/i },
    { code: 'TW', label: '台湾 (TW)', match: /台湾|台灣|\(TW\)/i },
    { code: 'JP', label: '日本 (JP)', match: /日本|\(JP\)/i },
    { code: 'KR', label: '韩国 (KR)', match: /韩国|韓國|\(KR\)/i },
    { code: 'SG', label: '新加坡 (SG)', match: /新加坡|\(SG\)/i },
    { code: 'US', label: '美国 (US)', match: /美国|美國|\(US\)/i }
];

let memoryConfigCache = null;
let memoryConfigTime = 0;
let d1TableEnsured = false;
let cachedDiscovery = null;
let cachedDiscoveryTime = 0;
let cachedPool = null;
let cachedPoolTime = 0;
let cachedIpPool = null;
let cachedIpPoolTime = 0;

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Pass',
            'Cache-Control': 'no-store'
        }
    });
}

function normalizeDomain(raw) {
    return String(raw || '')
        .trim()
        .replace(/^https?:\/\//i, '')
        .split('/')[0]
        .split(':')[0]
        .split('.')
        .filter(Boolean)
        .join('.')
        .toLowerCase();
}

function extractRootDomain(hostname) {
    const parts = normalizeDomain(hostname).split('.');
    if (parts.length <= 2) return parts.join('.');
    const sld = parts[parts.length - 2];
    const tld = parts[parts.length - 1];
    if (['co', 'com', 'net', 'org', 'gov', 'edu', 'ac'].includes(sld) && tld.length === 2 && parts.length >= 3) {
        return parts.slice(-3).join('.');
    }
    return parts.slice(-2).join('.');
}

function sanitizeProxyResourceName(rawName, fallbackDomain) {
    let base = String(rawName || '').trim().toLowerCase();
    if (!base) {
        base = 'proxy-' + normalizeDomain(fallbackDomain).replace(/\./g, '-');
    }
    base = base.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
    if (!base || !/^[a-z0-9]/.test(base)) base = 'proxy-' + Date.now().toString(36);
    if (!base.startsWith('proxy-')) base = 'proxy-' + base;
    if (base === RELAY_WORKER_NAME) base = base + '-site';
    if (base.length > 52) base = base.slice(0, 52).replace(/-+$/g, '');
    return base;
}

function detectDeployEnv(request, env) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    if (env.CF_PAGES === '1' || env.CF_PAGES_URL || env.CF_PAGES_BRANCH || host.endsWith('.pages.dev')) {
        return 'pages';
    }
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function' && !host.endsWith('.workers.dev')) {
        return 'pages';
    }
    return 'worker';
}

function hasD1Binding(env) {
    return Boolean(env && env[D1_BINDING_NAME] && typeof env[D1_BINDING_NAME].prepare === 'function');
}

function getDefaultConfig(env) {
    return {
        installed: false,
        adminPass: String(env?.ADMIN_PASS || env?.PASSWORD || '').trim(),
        cfEmail: String(env?.CF_EMAIL || env?.EMAIL || '').trim(),
        cfKey: String(env?.CF_KEY || env?.GLOBAL_KEY || env?.API_TOKEN || '').trim(),
        defaultCfDomain: normalizeDomain(env?.CF_DOMAIN || ''),
        defaultOptDomain: String(env?.OPT_DOMAIN || '').trim(),
        activeProvider: 'huawei',
        proxyResources: {},
        providers: {
            huawei: {
                enabled: Boolean(env?.HW_AK && env?.HW_SK),
                ak: String(env?.HW_AK || '').trim(),
                sk: String(env?.HW_SK || '').trim(),
                defaultDomain: normalizeDomain(env?.HW_DOMAIN || '')
            },
            tencent: {
                enabled: Boolean(env?.TX_AK && env?.TX_SK),
                ak: String(env?.TX_AK || '').trim(),
                sk: String(env?.TX_SK || '').trim(),
                defaultDomain: normalizeDomain(env?.TX_DOMAIN || '')
            },
            aliyun: {
                enabled: Boolean(env?.ALI_AK && env?.ALI_SK),
                ak: String(env?.ALI_AK || '').trim(),
                sk: String(env?.ALI_SK || '').trim(),
                defaultDomain: normalizeDomain(env?.ALI_DOMAIN || '')
            }
        }
    };
}

function mergeWithDefaultConfig(raw, env) {
    const base = getDefaultConfig(env);
    if (!raw || typeof raw !== 'object') return base;
    const proxyRes = {};
    if (raw.proxyResources && typeof raw.proxyResources === 'object') {
        for (const [k, v] of Object.entries(raw.proxyResources)) {
            if (v && typeof v === 'object' && v.name && v.type) {
                proxyRes[String(k).toLowerCase()] = {
                    type: v.type === 'worker' ? 'worker' : 'pages',
                    name: String(v.name).toLowerCase(),
                    targetHost: String(v.targetHost || '').toLowerCase(),
                    targetSite: String(v.targetSite || '').toLowerCase()
                };
            }
        }
    }
    const merged = {
        installed: Boolean(raw.installed),
        adminPass: String(raw.adminPass ?? base.adminPass).trim(),
        cfEmail: String(raw.cfEmail ?? base.cfEmail).trim(),
        cfKey: String(raw.cfKey ?? base.cfKey).trim(),
        defaultCfDomain: normalizeDomain(raw.defaultCfDomain ?? base.defaultCfDomain),
        defaultOptDomain: String(raw.defaultOptDomain ?? base.defaultOptDomain).trim(),
        activeProvider: PROVIDER_META[raw.activeProvider] ? raw.activeProvider : 'huawei',
        proxyResources: proxyRes,
        providers: {
            huawei: { ...base.providers.huawei, ...(raw.providers?.huawei || {}) },
            tencent: { ...base.providers.tencent, ...(raw.providers?.tencent || {}) },
            aliyun: { ...base.providers.aliyun, ...(raw.providers?.aliyun || {}) }
        }
    };
    for (const k of Object.keys(merged.providers)) {
        const p = merged.providers[k];
        p.ak = String(p.ak || '').trim();
        p.sk = String(p.sk || '').trim();
        p.defaultDomain = normalizeDomain(p.defaultDomain || '');
        p.enabled = Boolean(p.enabled && p.ak && p.sk);
    }
    if (!merged.providers[merged.activeProvider]?.enabled) {
        const firstEnabled = Object.keys(merged.providers).find((k) => merged.providers[k].enabled);
        if (firstEnabled) merged.activeProvider = firstEnabled;
    }
    return merged;
}

async function ensureD1Schema(db) {
    if (d1TableEnsured) return;
    await db.prepare(
        'CREATE TABLE IF NOT EXISTS cfwuya_config (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, updated_at INTEGER NOT NULL)'
    ).run();
    d1TableEnsured = true;
}

async function loadSystemConfig(env, forceReload = false) {
    if (!hasD1Binding(env)) {
        return { d1Bound: false, config: getDefaultConfig(env) };
    }
    const now = Date.now();
    if (!forceReload && memoryConfigCache && now - memoryConfigTime < 600000) {
        return { d1Bound: true, config: memoryConfigCache };
    }
    const db = env[D1_BINDING_NAME];
    await ensureD1Schema(db);
    const row = await db.prepare('SELECT data FROM cfwuya_config WHERE id = 1').first().catch(() => null);
    if (row && row.data) {
        try {
            const parsed = JSON.parse(row.data);
            memoryConfigCache = mergeWithDefaultConfig(parsed, env);
            memoryConfigTime = now;
            return { d1Bound: true, config: memoryConfigCache };
        } catch (e) {}
    }
    const fallback = getDefaultConfig(env);
    memoryConfigCache = fallback;
    memoryConfigTime = now;
    return { d1Bound: true, config: fallback };
}

async function saveSystemConfig(env, newConfigObj) {
    if (!hasD1Binding(env)) {
        throw new Error(`未检测到 ${D1_BINDING_NAME} D1 数据库绑定`);
    }
    const db = env[D1_BINDING_NAME];
    await ensureD1Schema(db);
    const normalized = mergeWithDefaultConfig(newConfigObj, env);
    const now = Date.now();
    await db.prepare(
        'INSERT INTO cfwuya_config (id, data, updated_at) VALUES (1, ?1, ?2) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'
    ).bind(JSON.stringify(normalized), now).run();
    memoryConfigCache = normalized;
    memoryConfigTime = now;
    return normalized;
}

function buildPublicConfigSummary(cfg) {
    const enabledProviders = [];
    const providerSummaries = {};
    for (const [id, meta] of Object.entries(PROVIDER_META)) {
        const p = cfg.providers?.[id] || {};
        const isEnabled = Boolean(p.enabled && p.ak && p.sk);
        if (isEnabled) enabledProviders.push(id);
        providerSummaries[id] = {
            id,
            name: meta.name,
            shortName: meta.shortName,
            akLabel: meta.akLabel,
            skLabel: meta.skLabel,
            consoleUrl: meta.consoleUrl,
            tokenUrl: meta.tokenUrl,
            enabled: isEnabled,
            hasCredentials: Boolean(p.ak && p.sk),
            maskedAk: p.ak ? (p.ak.slice(0, 4) + '****' + p.ak.slice(-3)) : '',
            defaultDomain: p.defaultDomain || ''
        };
    }
    return {
        installed: Boolean(cfg.installed),
        requirePass: Boolean(cfg.adminPass),
        hasCfCredentials: Boolean(cfg.cfKey),
        cfEmail: cfg.cfEmail || '',
        maskedCfKey: cfg.cfKey ? (cfg.cfKey.slice(0, 4) + '****' + cfg.cfKey.slice(-3)) : '',
        defaultCfDomain: cfg.defaultCfDomain || '',
        defaultOptDomain: cfg.defaultOptDomain || '',
        activeProvider: cfg.activeProvider || 'huawei',
        enabledProviders,
        providers: providerSummaries
    };
}

function toHex(buffer) {
    const bytes = new Uint8Array(buffer);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
}

function blake3SingleBlockHex32(bytes) {
    const iv = [
        0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A,
        0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19
    ];
    const perm = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];
    const block = new Uint8Array(64);
    block.set(bytes.subarray(0, Math.min(64, bytes.length)));
    const m = new Uint32Array(16);
    const view = new DataView(block.buffer);
    for (let i = 0; i < 16; i++) {
        m[i] = view.getUint32(i * 4, true);
    }
    const s = new Uint32Array([
        iv[0], iv[1], iv[2], iv[3],
        iv[4], iv[5], iv[6], iv[7],
        iv[0], iv[1], iv[2], iv[3],
        0, 0, bytes.length, 11
    ]);
    function rotr(x, n) {
        return ((x >>> n) | (x << (32 - n))) >>> 0;
    }
    function g(a, b, c, d, mx, my) {
        s[a] = (s[a] + s[b] + mx) >>> 0;
        s[d] = rotr(s[d] ^ s[a], 16);
        s[c] = (s[c] + s[d]) >>> 0;
        s[b] = rotr(s[b] ^ s[c], 12);
        s[a] = (s[a] + s[b] + my) >>> 0;
        s[d] = rotr(s[d] ^ s[a], 8);
        s[c] = (s[c] + s[d]) >>> 0;
        s[b] = rotr(s[b] ^ s[c], 7);
    }
    for (let r = 0; r < 7; r++) {
        g(0, 4, 8, 12, m[0], m[1]);
        g(1, 5, 9, 13, m[2], m[3]);
        g(2, 6, 10, 14, m[4], m[5]);
        g(3, 7, 11, 15, m[6], m[7]);
        g(0, 5, 10, 15, m[8], m[9]);
        g(1, 6, 11, 12, m[10], m[11]);
        g(2, 7, 8, 13, m[12], m[13]);
        g(3, 4, 9, 14, m[14], m[15]);
        if (r < 6) {
            const nextM = new Uint32Array(16);
            for (let i = 0; i < 16; i++) nextM[i] = m[perm[i]];
            m.set(nextM);
        }
    }
    const outBytes = new Uint8Array(16);
    const outView = new DataView(outBytes.buffer);
    for (let i = 0; i < 4; i++) {
        outView.setUint32(i * 4, (s[i] ^ s[i + 8]) >>> 0, true);
    }
    let hex = '';
    for (let i = 0; i < 16; i++) {
        hex += outBytes[i].toString(16).padStart(2, '0');
    }
    return hex;
}

async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', encoder.encode(str));
    return toHex(buf);
}

async function hmacSha256Raw(keyData, messageStr) {
    const rawKey = typeof keyData === 'string' ? encoder.encode(keyData) : keyData;
    const key = await crypto.subtle.importKey(
        'raw',
        rawKey,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    return await crypto.subtle.sign('HMAC', key, encoder.encode(messageStr));
}

async function hmacSha256Hex(keyData, messageStr) {
    const sig = await hmacSha256Raw(keyData, messageStr);
    return toHex(sig);
}

async function hmacSha1Base64(keyStr, messageStr) {
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(keyStr),
        { name: 'HMAC', hash: 'SHA-1' },
        false,
        ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(messageStr));
    const bytes = new Uint8Array(sig);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function rfc3986Encode(str) {
    return encodeURIComponent(str).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

async function huaweiRequest(ak, sk, method, path, queryObj = {}, bodyObj = null) {
    const host = 'dns.myhuaweicloud.com';
    const now = new Date();
    const sdkDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const canonicalUri = path.endsWith('/') ? path : path + '/';
    const queryKeys = Object.keys(queryObj).sort();
    const canonicalQuery = queryKeys
        .map((k) => `${rfc3986Encode(k)}=${rfc3986Encode(String(queryObj[k] ?? ''))}`)
        .join('&');
    const payloadStr = bodyObj ? JSON.stringify(bodyObj) : '';
    const payloadHash = await sha256Hex(payloadStr);
    const headersToSign = {
        'content-type': 'application/json',
        'host': host,
        'x-sdk-date': sdkDate
    };
    const signedHeaderKeys = Object.keys(headersToSign).sort();
    const canonicalHeaders = signedHeaderKeys.map((k) => `${k}:${headersToSign[k]}\n`).join('');
    const signedHeadersStr = signedHeaderKeys.join(';');
    const canonicalRequest = [
        method.toUpperCase(),
        canonicalUri,
        canonicalQuery,
        canonicalHeaders,
        signedHeadersStr,
        payloadHash
    ].join('\n');
    const hashedCanonicalRequest = await sha256Hex(canonicalRequest);
    const stringToSign = `SDK-HMAC-SHA256\n${sdkDate}\n${hashedCanonicalRequest}`;
    const signature = await hmacSha256Hex(sk, stringToSign);
    const authHeader = `SDK-HMAC-SHA256 Access=${ak}, SignedHeaders=${signedHeadersStr}, Signature=${signature}`;
    const url = `https://${host}${path}${canonicalQuery ? '?' + canonicalQuery : ''}`;

    const res = await fetch(url, {
        method: method.toUpperCase(),
        headers: {
            'Content-Type': 'application/json',
            'X-Sdk-Date': sdkDate,
            'Authorization': authHeader
        },
        body: payloadStr || undefined
    });
    const text = await res.text();
    let data = {};
    try {
        data = text ? JSON.parse(text) : {};
    } catch (e) {
        data = { raw: text };
    }
    if (!res.ok) {
        const msg = data.message || data.error_msg || data.code || `HTTP ${res.status}`;
        throw new Error(`华为云 API 错误: ${msg}`);
    }
    return data;
}

async function tencentRequest(secretId, secretKey, action, payloadObj = {}) {
    const host = 'dnspod.tencentcloudapi.com';
    const service = 'dnspod';
    const version = '2021-03-23';
    const timestamp = Math.floor(Date.now() / 1000);
    const dateStr = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const payloadStr = JSON.stringify(payloadObj);
    const payloadHash = await sha256Hex(payloadStr);
    const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
    const signedHeaders = 'content-type;host;x-tc-action';
    const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const credentialScope = `${dateStr}/${service}/tc3_request`;
    const hashedCanonicalRequest = await sha256Hex(canonicalRequest);
    const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${hashedCanonicalRequest}`;

    const kDate = await hmacSha256Raw('TC3' + secretKey, dateStr);
    const kService = await hmacSha256Raw(kDate, service);
    const kSigning = await hmacSha256Raw(kService, 'tc3_request');
    const signature = await hmacSha256Hex(kSigning, stringToSign);
    const authHeader = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const res = await fetch(`https://${host}/`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Host': host,
            'X-TC-Action': action,
            'X-TC-Version': version,
            'X-TC-Timestamp': String(timestamp),
            'Authorization': authHeader
        },
        body: payloadStr
    });
    const data = await res.json().catch(() => ({}));
    const err = data?.Response?.Error;
    if (err) {
        if (err.Code === 'ResourceNotFound.NoDataOfRecord' || err.Code === 'ResourceNotFound.NoDataOfDomain') {
            return { empty: true };
        }
        throw new Error(`腾讯云 DNSPod 错误 (${err.Code}): ${err.Message}`);
    }
    return data?.Response || {};
}

async function aliyunRequest(ak, sk, action, params = {}) {
    const endpoint = 'https://alidns.aliyuncs.com/';
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const nonce = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + String(Date.now());
    const allParams = {
        Format: 'JSON',
        Version: '2015-01-09',
        AccessKeyId: ak,
        SignatureMethod: 'HMAC-SHA1',
        Timestamp: timestamp,
        SignatureVersion: '1.0',
        SignatureNonce: nonce,
        Action: action,
        ...params
    };
    const sortedKeys = Object.keys(allParams).filter((k) => allParams[k] !== undefined && allParams[k] !== null).sort();
    const canonicalQuery = sortedKeys
        .map((k) => `${rfc3986Encode(k)}=${rfc3986Encode(String(allParams[k]))}`)
        .join('&');
    const stringToSign = `GET&%2F&${rfc3986Encode(canonicalQuery)}`;
    const signature = await hmacSha1Base64(sk + '&', stringToSign);
    const url = `${endpoint}?${canonicalQuery}&Signature=${rfc3986Encode(signature)}`;

    const res = await fetch(url, { method: 'GET' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.Code) {
        throw new Error(`阿里云 DNS 错误 (${data.Code || res.status}): ${data.Message || '请求失败'}`);
    }
    return data;
}

function splitFqdnToSub(fqdn, zoneName) {
    const cleanHost = String(fqdn || '').toLowerCase().replace(/\.$/, '');
    const cleanZone = String(zoneName || '').toLowerCase().replace(/\.$/, '');
    if (cleanHost === cleanZone) return '@';
    if (cleanHost.endsWith('.' + cleanZone)) {
        return cleanHost.slice(0, -(cleanZone.length + 1)) || '@';
    }
    return cleanHost;
}

function classifyProviderLine(provider, line) {
    const raw = String(line || '').trim();
    if (provider === 'huawei') {
        if (!raw || raw === 'default' || raw === 'default_view') return 'default';
        return 'preferred';
    }
    if (provider === 'tencent') {
        if (!raw || raw === '默认' || raw.toLowerCase() === 'default') return 'default';
        return 'preferred';
    }
    if (provider === 'aliyun') {
        if (!raw || raw === 'default') return 'default';
        return 'preferred';
    }
    return 'default';
}

async function dnsListZones(provider, ak, sk) {
    if (provider === 'huawei') {
        const res = await huaweiRequest(ak, sk, 'GET', '/v2/zones', { type: 'public', limit: 200 });
        return (res.zones || []).map((z) => ({
            id: z.id,
            name: String(z.name || '').replace(/\.$/, '').toLowerCase()
        }));
    }
    if (provider === 'tencent') {
        const res = await tencentRequest(ak, sk, 'DescribeDomainList', { Limit: 200 });
        return (res.DomainList || []).map((d) => ({
            id: String(d.DomainId || d.Name),
            name: String(d.Name || '').replace(/\.$/, '').toLowerCase()
        }));
    }
    if (provider === 'aliyun') {
        const res = await aliyunRequest(ak, sk, 'DescribeDomains', { PageSize: 100 });
        const list = res.Domains?.Domain || [];
        return list.map((d) => ({
            id: String(d.DomainId || d.DomainName),
            name: String(d.DomainName || '').replace(/\.$/, '').toLowerCase()
        }));
    }
    throw new Error(`未知的 DNS 服务商: ${provider}`);
}

async function dnsListRecords(provider, ak, sk, zoneId, zoneName) {
    const cleanZone = normalizeDomain(zoneName);
    if (provider === 'huawei') {
        const res = await huaweiRequest(ak, sk, 'GET', `/v2.1/zones/${zoneId}/recordsets`, { limit: 500 });
        return (res.recordsets || []).map((r) => {
            const fqdn = String(r.name || '').replace(/\.$/, '').toLowerCase();
            const rawVal = r.records?.[0] ? String(r.records[0]) : '';
            const cleanVal = rawVal.replace(/\.$/, '').replace(/^"+|"+$/g, '');
            const lineRaw = normalizeHwLine(r.line);
            return {
                id: r.id,
                fqdn,
                rr: splitFqdnToSub(fqdn, cleanZone),
                type: String(r.type || '').toUpperCase(),
                lineRole: classifyProviderLine('huawei', lineRaw),
                lineRaw,
                value: cleanVal,
                records: r.records || []
            };
        });
    }
    if (provider === 'tencent') {
        const res = await tencentRequest(ak, sk, 'DescribeRecordList', { Domain: cleanZone, Limit: 500 });
        return (res.RecordList || []).map((r) => {
            const sub = String(r.Name || '@');
            const fqdn = (sub === '@' || sub === '') ? cleanZone : `${sub.toLowerCase()}.${cleanZone}`;
            const cleanVal = String(r.Value || '').replace(/\.$/, '').replace(/^"+|"+$/g, '');
            const lineRaw = String(r.RecordLine || '默认');
            return {
                id: r.RecordId,
                fqdn,
                rr: sub,
                type: String(r.Type || '').toUpperCase(),
                lineRole: classifyProviderLine('tencent', lineRaw),
                lineRaw,
                value: cleanVal
            };
        });
    }
    if (provider === 'aliyun') {
        const res = await aliyunRequest(ak, sk, 'DescribeDomainRecords', { DomainName: cleanZone, PageSize: 500 });
        const list = res.DomainRecords?.Record || [];
        return list.map((r) => {
            const rr = String(r.RR || '@');
            const fqdn = (rr === '@' || rr === '') ? cleanZone : `${rr.toLowerCase()}.${cleanZone}`;
            const cleanVal = String(r.Value || '').replace(/\.$/, '').replace(/^"+|"+$/g, '');
            const lineRaw = String(r.Line || 'default');
            return {
                id: r.RecordId,
                fqdn,
                rr,
                type: String(r.Type || '').toUpperCase(),
                lineRole: classifyProviderLine('aliyun', lineRaw),
                lineRaw,
                value: cleanVal
            };
        });
    }
    return [];
}

async function dnsDeleteRecord(provider, ak, sk, zoneId, zoneName, recordId) {
    const cleanZone = normalizeDomain(zoneName);
    if (provider === 'huawei') {
        return await huaweiRequest(ak, sk, 'DELETE', `/v2.1/zones/${zoneId}/recordsets/${recordId}`).catch(() => {});
    }
    if (provider === 'tencent') {
        return await tencentRequest(ak, sk, 'DeleteRecord', { Domain: cleanZone, RecordId: Number(recordId) }).catch(() => {});
    }
    if (provider === 'aliyun') {
        return await aliyunRequest(ak, sk, 'DeleteDomainRecord', { RecordId: String(recordId) }).catch(() => {});
    }
}

function normalizeHwLine(line) {
    const val = String(line || '').trim();
    if (!val || val === 'default' || val === 'default_view') return 'default_view';
    return val;
}

async function dnsUpsertRecord(provider, ak, sk, zoneId, zoneName, existingRecords, fqdn, type, targetLineRaw, rawValue) {
    const cleanZone = normalizeDomain(zoneName);
    const cleanFqdn = normalizeDomain(fqdn);
    const rr = splitFqdnToSub(cleanFqdn, cleanZone);
    const upperType = type.toUpperCase();
    const cleanVal = String(rawValue || '').replace(/\.$/, '').replace(/^"+|"+$/g, '');

    if (upperType === 'CNAME' || upperType === 'A') {
        for (let i = existingRecords.length - 1; i >= 0; i--) {
            const r = existingRecords[i];
            if (r.fqdn === cleanFqdn && r.lineRaw === targetLineRaw && r.type !== upperType) {
                await dnsDeleteRecord(provider, ak, sk, zoneId, cleanZone, r.id);
                existingRecords.splice(i, 1);
            }
        }
    }

    const matched = existingRecords.find(
        (r) => r.fqdn === cleanFqdn && r.type === upperType && r.lineRaw === targetLineRaw
    );

    if (matched && matched.value.toLowerCase() === cleanVal.toLowerCase()) {
        return matched;
    }

    if (provider === 'huawei') {
        const hwFqdn = `${cleanFqdn}.`;
        const formattedVal = upperType === 'CNAME' ? `${cleanVal}.` : (upperType === 'TXT' ? `"${cleanVal}"` : cleanVal);
        const payload = {
            name: hwFqdn,
            type: upperType,
            ttl: 60,
            records: [formattedVal],
            line: normalizeHwLine(targetLineRaw)
        };
        if (matched) {
            const res = await huaweiRequest(ak, sk, 'PUT', `/v2.1/zones/${zoneId}/recordsets/${matched.id}`, {}, payload);
            matched.value = cleanVal;
            return res;
        }
        const res = await huaweiRequest(ak, sk, 'POST', `/v2.1/zones/${zoneId}/recordsets`, {}, payload);
        existingRecords.push({
            id: res.id,
            fqdn: cleanFqdn,
            rr,
            type: upperType,
            lineRole: classifyProviderLine('huawei', targetLineRaw),
            lineRaw: normalizeHwLine(targetLineRaw),
            value: cleanVal
        });
        return res;
    }

    if (provider === 'tencent') {
        if (matched) {
            const res = await tencentRequest(ak, sk, 'ModifyRecord', {
                Domain: cleanZone,
                RecordId: Number(matched.id),
                SubDomain: rr,
                RecordType: upperType,
                RecordLine: targetLineRaw,
                Value: cleanVal,
                TTL: 600
            });
            matched.value = cleanVal;
            return res;
        }
        const res = await tencentRequest(ak, sk, 'CreateRecord', {
            Domain: cleanZone,
            SubDomain: rr,
            RecordType: upperType,
            RecordLine: targetLineRaw,
            Value: cleanVal,
            TTL: 600
        });
        existingRecords.push({
            id: res.RecordId,
            fqdn: cleanFqdn,
            rr,
            type: upperType,
            lineRole: classifyProviderLine('tencent', targetLineRaw),
            lineRaw: targetLineRaw,
            value: cleanVal
        });
        return res;
    }

    if (provider === 'aliyun') {
        if (matched) {
            const res = await aliyunRequest(ak, sk, 'UpdateDomainRecord', {
                RecordId: String(matched.id),
                RR: rr,
                Type: upperType,
                Value: cleanVal,
                Line: targetLineRaw,
                TTL: 600
            });
            matched.value = cleanVal;
            return res;
        }
        const res = await aliyunRequest(ak, sk, 'AddDomainRecord', {
            DomainName: cleanZone,
            RR: rr,
            Type: upperType,
            Value: cleanVal,
            Line: targetLineRaw,
            TTL: 600
        });
        existingRecords.push({
            id: res.RecordId,
            fqdn: cleanFqdn,
            rr,
            type: upperType,
            lineRole: classifyProviderLine('aliyun', targetLineRaw),
            lineRaw: targetLineRaw,
            value: cleanVal
        });
        return res;
    }
}

async function applyProviderPreferredLines(provider, ak, sk, zoneId, zoneName, existingRecords, customHostname, finalPref, logs) {
    const cleanHost = normalizeDomain(customHostname);
    const cleanPref = finalPref.trim().replace(/^https?:\/\//i, '').split('/')[0].replace(/\.$/, '');
    const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(cleanPref);
    const prefType = isIpv4 ? 'A' : 'CNAME';
    const pName = PROVIDER_META[provider]?.shortName || provider;

    for (let i = existingRecords.length - 1; i >= 0; i--) {
        const r = existingRecords[i];
        if (r.fqdn === cleanHost && r.lineRole === 'preferred' && (r.type === 'A' || r.type === 'CNAME')) {
            if (r.type !== prefType || r.value.toLowerCase() !== cleanPref.toLowerCase()) {
                await dnsDeleteRecord(provider, ak, sk, zoneId, zoneName, r.id);
                existingRecords.splice(i, 1);
            }
        }
    }

    if (provider === 'huawei') {
        try {
            await dnsUpsertRecord('huawei', ak, sk, zoneId, zoneName, existingRecords, cleanHost, prefType, 'CN', cleanPref);
            logs.push(`${pName} [中国大陆线路] ${prefType} -> ${cleanPref}`);
        } catch (e) {
            for (const carrier of ['Dianxin', 'Liantong', 'Yidong']) {
                await dnsUpsertRecord('huawei', ak, sk, zoneId, zoneName, existingRecords, cleanHost, prefType, carrier, cleanPref);
            }
            logs.push(`${pName} [三网分流线路] ${prefType} -> ${cleanPref}`);
        }
        return;
    }

    if (provider === 'tencent') {
        try {
            await dnsUpsertRecord('tencent', ak, sk, zoneId, zoneName, existingRecords, cleanHost, prefType, '境内', cleanPref);
            logs.push(`${pName} [境内线路] ${prefType} -> ${cleanPref}`);
        } catch (e) {
            for (const carrier of ['电信', '联通', '移动']) {
                await dnsUpsertRecord('tencent', ak, sk, zoneId, zoneName, existingRecords, cleanHost, prefType, carrier, cleanPref);
            }
            logs.push(`${pName} [电信/联通/移动三网线路] ${prefType} -> ${cleanPref}`);
        }
        return;
    }

    if (provider === 'aliyun') {
        try {
            await dnsUpsertRecord('aliyun', ak, sk, zoneId, zoneName, existingRecords, cleanHost, prefType, 'internal', cleanPref);
            logs.push(`${pName} [中国大陆线路] ${prefType} -> ${cleanPref}`);
        } catch (e) {
            for (const carrier of ['telecom', 'unicom', 'mobile']) {
                await dnsUpsertRecord('aliyun', ak, sk, zoneId, zoneName, existingRecords, cleanHost, prefType, carrier, cleanPref);
            }
            logs.push(`${pName} [三网分流线路] ${prefType} -> ${cleanPref}`);
        }
    }
}

async function syncProviderDnsForHost(provider, ak, sk, zoneId, targetDomain, chObj, customHostname, fallbackOrigin, finalPref, logs) {
    const existingRecords = await dnsListRecords(provider, ak, sk, zoneId, targetDomain);
    const pName = PROVIDER_META[provider]?.shortName || provider;

    for (let i = existingRecords.length - 1; i >= 0; i--) {
        const r = existingRecords[i];
        if (r.type === 'CAA' && (r.fqdn === targetDomain || r.fqdn === customHostname)) {
            if (!r.value.toLowerCase().includes('pki.goog') && !r.value.toLowerCase().includes('letsencrypt.org')) {
                await dnsDeleteRecord(provider, ak, sk, zoneId, targetDomain, r.id);
                existingRecords.splice(i, 1);
                logs.push(`已清理限制性 CAA 记录: ${r.fqdn}`);
            }
        }
    }

    const acmeFqdn = `_acme-challenge.${customHostname}`;
    for (let i = existingRecords.length - 1; i >= 0; i--) {
        const r = existingRecords[i];
        if (r.fqdn === acmeFqdn) {
            await dnsDeleteRecord(provider, ak, sk, zoneId, targetDomain, r.id);
            existingRecords.splice(i, 1);
        }
    }

    const defaultLineRaw = provider === 'tencent' ? '默认' : (provider === 'aliyun' ? 'default' : 'default_view');

    if (chObj?.ownership_verification?.name && chObj?.ownership_verification?.value) {
        const ovName = String(chObj.ownership_verification.name).trim().toLowerCase().replace(/\.$/, '');
        const ovVal = String(chObj.ownership_verification.value).trim().replace(/^"+|"+$/g, '');
        await dnsUpsertRecord(provider, ak, sk, zoneId, targetDomain, existingRecords, ovName, 'TXT', defaultLineRaw, ovVal);
        logs.push(`${pName}已同步主机名所有权 TXT: ${ovName}`);
    }

    await dnsUpsertRecord(provider, ak, sk, zoneId, targetDomain, existingRecords, customHostname, 'CNAME', defaultLineRaw, fallbackOrigin);
    logs.push(`${pName} [默认线路] CNAME -> ${fallbackOrigin}`);

    await applyProviderPreferredLines(provider, ak, sk, zoneId, targetDomain, existingRecords, customHostname, finalPref, logs);
}

async function fetchTextWithTimeout(url, headers, timeoutMs = 4500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            headers,
            redirect: 'follow',
            signal: controller.signal
        });
        if (!res.ok) return null;
        return await res.text();
    } catch (e) {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function runPool(tasks, concurrency = 3) {
    const results = new Array(tasks.length);
    let index = 0;
    const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
        while (index < tasks.length) {
            const current = index++;
            results[current] = await tasks[current]();
        }
    });
    await Promise.all(workers);
    return results;
}

async function collectPreferredIpsByRegion(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && cachedIpPool && now - cachedIpPoolTime < 120000 && cachedIpPool.firstHkIp) {
        return cachedIpPool;
    }

    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        'Accept': 'text/plain,*/*;q=0.8',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
    };

    const text = await fetchTextWithTimeout('https://776771.xyz/hk-tw-jp-kr-sg-us=5', headers, 6000);
    const regionMap = {};
    for (const r of IP_REGION_ORDER) {
        regionMap[r.code] = {
            code: r.code,
            label: r.label,
            items: []
        };
    }

    if (text) {
        const lines = text.split(/\r?\n/);
        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) continue;
            const ipMatch = line.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:#(.*))?$/);
            if (!ipMatch) continue;
            const ip = ipMatch[1];
            const meta = ipMatch[2] || '';
            const latencyMatch = meta.match(/(\d+(?:\.\d+)?)\s*ms/i);
            const latency = latencyMatch ? `${latencyMatch[1]} ms` : '';

            for (const reg of IP_REGION_ORDER) {
                if (reg.match.test(meta)) {
                    const bucket = regionMap[reg.code].items;
                    if (bucket.length < 5 && !bucket.some((x) => x.ip === ip)) {
                        bucket.push({ ip, latency, region: reg.code });
                    }
                    break;
                }
            }
        }
    }

    const regions = IP_REGION_ORDER.map((r) => regionMap[r.code]);
    const hkFirst = regionMap.HK.items[0]?.ip || '';
    const anyFirst = regions.find((r) => r.items.length > 0)?.items[0]?.ip || '';
    const firstHkIp = hkFirst || anyFirst || '';

    const packed = {
        regions,
        firstHkIp
    };
    if (firstHkIp) {
        cachedIpPool = packed;
        cachedIpPoolTime = Date.now();
    }
    return packed;
}

async function findCfipOnlyApis(headers) {
    const now = Date.now();
    if (cachedDiscovery && now - cachedDiscoveryTime < 1800000) {
        return cachedDiscovery;
    }
    const apis = new Set();
    const chunkUrls = [];
    const html = await fetchTextWithTimeout('https://vps789.com/cfip/', headers, 5000);
    if (html) {
        const scriptUrls = [];
        const scriptRegex = /<script[^>]+src=["']([^"']+\.js)["']/gi;
        let sm0;
        while ((sm0 = scriptRegex.exec(html)) !== null) {
            scriptUrls.push(new URL(sm0[1], 'https://vps789.com/').toString());
        }
        const appJsUrl = scriptUrls.find((u) => /app\.[0-9a-fA-F]+\.js/i.test(u)) || scriptUrls[0] || '';
        if (appJsUrl) {
            const appText = await fetchTextWithTimeout(appJsUrl, headers, 5000);
            if (appText) {
                const hashMap = {};
                const mapRegex = /["'](chunk-[0-9a-fA-F]+)["']\s*:\s*["']([0-9a-fA-F]{6,16})["']/g;
                let m;
                while ((m = mapRegex.exec(appText)) !== null) {
                    hashMap[m[1]] = m[2];
                }
                const routeIdx = appText.toLowerCase().indexOf('/cfip');
                if (routeIdx !== -1) {
                    const win = appText.slice(Math.max(0, routeIdx - 300), Math.min(appText.length, routeIdx + 600));
                    const chunkMatch = win.match(/chunk-[0-9a-fA-F]+/g) || [];
                    for (const cid of chunkMatch) {
                        if (hashMap[cid]) {
                            const u = 'https://vps789.com/js/' + cid + '.' + hashMap[cid] + '.js';
                            if (!chunkUrls.includes(u)) chunkUrls.push(u);
                        }
                    }
                }
                const chunkTasks = chunkUrls.slice(0, 3).map((cUrl) => () => fetchTextWithTimeout(cUrl, headers, 4500));
                const chunkTexts = await runPool(chunkTasks, 3);
                for (const chunkText of chunkTexts) {
                    if (!chunkText) continue;
                    const strRegex = /["'](\/[a-zA-Z0-9_\/.-]+(?:\?[a-zA-Z0-9_=&-]*)?)["']/g;
                    let sm;
                    while ((sm = strRegex.exec(chunkText)) !== null) {
                        const p = sm[1];
                        if (/\.(?:js|css|png|jpg|svg|ico|woff|ttf|html)$/i.test(p)) continue;
                        if (/(?:ad\/|role\/|menu\/|user\/|login|logout|submit|insert|add|save|delete|sidebar|tanzhen|sendMail|top20|month|30d)/i.test(p)) continue;
                        apis.add('https://vps789.com' + p);
                        if (!p.startsWith('/public/') && !p.startsWith('/openApi/')) {
                            apis.add('https://vps789.com/public' + p);
                        }
                    }
                }
            }
        }
    }
    const result = {
        chunkUrl: chunkUrls[0] || '',
        endpoints: Array.from(apis).slice(0, 8)
    };
    if (result.endpoints.length > 0) {
        cachedDiscovery = result;
        cachedDiscoveryTime = now;
    }
    return result;
}

function extractScores(item) {
    const rawScore = item.avgScore ?? item.score ?? item.totalScore ?? item.weightScore ?? null;
    if (rawScore !== null && rawScore !== '' && !Number.isNaN(Number(rawScore))) {
        const num = Number(rawScore);
        if (num > 100 && num <= 300) {
            return { raw: num, display: Math.floor(num / 3) };
        }
        if (num > 300) {
            return { raw: num, display: Math.min(100, Math.floor(num / 10)) };
        }
        return { raw: num, display: Math.floor(num) };
    }
    if (item.dxScore !== undefined && item.ydScore !== undefined && item.ltScore !== undefined) {
        const sum = Number(item.dxScore) + Number(item.ydScore) + Number(item.ltScore);
        if (!Number.isNaN(sum)) {
            return sum > 100 ? { raw: sum, display: Math.floor(sum / 3) } : { raw: sum, display: Math.floor(sum) };
        }
    }
    return null;
}

function getBuiltinDomains() {
    return [
        { host: 'cf-cname.xingpingcn.top', score: 92, rawScore: 276 },
        { host: 'coreweave.com', score: 90, rawScore: 272 },
        { host: 'yg11.ygkkk.dpdns.org', score: 90, rawScore: 271 },
        { host: 'mail.notion.com', score: 90, rawScore: 270 },
        { host: 'kickstarter.com', score: 88, rawScore: 266 },
        { host: 'mfa.gov.ua', score: 88, rawScore: 266 },
        { host: 'tajikistan.mfa.gov.ua', score: 88, rawScore: 265 },
        { host: 'serviceshub.samsclub.com', score: 88, rawScore: 265 },
        { host: 'wppaunz.com', score: 88, rawScore: 264 },
        { host: 'cdn.aneko.ink', score: 88, rawScore: 264 },
        { host: 'cdns.doon.eu.org', score: 86, rawScore: 260 },
        { host: 'www.wto.org', score: 86, rawScore: 259 },
        { host: 'academy.7shifts.com', score: 86, rawScore: 259 },
        { host: 'jobsdb.com', score: 86, rawScore: 258 },
        { host: 'cf.xreak.top', score: 86, rawScore: 258 }
    ];
}

async function collectPreferredDomains(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && cachedPool && now - cachedPoolTime < 180000 && cachedPool.length > 0) {
        return cachedPool;
    }

    const browserHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        'Accept': 'application/json,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Referer': 'https://vps789.com/cfip/',
        'Origin': 'https://vps789.com',
        'Sec-Ch-Ua': '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin'
    };

    const domainMap = new Map();
    const coreUrls = [
        'https://vps789.com/public/sum/cfIpApi',
        'https://vps789.com/openApi/cfIpApi'
    ];
    const discovery = await findCfipOnlyApis(browserHeaders);
    const candidateUrls = [];
    const addUrl = (u) => {
        if (u && !candidateUrls.includes(u) && candidateUrls.length < 12) {
            candidateUrls.push(u);
        }
    };

    for (const ep of (discovery.endpoints || [])) {
        if (ep.endsWith('=')) {
            addUrl(ep + 'domain');
        } else if (!ep.includes('?')) {
            addUrl(ep);
            addUrl(ep + '?remarks=domain&pageNum=1&pageSize=50');
            addUrl(ep + '?page=1&size=50');
        } else {
            addUrl(ep);
        }
    }
    for (const cu of coreUrls) {
        addUrl(cu);
    }

    const domainRegex = /^(?:[a-zA-Z0-9_-]+\.)+[a-zA-Z]{2,}$/;
    const ipv4Regex = /^\d{1,3}(?:\.\d{1,3}){3}$/;

    const addRecord = (item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return;
        if (item.imageUrl || item.subTitle || item.adUrl) return;
        if (item.period === 'month' || item.timeType === 'month' || item.days === 30) return;

        let hostVal = '';
        const hostKeys = ['domain', 'host', 'cname', 'ipOrDomain', 'address', 'addr', 'server', 'ip', 'hostIp'];
        for (const k of hostKeys) {
            if (typeof item[k] === 'string') {
                const val = item[k].trim();
                if (domainRegex.test(val) && !ipv4Regex.test(val)) {
                    hostVal = val;
                    break;
                }
            }
        }

        const hasMetric = (
            item.dxLatencyAvg !== undefined ||
            item.ydLatencyAvg !== undefined ||
            item.ltLatencyAvg !== undefined ||
            item.avgScore !== undefined ||
            item.score !== undefined ||
            item.downloadSpeed !== undefined ||
            item.speed !== undefined ||
            item.dxScore !== undefined
        );

        if (hostVal && hasMetric) {
            const key = hostVal.toLowerCase();
            if (!domainMap.has(key)) {
                const parsed = extractScores(item);
                domainMap.set(key, {
                    host: hostVal,
                    score: parsed ? parsed.display : null,
                    rawScore: parsed ? parsed.raw : -1
                });
            }
            return;
        }

        for (const [k, v] of Object.entries(item)) {
            if (/^(?:code|msg|message|status|success|total|month|monthList|thirty|top20|ad|ads|banner)$/i.test(k)) continue;
            walkNode(v);
        }
    };

    const walkNode = (node) => {
        if (!node) return;
        if (Array.isArray(node)) {
            for (const sub of node) addRecord(sub);
            return;
        }
        if (typeof node === 'object') addRecord(node);
    };

    const fetchTasks = candidateUrls.map((target) => () => fetchTextWithTimeout(target, browserHeaders, 4500));
    const responses = await runPool(fetchTasks, 3);
    for (const text of responses) {
        if (!text) continue;
        const trimmed = text.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try { walkNode(JSON.parse(trimmed)); } catch (e) {}
        }
    }

    const domainItems = Array.from(domainMap.values());
    if (domainItems.length === 0) {
        domainItems.push(...getBuiltinDomains());
    }

    domainItems.sort((a, b) => (b.rawScore ?? -1) - (a.rawScore ?? -1));
    cachedPool = domainItems;
    cachedPoolTime = Date.now();
    return domainItems;
}

async function resolveDefaultHkIp(forceRefresh = false) {
    const ipData = await collectPreferredIpsByRegion(forceRefresh).catch(() => null);
    if (ipData && ipData.firstHkIp) return ipData.firstHkIp;
    return '42.98.74.174';
}

async function cfRequest(email, key, method, path, bodyObj = null) {
    const cleanKey = String(key || '').trim();
    const cleanEmail = String(email || '').trim();
    const headers = {};
    if (cleanEmail) {
        headers['X-Auth-Email'] = cleanEmail;
        headers['X-Auth-Key'] = cleanKey;
    } else {
        headers['Authorization'] = `Bearer ${cleanKey}`;
    }
    let reqBody;
    if (bodyObj instanceof FormData) {
        reqBody = bodyObj;
    } else if (bodyObj !== null && bodyObj !== undefined) {
        headers['Content-Type'] = 'application/json';
        reqBody = JSON.stringify(bodyObj);
    }
    const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
        method: method.toUpperCase(),
        headers,
        body: reqBody
    });
    const data = await res.json().catch(() => ({ success: false }));
    if (!data.success) {
        const firstCode = data.errors?.[0]?.code;
        if (firstCode === 10502 || res.status === 429) {
            throw new Error('Cloudflare 接口触发临时频控锁定 (10502)，请等待 5~10 分钟后再试');
        }
        const errText = (data.errors || []).map((e) => `${e.code}: ${e.message}`).join('; ') || `HTTP ${res.status}`;
        throw new Error(`Cloudflare API 错误: ${errText}`);
    }
    return data;
}

function buildUniversalProxyWorkerScript(rawTargetDomain) {
    const targetHost = normalizeDomain(rawTargetDomain);
    const rootDomain = extractRootDomain(targetHost);
    const lines = [
        'const TARGET_HOST = ' + JSON.stringify(targetHost) + ';',
        'const ROOT_DOMAIN = ' + JSON.stringify(rootDomain) + ';',
        'const PREFIX_PATH = "/__proxy_host__/";',
        'const BS = String.fromCharCode(92);',
        'const Q_SET = String.fromCharCode(34, 39, 40, 61, 44, 32, 9, 10, 13);',
        'const ESC_HOST = TARGET_HOST.split(".").join(BS + ".");',
        'const ESC_ROOT = ROOT_DOMAIN.split(".").join(BS + ".");',
        'const HOST_PROTO_RE = new RegExp("https?://" + ESC_HOST + "(?![a-z0-9.-])", "gi");',
        'const HOST_REL_RE = new RegExp("(^|[" + Q_SET + "])//" + ESC_HOST + "(?![a-z0-9.-])", "gi");',
        'const SUB_PROTO_RE = new RegExp("https?://([a-z0-9-]+(?:[.][a-z0-9-]+)*[.]" + ESC_ROOT + ")(?![a-z0-9.-])", "gi");',
        'const SUB_REL_RE = new RegExp("(^|[" + Q_SET + "])//([a-z0-9-]+(?:[.][a-z0-9-]+)*[.]" + ESC_ROOT + ")(?![a-z0-9.-])", "gi");',
        'function buildClientHook(proxyHost) {',
        '  const sOpen = "<scr" + "ipt>";',
        '  const sClose = "</scr" + "ipt>";',
        '  const body = "(function(){" +',
        '    "var PH=" + JSON.stringify(proxyHost) + ";var PO=location.origin;" +',
        '    "var TH=" + JSON.stringify(TARGET_HOST) + ";var RD=" + JSON.stringify(ROOT_DOMAIN) + ";var PX=\'/\' + \'__proxy_host__/\';" +',
        '    "function rw(u){" +',
        '    "  if(!u||typeof u!==\'string\')return u;" +',
        '    "  if(u.indexOf(\'data:\')===0||u.indexOf(\'blob:\')===0||u.indexOf(\'javascript:\')===0||u.indexOf(\'mailto:\')===0||u.indexOf(\'#\')===0)return u;" +',
        '    "  try{" +',
        '    "    var p=new URL(u,PO);" +',
        '    "    if(p.hostname===PH)return u;" +',
        '    "    if(p.hostname===TH)return PO+p.pathname+p.search+p.hash;" +',
        '    "    if(p.hostname===RD||p.hostname.slice(-(RD.length+1))===\'.\'+RD)return PO+PX+p.hostname+p.pathname+p.search+p.hash;" +',
        '    "  }catch(e){}" +',
        '    "  return u;" +',
        '    "}" +',
        '    "var _f=window.fetch;" +',
        '    "window.fetch=function(i,n){" +',
        '    "  if(typeof i===\'string\')i=rw(i);" +',
        '    "  else if(i&&i.url){var nu=rw(i.url);if(nu!==i.url)i=new Request(nu,i);}" +',
        '    "  return _f.call(this,i,n);" +',
        '    "};" +',
        '    "var _o=XMLHttpRequest.prototype.open;" +',
        '    "XMLHttpRequest.prototype.open=function(m,u){" +',
        '    "  arguments[1]=rw(u);return _o.apply(this,arguments);" +',
        '    "};" +',
        '    "var _w=window.open;" +',
        '    "window.open=function(u){" +',
        '    "  arguments[0]=rw(u);return _w.apply(this,arguments);" +',
        '    "};" +',
        '    "document.addEventListener(\'submit\',function(e){" +',
        '    "  var f=e.target;if(f&&f.action)f.action=rw(f.action);" +',
        '    "},true);" +',
        '    "})();";',
        '  return sOpen + body + sClose;',
        '}',
        'function rewriteCookie(rawCookie) {',
        '  let c = String(rawCookie || "");',
        '  c = c.replace(/;\\s*domain=[^;]+/gi, "");',
        '  c = c.replace(/;\\s*samesite=strict/gi, "; SameSite=Lax");',
        '  return c;',
        '}',
        'function rewriteLocation(loc, upstreamUrl, proxyOrigin) {',
        '  try {',
        '    const resolved = new URL(loc, upstreamUrl);',
        '    if (resolved.hostname.toLowerCase() === TARGET_HOST) {',
        '      return proxyOrigin + resolved.pathname + resolved.search + resolved.hash;',
        '    }',
        '    if (resolved.protocol === "http:" || resolved.protocol === "https:") {',
        '      return proxyOrigin + PREFIX_PATH + resolved.hostname + resolved.pathname + resolved.search + resolved.hash;',
        '    }',
        '  } catch (e) {}',
        '  return loc;',
        '}',
        'function rewriteBodyText(text, contentType, proxyHost, proxyOrigin) {',
        '  let out = text.replace(HOST_PROTO_RE, proxyOrigin);',
        '  out = out.replace(HOST_REL_RE, "$1//" + proxyHost);',
        '  out = out.replace(SUB_PROTO_RE, function(m, sub) {',
        '    if (sub.toLowerCase() === TARGET_HOST) return proxyOrigin;',
        '    return proxyOrigin + PREFIX_PATH + sub;',
        '  });',
        '  out = out.replace(SUB_REL_RE, function(m, pre, sub) {',
        '    if (sub.toLowerCase() === TARGET_HOST) return pre + "//" + proxyHost;',
        '    return pre + "//" + proxyHost + PREFIX_PATH + sub;',
        '  });',
        '  if (contentType.includes("text/html")) {',
        '    out = out.replace(/\\s+integrity\\s*=\\s*("[^"]*"|\'[^\']*\')/gi, "");',
        '    const hook = buildClientHook(proxyHost);',
        '    if (/<head[^>]*>/i.test(out)) {',
        '      out = out.replace(/<head[^>]*>/i, function(m) { return m + hook; });',
        '    } else {',
        '      out = hook + out;',
        '    }',
        '  }',
        '  return out;',
        '}',
        'export default {',
        '  async fetch(request) {',
        '    const url = new URL(request.url);',
        '    if (url.pathname === "/_proxy_health") {',
        '      return new Response("ok", { status: 200, headers: { "Content-Type": "text/plain" } });',
        '    }',
        '    const proxyHost = (request.headers.get("X-Forwarded-Host") || url.hostname).split(":")[0].toLowerCase();',
        '    const proxyOrigin = "https://" + proxyHost;',
        '    if (request.method === "OPTIONS" && request.headers.get("Origin")) {',
        '      return new Response(null, {',
        '        status: 204,',
        '        headers: {',
        '          "Access-Control-Allow-Origin": request.headers.get("Origin"),',
        '          "Access-Control-Allow-Credentials": "true",',
        '          "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD",',
        '          "Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers") || "*"',
        '        }',
        '      });',
        '    }',
        '    let actualHost = TARGET_HOST;',
        '    let actualPath = url.pathname;',
        '    if (url.pathname.startsWith(PREFIX_PATH)) {',
        '      const rest = url.pathname.slice(PREFIX_PATH.length);',
        '      const slashIdx = rest.indexOf("/");',
        '      if (slashIdx > 0) {',
        '        actualHost = rest.slice(0, slashIdx).toLowerCase();',
        '        actualPath = rest.slice(slashIdx);',
        '      } else if (rest) {',
        '        actualHost = rest.toLowerCase();',
        '        actualPath = "/";',
        '      }',
        '    }',
        '    const upstreamOrigin = "https://" + actualHost;',
        '    const upstreamUrl = upstreamOrigin + actualPath + url.search;',
        '    const reqHeaders = new Headers(request.headers);',
        '    reqHeaders.delete("Host");',
        '    const rawOrigin = reqHeaders.get("Origin");',
        '    if (rawOrigin && rawOrigin.includes(proxyHost)) {',
        '      reqHeaders.set("Origin", upstreamOrigin);',
        '    }',
        '    const rawRef = reqHeaders.get("Referer");',
        '    if (rawRef && rawRef.includes(proxyHost)) {',
        '      try {',
        '        const ru = new URL(rawRef);',
        '        if (ru.pathname.startsWith(PREFIX_PATH)) {',
        '          const rr = ru.pathname.slice(PREFIX_PATH.length);',
        '          const si = rr.indexOf("/");',
        '          const rh = si > 0 ? rr.slice(0, si) : rr;',
        '          const rp = si > 0 ? rr.slice(si) : "/";',
        '          reqHeaders.set("Referer", "https://" + rh + rp + ru.search);',
        '        } else {',
        '          reqHeaders.set("Referer", upstreamOrigin + ru.pathname + ru.search);',
        '        }',
        '      } catch (e) {',
        '        reqHeaders.set("Referer", upstreamOrigin + "/");',
        '      }',
        '    }',
        '    ["cf-connecting-ip","cf-ipcountry","cf-ray","cf-visitor","cf-worker","x-forwarded-for","x-forwarded-host","x-forwarded-proto","x-real-ip","x-proxy-origin"].forEach(function(h) { reqHeaders.delete(h); });',
        '    const init = { method: request.method, headers: reqHeaders, redirect: "manual" };',
        '    if (request.method !== "GET" && request.method !== "HEAD") {',
        '      init.body = request.body;',
        '    }',
        '    let res;',
        '    try {',
        '      res = await fetch(upstreamUrl, init);',
        '    } catch (err) {',
        '      return new Response("Upstream Fetch Error (" + upstreamUrl + "): " + (err && err.message ? err.message : String(err)), { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8" } });',
        '    }',
        '    if (res.status === 101) return res;',
        '    const resHeaders = new Headers(res.headers);',
        '    ["content-security-policy","content-security-policy-report-only","x-frame-options","strict-transport-security","clear-site-data","cross-origin-embedder-policy","cross-origin-opener-policy","cross-origin-resource-policy"].forEach(function(h) { resHeaders.delete(h); });',
        '    const loc = resHeaders.get("Location");',
        '    if (loc) {',
        '      resHeaders.set("Location", rewriteLocation(loc, upstreamUrl, proxyOrigin));',
        '    }',
        '    const cookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);',
        '    if (cookies.length > 0) {',
        '      resHeaders.delete("set-cookie");',
        '      for (let i = 0; i < cookies.length; i++) {',
        '        resHeaders.append("set-cookie", rewriteCookie(cookies[i]));',
        '      }',
        '    }',
        '    const reqOrig = request.headers.get("Origin");',
        '    if (reqOrig) {',
        '      resHeaders.set("Access-Control-Allow-Origin", reqOrig);',
        '      resHeaders.set("Access-Control-Allow-Credentials", "true");',
        '    }',
        '    const ct = (resHeaders.get("content-type") || "").toLowerCase();',
        '    const shouldRewrite = res.status !== 204 && res.status !== 304 && (ct.includes("text/html") || ct.includes("text/css") || ct.includes("javascript") || ct.includes("application/json") || ct.includes("xml"));',
        '    if (shouldRewrite) {',
        '      const rawText = await res.text();',
        '      const rewritten = rewriteBodyText(rawText, ct, proxyHost, proxyOrigin);',
        '      resHeaders.delete("content-length");',
        '      resHeaders.delete("content-encoding");',
        '      return new Response(rewritten, { status: res.status, statusText: res.statusText, headers: resHeaders });',
        '    }',
        '    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: resHeaders });',
        '  }',
        '};'
    ];
    return lines.join('\n');
}

async function deployProxyPagesFolder(cfEmail, cfKey, accountId, projectName, targetDomain, logs) {
    let projectSubdomain = `${projectName}.pages.dev`;
    const checkProj = await cfRequest(cfEmail, cfKey, 'GET', `/accounts/${accountId}/pages/projects/${projectName}`).catch(() => null);
    if (checkProj && checkProj.result) {
        projectSubdomain = (checkProj.result.subdomain || projectSubdomain).toLowerCase();
    } else {
        const created = await cfRequest(cfEmail, cfKey, 'POST', `/accounts/${accountId}/pages/projects`, {
            name: projectName,
            production_branch: 'main'
        });
        projectSubdomain = (created.result?.subdomain || projectSubdomain).toLowerCase();
    }

    const tokenRes = await cfRequest(cfEmail, cfKey, 'GET', `/accounts/${accountId}/pages/projects/${projectName}/upload-token`);
    const jwt = tokenRes?.result?.jwt;
    if (!jwt) throw new Error('未能获取 Pages 文件夹上传令牌');

    const indexHtml = '<!doctype html><meta charset=utf-8><title>Proxy</title>';
    const indexBytes = encoder.encode(indexHtml);
    const indexHash = blake3SingleBlockHex32(indexBytes);

    const uploadRes = await fetch('https://api.cloudflare.com/client/v4/pages/assets/upload', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${jwt}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify([{
            key: indexHash,
            value: btoa(indexHtml),
            metadata: { contentType: 'text/html' },
            base64: true
        }])
    });
    const uploadData = await uploadRes.json().catch(() => ({ success: false }));
    if (!uploadRes.ok || !uploadData.success) {
        throw new Error('Pages 静态目录资产上传失败');
    }

    await fetch('https://api.cloudflare.com/client/v4/pages/assets/upsert-hashes', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${jwt}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ hashes: [indexHash] })
    }).catch(() => {});

    const proxyScript = buildUniversalProxyWorkerScript(targetDomain);
    const manifestObj = { '/index.html': indexHash };
    const fd = new FormData();
    fd.append('manifest', JSON.stringify(manifestObj));
    fd.append('branch', 'main');
    fd.append('_worker.js', new Blob([proxyScript], { type: 'application/javascript+module' }), '_worker.js');
    await cfRequest(cfEmail, cfKey, 'POST', `/accounts/${accountId}/pages/projects/${projectName}/deployments`, fd);

    let healthy = false;
    for (let attempt = 0; attempt < 4; attempt++) {
        await new Promise((r) => setTimeout(r, 1500));
        const probe = await fetch(`https://${projectSubdomain}/_proxy_health`, { method: 'GET' }).catch(() => null);
        if (probe && probe.status === 200) {
            healthy = true;
            break;
        }
    }
    if (!healthy) {
        throw new Error('Pages 实例边缘未就绪，自动切换至 Worker 模式');
    }

    logs.push(`已优先部署全站反代 Pages 项目 (无请求次数限制): ${projectSubdomain} -> 目标站 ${targetDomain}`);
    return { type: 'pages', name: projectName, targetHost: projectSubdomain };
}

async function deployProxyWorkerScript(cfEmail, cfKey, accountId, scriptName, targetDomain, logs) {
    const proxyScript = buildUniversalProxyWorkerScript(targetDomain);
    const formData = new FormData();
    const metadata = {
        main_module: 'worker.js',
        compatibility_date: '2026-01-01'
    };
    formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    formData.append('worker.js', new Blob([proxyScript], { type: 'application/javascript+module' }), 'worker.js');
    await cfRequest(cfEmail, cfKey, 'PUT', `/accounts/${accountId}/workers/scripts/${scriptName}`, formData);
    logs.push(`已回退部署全站反代 Worker: ${scriptName} -> 目标站 ${targetDomain}`);
    return { type: 'worker', name: scriptName, targetHost: scriptName };
}

async function resolveRuntimeContext(env, body = {}) {
    const { config } = await loadSystemConfig(env);
    const provider = PROVIDER_META[body?.provider] ? body.provider : (config.activeProvider || 'huawei');
    const provCfg = config.providers?.[provider] || {};
    const cfEmail = String(body?.cfEmail ?? config.cfEmail ?? '').trim();
    const cfKey = String(body?.cfKey || config.cfKey || '').trim();
    const dnsAk = String(body?.dnsAk || provCfg.ak || '').trim();
    const dnsSk = String(body?.dnsSk || provCfg.sk || '').trim();
    const pMeta = PROVIDER_META[provider];

    if (!cfKey) throw new Error('尚未配置 Cloudflare API Key / Token，请先在设置中完成配置');
    if (!dnsAk || !dnsSk) throw new Error(`尚未配置 ${pMeta.name} 的密钥 (${pMeta.akLabel} / ${pMeta.skLabel})`);

    return {
        config,
        provider,
        providerMeta: pMeta,
        cfEmail,
        cfKey,
        dnsAk,
        dnsSk,
        defaultCfDomain: config.defaultCfDomain || '',
        defaultDnsDomain: provCfg.defaultDomain || ''
    };
}

function normalizeRouteEntry(raw) {
    if (!raw) return null;
    if (typeof raw === 'string') {
        const target = raw.trim().toLowerCase();
        return target ? { type: 'pages', target } : null;
    }
    if (typeof raw === 'object') {
        if (raw.type === 'worker' && raw.script) {
            return {
                type: 'worker',
                script: String(raw.script).trim(),
                binding: raw.binding ? String(raw.binding).trim() : ''
            };
        }
        if (raw.target) {
            return {
                type: 'pages',
                target: String(raw.target).trim().toLowerCase()
            };
        }
    }
    return null;
}

async function readRelayRouteMap(cfEmail, cfKey, accountId) {
    try {
        const res = await cfRequest(cfEmail, cfKey, 'GET', `/accounts/${accountId}/workers/scripts/${RELAY_WORKER_NAME}/settings`);
        const bindings = res.result?.bindings || [];
        const mapBind = bindings.find((item) => item.name === 'ROUTE_MAP');
        if (mapBind?.text) {
            const parsed = JSON.parse(mapBind.text);
            const cleanMap = {};
            for (const [k, v] of Object.entries(parsed || {})) {
                if (k === '_default') continue;
                const host = String(k).trim().toLowerCase();
                if (!host || host.startsWith('saas-origin.')) continue;
                const norm = normalizeRouteEntry(v);
                if (norm) cleanMap[host] = norm;
            }
            return cleanMap;
        }
        return {};
    } catch (e) {
        return {};
    }
}

async function deployRelayWorker(cfEmail, cfKey, accountId, routeMap) {
    const scriptsRes = await cfRequest(cfEmail, cfKey, 'GET', `/accounts/${accountId}/workers/scripts`).catch(() => null);
    const validScripts = scriptsRes?.result
        ? new Set(scriptsRes.result.map((w) => w.id).filter((id) => id && id !== RELAY_WORKER_NAME))
        : null;

    const normalizedMap = {};
    const workerBindingMap = new Map();
    const serviceBindings = [];

    for (const [rawHost, rawEntry] of Object.entries(routeMap || {})) {
        if (rawHost === '_default') continue;
        const host = String(rawHost).trim().toLowerCase();
        if (!host || host.startsWith('saas-origin.')) continue;
        const entry = normalizeRouteEntry(rawEntry);
        if (!entry) continue;

        if (entry.type === 'worker') {
            if (!entry.script || entry.script === RELAY_WORKER_NAME) continue;
            if (validScripts && !validScripts.has(entry.script)) continue;

            let bindingName = workerBindingMap.get(entry.script);
            if (!bindingName) {
                bindingName = `SVC_${workerBindingMap.size}`;
                workerBindingMap.set(entry.script, bindingName);
                serviceBindings.push({
                    type: 'service',
                    name: bindingName,
                    service: entry.script
                });
            }
            normalizedMap[host] = {
                type: 'worker',
                script: entry.script,
                binding: bindingName
            };
        } else if (entry.type === 'pages' && entry.target) {
            normalizedMap[host] = {
                type: 'pages',
                target: entry.target
            };
        }
    }

    const relayScript = [
        'export default {',
        '  async fetch(request, env) {',
        '    let map = {};',
        '    try { map = JSON.parse(env.ROUTE_MAP || "{}"); } catch (e) {}',
        '    const url = new URL(request.url);',
        '    const host = (url.hostname || request.headers.get("Host") || "").split(":")[0].toLowerCase();',
        '    const target = map[host];',
        '    if (!target) {',
        '      return new Response("SaaS Origin Router: Unmapped host " + host, { status: 404 });',
        '    }',
        '    if (typeof target === "string") {',
        '      url.hostname = target;',
        '      const req = new Request(url.toString(), request);',
        '      req.headers.set("Host", target);',
        '      req.headers.set("X-Forwarded-Host", host);',
        '      return fetch(req, { redirect: "manual" });',
        '    }',
        '    if (target.type === "worker" && target.binding && env[target.binding]) {',
        '      return env[target.binding].fetch(request);',
        '    }',
        '    if (target.type === "pages" && target.target) {',
        '      url.hostname = target.target;',
        '      const req = new Request(url.toString(), request);',
        '      req.headers.set("Host", target.target);',
        '      req.headers.set("X-Forwarded-Host", host);',
        '      return fetch(req, { redirect: "manual" });',
        '    }',
        '    return new Response("SaaS Origin Router: Invalid route target for " + host, { status: 502 });',
        '  }',
        '};'
    ].join('\n');

    const formData = new FormData();
    const metadata = {
        main_module: 'worker.js',
        compatibility_date: '2026-01-01',
        bindings: [
            { type: 'plain_text', name: 'ROUTE_MAP', text: JSON.stringify(normalizedMap) },
            ...serviceBindings
        ]
    };
    formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    formData.append('worker.js', new Blob([relayScript], { type: 'application/javascript+module' }), 'worker.js');

    await cfRequest(cfEmail, cfKey, 'PUT', `/accounts/${accountId}/workers/scripts/${RELAY_WORKER_NAME}`, formData);
    return normalizedMap;
}

async function detachDomainFromAllPagesProjects(cfEmail, cfKey, accountId, hostname, keepProjectName, logs) {
    if (!accountId || !hostname) return;
    const cleanHost = String(hostname).trim().toLowerCase();
    const pagesRes = await cfRequest(cfEmail, cfKey, 'GET', `/accounts/${accountId}/pages/projects`).catch(() => ({ result: [] }));
    for (const p of (pagesRes.result || [])) {
        if (keepProjectName && p.name === keepProjectName) continue;
        const doms = Array.isArray(p.domains) ? p.domains.map((d) => String(d).toLowerCase()) : [];
        if (doms.includes(cleanHost)) {
            await cfRequest(cfEmail, cfKey, 'DELETE', `/accounts/${accountId}/pages/projects/${p.name}/domains/${encodeURIComponent(cleanHost)}`).catch(() => {});
            if (logs) logs.push(`已从原 Pages 项目 [${p.name}] 自动卸载冲突域名: ${cleanHost}`);
        }
    }
}

async function cleanupProxyBackendIfUnused(env, cfEmail, cfKey, accountId, removedRouteEntry, remainingRouteMap, logs) {
    if (!removedRouteEntry || !accountId) return;
    const { config } = await loadSystemConfig(env);
    const proxyMap = { ...(config.proxyResources || {}) };
    let targetType = '';
    let resourceName = '';
    let matchedKey = '';

    if (removedRouteEntry.type === 'worker' && removedRouteEntry.script) {
        const sName = removedRouteEntry.script.toLowerCase();
        const stillUsed = Object.values(remainingRouteMap).some((e) => e.type === 'worker' && e.script.toLowerCase() === sName);
        if (stillUsed) return;
        if (proxyMap[sName] && proxyMap[sName].type === 'worker') {
            targetType = 'worker';
            resourceName = proxyMap[sName].name;
            matchedKey = sName;
        } else if (sName.startsWith('proxy-')) {
            targetType = 'worker';
            resourceName = sName;
        }
    } else if (removedRouteEntry.type === 'pages' && removedRouteEntry.target) {
        const pHost = removedRouteEntry.target.toLowerCase();
        const stillUsed = Object.values(remainingRouteMap).some((e) => e.type === 'pages' && e.target.toLowerCase() === pHost);
        if (stillUsed) return;
        const pName = pHost.endsWith('.pages.dev') ? pHost.slice(0, -10) : pHost;
        if (proxyMap[pName] && proxyMap[pName].type === 'pages') {
            targetType = 'pages';
            resourceName = proxyMap[pName].name;
            matchedKey = pName;
        } else if (pName.startsWith('proxy-')) {
            targetType = 'pages';
            resourceName = pName;
        }
    }

    if (!targetType || !resourceName || resourceName === RELAY_WORKER_NAME) return;

    if (targetType === 'pages') {
        await cfRequest(cfEmail, cfKey, 'DELETE', `/accounts/${accountId}/pages/projects/${resourceName}`).catch(() => {});
        logs.push(`已同步删除全站反代 Pages 项目: ${resourceName}`);
    } else if (targetType === 'worker') {
        await cfRequest(cfEmail, cfKey, 'DELETE', `/accounts/${accountId}/workers/scripts/${resourceName}`).catch(() => {});
        logs.push(`已同步删除全站反代 Worker 脚本: ${resourceName}`);
    }

    if (matchedKey && proxyMap[matchedKey]) {
        delete proxyMap[matchedKey];
        await saveSystemConfig(env, { ...config, proxyResources: proxyMap }).catch(() => {});
    }
}

async function cleanupOldHostnameRecords(env, provider, cfEmail, cfKey, dnsAk, dnsSk, cfZoneId, dnsZoneId, dnsZoneName, oldHostname, accountId, logs) {
    if (!oldHostname) return;
    const cleanOld = normalizeDomain(oldHostname);
    if (!cleanOld) return;

    const chListRes = await cfRequest(cfEmail, cfKey, 'GET', `/zones/${cfZoneId}/custom_hostnames?hostname=${encodeURIComponent(cleanOld)}`).catch(() => ({ result: [] }));
    for (const ch of (chListRes.result || [])) {
        await cfRequest(cfEmail, cfKey, 'DELETE', `/zones/${cfZoneId}/custom_hostnames/${ch.id}`).catch(() => {});
        logs.push(`已从 CF SaaS 注销主机名: ${cleanOld}`);
    }

    if (accountId) {
        await detachDomainFromAllPagesProjects(cfEmail, cfKey, accountId, cleanOld, '', logs);
        const currentMap = await readRelayRouteMap(cfEmail, cfKey, accountId);
        const removedEntry = currentMap[cleanOld] || null;
        if (removedEntry) {
            delete currentMap[cleanOld];
            await deployRelayWorker(cfEmail, cfKey, accountId, currentMap).catch(() => {});
            logs.push(`已从边缘中继路由表移除: ${cleanOld}`);
            await cleanupProxyBackendIfUnused(env, cfEmail, cfKey, accountId, removedEntry, currentMap, logs);
        }
    }

    if (dnsZoneId && dnsZoneName) {
        const records = await dnsListRecords(provider, dnsAk, dnsSk, dnsZoneId, dnsZoneName).catch(() => []);
        const targetNames = new Set([
            cleanOld,
            `_acme-challenge.${cleanOld}`,
            `_cf-custom-hostname.${cleanOld}`
        ]);
        const pName = PROVIDER_META[provider]?.shortName || provider;
        for (const rec of records) {
            if (targetNames.has(rec.fqdn)) {
                await dnsDeleteRecord(provider, dnsAk, dnsSk, dnsZoneId, dnsZoneName, rec.id);
                logs.push(`已清理${pName}解析记录: ${rec.fqdn} (${rec.type} / ${rec.lineRaw})`);
            }
        }
    }
}

async function inspectZoneAcceleration(provider, cfEmail, cfKey, dnsAk, dnsSk, cfZoneId, cfZoneName, dnsZoneId, targetDomain, accountId = '') {
    const fallbackOrigin = `saas-origin.${cfZoneName}`;
    const [dnsRes, routesRes, chRes, providerRecords, relayMap] = await Promise.all([
        cfRequest(cfEmail, cfKey, 'GET', `/zones/${cfZoneId}/dns_records?name=${encodeURIComponent(fallbackOrigin)}`).catch(() => ({ result: [] })),
        cfRequest(cfEmail, cfKey, 'GET', `/zones/${cfZoneId}/workers/routes`).catch(() => ({ result: [] })),
        cfRequest(cfEmail, cfKey, 'GET', `/zones/${cfZoneId}/custom_hostnames?per_page=100`).catch(() => ({ result: [] })),
        (dnsZoneId && targetDomain)
            ? dnsListRecords(provider, dnsAk, dnsSk, dnsZoneId, targetDomain).catch(() => [])
            : Promise.resolve([]),
        accountId ? readRelayRouteMap(cfEmail, cfKey, accountId) : Promise.resolve({})
    ]);

    let originBinding = null;
    const routesList = routesRes.result || [];
    const wildcardRoute = routesList.find((r) => r.pattern === '*/*' || r.pattern === `${fallbackOrigin}/*`);

    if (wildcardRoute && wildcardRoute.script) {
        if (wildcardRoute.script === RELAY_WORKER_NAME) {
            originBinding = { type: 'relay', scriptName: RELAY_WORKER_NAME, relayMap };
        } else {
            originBinding = { type: 'workers', scriptName: wildcardRoute.script, isLegacyWildcard: true };
        }
    } else {
        const cnameRec = (dnsRes.result || []).find((r) => r.type === 'CNAME');
        if (cnameRec && cnameRec.content) {
            originBinding = { type: 'pages', targetHost: cnameRec.content.toLowerCase() };
        }
    }

    const acceleratedHosts = [];
    for (const ch of (chRes.result || [])) {
        const host = String(ch.hostname || '').toLowerCase();
        if (targetDomain && host !== targetDomain && !host.endsWith(`.${targetDomain}`)) continue;
        if (ch.status === 'moved' || ch.status === 'deleted') continue;

        const hostRecords = providerRecords.filter((r) => r.fqdn === host && (r.type === 'CNAME' || r.type === 'A'));
        const defaultRec = hostRecords.find((r) => r.lineRole === 'default');
        const prefRec = hostRecords.find((r) => r.lineRole === 'preferred');

        const preferredTarget = prefRec?.value || '';
        const defaultTarget = defaultRec?.value || '';
        const prefix = (targetDomain && host === targetDomain) ? '@' : (targetDomain ? host.slice(0, -(targetDomain.length + 1)) : host.split('.')[0]);

        const errors = [
            ...(ch.verification_errors || []),
            ...(ch.ssl?.validation_errors || []).map((e) => e.message || JSON.stringify(e))
        ].filter(Boolean);

        const routeEntry = relayMap[host] || null;
        let boundTargetType = '';
        let boundTargetName = '';
        let hasRoutingError = false;

        if (originBinding?.isLegacyWildcard) {
            hasRoutingError = true;
            boundTargetType = 'worker';
            boundTargetName = originBinding.scriptName;
        } else if (routeEntry) {
            boundTargetType = routeEntry.type;
            boundTargetName = routeEntry.type === 'worker' ? routeEntry.script : routeEntry.target;
        } else {
            hasRoutingError = true;
        }

        if (!wildcardRoute || wildcardRoute.script !== RELAY_WORKER_NAME) {
            hasRoutingError = true;
        }

        acceleratedHosts.push({
            id: ch.id,
            hostname: host,
            prefix,
            provider,
            status: ch.status || 'pending',
            sslStatus: ch.ssl?.status || 'pending',
            sslMethod: ch.ssl?.method || 'http',
            preferredTarget,
            defaultTarget,
            targetType: boundTargetType,
            targetName: boundTargetName,
            mappedTarget: boundTargetName,
            hasRoutingError,
            dnsReady: Boolean(defaultRec && prefRec),
            errors
        });
    }

    return {
        provider,
        cfZoneId,
        cfZoneName,
        dnsZoneName: targetDomain,
        fallbackOrigin,
        originBinding,
        acceleratedHosts
    };
}

async function ensureOriginAndFallback(cfEmail, cfKey, cfZoneId, cfZoneName, accountId, targetType, projectName, projectDomain, customHostname, logs) {
    const fallbackSub = 'saas-origin';
    const fallbackOrigin = `${fallbackSub}.${cfZoneName}`;

    const existingDnsRes = await cfRequest(cfEmail, cfKey, 'GET', `/zones/${cfZoneId}/dns_records?name=${encodeURIComponent(fallbackOrigin)}`);
    const existingDns = existingDnsRes.result || [];

    if (existingDns.length > 0) {
        const primaryRec = existingDns[0];
        if (!primaryRec.proxied) {
            await cfRequest(cfEmail, cfKey, 'PUT', `/zones/${cfZoneId}/dns_records/${primaryRec.id}`, {
                type: primaryRec.type,
                name: fallbackSub,
                content: primaryRec.content,
                proxied: true,
                ttl: 1
            });
        }
        logs.push(`回退源 DNS 锚点已就绪: ${fallbackOrigin} (${primaryRec.type} · 已开启橙云代理)`);
    } else {
        await cfRequest(cfEmail, cfKey, 'POST', `/zones/${cfZoneId}/dns_records`, {
            type: 'AAAA',
            name: fallbackSub,
            content: '100::',
            proxied: true,
            ttl: 1
        });
        logs.push(`已创建回退源 DNS 锚点: ${fallbackOrigin} (AAAA 100:: · 已开启橙云代理)`);
    }

    const fbCheck = await cfRequest(cfEmail, cfKey, 'GET', `/zones/${cfZoneId}/custom_hostnames/fallback_origin`).catch(() => ({ result: {} }));
    if (fbCheck.result?.origin !== fallbackOrigin) {
        await cfRequest(cfEmail, cfKey, 'PUT', `/zones/${cfZoneId}/custom_hostnames/fallback_origin`, { origin: fallbackOrigin });
        logs.push(`已设定 SaaS 回退源: ${fallbackOrigin}`);
    } else {
        logs.push(`SaaS 回退源已激活: ${fallbackOrigin} (${fbCheck.result?.status || 'active'})`);
    }

    const routesRes = await cfRequest(cfEmail, cfKey, 'GET', `/zones/${cfZoneId}/workers/routes`);
    const routesList = routesRes.result || [];
    const oldSubRoute = routesList.find((r) => r.pattern === `${fallbackOrigin}/*`);
    if (oldSubRoute) {
        await cfRequest(cfEmail, cfKey, 'DELETE', `/zones/${cfZoneId}/workers/routes/${oldSubRoute.id}`).catch(() => {});
    }

    if (!accountId) throw new Error('未能获取 Account ID，无法部署独立边缘分流中继');

    const cleanHost = customHostname.toLowerCase();
    await detachDomainFromAllPagesProjects(cfEmail, cfKey, accountId, cleanHost, '', logs);

    const routeMap = await readRelayRouteMap(cfEmail, cfKey, accountId);
    const prevEntry = routeMap[cleanHost];

    if (targetType === 'pages') {
        const targetHost = (projectDomain || `${projectName}.pages.dev`).toLowerCase();
        if (prevEntry && (prevEntry.type !== 'pages' || prevEntry.target !== targetHost)) {
            const oldLabel = prevEntry.type === 'worker' ? `[Worker] ${prevEntry.script}` : `[Pages] ${prevEntry.target}`;
            logs.push(`已自动卸载 ${cleanHost} 原绑定的 ${oldLabel}`);
        }
        routeMap[cleanHost] = { type: 'pages', target: targetHost };
        await deployRelayWorker(cfEmail, cfKey, accountId, routeMap);
        logs.push(`已配置独立域名边缘中继: ${cleanHost} -> [Pages] ${targetHost}`);
    } else {
        if (prevEntry && (prevEntry.type !== 'worker' || prevEntry.script !== projectName)) {
            const oldLabel = prevEntry.type === 'worker' ? `[Worker] ${prevEntry.script}` : `[Pages] ${prevEntry.target}`;
            logs.push(`已自动卸载 ${cleanHost} 原绑定的 ${oldLabel}`);
        }
        routeMap[cleanHost] = { type: 'worker', script: projectName };
        await deployRelayWorker(cfEmail, cfKey, accountId, routeMap);
        logs.push(`已绑定独立 Worker 服务直连路由: ${cleanHost} -> [Worker] ${projectName}`);
    }

    const wildcardPattern = '*/*';
    const existingWildcard = routesList.find((r) => r.pattern === wildcardPattern);
    if (existingWildcard) {
        if (existingWildcard.script !== RELAY_WORKER_NAME) {
            await cfRequest(cfEmail, cfKey, 'PUT', `/zones/${cfZoneId}/workers/routes/${existingWildcard.id}`, {
                pattern: wildcardPattern,
                script: RELAY_WORKER_NAME
            });
        }
    } else {
        await cfRequest(cfEmail, cfKey, 'POST', `/zones/${cfZoneId}/workers/routes`, {
            pattern: wildcardPattern,
            script: RELAY_WORKER_NAME
        });
    }

    return fallbackOrigin;
}

async function ensureHttpCustomHostname(cfEmail, cfKey, cfZoneId, customHostname, existingChObj, logs) {
    let chObj = existingChObj;
    if (chObj) {
        const hasErrors = (chObj.verification_errors?.length || 0) > 0 || (chObj.ssl?.validation_errors?.length || 0) > 0;
        const isTxtMethod = chObj.ssl?.method && chObj.ssl.method !== 'http';
        if (chObj.ssl?.status !== 'active' && (hasErrors || isTxtMethod)) {
            logs.push(`检测到旧证书验证模式 (${chObj.ssl?.method || 'txt'}) 存在校验错误，正在切换为 HTTP-01 边缘直连验证...`);
            await cfRequest(cfEmail, cfKey, 'DELETE', `/zones/${cfZoneId}/custom_hostnames/${chObj.id}`).catch(() => {});
            chObj = null;
        }
    }
    if (!chObj) {
        const createRes = await cfRequest(cfEmail, cfKey, 'POST', `/zones/${cfZoneId}/custom_hostnames`, {
            hostname: customHostname,
            ssl: {
                method: 'http',
                type: 'dv',
                settings: { min_tls_version: '1.2' }
            }
        });
        chObj = createRes.result;
        logs.push(`已创建 SaaS 主机名并启用 HTTP-01 边缘极速证书验证: ${customHostname}`);
    } else {
        logs.push(`SaaS 主机名已就绪: ${customHostname} (状态: ${chObj.status} / SSL: ${chObj.ssl?.status})`);
    }
    return chObj;
}

async function handleSetupAndSaveConfig(env, body) {
    const { config: existing } = await loadSystemConfig(env);
    const next = mergeWithDefaultConfig(existing, env);

    if (body.adminPass !== undefined && String(body.adminPass).trim() !== '') {
        next.adminPass = String(body.adminPass).trim();
    }
    if (body.cfEmail !== undefined) {
        next.cfEmail = String(body.cfEmail).trim();
    }
    if (body.cfKey && !String(body.cfKey).includes('****')) {
        next.cfKey = String(body.cfKey).trim();
    }
    if (body.defaultCfDomain !== undefined) {
        next.defaultCfDomain = normalizeDomain(body.defaultCfDomain);
    }
    if (body.defaultOptDomain !== undefined && String(body.defaultOptDomain).trim() !== '') {
        next.defaultOptDomain = String(body.defaultOptDomain).trim();
    }

    const targetProv = PROVIDER_META[body.provider] ? body.provider : next.activeProvider;
    if (body.dnsAk && !String(body.dnsAk).includes('****')) {
        next.providers[targetProv].ak = String(body.dnsAk).trim();
    }
    if (body.dnsSk && !String(body.dnsSk).includes('****')) {
        next.providers[targetProv].sk = String(body.dnsSk).trim();
    }
    if (body.defaultDnsDomain !== undefined) {
        next.providers[targetProv].defaultDomain = normalizeDomain(body.defaultDnsDomain);
    }
    if (next.providers[targetProv].ak && next.providers[targetProv].sk) {
        next.providers[targetProv].enabled = body.enabled !== undefined ? Boolean(body.enabled) : true;
    }
    if (body.setActive !== false && next.providers[targetProv].enabled) {
        next.activeProvider = targetProv;
    }

    if (!next.cfKey) throw new Error('请填写有效的 Cloudflare API Key 或 Token');
    if (!next.providers[next.activeProvider]?.enabled) {
        throw new Error(`请填写 ${PROVIDER_META[next.activeProvider].name} 的有效密钥`);
    }

    await cfRequest(next.cfEmail, next.cfKey, 'GET', '/zones?per_page=5');
    const activeProvObj = next.providers[next.activeProvider];
    await dnsListZones(next.activeProvider, activeProvObj.ak, activeProvObj.sk);

    next.installed = true;
    const saved = await saveSystemConfig(env, next);
    return buildPublicConfigSummary(saved);
}

async function handleSwitchProviderOrDefaults(env, body) {
    const { config: existing } = await loadSystemConfig(env);
    const next = mergeWithDefaultConfig(existing, env);

    if (body.activeProvider && PROVIDER_META[body.activeProvider]) {
        if (!next.providers[body.activeProvider]?.enabled) {
            throw new Error(`${PROVIDER_META[body.activeProvider].name} 尚未启用或配置密钥`);
        }
        next.activeProvider = body.activeProvider;
    }
    if (body.defaultCfDomain !== undefined) {
        next.defaultCfDomain = normalizeDomain(body.defaultCfDomain);
    }
    if (body.defaultDnsDomain !== undefined) {
        const p = body.provider || next.activeProvider;
        if (next.providers[p]) {
            next.providers[p].defaultDomain = normalizeDomain(body.defaultDnsDomain);
        }
    }
    if (body.disableProvider && PROVIDER_META[body.disableProvider]) {
        const dp = body.disableProvider;
        next.providers[dp].enabled = false;
        const remaining = Object.keys(next.providers).find((k) => next.providers[k].enabled);
        if (!remaining) throw new Error('至少需要保留一个已启用的云解析服务商');
        if (next.activeProvider === dp) next.activeProvider = remaining;
    }

    const saved = await saveSystemConfig(env, next);
    return buildPublicConfigSummary(saved);
}

async function handleGetResources(env, body) {
    const ctx = await resolveRuntimeContext(env, body);
    const { config, provider, providerMeta, cfEmail, cfKey, dnsAk, dnsSk, defaultCfDomain, defaultDnsDomain } = ctx;
    const warnings = [];

    const [cfZonesRes, ipPool] = await Promise.all([
        cfRequest(cfEmail, cfKey, 'GET', '/zones?per_page=50'),
        collectPreferredIpsByRegion(false).catch(() => null)
    ]);

    const rawZones = cfZonesRes.result || [];
    const cfZones = rawZones.map((z) => ({
        id: z.id,
        name: z.name.toLowerCase()
    }));

    if (defaultCfDomain) {
        cfZones.sort((a, b) => (a.name === defaultCfDomain ? -1 : (b.name === defaultCfDomain ? 1 : 0)));
    }

    let accountId = rawZones[0]?.account?.id || '';
    if (!accountId) {
        const accRes = await cfRequest(cfEmail, cfKey, 'GET', '/accounts?per_page=20').catch(() => ({ result: [] }));
        accountId = accRes.result?.[0]?.id || '';
    }
    if (!accountId) {
        throw new Error('未能获取到 Cloudflare Account ID，请确认账号下存在有效域名');
    }

    const [pagesRes, workersRes, dnsZonesRaw] = await Promise.all([
        cfRequest(cfEmail, cfKey, 'GET', `/accounts/${accountId}/pages/projects`).catch((e) => {
            warnings.push(`Pages 列表提示: ${e.message}`);
            return { result: [] };
        }),
        cfRequest(cfEmail, cfKey, 'GET', `/accounts/${accountId}/workers/scripts`).catch((e) => {
            warnings.push(`Workers 列表提示: ${e.message}`);
            return { result: [] };
        }),
        dnsListZones(provider, dnsAk, dnsSk).catch((e) => {
            warnings.push(e.message);
            return [];
        })
    ]);

    const pagesProjects = (pagesRes.result || []).map((p) => ({
        name: p.name,
        subdomain: p.subdomain || `${p.name}.pages.dev`,
        domains: Array.isArray(p.domains) ? p.domains.map((d) => String(d).toLowerCase()) : []
    }));

    const workerScripts = (workersRes.result || [])
        .filter((w) => w.id !== RELAY_WORKER_NAME)
        .map((w) => ({ name: w.id }));

    const dnsZones = dnsZonesRaw.slice();
    if (defaultDnsDomain) {
        dnsZones.sort((a, b) => (a.name === defaultDnsDomain ? -1 : (b.name === defaultDnsDomain ? 1 : 0)));
    }

    if (!dnsZones.length && warnings.length === 0) {
        warnings.push(`${providerMeta.name} 账号下暂未检测到公网域名，请先添加域名至云解析`);
    }

    let inspection = null;
    if (cfZones.length > 0 && dnsZones.length > 0) {
        inspection = await inspectZoneAcceleration(
            provider,
            cfEmail,
            cfKey,
            dnsAk,
            dnsSk,
            cfZones[0].id,
            cfZones[0].name,
            dnsZones[0].id,
            dnsZones[0].name,
            accountId
        ).catch(() => null);
    }

    const defaultOptIp = ipPool?.firstHkIp || config.defaultOptDomain || '42.98.74.174';

    return {
        accountId,
        provider,
        providerMeta,
        configSummary: buildPublicConfigSummary(config),
        defaultOptIp,
        ipPool,
        pagesProjects,
        workerScripts,
        cfZones,
        dnsZones,
        inspection,
        warnings
    };
}

async function handleInspect(env, body) {
    const ctx = await resolveRuntimeContext(env, body);
    const { provider, cfEmail, cfKey, dnsAk, dnsSk } = ctx;
    const { cfZoneId, cfZoneName, dnsZoneId, dnsZoneName } = body;
    if (!cfZoneId || !cfZoneName) throw new Error('缺少 Cloudflare 域名参数');
    const targetDomain = normalizeDomain(dnsZoneName);
    const zoneRes = await cfRequest(cfEmail, cfKey, 'GET', `/zones/${cfZoneId}`).catch(() => ({ result: {} }));
    const accountId = zoneRes.result?.account?.id || '';
    return await inspectZoneAcceleration(provider, cfEmail, cfKey, dnsAk, dnsSk, cfZoneId, cfZoneName, dnsZoneId, targetDomain, accountId);
}

async function handleActivateSaas(env, body) {
    const ctx = await resolveRuntimeContext(env, body);
    const { provider, providerMeta, cfEmail, cfKey, dnsAk, dnsSk } = ctx;
    const {
        targetType,
        projectName,
        projectDomain,
        cfZoneId,
        cfZoneName,
        dnsZoneId,
        dnsZoneName,
        prefix,
        preferredTarget,
        replaceOldHostname
    } = body;

    const targetDomain = normalizeDomain(dnsZoneName);
    if (!projectName) throw new Error('请选择要加速的 Pages 或 Workers 项目');
    if (!cfZoneId || !cfZoneName) throw new Error('请选择 Cloudflare 中转回源域');
    if (!dnsZoneId || !targetDomain) throw new Error(`请选择 ${providerMeta.shortName} 最终访问域名`);

    let finalPref = String(preferredTarget || '').trim();
    if (!finalPref) {
        finalPref = await resolveDefaultHkIp(false);
    }

    const logs = [];
    const cleanPrefix = String(prefix || '').trim().split('.').filter(Boolean).join('.');
    const isApex = !cleanPrefix || cleanPrefix === '@';
    const customHostname = isApex ? targetDomain : `${cleanPrefix}.${targetDomain}`;

    const zoneInfoRes = await cfRequest(cfEmail, cfKey, 'GET', `/zones/${cfZoneId}`);
    const accountId = zoneInfoRes.result?.account?.id || '';

    if (replaceOldHostname && String(replaceOldHostname).toLowerCase() !== customHostname) {
        logs.push(`正在更换加速域名: ${replaceOldHostname} -> ${customHostname}`);
        await cleanupOldHostnameRecords(
            env,
            provider,
            cfEmail,
            cfKey,
            dnsAk,
            dnsSk,
            cfZoneId,
            dnsZoneId,
            targetDomain,
            replaceOldHostname,
            accountId,
            logs
        );
    }

    logs.push(`开始配置最终访问域名 (${providerMeta.shortName}): https://${customHostname}`);

    const fallbackOrigin = await ensureOriginAndFallback(
        cfEmail,
        cfKey,
        cfZoneId,
        cfZoneName,
        accountId,
        targetType,
        projectName,
        projectDomain,
        customHostname,
        logs
    );

    const chListRes = await cfRequest(cfEmail, cfKey, 'GET', `/zones/${cfZoneId}/custom_hostnames?hostname=${encodeURIComponent(customHostname)}`);
    let chObj = (chListRes.result || [])[0];
    if (chObj && (chObj.status === 'moved' || chObj.status === 'deleted')) {
        await cfRequest(cfEmail, cfKey, 'DELETE', `/zones/${cfZoneId}/custom_hostnames/${chObj.id}`).catch(() => {});
        chObj = null;
    }

    chObj = await ensureHttpCustomHostname(cfEmail, cfKey, cfZoneId, customHostname, chObj, logs);

    await syncProviderDnsForHost(
        provider,
        dnsAk,
        dnsSk,
        dnsZoneId,
        targetDomain,
        chObj,
        customHostname,
        fallbackOrigin,
        finalPref,
        logs
    );

    const inspection = await inspectZoneAcceleration(provider, cfEmail, cfKey, dnsAk, dnsSk, cfZoneId, cfZoneName, dnsZoneId, targetDomain, accountId).catch(() => null);

    return {
        customHostname,
        customHostnameId: chObj.id,
        cfZoneId,
        status: chObj.status,
        sslStatus: chObj.ssl?.status || 'initializing',
        inspection,
        logs
    };
}

async function handleDeployProxySaas(env, body) {
    const ctx = await resolveRuntimeContext(env, body);
    const { provider, providerMeta, cfEmail, cfKey, dnsAk, dnsSk } = ctx;
    const {
        proxyTargetSite,
        proxyPagesName,
        cfZoneId,
        cfZoneName,
        dnsZoneId,
        dnsZoneName,
        prefix,
        preferredTarget,
        replaceOldHostname
    } = body;

    const cleanTargetSite = normalizeDomain(proxyTargetSite);
    const targetDomain = normalizeDomain(dnsZoneName);
    if (!cleanTargetSite || !cleanTargetSite.includes('.')) {
        throw new Error('请输入有效的目标网站域名，例如 baidu.com');
    }
    if (!cfZoneId || !cfZoneName) throw new Error('请选择 Cloudflare 中转回源域');
    if (!dnsZoneId || !targetDomain) throw new Error(`请选择 ${providerMeta.shortName} 最终访问域名`);

    let finalPref = String(preferredTarget || '').trim();
    if (!finalPref) {
        finalPref = await resolveDefaultHkIp(false);
    }

    const logs = [];
    const zoneInfoRes = await cfRequest(cfEmail, cfKey, 'GET', `/zones/${cfZoneId}`);
    const accountId = zoneInfoRes.result?.account?.id || '';
    if (!accountId) throw new Error('未能获取 Cloudflare Account ID');

    const cleanPrefix = String(prefix || '').trim().split('.').filter(Boolean).join('.');
    const isApex = !cleanPrefix || cleanPrefix === '@';
    const customHostname = isApex ? targetDomain : `${cleanPrefix}.${targetDomain}`;

    if (replaceOldHostname && String(replaceOldHostname).toLowerCase() !== customHostname) {
        logs.push(`正在更换加速域名: ${replaceOldHostname} -> ${customHostname}`);
        await cleanupOldHostnameRecords(
            env,
            provider,
            cfEmail,
            cfKey,
            dnsAk,
            dnsSk,
            cfZoneId,
            dnsZoneId,
            targetDomain,
            replaceOldHostname,
            accountId,
            logs
        );
    }

    const safeName = sanitizeProxyResourceName(proxyPagesName, cleanTargetSite);
    logs.push(`[1/4] 优先以文件夹上传方式部署全站反代 Pages (${safeName}) -> https://${cleanTargetSite}`);

    let deployed;
    try {
        deployed = await deployProxyPagesFolder(cfEmail, cfKey, accountId, safeName, cleanTargetSite, logs);
    } catch (pagesErr) {
        logs.push(`Pages 部署提示 (${pagesErr.message})，正在回退部署至独立 Worker...`);
        await cfRequest(cfEmail, cfKey, 'DELETE', `/accounts/${accountId}/pages/projects/${safeName}`).catch(() => {});
        deployed = await deployProxyWorkerScript(cfEmail, cfKey, accountId, safeName, cleanTargetSite, logs);
    }

    const { config: latestCfg } = await loadSystemConfig(env);
    const nextProxyRes = { ...(latestCfg.proxyResources || {}) };
    nextProxyRes[deployed.name] = {
        type: deployed.type,
        name: deployed.name,
        targetHost: deployed.targetHost,
        targetSite: cleanTargetSite
    };
    await saveSystemConfig(env, { ...latestCfg, proxyResources: nextProxyRes }).catch(() => {});

    logs.push(`[2/4] 正在建立边缘独立路由: ${customHostname} -> [${deployed.type.toUpperCase()}] ${deployed.targetHost}`);
    const fallbackOrigin = await ensureOriginAndFallback(
        cfEmail,
        cfKey,
        cfZoneId,
        cfZoneName,
        accountId,
        deployed.type === 'pages' ? 'pages' : 'workers',
        deployed.name,
        deployed.type === 'pages' ? deployed.targetHost : '',
        customHostname,
        logs
    );

    logs.push(`[3/4] 正在签发 SaaS 自定义主机名证书: ${customHostname}`);
    const chListRes = await cfRequest(cfEmail, cfKey, 'GET', `/zones/${cfZoneId}/custom_hostnames?hostname=${encodeURIComponent(customHostname)}`);
    let chObj = (chListRes.result || [])[0];
    if (chObj && (chObj.status === 'moved' || chObj.status === 'deleted')) {
        await cfRequest(cfEmail, cfKey, 'DELETE', `/zones/${cfZoneId}/custom_hostnames/${chObj.id}`).catch(() => {});
        chObj = null;
    }
    chObj = await ensureHttpCustomHostname(cfEmail, cfKey, cfZoneId, customHostname, chObj, logs);

    logs.push(`[4/4] 正在同步${providerMeta.shortName}双线优选解析 -> ${finalPref}`);
    await syncProviderDnsForHost(
        provider,
        dnsAk,
        dnsSk,
        dnsZoneId,
        targetDomain,
        chObj,
        customHostname,
        fallbackOrigin,
        finalPref,
        logs
    );

    const [inspection, pagesRes, workersRes] = await Promise.all([
        inspectZoneAcceleration(provider, cfEmail, cfKey, dnsAk, dnsSk, cfZoneId, cfZoneName, dnsZoneId, targetDomain, accountId).catch(() => null),
        cfRequest(cfEmail, cfKey, 'GET', `/accounts/${accountId}/pages/projects`).catch(() => ({ result: [] })),
        cfRequest(cfEmail, cfKey, 'GET', `/accounts/${accountId}/workers/scripts`).catch(() => ({ result: [] }))
    ]);

    const pagesProjects = (pagesRes.result || []).map((p) => ({
        name: p.name,
        subdomain: p.subdomain || `${p.name}.pages.dev`,
        domains: Array.isArray(p.domains) ? p.domains.map((d) => String(d).toLowerCase()) : []
    }));

    const workerScripts = (workersRes.result || [])
        .filter((w) => w.id !== RELAY_WORKER_NAME)
        .map((w) => ({ name: w.id }));

    return {
        customHostname,
        customHostnameId: chObj.id,
        cfZoneId,
        projectName: deployed.name,
        deployType: deployed.type,
        targetSite: cleanTargetSite,
        status: chObj.status,
        sslStatus: chObj.ssl?.status || 'initializing',
        pagesProjects,
        workerScripts,
        inspection,
        logs
    };
}

async function handleRebindOrigin(env, body) {
    const ctx = await resolveRuntimeContext(env, body);
    const { provider, cfEmail, cfKey, dnsAk, dnsSk } = ctx;
    const { hostname, targetType, projectName, projectDomain, cfZoneId, cfZoneName, dnsZoneId, dnsZoneName } = body;

    const cleanHost = normalizeDomain(hostname);
    const targetDomain = normalizeDomain(dnsZoneName);
    if (!cleanHost) throw new Error('缺少目标加速域名');
    if (!projectName) throw new Error('请选择要绑定的目标项目');
    if (!cfZoneId || !cfZoneName) throw new Error('缺少 Cloudflare 域名参数');

    const logs = [];
    const zoneRes = await cfRequest(cfEmail, cfKey, 'GET', `/zones/${cfZoneId}`);
    const accountId = zoneRes.result?.account?.id || '';

    await ensureOriginAndFallback(
        cfEmail,
        cfKey,
        cfZoneId,
        cfZoneName,
        accountId,
        targetType,
        projectName,
        projectDomain,
        cleanHost,
        logs
    );

    const inspection = await inspectZoneAcceleration(provider, cfEmail, cfKey, dnsAk, dnsSk, cfZoneId, cfZoneName, dnsZoneId, targetDomain, accountId).catch(() => null);
    return { hostname: cleanHost, inspection, logs };
}

function isInitialSubsequence(prefix, fullName) {
    if (!prefix || prefix.length < 2) return false;
    const p = prefix.toLowerCase().replace(/[^a-z0-9]/g, '');
    const f = fullName.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!p || p.length >= f.length) return false;
    let idx = 0;
    for (let i = 0; i < f.length && idx < p.length; i++) {
        if (f[i] === p[idx]) idx++;
    }
    return idx === p.length && p[0] === f[0];
}

async function handleRepairAllOrigins(env, body) {
    const ctx = await resolveRuntimeContext(env, body);
    const { provider, providerMeta, cfEmail, cfKey, dnsAk, dnsSk } = ctx;
    const { cfZoneId, cfZoneName, dnsZoneId, dnsZoneName } = body;
    const targetDomain = normalizeDomain(dnsZoneName);

    if (!cfZoneId || !cfZoneName) throw new Error('请选择 Cloudflare 中转回源域');
    if (!dnsZoneId || !targetDomain) throw new Error(`请选择 ${providerMeta.shortName} 最终访问域名`);

    const logs = [];
    const zoneRes = await cfRequest(cfEmail, cfKey, 'GET', `/zones/${cfZoneId}`);
    const accountId = zoneRes.result?.account?.id || '';
    if (!accountId) throw new Error('未能获取 Cloudflare Account ID');

    const bestHkIp = await resolveDefaultHkIp(true);
    logs.push(`[0/4] 已获取当前香港最优 IP 节点: ${bestHkIp}`);

    const fallbackSub = 'saas-origin';
    const fallbackOrigin = `${fallbackSub}.${cfZoneName}`;

    const existingDnsRes = await cfRequest(cfEmail, cfKey, 'GET', `/zones/${cfZoneId}/dns_records?name=${encodeURIComponent(fallbackOrigin)}`);
    const existingDns = existingDnsRes.result || [];
    if (existingDns.length > 0) {
        const primaryRec = existingDns[0];
        if (!primaryRec.proxied) {
            await cfRequest(cfEmail, cfKey, 'PUT', `/zones/${cfZoneId}/dns_records/${primaryRec.id}`, {
                type: primaryRec.type,
                name: fallbackSub,
                content: primaryRec.content,
                proxied: true,
                ttl: 1
            });
        }
    } else {
        await cfRequest(cfEmail, cfKey, 'POST', `/zones/${cfZoneId}/dns_records`, {
            type: 'AAAA',
            name: fallbackSub,
            content: '100::',
            proxied: true,
            ttl: 1
        });
    }

    const fbCheck = await cfRequest(cfEmail, cfKey, 'GET', `/zones/${cfZoneId}/custom_hostnames/fallback_origin`).catch(() => ({ result: {} }));
    if (fbCheck.result?.origin !== fallbackOrigin) {
        await cfRequest(cfEmail, cfKey, 'PUT', `/zones/${cfZoneId}/custom_hostnames/fallback_origin`, { origin: fallbackOrigin });
    }
    logs.push(`[1/4] 已校准主回退源锚点: ${fallbackOrigin}`);

    const [routesRes, chRes, pagesRes, workersRes, existingDnsRecords, currentRouteMap] = await Promise.all([
        cfRequest(cfEmail, cfKey, 'GET', `/zones/${cfZoneId}/workers/routes`),
        cfRequest(cfEmail, cfKey, 'GET', `/zones/${cfZoneId}/custom_hostnames?per_page=100`),
        cfRequest(cfEmail, cfKey, 'GET', `/accounts/${accountId}/pages/projects`).catch(() => ({ result: [] })),
        cfRequest(cfEmail, cfKey, 'GET', `/accounts/${accountId}/workers/scripts`).catch(() => ({ result: [] })),
        dnsListRecords(provider, dnsAk, dnsSk, dnsZoneId, targetDomain),
        readRelayRouteMap(cfEmail, cfKey, accountId)
    ]);

    const pagesList = (pagesRes.result || []).map((p) => ({
        name: p.name,
        subdomain: (p.subdomain || `${p.name}.pages.dev`).toLowerCase(),
        domains: Array.isArray(p.domains) ? p.domains.map((d) => String(d).toLowerCase()) : []
    }));
    const validPagesHosts = new Set(pagesList.map((p) => p.subdomain));
    const workerNames = (workersRes.result || []).map((w) => w.id).filter((id) => id && id !== RELAY_WORKER_NAME);
    const validWorkers = new Set(workerNames);

    const routesList = routesRes.result || [];
    const wildcardRoute = routesList.find((r) => r.pattern === '*/*');
    if (wildcardRoute && wildcardRoute.script && wildcardRoute.script !== RELAY_WORKER_NAME) {
        logs.push(`[2/4] 检测到全局通配路由 (*/*) 被单一脚本 [${wildcardRoute.script}] 劫持，正在切换为独立分流中继...`);
    } else {
        logs.push(`[2/4] 边缘通配路由已由独立分流中继 (${RELAY_WORKER_NAME}) 接管`);
    }

    const activeHosts = (chRes.result || [])
        .filter((ch) => {
            const h = String(ch.hostname || '').toLowerCase();
            return (h === targetDomain || h.endsWith(`.${targetDomain}`)) && ch.status !== 'moved' && ch.status !== 'deleted';
        })
        .map((ch) => String(ch.hostname).toLowerCase());

    const repairedMap = { ...currentRouteMap };
    const defaultLineRaw = provider === 'tencent' ? '默认' : (provider === 'aliyun' ? 'default' : 'default_view');
    let fixedCount = 0;
    const unresolvedHosts = [];

    for (const host of activeHosts) {
        let entry = repairedMap[host];
        let valid = false;

        if (entry) {
            if (entry.type === 'worker' && validWorkers.has(entry.script)) valid = true;
            if (entry.type === 'pages' && (validPagesHosts.has(entry.target) || entry.target.endsWith('.pages.dev'))) valid = true;
        }

        if (!valid) {
            const ownerPages = pagesList.find((p) => p.domains.includes(host));
            if (ownerPages) {
                entry = { type: 'pages', target: ownerPages.subdomain };
                await cfRequest(cfEmail, cfKey, 'DELETE', `/accounts/${accountId}/pages/projects/${ownerPages.name}/domains/${encodeURIComponent(host)}`).catch(() => {});
                valid = true;
                logs.push(`[3/4] 自动恢复 Pages 独立映射: ${host} -> ${ownerPages.subdomain}`);
            }
        }

        if (!valid) {
            const prefix = host === targetDomain ? '' : host.slice(0, -(targetDomain.length + 1));
            const exactWorker = workerNames.find((w) => w.toLowerCase() === prefix);
            const exactPages = pagesList.find((p) => p.name.toLowerCase() === prefix);
            if (exactWorker) {
                entry = { type: 'worker', script: exactWorker };
                valid = true;
                logs.push(`[3/4] 按前缀匹配恢复 Worker 映射: ${host} -> ${exactWorker}`);
            } else if (exactPages) {
                entry = { type: 'pages', target: exactPages.subdomain };
                valid = true;
                logs.push(`[3/4] 按前缀匹配恢复 Pages 映射: ${host} -> ${exactPages.subdomain}`);
            } else if (prefix) {
                const subWorkers = workerNames.filter((w) => isInitialSubsequence(prefix, w));
                const subPages = pagesList.filter((p) => isInitialSubsequence(prefix, p.name));
                if (subWorkers.length === 1 && subPages.length === 0) {
                    entry = { type: 'worker', script: subWorkers[0] };
                    valid = true;
                    logs.push(`[3/4] 智能识别缩写前缀恢复 Worker 映射: ${host} -> ${subWorkers[0]}`);
                } else if (subPages.length === 1 && subWorkers.length === 0) {
                    entry = { type: 'pages', target: subPages[0].subdomain };
                    valid = true;
                    logs.push(`[3/4] 智能识别缩写前缀恢复 Pages 映射: ${host} -> ${subPages[0].subdomain}`);
                }
            }
        }

        if (valid && entry) {
            repairedMap[host] = entry;
            fixedCount++;
        } else {
            delete repairedMap[host];
            unresolvedHosts.push(host);
        }

        await dnsUpsertRecord(provider, dnsAk, dnsSk, dnsZoneId, targetDomain, existingDnsRecords, host, 'CNAME', defaultLineRaw, fallbackOrigin);
        await applyProviderPreferredLines(provider, dnsAk, dnsSk, dnsZoneId, targetDomain, existingDnsRecords, host, bestHkIp, logs);
    }

    await deployRelayWorker(cfEmail, cfKey, accountId, repairedMap);

    if (wildcardRoute) {
        if (wildcardRoute.script !== RELAY_WORKER_NAME) {
            await cfRequest(cfEmail, cfKey, 'PUT', `/zones/${cfZoneId}/workers/routes/${wildcardRoute.id}`, {
                pattern: '*/*',
                script: RELAY_WORKER_NAME
            });
        }
    } else {
        await cfRequest(cfEmail, cfKey, 'POST', `/zones/${cfZoneId}/workers/routes`, {
            pattern: '*/*',
            script: RELAY_WORKER_NAME
        });
    }

    logs.push(`[4/4] 修复完成：已校准 ${fixedCount} 个独立回源节点，全部境内优选线路已同步为香港首选 IP (${bestHkIp})`);
    if (unresolvedHosts.length > 0) {
        logs.push(`提示：域名 [${unresolvedHosts.join(', ')}] 尚未绑定独立源站，请在资产卡片中选择对应项目完成绑定`);
    }

    const inspection = await inspectZoneAcceleration(provider, cfEmail, cfKey, dnsAk, dnsSk, cfZoneId, cfZoneName, dnsZoneId, targetDomain, accountId).catch(() => null);
    return { fixedCount, bestHkIp, unresolvedHosts, inspection, logs };
}

async function handleUpdatePreferredTarget(env, body) {
    const ctx = await resolveRuntimeContext(env, body);
    const { config, provider, cfEmail, cfKey, dnsAk, dnsSk } = ctx;
    const { hostname, preferredTarget, cfZoneId, cfZoneName, dnsZoneId, dnsZoneName } = body;
    const targetDomain = normalizeDomain(dnsZoneName);

    const cleanHost = normalizeDomain(hostname);
    const cleanPref = String(preferredTarget || '').trim();
    if (!cleanHost) throw new Error('缺少目标加速域名');
    if (!cleanPref) throw new Error('请输入新的优选域名或优选 IP');

    const logs = [];
    let resolvedProvider = provider;
    let resolvedAk = dnsAk;
    let resolvedSk = dnsSk;
    let resolvedZoneId = dnsZoneId;
    let resolvedZoneName = targetDomain;

    if (resolvedZoneId && resolvedZoneName && (cleanHost === resolvedZoneName || cleanHost.endsWith(`.${resolvedZoneName}`))) {
        const existingRecords = await dnsListRecords(resolvedProvider, resolvedAk, resolvedSk, resolvedZoneId, resolvedZoneName);
        await applyProviderPreferredLines(resolvedProvider, resolvedAk, resolvedSk, resolvedZoneId, resolvedZoneName, existingRecords, cleanHost, cleanPref, logs);
    } else {
        let matchedAny = false;
        const candidateProviders = [provider, ...Object.keys(config.providers || {}).filter((k) => k !== provider)];
        for (const pid of candidateProviders) {
            const pObj = config.providers?.[pid];
            if (!pObj?.enabled || !pObj.ak || !pObj.sk) continue;
            const zones = await dnsListZones(pid, pObj.ak, pObj.sk).catch(() => []);
            const matchedZone = zones.find((z) => cleanHost === z.name || cleanHost.endsWith(`.${z.name}`));
            if (matchedZone) {
                resolvedProvider = pid;
                resolvedAk = pObj.ak;
                resolvedSk = pObj.sk;
                resolvedZoneId = matchedZone.id;
                resolvedZoneName = matchedZone.name;
                const existingRecords = await dnsListRecords(pid, pObj.ak, pObj.sk, matchedZone.id, matchedZone.name);
                await applyProviderPreferredLines(pid, pObj.ak, pObj.sk, matchedZone.id, matchedZone.name, existingRecords, cleanHost, cleanPref, logs);
                matchedAny = true;
                break;
            }
        }
        if (!matchedAny) {
            throw new Error(`未在已启用的云解析服务商中找到域名 ${cleanHost} 所属的主域`);
        }
    }

    let inspection = null;
    if (cfZoneId && cfZoneName && resolvedZoneId && resolvedZoneName) {
        const zoneRes = await cfRequest(cfEmail, cfKey, 'GET', `/zones/${cfZoneId}`).catch(() => ({ result: {} }));
        const accountId = zoneRes.result?.account?.id || '';
        inspection = await inspectZoneAcceleration(resolvedProvider, cfEmail, cfKey, resolvedAk, resolvedSk, cfZoneId, cfZoneName, resolvedZoneId, resolvedZoneName, accountId).catch(() => null);
    }

    return { hostname: cleanHost, preferredTarget: cleanPref, inspection, logs };
}

async function handleUpdateAllBestOpt(env, body = {}) {
    const { config } = await loadSystemConfig(env);
    if (!config.cfKey) throw new Error('尚未配置 Cloudflare 密钥');

    const ipPool = await collectPreferredIpsByRegion(true);
    const bestTarget = ipPool.firstHkIp || await resolveDefaultHkIp(true);
    const logs = [`已获取香港首选优选 IP: ${bestTarget}`];

    const cfZonesRes = await cfRequest(config.cfEmail, config.cfKey, 'GET', '/zones?per_page=50');
    const cfZones = (cfZonesRes.result || []).map((z) => ({ id: z.id, name: z.name.toLowerCase() }));

    const allCustomHosts = new Set();
    for (const cfZone of cfZones) {
        const chRes = await cfRequest(config.cfEmail, config.cfKey, 'GET', `/zones/${cfZone.id}/custom_hostnames?per_page=100`).catch(() => ({ result: [] }));
        for (const ch of (chRes.result || [])) {
            if (ch.status === 'moved' || ch.status === 'deleted') continue;
            const h = String(ch.hostname || '').toLowerCase();
            if (h) allCustomHosts.add(h);
        }
    }

    const updatedHosts = [];
    for (const [provId, provObj] of Object.entries(config.providers || {})) {
        if (!provObj.enabled || !provObj.ak || !provObj.sk) continue;
        const pZones = await dnsListZones(provId, provObj.ak, provObj.sk).catch(() => []);
        for (const pz of pZones) {
            const matchedHosts = Array.from(allCustomHosts).filter((h) => h === pz.name || h.endsWith(`.${pz.name}`));
            if (!matchedHosts.length) continue;
            const existingRecords = await dnsListRecords(provId, provObj.ak, provObj.sk, pz.id, pz.name).catch(() => []);
            for (const h of matchedHosts) {
                await applyProviderPreferredLines(provId, provObj.ak, provObj.sk, pz.id, pz.name, existingRecords, h, bestTarget, logs);
                updatedHosts.push(h);
            }
        }
    }

    if (updatedHosts.length === 0) {
        logs.push('当前未发现需要更新的已激活 SaaS 矩阵域名');
    } else {
        logs.push(`全部更新完成：共 ${updatedHosts.length} 个 SaaS 节点已切换至香港首选 IP ${bestTarget}`);
    }

    let inspection = null;
    if (body.cfZoneId && body.cfZoneName && body.dnsZoneId && body.dnsZoneName) {
        const ctx = await resolveRuntimeContext(env, body);
        const zoneRes = await cfRequest(ctx.cfEmail, ctx.cfKey, 'GET', `/zones/${body.cfZoneId}`).catch(() => ({ result: {} }));
        const accountId = zoneRes.result?.account?.id || '';
        inspection = await inspectZoneAcceleration(
            ctx.provider,
            ctx.cfEmail,
            ctx.cfKey,
            ctx.dnsAk,
            ctx.dnsSk,
            body.cfZoneId,
            body.cfZoneName,
            body.dnsZoneId,
            normalizeDomain(body.dnsZoneName),
            accountId
        ).catch(() => null);
    }

    return {
        bestDomain: bestTarget,
        updatedCount: updatedHosts.length,
        updatedHosts,
        inspection,
        logs
    };
}

async function handleDeleteHostname(env, body) {
    const ctx = await resolveRuntimeContext(env, body);
    const { provider, cfEmail, cfKey, dnsAk, dnsSk } = ctx;
    const { hostname, cfZoneId, cfZoneName, dnsZoneId, dnsZoneName } = body;
    const targetDomain = normalizeDomain(dnsZoneName);
    const cleanHost = normalizeDomain(hostname);

    if (!cleanHost) throw new Error('缺少要卸载的域名');
    if (!cfZoneId) throw new Error('缺少 Cloudflare 域名参数');

    const logs = [];
    const zoneRes = await cfRequest(cfEmail, cfKey, 'GET', `/zones/${cfZoneId}`).catch(() => ({ result: {} }));
    const accountId = zoneRes.result?.account?.id || '';

    await cleanupOldHostnameRecords(
        env,
        provider,
        cfEmail,
        cfKey,
        dnsAk,
        dnsSk,
        cfZoneId,
        dnsZoneId,
        targetDomain,
        cleanHost,
        accountId,
        logs
    );

    const [inspection, pagesRes, workersRes] = await Promise.all([
        (cfZoneName && dnsZoneId && targetDomain)
            ? inspectZoneAcceleration(provider, cfEmail, cfKey, dnsAk, dnsSk, cfZoneId, cfZoneName, dnsZoneId, targetDomain, accountId).catch(() => null)
            : Promise.resolve(null),
        accountId ? cfRequest(cfEmail, cfKey, 'GET', `/accounts/${accountId}/pages/projects`).catch(() => ({ result: [] })) : Promise.resolve({ result: [] }),
        accountId ? cfRequest(cfEmail, cfKey, 'GET', `/accounts/${accountId}/workers/scripts`).catch(() => ({ result: [] })) : Promise.resolve({ result: [] })
    ]);

    const pagesProjects = (pagesRes.result || []).map((p) => ({
        name: p.name,
        subdomain: p.subdomain || `${p.name}.pages.dev`,
        domains: Array.isArray(p.domains) ? p.domains.map((d) => String(d).toLowerCase()) : []
    }));

    const workerScripts = (workersRes.result || [])
        .filter((w) => w.id !== RELAY_WORKER_NAME)
        .map((w) => ({ name: w.id }));

    return { deletedHostname: cleanHost, pagesProjects, workerScripts, inspection, logs };
}

async function handleSelfCheckAndRepair(env, body) {
    const ctx = await resolveRuntimeContext(env, body);
    const { provider, providerMeta, cfEmail, cfKey, dnsAk, dnsSk } = ctx;
    const {
        targetType,
        projectName,
        projectDomain,
        cfZoneId,
        cfZoneName,
        dnsZoneId,
        dnsZoneName,
        prefix,
        preferredTarget
    } = body;

    const targetDomain = normalizeDomain(dnsZoneName);
    if (!cfZoneId || !cfZoneName) throw new Error('请选择 Cloudflare 中转回源域');
    if (!dnsZoneId || !targetDomain) throw new Error(`请选择 ${providerMeta.shortName} 最终访问域名`);

    let finalPref = String(preferredTarget || '').trim();
    if (!finalPref) {
        finalPref = await resolveDefaultHkIp(false);
    }

    const cleanPrefix = String(prefix || '').trim().split('.').filter(Boolean).join('.');
    const isApex = !cleanPrefix || cleanPrefix === '@';
    const customHostname = isApex ? targetDomain : `${cleanPrefix}.${targetDomain}`;

    const checks = [];
    const logs = [];

    const zoneInfoRes = await cfRequest(cfEmail, cfKey, 'GET', `/zones/${cfZoneId}`);
    const zoneObj = zoneInfoRes.result || {};
    const accountId = zoneObj.account?.id || '';
    checks.push({
        step: '1. 账号与多云主域状态',
        status: zoneObj.status === 'active' ? 'pass' : 'warn',
        detail: `CF 中转域 ${cfZoneName} (${zoneObj.status}) · ${providerMeta.shortName}主域 ${targetDomain} 已就绪`
    });
    logs.push(`[自检 1/6] CF 中转域 ${cfZoneName} 与 ${providerMeta.name} 凭据验证通过`);

    const allChRes = await cfRequest(cfEmail, cfKey, 'GET', `/zones/${cfZoneId}/custom_hostnames?per_page=100`);
    const allChList = allChRes.result || [];
    let cleanedCount = 0;
    for (const item of allChList) {
        const h = String(item.hostname || '').toLowerCase();
        if ((h === targetDomain || h.endsWith(`.${targetDomain}`)) && (item.status === 'moved' || item.status === 'deleted')) {
            await cfRequest(cfEmail, cfKey, 'DELETE', `/zones/${cfZoneId}/custom_hostnames/${item.id}`).catch(() => {});
            cleanedCount++;
            logs.push(`[自检 2/6] 已自动清理异常残留主机名: ${h}`);
        }
    }
    checks.push({
        step: '2. 残留脏数据清理',
        status: cleanedCount > 0 ? 'fixed' : 'pass',
        detail: cleanedCount > 0 ? `已清理 ${cleanedCount} 条残留主机名` : '未发现冲突或残留主机名记录'
    });

    const fallbackOrigin = await ensureOriginAndFallback(
        cfEmail,
        cfKey,
        cfZoneId,
        cfZoneName,
        accountId,
        targetType,
        projectName,
        projectDomain,
        customHostname,
        logs
    );
    checks.push({
        step: '3. 独立域名中继与回源路由',
        status: 'fixed',
        detail: `域名 ${customHostname} 已独立映射 -> [${targetType.toUpperCase()}] ${projectName}`
    });

    let chObj = allChList.find((c) => String(c.hostname || '').toLowerCase() === customHostname && c.status !== 'moved' && c.status !== 'deleted');
    chObj = await ensureHttpCustomHostname(cfEmail, cfKey, cfZoneId, customHostname, chObj, logs);
    checks.push({
        step: '4. SSL 证书 HTTP-01 边缘验证',
        status: chObj?.ssl?.status === 'active' ? 'pass' : 'fixed',
        detail: '已启用 Cloudflare 边缘 HTTP-01 自动核验'
    });

    await syncProviderDnsForHost(
        provider,
        dnsAk,
        dnsSk,
        dnsZoneId,
        targetDomain,
        chObj,
        customHostname,
        fallbackOrigin,
        finalPref,
        logs
    );
    checks.push({
        step: `5. ${providerMeta.shortName}双线分流解析`,
        status: 'pass',
        detail: `默认线路 -> ${fallbackOrigin} · 境内优选线路 -> ${finalPref}`
    });

    let probeDetail = '';
    let probeStatus = 'pass';
    try {
        if (targetType === 'pages') {
            const start = Date.now();
            const targetCheckUrl = `https://${(projectDomain || `${projectName}.pages.dev`)}`;
            const probeRes = await fetch(targetCheckUrl, {
                method: 'GET',
                headers: { 'User-Agent': 'SaaS-SelfCheck-Probe/4.0' },
                redirect: 'manual'
            });
            const cost = Date.now() - start;
            probeDetail = `源站 ${targetCheckUrl} 响应正常 (HTTP ${probeRes.status} · ${cost}ms)`;
            logs.push(`[自检 6/6] ${probeDetail}`);
        } else {
            const scriptsRes = await cfRequest(cfEmail, cfKey, 'GET', `/accounts/${accountId}/workers/scripts`);
            const exists = (scriptsRes.result || []).some((w) => w.id === projectName);
            if (!exists) throw new Error(`Worker 脚本 ${projectName} 不存在`);
            probeDetail = `Worker 脚本 [${projectName}] 在线且 Service Binding 内部直连已就绪`;
            logs.push(`[自检 6/6] ${probeDetail}`);
        }
    } catch (e) {
        probeStatus = 'warn';
        probeDetail = `源站探测提示: ${e.message}`;
        logs.push(`[自检 6/6] ${probeDetail}`);
    }
    checks.push({
        step: '6. 源站回源连通性探测',
        status: probeStatus,
        detail: probeDetail
    });

    const inspection = await inspectZoneAcceleration(provider, cfEmail, cfKey, dnsAk, dnsSk, cfZoneId, cfZoneName, dnsZoneId, targetDomain, accountId).catch(() => null);

    return {
        customHostname,
        customHostnameId: chObj.id,
        cfZoneId,
        status: chObj.status,
        sslStatus: chObj.ssl?.status || 'pending_validation',
        checks,
        inspection,
        logs
    };
}

async function handleCheckStatus(env, body) {
    const ctx = await resolveRuntimeContext(env, body);
    const { cfEmail, cfKey } = ctx;
    const { cfZoneId, customHostnameId } = body;
    if (!cfZoneId || !customHostnameId) throw new Error('缺少检查参数');
    const res = await cfRequest(cfEmail, cfKey, 'GET', `/zones/${cfZoneId}/custom_hostnames/${customHostnameId}`);
    const ch = res.result || {};
    const errors = [
        ...(ch.verification_errors || []),
        ...(ch.ssl?.validation_errors || []).map((e) => e.message || JSON.stringify(e))
    ].filter(Boolean);
    return {
        hostname: ch.hostname,
        status: ch.status,
        sslStatus: ch.ssl?.status || 'pending',
        errors
    };
}

function formatCarrierDelay(rawDelay) {
    const str = String(rawDelay || '').trim();
    if (!str) return '-- ms';
    const numMatch = str.match(/(\d+(?:\.\d+)?)/);
    return numMatch ? `${numMatch[1]} ms` : str;
}

async function handleProbeUrl(body) {
    const rawTarget = String(body?.target || body?.hostname || '')
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .split('/')[0];
    if (!rawTarget) throw new Error('缺少测速目标节点');
    const targetWithPort = rawTarget.includes(':') ? rawTarget : `${rawTarget}:443`;
    const apiUrl = `https://776771.xyz/ip=${targetWithPort}`;
    const res = await fetch(apiUrl, {
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
            'Accept': 'application/json,text/plain,*/*'
        }
    });
    if (!res.ok) {
        throw new Error(`测速接口返回 HTTP ${res.status}`);
    }
    const data = await res.json().catch(() => null);
    const carriers = data?.['运营商分项遥测'] || {};
    const ct = formatCarrierDelay(carriers['中国电信']?.['平均延迟']);
    const cu = formatCarrierDelay(carriers['中国联通']?.['平均延迟']);
    const cm = formatCarrierDelay(carriers['中国移动']?.['平均延迟']);
    return {
        target: targetWithPort,
        region: data?.['地区归属'] || '',
        ct,
        cu,
        cm
    };
}

function renderAppHtml(bootState) {
    const safeBootJson = JSON.stringify(bootState).replace(/</g, '\\u003c');
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Cloudflare SaaS 智能优选</title>
<style>
  :root {
    --bg: #080C15;
    --glass-bg: linear-gradient(145deg, rgba(24, 34, 54, 0.72), rgba(13, 19, 32, 0.62));
    --glass-soft: rgba(15, 23, 42, 0.56);
    --glass-strong: linear-gradient(155deg, rgba(28, 40, 64, 0.88), rgba(14, 21, 36, 0.84));
    --glass-border: rgba(255, 255, 255, 0.13);
    --glass-border-accent: rgba(56, 136, 255, 0.48);
    --glass-shadow: 0 14px 36px rgba(0, 0, 0, 0.48), inset 0 1px 0 rgba(255, 255, 255, 0.12), inset 0 -1px 0 rgba(0, 0, 0, 0.32);
    --neu-inset: inset 2px 2px 6px rgba(0, 0, 0, 0.58), inset -1px -1px 4px rgba(255, 255, 255, 0.06);
    --text: #E2E8F0;
    --text-bright: #F8FAFC;
    --text-muted: #94A3B8;
    --accent: #3888FF;
    --accent-cyan: #38BDF8;
    --accent-soft: rgba(56, 136, 255, 0.18);
    --warn: #E69539;
    --warn-soft: rgba(230, 149, 57, 0.16);
    --ok: #10B981;
    --ok-soft: rgba(16, 185, 129, 0.16);
    --danger: #F43F5E;
    --danger-soft: rgba(244, 63, 94, 0.16);
    --radius: 12px;
    --radius-sm: 8px;
    --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    --font-sans: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Segoe UI", Roboto, sans-serif;
  }
  * {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
    -webkit-tap-highlight-color: transparent;
  }
  html, body {
    width: 100%;
    max-width: 100%;
    min-height: 100vh;
    background-color: var(--bg);
    background-image:
      radial-gradient(circle at 12% 8%, rgba(56, 136, 255, 0.22), transparent 42%),
      radial-gradient(circle at 88% 14%, rgba(56, 189, 248, 0.16), transparent 38%),
      radial-gradient(circle at 50% 92%, rgba(99, 102, 241, 0.14), transparent 45%),
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='56' height='98' viewBox='0 0 56 98'%3E%3Cg fill='none' stroke='%233888FF' stroke-opacity='0.05' stroke-width='1'%3E%3Cpath d='M28 66L0 50L0 16L28 0L56 16L56 50L28 66L28 100'/%3E%3Cpath d='M28 0L28 34L0 50L0 84L28 100L56 84L56 50L28 34'/%3E%3C/g%3E%3C/svg%3E");
    background-attachment: fixed;
    color: var(--text);
    font-family: var(--font-sans);
    font-size: 14px;
    line-height: 1.55;
    overflow-x: hidden;
  }
  .hidden { display: none !important; }
  .mono {
    font-family: var(--font-mono);
    white-space: normal;
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  .wrap-text {
    white-space: normal;
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  .toast-wrap {
    position: fixed;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 9999;
    display: flex;
    flex-direction: column;
    gap: 8px;
    pointer-events: none;
    width: max-content;
    max-width: 94vw;
  }
  .toast {
    padding: 10px 18px;
    border-radius: var(--radius-sm);
    font-size: 13px;
    font-weight: 600;
    background: rgba(15, 23, 42, 0.88);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
    border: 1px solid var(--glass-border-accent);
    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.6);
    color: var(--text-bright);
    white-space: normal;
    word-break: break-word;
  }
  .toast.ok { border-color: rgba(16, 185, 129, 0.6); color: #34D399; }
  .toast.err { border-color: rgba(230, 149, 57, 0.7); color: var(--warn); }
  .btn-flow {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    width: 100%;
    align-items: stretch;
  }
  .btn-flow > .btn,
  .btn-flow > a.btn,
  .btn-flow > button {
    flex: 1 1 auto;
    min-width: max-content;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 38px;
    padding: 0 14px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--glass-border);
    background: linear-gradient(145deg, rgba(34, 48, 74, 0.72), rgba(20, 29, 48, 0.65));
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.12);
    color: var(--text-bright);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    text-decoration: none;
    white-space: nowrap;
    transition: background-color 0.16s ease, border-color 0.16s ease, transform 0.14s ease;
  }
  .btn:hover:not(:disabled) {
    background: linear-gradient(145deg, rgba(56, 136, 255, 0.28), rgba(30, 52, 88, 0.78));
    border-color: var(--accent);
    color: #FFFFFF;
  }
  .btn:active:not(:disabled) { transform: scale(0.985); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-sm { min-height: 34px; padding: 0 12px; font-size: 12.5px; }
  .btn-xs { min-height: 28px; padding: 0 10px; font-size: 12px; }
  .btn-primary {
    background: linear-gradient(135deg, #3888FF, #2563EB);
    border-color: rgba(147, 197, 253, 0.45);
    color: #FFFFFF;
    min-height: 42px;
    font-size: 13.5px;
    box-shadow: 0 8px 22px rgba(56, 136, 255, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.28);
  }
  .btn-primary:hover:not(:disabled) {
    background: linear-gradient(135deg, #4B96FF, #3B82F6);
    border-color: #93C5FD;
  }
  .btn-ok {
    background: linear-gradient(145deg, rgba(16, 185, 129, 0.26), rgba(6, 95, 70, 0.34));
    border-color: rgba(52, 211, 153, 0.45);
    color: #6EE7B7;
  }
  .btn-ok:hover:not(:disabled) {
    background: linear-gradient(145deg, rgba(16, 185, 129, 0.42), rgba(6, 95, 70, 0.5));
    border-color: #34D399;
    color: #FFFFFF;
  }
  .btn-warn {
    background: linear-gradient(145deg, rgba(230, 149, 57, 0.24), rgba(146, 64, 14, 0.3));
    border-color: rgba(230, 149, 57, 0.5);
    color: #FCD34D;
  }
  .btn-warn:hover:not(:disabled) {
    background: linear-gradient(145deg, rgba(230, 149, 57, 0.38), rgba(146, 64, 14, 0.46));
    border-color: var(--warn);
    color: #FFFFFF;
  }
  .btn-danger {
    background: linear-gradient(145deg, rgba(244, 63, 94, 0.22), rgba(136, 19, 55, 0.3));
    border-color: rgba(244, 63, 94, 0.45);
    color: #FDA4AF;
  }
  .btn-danger:hover:not(:disabled) {
    background: linear-gradient(145deg, rgba(244, 63, 94, 0.38), rgba(136, 19, 55, 0.48));
    border-color: var(--danger);
    color: #FFFFFF;
  }
  .btn-tab-active {
    background: linear-gradient(135deg, #3888FF, #2563EB);
    border-color: rgba(147, 197, 253, 0.5);
    color: #FFFFFF;
    box-shadow: 0 4px 14px rgba(56, 136, 255, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.25);
  }
  .modal-mask {
    position: fixed;
    inset: 0;
    z-index: 9000;
    background: rgba(5, 8, 15, 0.76);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 14px;
  }
  .modal-card {
    width: 100%;
    max-width: 560px;
    background: var(--glass-strong);
    backdrop-filter: blur(24px) saturate(160%);
    -webkit-backdrop-filter: blur(24px) saturate(160%);
    border: 1px solid var(--glass-border-accent);
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.72), inset 0 1px 0 rgba(255, 255, 255, 0.16);
    border-radius: 14px;
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 10px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--glass-border);
  }
  .modal-title {
    font-size: 15px;
    font-weight: 700;
    color: var(--text-bright);
    white-space: normal;
    word-break: break-word;
  }
  .opt-rank-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 54vh;
    overflow-y: auto;
  }
  .region-block {
    background: rgba(8, 12, 22, 0.56);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius-sm);
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .region-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 6px;
    padding-bottom: 6px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  .region-title {
    font-family: var(--font-mono);
    font-size: 12.5px;
    font-weight: 700;
    color: var(--accent-cyan);
  }
  .opt-rank-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
    padding: 9px 11px;
    border-radius: var(--radius-sm);
    background: rgba(22, 32, 52, 0.65);
    border: 1px solid rgba(255, 255, 255, 0.08);
    cursor: pointer;
    transition: border-color 0.15s, background-color 0.15s;
  }
  .opt-rank-row:hover, .opt-rank-row.selected {
    background: rgba(56, 136, 255, 0.22);
    border-color: var(--accent);
  }
  .opt-rank-left {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1 1 200px;
    min-width: 0;
  }
  .opt-rank-num {
    padding: 2px 7px;
    border-radius: 5px;
    background: rgba(56, 136, 255, 0.2);
    color: #93C5FD;
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 700;
    flex-shrink: 0;
  }
  .opt-rank-host {
    font-family: var(--font-mono);
    font-size: 13px;
    font-weight: 600;
    color: var(--text-bright);
    white-space: normal;
    word-break: break-all;
  }
  .opt-rank-score {
    padding: 2px 8px;
    border-radius: 5px;
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 700;
    background: var(--ok-soft);
    border: 1px solid rgba(52, 211, 153, 0.35);
    color: #6EE7B7;
    white-space: nowrap;
  }
  .center-stage {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px 14px;
  }
  .stage-card {
    width: 100%;
    max-width: 780px;
    background: var(--glass-bg);
    backdrop-filter: blur(22px) saturate(150%);
    -webkit-backdrop-filter: blur(22px) saturate(150%);
    border: 1px solid var(--glass-border);
    box-shadow: var(--glass-shadow);
    border-radius: 14px;
    padding: 24px 20px;
  }
  .stage-card.narrow { max-width: 400px; }
  .step-indicator {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 16px;
  }
  .step-tag {
    padding: 4px 10px;
    border-radius: 6px;
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 600;
    background: rgba(8, 12, 22, 0.6);
    border: 1px solid var(--glass-border);
    color: var(--text-muted);
    white-space: nowrap;
  }
  .step-tag.current {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: #93C5FD;
  }
  .stage-title {
    font-size: 20px;
    font-weight: 700;
    color: var(--text-bright);
    margin-bottom: 8px;
    white-space: normal;
    word-break: break-word;
  }
  .stage-sub {
    font-size: 13.5px;
    color: var(--text-muted);
    margin-bottom: 18px;
    line-height: 1.65;
    white-space: normal;
    word-break: break-word;
  }
  .d1-step-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-bottom: 18px;
  }
  .d1-step {
    background: rgba(8, 12, 22, 0.56);
    border: 1px solid var(--glass-border);
    border-left: 3px solid var(--accent);
    border-radius: var(--radius-sm);
    padding: 13px 15px;
    font-size: 13px;
    color: var(--text);
    line-height: 1.65;
    white-space: normal;
    word-break: break-word;
  }
  .d1-step b { color: var(--accent-cyan); }
  .env-alert {
    padding: 13px 15px;
    border-radius: var(--radius-sm);
    margin-bottom: 16px;
    font-size: 13px;
    line-height: 1.65;
    white-space: normal;
    word-break: break-word;
  }
  .env-alert.pages {
    background: var(--warn-soft);
    border: 1px solid rgba(230, 149, 57, 0.45);
    color: #FCD34D;
  }
  .env-alert.worker {
    background: var(--ok-soft);
    border: 1px solid rgba(16, 185, 129, 0.42);
    color: #6EE7B7;
  }
  .code-chip {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 5px;
    background: var(--accent-soft);
    border: 1px solid rgba(56, 136, 255, 0.35);
    color: #93C5FD;
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 600;
  }
  .grid-2 {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
  }
  @media (max-width: 680px) {
    .grid-2 { grid-template-columns: 1fr; }
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .field-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
  }
  .field label {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-muted);
    white-space: normal;
    word-break: break-word;
  }
  input, select {
    width: 100%;
    min-height: 40px;
    padding: 8px 12px;
    background: rgba(7, 11, 20, 0.78);
    border: 1px solid var(--glass-border);
    box-shadow: var(--neu-inset);
    border-radius: var(--radius-sm);
    color: var(--text-bright);
    font-family: var(--font-mono);
    font-size: 13px;
    outline: none;
    transition: border-color 0.16s, box-shadow 0.16s;
  }
  input:focus, select:focus {
    border-color: var(--accent);
    box-shadow: var(--neu-inset), 0 0 0 2px rgba(56, 136, 255, 0.25);
  }
  .switch-box {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    background: rgba(7, 11, 20, 0.72);
    border: 1px solid var(--glass-border);
    box-shadow: var(--neu-inset);
    border-radius: var(--radius-sm);
    padding: 4px;
  }
  .switch-btn {
    flex: 1 1 auto;
    min-height: 32px;
    padding: 0 12px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-muted);
    font-size: 13px;
    font-weight: 600;
    border-radius: 6px;
    cursor: pointer;
    white-space: nowrap;
  }
  .switch-btn.active {
    background: linear-gradient(135deg, #3888FF, #2563EB);
    color: #FFFFFF;
    box-shadow: 0 3px 10px rgba(56, 136, 255, 0.35);
  }
  .input-flow {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    width: 100%;
  }
  .input-flow input {
    flex: 1 1 210px;
    min-width: 0;
  }
  .input-flow .btn {
    flex: 0 1 auto;
  }
  @media (max-width: 520px) {
    .input-flow .btn { flex: 1 1 100%; }
  }
  .console-shell {
    width: 100%;
    max-width: 1480px;
    margin: 0 auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .topbar {
    position: relative;
    z-index: 400;
    background: var(--glass-bg);
    backdrop-filter: blur(22px) saturate(160%);
    -webkit-backdrop-filter: blur(22px) saturate(160%);
    border: 1px solid var(--glass-border);
    box-shadow: var(--glass-shadow);
    border-radius: var(--radius);
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .topbar-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 10px;
  }
  .brand-block {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    flex: 1 1 auto;
  }
  .brand-mark {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    background: linear-gradient(135deg, rgba(56, 136, 255, 0.3), rgba(56, 189, 248, 0.16));
    border: 1px solid rgba(147, 197, 253, 0.45);
    color: #93C5FD;
    font-family: var(--font-mono);
    font-weight: 800;
    font-size: 15px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    box-shadow: 0 4px 14px rgba(56, 136, 255, 0.28);
  }
  .topbar-title {
    font-size: 16px;
    font-weight: 700;
    color: var(--text-bright);
    white-space: normal;
    word-break: break-word;
  }
  .topbar-right-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    position: relative;
  }
  .menu-trigger-btn {
    min-height: 34px;
    padding: 0 14px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--glass-border-accent);
    background: linear-gradient(135deg, rgba(56, 136, 255, 0.24), rgba(30, 58, 138, 0.34));
    color: var(--text-bright);
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
    box-shadow: 0 4px 14px rgba(56, 136, 255, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.18);
  }
  .menu-trigger-btn:hover {
    border-color: var(--accent-cyan);
    background: linear-gradient(135deg, rgba(56, 136, 255, 0.38), rgba(30, 58, 138, 0.48));
  }
  .top-menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 450;
    background: rgba(4, 8, 16, 0.45);
    backdrop-filter: blur(4px);
  }
  .top-menu-drawer {
    position: fixed;
    top: 66px;
    right: 14px;
    z-index: 500;
    width: min(310px, calc(100vw - 28px));
    max-height: calc(100vh - 84px);
    overflow-y: auto;
    background: var(--glass-strong);
    backdrop-filter: blur(26px) saturate(170%);
    -webkit-backdrop-filter: blur(26px) saturate(170%);
    border: 1px solid var(--glass-border-accent);
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.72), inset 0 1px 0 rgba(255, 255, 255, 0.16);
    border-radius: 14px;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .menu-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .menu-group-title {
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 700;
    color: var(--accent-cyan);
    letter-spacing: 0.04em;
    padding: 0 4px 4px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  .menu-item-btn {
    min-height: 38px;
    padding: 0 12px;
    border-radius: var(--radius-sm);
    border: 1px solid rgba(255, 255, 255, 0.07);
    background: rgba(15, 23, 42, 0.56);
    color: var(--text);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    text-align: left;
    transition: all 0.15s ease;
  }
  .menu-item-btn:hover {
    background: rgba(56, 136, 255, 0.22);
    border-color: var(--accent);
    color: #FFFFFF;
  }
  .menu-item-btn.active {
    background: linear-gradient(135deg, rgba(56, 136, 255, 0.34), rgba(37, 99, 235, 0.26));
    border-color: var(--accent);
    color: #FFFFFF;
  }
  .provider-action-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    width: 100%;
    padding-top: 8px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }
  .provider-action-bar > button {
    flex: 1 1 auto;
    min-width: max-content;
    min-height: 36px;
    padding: 0 12px;
    border-radius: var(--radius-sm);
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    transition: all 0.15s ease;
  }
  .prov-chip {
    background: rgba(8, 12, 22, 0.62);
    border: 1px solid var(--glass-border);
    color: var(--text-muted);
  }
  .prov-chip:hover {
    border-color: var(--accent);
    color: var(--text-bright);
  }
  .prov-chip.active {
    background: var(--ok-soft);
    border-color: rgba(52, 211, 153, 0.5);
    color: #6EE7B7;
  }
  .prov-chip.add-btn {
    background: var(--accent-soft);
    border: 1px solid rgba(56, 136, 255, 0.45);
    color: #93C5FD;
  }
  .prov-chip.refresh-btn {
    background: rgba(30, 41, 59, 0.72);
    border: 1px solid var(--glass-border-accent);
    color: var(--text-bright);
  }
  .dashboard-grid {
    display: grid;
    grid-template-columns: repeat(12, minmax(0, 1fr));
    gap: 12px;
    align-items: start;
  }
  .col-center  { grid-column: span 8; display: flex; flex-direction: column; gap: 12px; }
  .col-right   { grid-column: span 4; display: flex; flex-direction: column; gap: 12px; }
  .col-logs    { grid-column: 1 / -1; }
  @media (max-width: 1080px) {
    .col-center  { grid-column: 1 / -1; }
    .col-right   { grid-column: 1 / -1; }
  }
  .panel {
    background: var(--glass-bg);
    backdrop-filter: blur(20px) saturate(150%);
    -webkit-backdrop-filter: blur(20px) saturate(150%);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius);
    padding: 16px;
    min-width: 0;
    box-shadow: var(--glass-shadow);
  }
  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
    padding-bottom: 10px;
    margin-bottom: 14px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  .panel-title {
    font-size: 14.5px;
    font-weight: 700;
    color: var(--text-bright);
    display: flex;
    align-items: center;
    gap: 8px;
    white-space: normal;
    word-break: break-word;
  }
  .badge-num {
    padding: 2px 8px;
    border-radius: 6px;
    background: var(--accent-soft);
    border: 1px solid rgba(56, 136, 255, 0.42);
    color: #93C5FD;
    font-family: var(--font-mono);
    font-size: 11.5px;
    font-weight: 700;
    flex-shrink: 0;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    padding: 3px 8px;
    border-radius: 6px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    font-weight: 600;
    background: rgba(8, 12, 22, 0.65);
    border: 1px solid var(--glass-border);
    color: var(--text-muted);
    white-space: normal;
    word-break: break-word;
  }
  .pill.ok { background: var(--ok-soft); border-color: rgba(52, 211, 153, 0.45); color: #6EE7B7; }
  .pill.warn { background: var(--warn-soft); border-color: rgba(230, 149, 57, 0.48); color: #FCD34D; }
  .pill.info { background: var(--accent-soft); border-color: rgba(56, 136, 255, 0.42); color: #93C5FD; }
  .quick-tabs-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    width: 100%;
  }
  .quick-tabs-strip .nav-btn {
    flex: 1 1 auto;
    min-width: max-content;
    justify-content: center;
  }
  .nav-btn {
    min-height: 36px;
    padding: 0 12px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--glass-border);
    background: rgba(12, 18, 32, 0.62);
    color: var(--text-muted);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
    transition: all 0.15s ease;
  }
  .nav-btn:hover {
    border-color: var(--accent);
    color: var(--text-bright);
  }
  .nav-btn.active {
    background: linear-gradient(135deg, rgba(56, 136, 255, 0.34), rgba(37, 99, 235, 0.22));
    border-color: var(--accent);
    color: #FFFFFF;
    box-shadow: 0 4px 14px rgba(56, 136, 255, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.16);
  }
  .topo-canvas {
    background: rgba(7, 11, 20, 0.65);
    border: 1px solid var(--glass-border);
    box-shadow: var(--neu-inset);
    border-radius: var(--radius-sm);
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .topo-flow {
    display: flex;
    align-items: stretch;
    justify-content: space-between;
    gap: 8px;
  }
  @media (max-width: 720px) {
    .topo-flow { flex-direction: column; }
  }
  .topo-node {
    flex: 1 1 0;
    min-width: 0;
    background: linear-gradient(145deg, rgba(25, 36, 58, 0.72), rgba(14, 21, 36, 0.68));
    border: 1px solid var(--glass-border);
    border-radius: var(--radius-sm);
    padding: 11px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.32), inset 0 1px 0 rgba(255, 255, 255, 0.1);
  }
  .topo-node-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 4px;
  }
  .topo-node-role {
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 700;
    color: var(--accent-cyan);
    text-transform: uppercase;
  }
  .topo-node-val {
    font-family: var(--font-mono);
    font-size: 12.5px;
    font-weight: 700;
    color: var(--text-bright);
    white-space: normal;
    word-break: break-all;
  }
  .topo-node-sub {
    font-size: 11.5px;
    color: var(--text-muted);
    white-space: normal;
    word-break: break-word;
  }
  .topo-link {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 4px 2px;
    flex-shrink: 0;
  }
  .topo-line-h {
    width: 34px;
    height: 1px;
    background: linear-gradient(90deg, rgba(56, 136, 255, 0.35), var(--accent-cyan), rgba(56, 136, 255, 0.35));
    position: relative;
  }
  .topo-line-h::after {
    content: "›";
    position: absolute;
    right: -2px;
    top: -10px;
    color: var(--accent-cyan);
    font-size: 14px;
    font-weight: 700;
  }
  .topo-link-tag {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-muted);
    white-space: nowrap;
  }
  @media (max-width: 720px) {
    .topo-link { flex-direction: row; padding: 2px 0; }
    .topo-line-h { width: 1px; height: 18px; background: var(--accent-cyan); }
    .topo-line-h::after { content: "⌄"; right: -4px; top: 4px; }
  }
  .detect-box {
    margin-top: 12px;
    padding: 13px 14px;
    border-radius: var(--radius-sm);
    background: rgba(8, 12, 22, 0.62);
    border: 1px solid var(--glass-border);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .detect-box.accelerated {
    border-color: rgba(52, 211, 153, 0.45);
    background: rgba(16, 185, 129, 0.08);
  }
  .detect-box.pending {
    border-color: rgba(230, 149, 57, 0.52);
    background: rgba(230, 149, 57, 0.08);
  }
  .detect-title {
    font-size: 13.5px;
    font-weight: 700;
    color: var(--text-bright);
    white-space: normal;
    word-break: break-word;
  }
  .detect-box.accelerated .detect-title { color: #6EE7B7; }
  .detect-box.pending .detect-title { color: #FCD34D; }
  .detect-lines {
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: 12.5px;
    color: var(--text);
    line-height: 1.55;
  }
  .detect-line-item {
    white-space: normal;
    word-break: break-all;
  }
  .detect-line-item code {
    font-family: var(--font-mono);
    color: #93C5FD;
    background: rgba(56, 136, 255, 0.14);
    padding: 1px 6px;
    border-radius: 4px;
  }
  .prefix-glow-wrap {
    margin-top: 12px;
    padding: 14px;
    border-radius: var(--radius-sm);
    background: linear-gradient(145deg, rgba(56, 136, 255, 0.12), rgba(15, 23, 42, 0.65));
    border: 1px solid rgba(56, 136, 255, 0.55);
    box-shadow: 0 0 20px rgba(56, 136, 255, 0.16), inset 0 1px 0 rgba(255, 255, 255, 0.12);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .prefix-glow-wrap.conflict-glow {
    border-color: var(--warn);
    background: rgba(230, 149, 57, 0.1);
    box-shadow: 0 0 18px rgba(230, 149, 57, 0.22);
  }
  .domain-compose {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    width: 100%;
  }
  .domain-compose input {
    flex: 1 1 150px;
    min-width: 0;
    font-weight: 700;
  }
  .domain-compose .dot {
    font-family: var(--font-mono);
    font-weight: 800;
    font-size: 16px;
    color: var(--accent-cyan);
    padding: 0 2px;
  }
  .domain-compose select {
    flex: 1 1 180px;
    min-width: 0;
    color: #93C5FD;
    font-weight: 700;
  }
  .replace-opt {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 9px 11px;
    border-radius: 6px;
    background: rgba(8, 12, 22, 0.65);
    border: 1px solid var(--glass-border);
    font-size: 12.5px;
    color: var(--text);
  }
  .replace-opt input[type="checkbox"] {
    width: 16px;
    height: 16px;
    min-height: 16px;
    margin-top: 2px;
    accent-color: var(--accent);
    flex-shrink: 0;
  }
  .preview-bar {
    margin-top: 12px;
    padding: 10px 13px;
    border-radius: var(--radius-sm);
    background: rgba(8, 12, 22, 0.68);
    border: 1px dashed var(--glass-border-accent);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .preview-bar span {
    font-size: 12px;
    color: var(--text-muted);
  }
  .preview-bar strong {
    font-family: var(--font-mono);
    font-size: 13.5px;
    color: #6EE7B7;
    white-space: normal;
    word-break: break-all;
  }
  .matrix-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .matrix-item {
    background: linear-gradient(145deg, rgba(20, 29, 48, 0.72), rgba(10, 15, 26, 0.72));
    border: 1px solid var(--glass-border);
    border-radius: var(--radius-sm);
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.1);
    transition: border-color 0.2s ease, box-shadow 0.2s ease;
  }
  .matrix-item.err-card { border-color: var(--warn); }
  .matrix-item.just-activated {
    border-color: #34D399;
    box-shadow: 0 0 24px rgba(16, 185, 129, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.2);
  }
  .matrix-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
  }
  .matrix-domain {
    font-family: var(--font-mono);
    font-size: 14px;
    font-weight: 700;
    color: #6EE7B7;
    white-space: normal;
    word-break: break-all;
  }
  .matrix-meta {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .matrix-meta b {
    font-family: var(--font-mono);
    color: var(--text-bright);
    font-weight: 600;
    word-break: break-all;
  }
  .quick-opt-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    width: 100%;
  }
  .quick-opt-row input,
  .quick-opt-row select {
    flex: 1 1 180px;
    min-height: 34px;
    font-size: 12.5px;
  }
  .quick-opt-row .btn {
    flex: 1 1 auto;
  }
  .carrier-probe-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 11px;
    border-radius: var(--radius-sm);
    background: rgba(56, 136, 255, 0.12);
    border: 1px solid rgba(56, 136, 255, 0.38);
    font-family: var(--font-mono);
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-bright);
  }
  .carrier-probe-row span {
    white-space: nowrap;
  }
  .check-report {
    margin-top: 12px;
    padding: 12px;
    border-radius: var(--radius-sm);
    background: rgba(8, 12, 22, 0.65);
    border: 1px solid rgba(16, 185, 129, 0.42);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .check-row {
    padding-bottom: 8px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    font-size: 12.5px;
  }
  .check-row:last-child { border-bottom: none; padding-bottom: 0; }
  .log-box {
    background: rgba(6, 10, 18, 0.8);
    border: 1px solid var(--glass-border);
    box-shadow: var(--neu-inset);
    border-radius: var(--radius-sm);
    padding: 12px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text);
    max-height: 240px;
    overflow-y: auto;
    line-height: 1.65;
  }
  .log-item {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 2px 0;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  .log-ok { color: #6EE7B7; font-weight: 700; flex-shrink: 0; }
  .log-err { color: var(--warn); font-weight: 700; flex-shrink: 0; }
  .doc-step {
    background: rgba(8, 12, 22, 0.56);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius-sm);
    padding: 14px;
    margin-bottom: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .doc-step h3 { font-size: 14px; font-weight: 700; color: var(--text-bright); }
  .doc-step p, .doc-step li {
    font-size: 13px;
    color: var(--text);
    line-height: 1.65;
    white-space: normal;
    word-break: break-word;
  }
  .doc-step ul { padding-left: 18px; display: flex; flex-direction: column; gap: 6px; }
  .doc-link { color: var(--accent-cyan); text-decoration: none; font-family: var(--font-mono); word-break: break-all; }
  .doc-link:hover { text-decoration: underline; }
</style>
</head>
<body>

<div class="toast-wrap" id="toastWrap"></div>

<div id="topMenuBackdrop" class="top-menu-backdrop hidden" onclick="toggleTopMenu(false)"></div>
<div id="topMenuDrawer" class="top-menu-drawer hidden">
  <div class="menu-group">
    <div class="menu-group-title">核心加速 · ACCELERATION</div>
    <button type="button" class="menu-item-btn active" data-menu="deploy-std" onclick="openMenuAction('deploy-std')">
      <span>🚀 项目 SaaS 加速</span>
      <span class="pill info">Pages / Worker</span>
    </button>
    <button type="button" class="menu-item-btn" data-menu="deploy-proxy" onclick="openMenuAction('deploy-proxy')">
      <span>🌐 网站全站反代加速</span>
      <span class="pill ok">优先 Pages</span>
    </button>
    <button type="button" class="menu-item-btn" data-menu="matrix" onclick="openMenuAction('matrix')">
      <span>💎 加速资产矩阵</span>
      <span class="pill" id="menuMatrixCount">0</span>
    </button>
  </div>
  <div class="menu-group">
    <div class="menu-group-title">节点与监控 · TELEMETRY</div>
    <button type="button" class="menu-item-btn" data-menu="nodes" onclick="openMenuAction('nodes')">
      <span>⚡ 优选节点榜单</span>
      <span class="pill">IP / 域名</span>
    </button>
    <button type="button" class="menu-item-btn" data-menu="logs" onclick="openMenuAction('logs')">
      <span>📜 实时审计日志</span>
      <span class="pill">LOG</span>
    </button>
  </div>
  <div class="menu-group">
    <div class="menu-group-title">系统管理 · SYSTEM</div>
    <button type="button" class="menu-item-btn" data-menu="settings" onclick="openMenuAction('settings')">
      <span>⚙️ 云厂商与系统设置</span>
      <span class="pill">D1</span>
    </button>
    <button type="button" class="menu-item-btn" data-menu="guide" onclick="openMenuAction('guide')">
      <span>📖 使用说明书</span>
      <span class="pill">DOC</span>
    </button>
    <button type="button" class="menu-item-btn" onclick="toggleTopMenu(false);logoutConsole()">
      <span style="color:#FDA4AF;">🔒 锁定退出控制台</span>
      <span class="pill warn">LOCK</span>
    </button>
  </div>
</div>

<div id="optModal" class="modal-mask hidden" onclick="if(event.target===this)closeOptModal()" onkeydown="if(event.key==='Escape')closeOptModal()">
  <div class="modal-card">
    <div class="modal-head">
      <div class="modal-title" id="optModalTitle">⚡ 优选节点选择 (默认优先香港 IP)</div>
      <div class="btn-flow" style="width:auto;">
        <button type="button" class="btn btn-sm" id="btnRefreshOptModal" onclick="loadOptModalList(true)">实时刷新</button>
        <button type="button" class="btn btn-danger btn-sm" onclick="closeOptModal()">关闭</button>
      </div>
    </div>

    <div class="input-flow">
      <input type="text" id="optModalCustomInput" placeholder="手动输入自定义优选 IP 或域名，如 1.2.3.4 或 cf.xxx.top" onkeydown="if(event.key==='Enter')applyCustomOptFromModal()" />
      <button type="button" class="btn btn-primary btn-sm" onclick="applyCustomOptFromModal()">使用自定义节点</button>
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
      <div class="topbar-right-actions">
        <span class="pill ok">D1: CFWUYA</span>
        <span class="pill info" id="currentProviderBadge">华为云 DNS</span>
        <button type="button" class="menu-trigger-btn" id="btnTopMenu" onclick="toggleTopMenu()">☰ 菜单</button>
      </div>
    </div>

    <div class="provider-action-bar" id="activeProviderBar"></div>

    <div class="quick-tabs-strip" id="quickNavTabs">
      <button type="button" class="nav-btn active" data-view="deploy" onclick="switchWorkspaceView('deploy')">🚀 部署与反代</button>
      <button type="button" class="nav-btn" data-view="matrix" onclick="switchWorkspaceView('matrix')">💎 加速矩阵</button>
      <button type="button" class="nav-btn" data-view="nodes" onclick="switchWorkspaceView('nodes')">⚡ 优选节点</button>
      <button type="button" class="nav-btn" data-view="settings" onclick="switchWorkspaceView('settings')">⚙️ 系统设置</button>
      <button type="button" class="nav-btn" data-view="guide" onclick="switchWorkspaceView('guide')">📖 使用说明</button>
    </div>
  </header>

  <div class="dashboard-grid">

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
          <div class="panel-title"><span class="badge-num">01</span> 部署与全站反代 SaaS 优选加速</div>
          <span class="pill" id="deployStepHint">支持自定义优选</span>
        </div>

        <div class="grid-2">
          <div class="field" style="grid-column: 1 / -1;">
            <label>加速源站模式</label>
            <div class="switch-box">
              <button type="button" class="switch-btn active" id="swPages" onclick="switchTargetType('pages')">Pages 项目</button>
              <button type="button" class="switch-btn" id="swWorkers" onclick="switchTargetType('workers')">Workers 脚本</button>
              <button type="button" class="switch-btn" id="swProxy" onclick="switchTargetType('proxy')">🌐 全站反代任意网站</button>
            </div>
          </div>

          <div class="field" id="projectSelectField">
            <label id="projectLabel">选择 Pages 项目</label>
            <select id="projectSelect" onchange="onProjectChange()">
              <option value="">等待同步项目...</option>
            </select>
          </div>

          <div class="field hidden" id="proxySiteField">
            <label>目标反代网站域名 (支持全站浏览与登录) *</label>
            <input type="text" id="proxyTargetSite" placeholder="例如: baidu.com 或 github.com" oninput="onProxyInputChange()" />
          </div>

          <div class="field hidden" id="proxyNameField">
            <label>反代项目名称 (可选，优先创建同名 Pages，留空自动生成)</label>
            <input type="text" id="proxyPagesName" placeholder="例如: proxy-baidu (仅小写字母与短横线)" oninput="onProxyInputChange()" />
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

          <div class="field" style="grid-column: 1 / -1;">
            <label>国内优选 IP 或优选域名 (支持手动自由输入或自动获取)</label>
            <div class="input-flow">
              <input type="text" id="preferredTarget" placeholder="可手动输入任意优选 IP / 域名，留空自动使用香港第 1 个 IP" oninput="updateTopologyCanvas()" />
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
          <div class="panel-title"><span class="badge-num">DOC</span> 多云 SaaS 部署与全站反代说明书</div>
        </div>

        <div class="doc-step">
          <h3>一、全站反代 + SaaS 一键加速说明</h3>
          <ul>
            <li>在「部署与反代」中切换至 <b>🌐 全站反代任意网站</b>，填写目标网站域名（如 <span class="code-chip">baidu.com</span>），系统优先以文件夹方式（含 <span class="code-chip">index.html</span> 与 <span class="code-chip">_worker.js</span>）部署至 Pages（无每日 10 万次请求限制），若 Pages 不可用则自动回退部署至独立 Worker。</li>
            <li>反代引擎内置 Cookie 域重写、301/302 跳转接管、子域名路径映射、SRI 校验剥离及前端 Fetch/XHR 劫持，支持全站页面浏览与账号登录。</li>
            <li>在「加速矩阵」中点击「彻底卸载」时，若该域名关联的是「全站反代」创建的 Pages 或 Worker，系统会自动连同该反代项目一并删除清理；您原有的普通 Pages 和 Worker 项目绝不会被误删。</li>
          </ul>
        </div>

        <div class="doc-step">
          <h3>二、CFWUYA D1 数据库绑定规范</h3>
          <ul>
            <li>在 Cloudflare 控制台创建一个 D1 数据库，并在项目的 <b>设置 → 绑定 (Bindings)</b> 中添加 D1 绑定，<b>变量名必须严格大写为</b> <span class="code-chip">CFWUYA</span>。</li>
            <li><b>Cloudflare Pages 部署特别注意</b>：绑定 <span class="code-chip">CFWUYA</span> 后，必须前往 <b>Deployments（部署）</b> 页面点击最新记录右侧的 <b>Retry deployment（重新部署）</b>。</li>
          </ul>
        </div>

        <div class="doc-step">
          <h3>三、Cloudflare 与三大云解析 API 获取地址</h3>
          <ul>
            <li><b>Cloudflare 令牌管理</b>：<a class="doc-link" href="https://dash.cloudflare.com/profile/api-tokens" target="_blank">https://dash.cloudflare.com/profile/api-tokens</a></li>
            <li><b>华为云 DNS</b>：<a class="doc-link" href="https://console.huaweicloud.com/iam/#/mine/accessKey" target="_blank">https://console.huaweicloud.com/iam/#/mine/accessKey</a></li>
            <li><b>腾讯云 DNSPod</b>：<a class="doc-link" href="https://console.cloud.tencent.com/cam/capi" target="_blank">https://console.cloud.tencent.com/cam/capi</a></li>
            <li><b>阿里云 DNS</b>：<a class="doc-link" href="https://ram.console.aliyun.com/manage/ak" target="_blank">https://ram.console.aliyun.com/manage/ak</a></li>
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
          <div style="font-size:13px; font-weight:700; color:#6EE7B7;">全链路自检与修复诊断报告</div>
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
        <div class="log-item"><span class="log-ok">[就绪]</span><span>多云 SaaS 优选与全站反代控制台已启动，优先 Pages 文件夹上传部署...</span></div>
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
    justActivatedHost: '',
    lastCfZoneId: '',
    lastCustomHostnameId: '',
    pollTimer: null,
    busy: false,
    pendingAction: null
  };

  function cleanHostInput(raw) {
    var s = String(raw || '').trim().toLowerCase();
    var idx = s.indexOf('://');
    if (idx !== -1) s = s.slice(idx + 3);
    s = s.split('/')[0].split(':')[0];
    var parts = s.split('.').filter(Boolean);
    return parts.join('.');
  }

  function sanitizeProxyProjectClient(rawName, fallbackDomain) {
    var base = String(rawName || '').trim().toLowerCase();
    if (!base) {
      var clean = cleanHostInput(fallbackDomain);
      base = clean ? ('proxy-' + clean.split('.').join('-')) : '';
    }
    var out = '';
    for (var i = 0; i < base.length; i++) {
      var ch = base.charAt(i);
      if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '-') out += ch;
      else out += '-';
    }
    while (out.indexOf('--') !== -1) out = out.replace('--', '-');
    while (out.charAt(0) === '-') out = out.slice(1);
    while (out.charAt(out.length - 1) === '-') out = out.slice(0, -1);
    if (out && out.indexOf('proxy-') !== 0) out = 'proxy-' + out;
    if (out.length > 52) out = out.slice(0, 52);
    return out;
  }

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

  function toggleTopMenu(forceOpen) {
    var drawer = document.getElementById('topMenuDrawer');
    var bd = document.getElementById('topMenuBackdrop');
    if (!drawer || !bd) return;
    var shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : drawer.classList.contains('hidden');
    if (shouldOpen) {
      drawer.classList.remove('hidden');
      bd.classList.remove('hidden');
    } else {
      drawer.classList.add('hidden');
      bd.classList.add('hidden');
    }
  }

  function syncMenuHighlight(viewId) {
    var activeKey = viewId;
    if (viewId === 'deploy') {
      activeKey = state.targetType === 'proxy' ? 'deploy-proxy' : 'deploy-std';
    }
    var items = document.querySelectorAll('#topMenuDrawer .menu-item-btn');
    for (var i = 0; i < items.length; i++) {
      var key = items[i].getAttribute('data-menu');
      if (key) items[i].classList.toggle('active', key === activeKey);
    }
  }

  function openMenuAction(action) {
    toggleTopMenu(false);
    if (action === 'deploy-std') {
      switchWorkspaceView('deploy');
      if (state.targetType === 'proxy') switchTargetType('pages');
      syncMenuHighlight('deploy');
      return;
    }
    if (action === 'deploy-proxy') {
      switchWorkspaceView('deploy');
      switchTargetType('proxy');
      syncMenuHighlight('deploy');
      return;
    }
    if (action === 'logs') {
      scrollToLogs();
      return;
    }
    switchWorkspaceView(action);
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
    document.getElementById('optModalTitle').textContent = '⚡ 选择或输入优选节点';
    document.getElementById('optModalCustomInput').value = (document.getElementById('preferredTarget').value || '').trim();
    updateOptModalTabButtons();
    document.getElementById('optModal').classList.remove('hidden');
    loadOptModalList(false);
  }

  function openOptModalForMatrix(hostname, currentTarget) {
    state.optModalTargetHost = hostname;
    state.optModalTab = 'ip';
    document.getElementById('optModalTitle').textContent = '⚡ 切换 [' + hostname + '] 优选节点';
    document.getElementById('optModalCustomInput').value = currentTarget || '';
    updateOptModalTabButtons();
    document.getElementById('optModal').classList.remove('hidden');
    loadOptModalList(false);
  }

  function closeOptModal() {
    document.getElementById('optModal').classList.add('hidden');
  }

  function applyCustomOptFromModal() {
    var val = (document.getElementById('optModalCustomInput').value || '').trim();
    if (!val) {
      showToast('请先输入自定义优选 IP 或域名', 'err');
      return;
    }
    handleSelectOptCandidate(val);
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
    var navs = document.querySelectorAll('#quickNavTabs .nav-btn');
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
    syncMenuHighlight(viewId);
    if (viewId === 'settings') renderSettingsView();
    if (viewId === 'nodes') loadInlineOptNodes(false);
  }

  function jumpToActivatedMatrix(hostname) {
    state.justActivatedHost = String(hostname || '').trim().toLowerCase();
    switchWorkspaceView('matrix');
    renderMatrixList();
    setTimeout(function() {
      var targetCard = document.getElementById('activatedMatrixCard');
      if (targetCard) {
        targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        var matEl = document.getElementById('view-matrix');
        if (matEl) matEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 120);
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
          '<div class="detect-line-item" style="color:#6EE7B7; font-weight:700;">⚡ Pages 定时优选触发接口</div>' +
          '<div class="detect-line-item">外部监控或定时任务访问下方 API 即可自动将全部矩阵切换至香港首选 IP：</div>' +
          '<div class="detect-line-item"><code id="autoUpdateApiText">' + fullApiUrl + '</code></div>' +
        '</div>' +
        '<div class="btn-flow" style="margin-top:10px;">' +
          '<button type="button" class="btn btn-sm" data-copy-id="autoUpdateApiText" onclick="copyByDataId(this)">复制定时更新 API</button>' +
        '</div>';
    } else {
      box.innerHTML =
        '<div class="detect-lines">' +
          '<div class="detect-line-item" style="color:#6EE7B7; font-weight:700;">⚡ Workers Cron 自动巡检</div>' +
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
    var targetLabel = '未选择源站项目';

    if (state.targetType === 'proxy') {
      var cleanSite = cleanHostInput(document.getElementById('proxyTargetSite').value);
      targetLabel = cleanSite ? ('[全站反代] https://' + cleanSite) : '[全站反代] 等待输入目标网站';
    } else if (meta.projName) {
      targetLabel = '[' + (state.targetType === 'pages' ? 'Pages' : 'Worker') + '] ' + meta.projName;
    }

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

    if (state.targetType !== 'proxy' && state.currentProjectBoundHosts.length > 0) {
      var activeHost = state.currentProjectBoundHosts[0];
      var isReady = activeHost.status === 'active' && activeHost.sslStatus === 'active' && activeHost.dnsReady;
      domainTag.className = isReady ? 'pill ok' : 'pill warn';
      domainTag.textContent = isReady ? '已加速' : '签发中';
      originTag.className = 'pill ok';
      originTag.textContent = '中继已绑定';
      overallTag.className = isReady ? 'pill ok' : 'pill warn';
      overallTag.textContent = isReady ? '全链路已激活' : '证书验证中';
    } else if (state.targetType === 'proxy') {
      domainTag.className = 'pill info';
      domainTag.textContent = fullDomain ? '待部署加速' : '待选域名';
      originTag.className = 'pill ok';
      originTag.textContent = '优先 Pages';
      overallTag.className = 'pill info';
      overallTag.textContent = '全站反代模式';
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

  function onProxyInputChange() {
    var cleanSite = cleanHostInput(document.getElementById('proxyTargetSite').value);
    var prefixEl = document.getElementById('prefixInput');
    if (cleanSite && prefixEl && !prefixEl.value.trim()) {
      var firstLabel = cleanSite.split('.')[0];
      if (firstLabel && firstLabel !== 'www') {
        prefixEl.value = firstLabel;
      } else if (cleanSite.split('.').length >= 2) {
        prefixEl.value = cleanSite.split('.')[1];
      }
    }
    updatePreview();
    evaluateAccelerationStatus();
  }

  function getProjectAcceleratedHosts(type, projName, projDomain, insp) {
    if (!projName || !insp || type === 'proxy') return [];
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
    if (!fullDomain) return null;

    if (state.targetType === 'proxy') {
      var targetSite = cleanHostInput(document.getElementById('proxyTargetSite').value);
      var customName = document.getElementById('proxyPagesName').value.trim();
      var safeName = sanitizeProxyProjectClient(customName, targetSite);
      if (!safeName) return null;

      if (meta.insp && Array.isArray(meta.insp.acceleratedHosts)) {
        var matchedProxy = meta.insp.acceleratedHosts.find(function(h) { return h.hostname === fullDomain; });
        if (matchedProxy) {
          var curT = (matchedProxy.targetName || '').toLowerCase();
          if (curT !== safeName && curT !== (safeName + '.pages.dev')) {
            var lbl = (matchedProxy.targetType === 'worker' ? '[Worker] ' : '[Pages] ') + (matchedProxy.targetName || '存量节点');
            return { hostname: fullDomain, conflictOwner: lbl };
          }
        }
      }
      for (var k = 0; k < state.pagesProjects.length; k++) {
        var pp = state.pagesProjects[k];
        if (pp.name === safeName) continue;
        if (Array.isArray(pp.domains) && pp.domains.indexOf(fullDomain) !== -1) {
          return { hostname: fullDomain, conflictOwner: '[Pages] ' + pp.name };
        }
      }
      return null;
    }

    if (!meta.projName) return null;
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
    if (state.targetType === 'proxy') {
      state.currentProjectBoundHosts = [];
      if (state.defaultHkIp && !document.getElementById('preferredTarget').value.trim()) {
        document.getElementById('preferredTarget').value = state.defaultHkIp;
      }
      updatePreview();
      return;
    }

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
    document.getElementById('swProxy').className = type === 'proxy' ? 'switch-btn active' : 'switch-btn';

    var isProxy = type === 'proxy';
    document.getElementById('projectSelectField').classList.toggle('hidden', isProxy);
    document.getElementById('proxySiteField').classList.toggle('hidden', !isProxy);
    document.getElementById('proxyNameField').classList.toggle('hidden', !isProxy);
    document.getElementById('btnSelfCheck').classList.toggle('hidden', isProxy);

    if (!isProxy) {
      document.getElementById('projectLabel').textContent = type === 'pages' ? '选择 Pages 项目' : '选择 Workers 脚本';
      renderProjectOptions();
    }
    syncPrefixFromSelectedProject();
    evaluateAccelerationStatus();
    syncMenuHighlight('deploy');
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
    var insp = meta.insp;

    openEl.className = 'btn btn-ok btn-sm hidden';
    replaceBox.className = 'replace-opt hidden';
    glowWrap.className = 'prefix-glow-wrap';

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
      btnAct.textContent = state.targetType === 'proxy' ? ('覆盖部署全站反代并绑定 ' + conflict.hostname) : ('覆盖迁移并绑定 ' + conflict.hostname);
      updateTopologyCanvas();
      return;
    }

    if (state.targetType === 'proxy') {
      var targetSite = cleanHostInput(document.getElementById('proxyTargetSite').value);
      var customName = document.getElementById('proxyPagesName').value.trim();
      var autoName = sanitizeProxyProjectClient(customName, targetSite) || 'proxy-auto';
      var fbHost = meta.cfZoneName ? ('saas-origin.' + meta.cfZoneName) : '待选回源域';
      var prefNode = (document.getElementById('preferredTarget').value || '').trim() || state.defaultHkIp || '香港第 1 个优选 IP';

      box.className = 'detect-box accelerated';
      titleEl.textContent = targetSite
        ? ('🌐 就绪：全站反代 [' + targetSite + '] 并启用 SaaS 优选加速')
        : '🌐 全站反代模式：输入任意目标网站域名即可一键部署并加速';
      linesEl.innerHTML =
        '<div class="detect-line-item">优先 Pages 部署: <code>' + autoName + '.pages.dev</code> (无请求限制，失败自动回退 Worker) → <code>https://' + (targetSite || '目标网站') + '</code></div>' +
        '<div class="detect-line-item">回退源 / 优选目标: <code>' + fbHost + '</code> / <code>' + prefNode + '</code></div>' +
        '<div class="detect-line-item">卸载时自动识别并清理该全站反代项目，绝不误删其他正常项目</div>';
      btnAct.textContent = '一键部署全站反代并 SaaS 加速';
      updateTopologyCanvas();
      return;
    }

    var projName = meta.projName;
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
    if (state.targetType === 'proxy') {
      var targetSite = cleanHostInput(document.getElementById('proxyTargetSite').value);
      if (!targetSite || targetSite.indexOf('.') === -1) {
        showToast('请输入有效的目标网站域名，例如 baidu.com', 'err');
        return;
      }
    }
    var conflict = detectDomainConflict();
    if (conflict) {
      var rawPrefix = document.getElementById('prefixInput').value.trim();
      var prefixLabel = rawPrefix ? ('前缀「' + rawPrefix + '」(' + conflict.hostname + ')') : ('主域名「' + conflict.hostname + '」（未输入前缀）');
      document.getElementById('conflictModalBody').innerHTML = '当前 <b>' + prefixLabel + '</b> 已经绑定了 <b>' + conflict.conflictOwner + '</b> 项目，是否继续？';
      state.pendingAction = actionType;
      document.getElementById('btnConfirmConflict').onclick = function() {
        var act = state.pendingAction;
        closeConflictModal();
        if (state.targetType === 'proxy') deployProxySaas();
        else if (act === 'selfcheck') runSelfCheck();
        else activateSaas();
      };
      document.getElementById('conflictModal').classList.remove('hidden');
      return;
    }
    if (state.targetType === 'proxy') deployProxySaas();
    else if (actionType === 'selfcheck') runSelfCheck();
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
    var menuCount = document.getElementById('menuMatrixCount');
    var cf = getActiveCfZone();
    var dz = getActiveDnsZone();
    var insp = (cf.id && dz.id) ? state.inspectionByPair[getPairKey(cf.id, dz.id)] : null;
    var hosts = (insp && Array.isArray(insp.acceleratedHosts)) ? insp.acceleratedHosts : [];

    countEl.textContent = '共 ' + hosts.length + ' 个节点';
    if (rightBadge) rightBadge.textContent = hosts.length + ' 节点在线';
    if (menuCount) menuCount.textContent = String(hosts.length);
    listEl.innerHTML = '';

    if (!hosts.length) {
      var empty = document.createElement('div');
      empty.className = 'wrap-text';
      empty.style.cssText = 'text-align:center; padding:20px; font-size:13px; color:var(--text-muted);';
      empty.textContent = '当前云服务商与域名组合下暂无已激活的 SaaS 节点，请在「部署与反代」中配置。';
      listEl.appendChild(empty);
      return;
    }

    for (var i = 0; i < hosts.length; i++) {
      (function(h) {
        var isJust = state.justActivatedHost && h.hostname.toLowerCase() === state.justActivatedHost;
        var item = document.createElement('div');
        item.className = 'matrix-item' + (h.hasRoutingError ? ' err-card' : '') + (isJust ? ' just-activated' : '');
        if (isJust) item.id = 'activatedMatrixCard';

        var top = document.createElement('div');
        top.className = 'matrix-top';

        var domSpan = document.createElement('span');
        domSpan.className = 'matrix-domain';
        domSpan.textContent = 'https://' + h.hostname;

        var badges = document.createElement('div');
        badges.style.cssText = 'display:flex; flex-wrap:wrap; gap:6px;';

        if (isJust) {
          var bNew = document.createElement('span');
          bNew.className = 'pill ok';
          bNew.textContent = '刚刚激活';
          badges.appendChild(bNew);
        }

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
        optInput.value = h.preferredTarget || '';
        optInput.placeholder = '输入自定义优选 IP 或域名';
        optInput.onkeydown = function(ev) {
          if (ev.key === 'Enter') quickSwitchOpt(h.hostname, optInput.value.trim(), btnSaveOpt);
        };

        var btnSaveOpt = document.createElement('button');
        btnSaveOpt.type = 'button';
        btnSaveOpt.className = 'btn btn-ok btn-sm';
        btnSaveOpt.textContent = '保存切换';
        btnSaveOpt.onclick = function() { quickSwitchOpt(h.hostname, optInput.value.trim(), btnSaveOpt); };

        var btnPickOpt = document.createElement('button');
        btnPickOpt.type = 'button';
        btnPickOpt.className = 'btn btn-sm';
        btnPickOpt.textContent = '⚡ 选节点';
        btnPickOpt.onclick = function() { openOptModalForMatrix(h.hostname, optInput.value.trim()); };

        optRow.appendChild(optInput);
        optRow.appendChild(btnSaveOpt);
        optRow.appendChild(btnPickOpt);

        var carrierRow = document.createElement('div');
        carrierRow.className = 'carrier-probe-row hidden';

        var btns = document.createElement('div');
        btns.className = 'btn-flow';

        var btnProbe = document.createElement('button');
        btnProbe.type = 'button';
        btnProbe.className = 'btn btn-sm';
        btnProbe.textContent = '延迟测速';
        btnProbe.onclick = function() { probeHostname(optInput.value.trim() || h.preferredTarget || h.hostname, h.hostname, btnProbe, carrierRow); };

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
      proxyTargetSite: cleanHostInput(document.getElementById('proxyTargetSite').value),
      proxyPagesName: document.getElementById('proxyPagesName').value.trim(),
      cfZoneId: cf.id,
      cfZoneName: cf.name,
      dnsZoneId: dz.id,
      dnsZoneName: dz.name,
      prefix: document.getElementById('prefixInput').value.trim(),
      preferredTarget: prefVal,
      replaceOldHostname: replaceOld
    };
  }

  function deployProxySaas() {
    if (state.busy) return;
    state.busy = true;
    var btn = document.getElementById('btnActivate');
    var payload = collectFormPayload();

    btn.disabled = true;
    btn.textContent = '正在优先部署全站反代 Pages 并激活 SaaS...';
    addLog('开始部署全站反代并打通 SaaS 加速: ' + payload.proxyTargetSite);

    fetch('/api/deploy-proxy', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload)
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (!res.ok) throw new Error(res.error || '全站反代部署失败');
      var d = res.data;
      if (d.logs) for (var i = 0; i < d.logs.length; i++) addLog(d.logs[i]);
      if (Array.isArray(d.pagesProjects) && d.pagesProjects.length > 0) {
        state.pagesProjects = d.pagesProjects;
      }
      if (Array.isArray(d.workerScripts) && d.workerScripts.length > 0) {
        state.workerScripts = d.workerScripts;
      }
      state.lastCfZoneId = d.cfZoneId;
      state.lastCustomHostnameId = d.customHostnameId;
      if (d.inspection && d.cfZoneId && payload.dnsZoneId) {
        state.inspectionByPair[getPairKey(d.cfZoneId, payload.dnsZoneId)] = d.inspection;
      }
      document.getElementById('openLink').href = 'https://' + d.customHostname;
      updateStatusPills(d.status, d.sslStatus);
      showToast('全站反代部署并加速成功: https://' + d.customHostname, 'ok');
      if (d.sslStatus !== 'active') startCertPolling();
      jumpToActivatedMatrix(d.customHostname);
    })
    .catch(function(err) {
      addLog(err.message, true);
      showToast(err.message, 'err');
    })
    .finally(function() {
      state.busy = false;
      btn.disabled = false;
      evaluateAccelerationStatus();
    });
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
      }
      document.getElementById('openLink').href = 'https://' + d.customHostname;
      updateStatusPills(d.status, d.sslStatus);
      showToast('SaaS 加速激活成功: ' + d.customHostname, 'ok');
      if (d.sslStatus !== 'active') startCertPolling();
      jumpToActivatedMatrix(d.customHostname);
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
    if (!newOpt) { showToast('请输入或选择优选 IP / 优选域名', 'err'); return; }
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
      if (btn) { btn.disabled = false; btn.textContent = '保存切换'; }
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
    if (!confirm('确认彻底卸载 ' + hostname + ' 吗？（若为全站反代项目将同步清理）')) return;
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
      if (Array.isArray(d.pagesProjects)) state.pagesProjects = d.pagesProjects;
      if (Array.isArray(d.workerScripts)) state.workerScripts = d.workerScripts;
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
            if (path === '/api/deploy-proxy') {
                const data = await handleDeployProxySaas(env, body);
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
