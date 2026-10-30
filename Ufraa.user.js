// ==UserScript==
// @name         Ufraa
// @namespace    https://github.com/yuyna-amazon/Ufraa
// @version      4.3
// @description  Ufraa Assignment Plan: Route Duration乖離表示 + SSDラベル + CSV出力 / Service AreasからSSD時間帯を一括巡回してCSV出力
// @author       yuyna
// @icon         https://www.google.com/s2/favicons?sz=64&domain=amazon.com
// @match        https://viz-fe.ufraa.last-mile.amazon.dev/*
// @updateURL    https://raw.githubusercontent.com/yuyna-amazon/Ufraa/main/Ufraa.user.js
// @downloadURL  https://raw.githubusercontent.com/yuyna-amazon/Ufraa/main/Ufraa.user.js
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    if (window.top !== window.self) return;
    if (document.documentElement.dataset.ufraaV43Started === 'true') return;
    document.documentElement.dataset.ufraaV43Started = 'true';

    // ===========================================================
    // 1. 共通定義 / ページ判定
    // ===========================================================

    const CHECK_INTERVAL_MS = 5000;
    const TICK_INTERVAL_MS = 500;

    const CYCLE_SETTINGS_VERSION = 4;
    const LEGACY_SIX_CYCLE_DEFAULTS_UNDERSCORED_0600 = Object.freeze([
        Object.freeze({ name: 'SSD_1',   endTime: '06:00' }),
        Object.freeze({ name: 'SSD_1_B', endTime: '09:00' }),
        Object.freeze({ name: 'SSD_2',   endTime: '12:00' }),
        Object.freeze({ name: 'SSD_3',   endTime: '16:00' }),
        Object.freeze({ name: 'SSD_3_B', endTime: '19:00' }),
        Object.freeze({ name: 'SSD_4',   endTime: '22:00' })
    ]);
    const LEGACY_SIX_CYCLE_DEFAULTS_NON_UNDERSCORED_0600 = Object.freeze([
        Object.freeze({ name: 'SSD1',   endTime: '06:00' }),
        Object.freeze({ name: 'SSD1_B', endTime: '09:00' }),
        Object.freeze({ name: 'SSD2',   endTime: '12:00' }),
        Object.freeze({ name: 'SSD3',   endTime: '16:00' }),
        Object.freeze({ name: 'SSD3_B', endTime: '19:00' }),
        Object.freeze({ name: 'SSD4',   endTime: '22:00' })
    ]);
    const DEFAULT_CYCLE_SETTINGS = Object.freeze({
        version: CYCLE_SETTINGS_VERSION,
        selectedCycleCount: 6,
        configs: Object.freeze({
            '6': Object.freeze({
                cycles: Object.freeze([
                    Object.freeze({ name: 'SSD1',   endTime: '05:55' }),
                    Object.freeze({ name: 'SSD1_B', endTime: '08:55' }),
                    Object.freeze({ name: 'SSD2',   endTime: '11:55' }),
                    Object.freeze({ name: 'SSD3',   endTime: '15:55' }),
                    Object.freeze({ name: 'SSD3_B', endTime: '18:55' }),
                    Object.freeze({ name: 'SSD4',   endTime: '21:55' })
                ])
            }),
            '8': Object.freeze({
                cycles: Object.freeze([
                    Object.freeze({ name: 'SSDF_1', endTime: '05:35' }),
                    Object.freeze({ name: 'SSDF_2', endTime: '08:35' }),
                    Object.freeze({ name: 'SSDF_3', endTime: '11:35' }),
                    Object.freeze({ name: 'SSDF_4', endTime: '14:35' }),
                    Object.freeze({ name: 'SSDF_5', endTime: '17:35' }),
                    Object.freeze({ name: 'SSDF_6', endTime: '19:35' }),
                    Object.freeze({ name: 'SSDF_7', endTime: '21:20' }),
                    Object.freeze({ name: 'SSDF_8', endTime: '23:05' })
                ])
            })
        })
    });

    // Preferencesで表示ONにするカラム（これ以外はOFF）／CSVに出力するカラム
    const DESIRED_COLUMNS = [
        'Route Name Prefix',
        'Route Id Prefix',
        'Route Duration',
        'Route Package Count',
        'Dispatch Start',
        'Dispatch End',
        'Assignment Status',
        'Transporter Id',
        'Ready To Work',
        'Block Start',
        'Block End',
        'Block Length'
    ];

    const SSD_ROUTE_CSV_COLUMNS = [
        'Route Code',
        'Route ID',
        'Status',
        'Route Tags',
        'Packages',
        'Route Duration Without Inbound Stem',
        'Inbound Stem Duration',
        'Outbound Stem Duration',
        'Under The Roof Duration',
        'Route Promise Time',
        'Dispatch Window Start',
        'Dispatch Window End',
        'Matched Block'
    ];

    // Live画面のFilter入力欄に自動入力する文字列
    const FILTER_TEXT = 'Open,Waiting,Unknown';

    const BLOCK_START_SORT_SELECTOR = '[data-focus-id="sorting-control-driverShiftStart"]';
    const BLOCK_START_SORT_DEBOUNCE_MS = 300;
    const BLOCK_START_SORT_MAX_CLICKS = 3;
    const BLOCK_START_SORT_CONFIRM_MS = 600;
    const BLOCK_START_SORT_STABILIZE_MS = 2000;
    const BLOCK_START_SORT_MAX_RECOVERIES = 1;

    // artifact-metadata API
    const HOST = 'fulv8diza1.execute-api.us-west-2.amazonaws.com';
    const REGION = 'us-west-2';
    const SERVICE = 'execute-api';
    const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const INPUT_TYPE = 'FLEX_ROUTE_ASSIGNMENT_PLANNER_INPUT';
    const SSD_ROUTE_PLAN_TYPES = [
        'FLEX_SSD_ROUTE_PLAN',
        'SSD_ROUTE_PLAN',
        'FLEX_SSD_ROUTING_PLAN',
        'SSD_ROUTING_PLAN'
    ];

    // localStorageキー
    const LS_COLLECT = 'ufraaSsdCollected';
    const LS_SSD_ROUTE_COLLECT = 'ufraaSsdRouteCollected';
    const LS_QUEUE = 'ufraaSsdWorkerQueue';
    const LS_CYCLE_SETTINGS = 'ufraaCycleSettings_v1';

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const p2 = (n) => String(n).padStart(2, '0');

    /** /service-areas/<uuid> ページならservice area IDを返す */
    function serviceAreaId() {
        const m = /\/service-areas\/([0-9a-f-]{36})/i.exec(location.pathname);
        return m ? m[1] : null;
    }

    /** /assignment-plan/<artifactId> のartifactIdを返す（liveは除外） */
    function artifactIdFromPath() {
        const m = /^\/assignment-plan\/(.+)$/.exec(location.pathname);
        if (!m) return null;
        const id = decodeURIComponent(m[1]);
        return id === 'live' || id.startsWith('live/') ? null : id;
    }

    /** /ssd-route-page/<artifactId> のartifactIdを返す */
    function ssdRoutePlanIdFromPath() {
        const m = /^\/ssd-route-page\/(.+)$/.exec(location.pathname);
        return m ? decodeURIComponent(m[1]) : null;
    }

    /** Assignment Plan Live画面か */
    function isLivePage() {
        return /^\/assignment-plan\/live/.test(location.pathname);
    }

    // ===========================================================
    // 2. 認証フック
    //    document-start でアプリより先に fetch/XHR を包み、
    //    cognitoレスポンスの一時credsと x-midway-token を捕捉する
    // ===========================================================

    const AUTH = { creds: null, midway: null };

    function captureCreds(j) {
        if (j && j.Credentials && j.Credentials.AccessKeyId) AUTH.creds = j.Credentials;
    }

    const origFetch = window.fetch;
    window.fetch = function (input, init) {
        try {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            // ヘッダーからmidwayトークンを探す（Headers / 配列 / プレーンobject に対応）
            const h = (init && init.headers) || (typeof input === 'object' && input.headers);
            if (h) {
                let mid = null;
                if (h instanceof Headers) {
                    mid = h.get('x-midway-token');
                } else if (Array.isArray(h)) {
                    const found = h.find(([k]) => k.toLowerCase() === 'x-midway-token');
                    if (found) mid = found[1];
                } else if (typeof h === 'object') {
                    for (const k of Object.keys(h)) {
                        if (k.toLowerCase() === 'x-midway-token') { mid = h[k]; break; }
                    }
                }
                if (mid) { AUTH.midway = mid; console.log('[Ufraa] midway token captured via fetch'); }
            }
            const p = origFetch.apply(this, arguments);
            if (url.includes('cognito-identity')) {
                p.then((res) => {
                    res.clone().text().then((t) => {
                        try { captureCreds(JSON.parse(t)); console.log('[Ufraa] creds captured via fetch'); } catch (e) {}
                    }).catch(() => {});
                }).catch(() => {});
            }
            return p;
        } catch (e) {
            return origFetch.apply(this, arguments);
        }
    };

    const oOpen = XMLHttpRequest.prototype.open;
    const oSend = XMLHttpRequest.prototype.send;
    const oSet = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function (m, u) {
        this.__u = u;
        return oOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
        if (k && k.toLowerCase() === 'x-midway-token') {
            AUTH.midway = v;
            console.log('[Ufraa] midway token captured via XHR header');
        }
        return oSet.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
        this.addEventListener('load', () => {
            try {
                if (!this.__u) return;
                if (!String(this.__u).includes('cognito-identity')) return;
                const rt = this.responseType;
                let obj = null;
                if (rt === 'json') obj = this.response;
                else if (rt === '' || rt === 'text') obj = JSON.parse(this.responseText);
                else if (rt === 'arraybuffer' && this.response) obj = JSON.parse(new TextDecoder().decode(this.response));
                if (obj) { captureCreds(obj); console.log('[Ufraa] creds captured via XHR'); }
            } catch (e) {}
        });
        return oSend.apply(this, arguments);
    };

    // ===========================================================
    // 3. SigV4署名 / artifact-metadata API
    // ===========================================================

    const enc = new TextEncoder();
    const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

    async function sha256Hex(str) {
        return toHex(await crypto.subtle.digest('SHA-256', enc.encode(str)));
    }

    async function hmac(keyBuf, msg) {
        const key = await crypto.subtle.importKey('raw', keyBuf, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        return crypto.subtle.sign('HMAC', key, enc.encode(msg));
    }

    function awsEncode(str) {
        return encodeURIComponent(str).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    }

    function canonicalQuery(params) {
        return Object.keys(params).sort().map((k) => `${awsEncode(k)}=${awsEncode(params[k])}`).join('&');
    }

    async function signedGet(pathOnly, query) {
        if (!AUTH.creds || !AUTH.midway) throw new Error('認証情報が未取得です。ページを一度リロードしてください。');
        const { AccessKeyId, SecretKey, SessionToken } = AUTH.creds;
        const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
        const dateStamp = amzDate.slice(0, 8);
        const qs = query ? canonicalQuery(query) : '';
        const canonicalHeaders =
            `host:${HOST}\nx-amz-date:${amzDate}\nx-amz-security-token:${SessionToken}\nx-midway-token:${AUTH.midway}\n`;
        const signedHeaders = 'host;x-amz-date;x-amz-security-token;x-midway-token';
        const canonicalRequest = `GET\n${pathOnly}\n${qs}\n${canonicalHeaders}\n${signedHeaders}\n${EMPTY_SHA256}`;
        const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
        const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await sha256Hex(canonicalRequest)}`;
        const kDate = await hmac(enc.encode('AWS4' + SecretKey), dateStamp);
        const kRegion = await hmac(kDate, REGION);
        const kService = await hmac(kRegion, SERVICE);
        const kSigning = await hmac(kService, 'aws4_request');
        const signature = toHex(await hmac(kSigning, stringToSign));
        const authorization =
            `AWS4-HMAC-SHA256 Credential=${AccessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
        const headers = {
            Authorization: authorization,
            'X-Amz-Date': amzDate,
            'X-Amz-Security-Token': SessionToken,
            'x-midway-token': AUTH.midway
        };
        const url = `https://${HOST}${pathOnly}` + (qs ? `?${qs}` : '');
        return origFetch(url, { method: 'GET', mode: 'cors', credentials: 'omit', headers });
    }

    async function gunzipText(res) {
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
            return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
        }
        return new TextDecoder().decode(buf);
    }

    async function apiGetJson(pathOnly, query, tries = 3) {
        for (let i = 0; i < tries; i++) {
            const res = await signedGet(pathOnly, query);
            if (res.ok) {
                try { return JSON.parse(await gunzipText(res)); } catch (e) { return null; }
            }
            if ([401, 403, 429, 500, 502, 503].includes(res.status) && i < tries - 1) {
                await sleep(2000);
                continue;
            }
            return null;
        }
        return null;
    }

    /** 1時間刻みでartifact-metadataを取得して重複排除 */
    async function fetchArtifactMeta(sa, startSec, endSec, artifactType) {
        let all = [];
        for (let t = startSec; t < endSec; t += 3600) {
            const to = Math.min(t + 3600, endSec);
            const j = await apiGetJson('/prod/artifact-metadata', {
                scope: sa,
                artifactType,
                startTime: String(t),
                endTime: String(to)
            });
            if (j && j.artifactMetadataList) all = all.concat(j.artifactMetadataList);
        }
        const seen = new Set();
        const list = [];
        for (const a of all) {
            if (!seen.has(a.artifactId)) { seen.add(a.artifactId); list.push(a); }
        }
        list.sort((a, b) => (a.creationTime < b.creationTime ? -1 : 1));
        return list;
    }

    async function fetchInputMeta(sa, startSec, endSec) {
        return fetchArtifactMeta(sa, startSec, endSec, INPUT_TYPE);
    }

    /** 環境差を考慮し、利用可能なSSD Route Planのartifact種別を順に試す */
    async function fetchSsdRoutePlanMeta(sa, startSec, endSec) {
        for (const artifactType of SSD_ROUTE_PLAN_TYPES) {
            const list = await fetchArtifactMeta(sa, startSec, endSec, artifactType);
            if (list.length) return list;
        }
        return [];
    }

    // ===========================================================
    // 4. 共通ユーティリティ
    // ===========================================================

    function loadJson(key) {
        try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
    }

    function copyDefaultCycleSettings() {
        return JSON.parse(JSON.stringify(DEFAULT_CYCLE_SETTINGS));
    }

    function timeToMinutes(time) {
        const match = typeof time === 'string' && time.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
        return match ? Number(match[1]) * 60 + Number(match[2]) : null;
    }

    function cyclesMatch(cycles, expected) {
        return Array.isArray(cycles) && cycles.length === expected.length && cycles.every((cycle, index) =>
            cycle && cycle.name === expected[index].name && cycle.endTime === expected[index].endTime
        );
    }

    function migrateCycleSettings(candidate) {
        if (!candidate || ![1, 2, 3].includes(candidate.version)) return candidate;

        const migrated = JSON.parse(JSON.stringify(candidate));
        if (migrated.selectedCycleCount === '6' || migrated.selectedCycleCount === '8') {
            migrated.selectedCycleCount = Number(migrated.selectedCycleCount);
        }

        const sixCycles = migrated.configs && migrated.configs['6'] && migrated.configs['6'].cycles;
        const matchesGeneratedSixCycleDefaults =
            cyclesMatch(sixCycles, LEGACY_SIX_CYCLE_DEFAULTS_UNDERSCORED_0600) ||
            cyclesMatch(sixCycles, LEGACY_SIX_CYCLE_DEFAULTS_NON_UNDERSCORED_0600);
        if (matchesGeneratedSixCycleDefaults) {
            migrated.configs['6'].cycles = DEFAULT_CYCLE_SETTINGS.configs['6'].cycles.map((cycle) => ({ ...cycle }));
        }
        migrated.version = CYCLE_SETTINGS_VERSION;
        return migrated;
    }

    function validateCycleSettings(candidate) {
        if (!candidate || candidate.version !== CYCLE_SETTINGS_VERSION) {
            return { ok: false, message: '設定データのバージョンが不正です。' };
        }
        if (candidate.selectedCycleCount !== 6 && candidate.selectedCycleCount !== 8) {
            return { ok: false, message: 'Cycle数は6または8を選択してください。' };
        }
        if (!candidate.configs || typeof candidate.configs !== 'object') {
            return { ok: false, message: 'Cycle設定が見つかりません。' };
        }

        const normalized = { version: CYCLE_SETTINGS_VERSION, selectedCycleCount: candidate.selectedCycleCount, configs: {} };
        for (const count of [6, 8]) {
            const config = candidate.configs[String(count)];
            if (!config || !Array.isArray(config.cycles) || config.cycles.length !== count) {
                return { ok: false, message: `${count} Cycleの行数が不正です。` };
            }

            const names = new Set();
            const cycles = [];
            let previousEnd = -1;
            for (let index = 0; index < config.cycles.length; index += 1) {
                const cycle = config.cycles[index];
                const name = cycle && typeof cycle.name === 'string' ? cycle.name.trim() : '';
                const endTime = cycle && typeof cycle.endTime === 'string' ? cycle.endTime.trim() : '';
                if (!name) {
                    return { ok: false, message: `${count} Cycleの${index + 1}行目にCycleNameを入力してください。` };
                }
                if (names.has(name)) {
                    return { ok: false, message: `${count} Cycle内でCycleName「${name}」が重複しています。` };
                }
                const endMinutes = timeToMinutes(endTime);
                if (endMinutes === null) {
                    return { ok: false, message: `${count} Cycleの${index + 1}行目の終了時刻をHH:MM形式で入力してください。` };
                }
                if (endMinutes <= previousEnd) {
                    return { ok: false, message: `${count} Cycleの終了時刻は上から昇順に設定してください。` };
                }
                names.add(name);
                previousEnd = endMinutes;
                cycles.push({ name, endTime });
            }
            normalized.configs[String(count)] = { cycles };
        }
        return { ok: true, settings: normalized };
    }

    function loadCycleSettings() {
        const stored = loadJson(LS_CYCLE_SETTINGS);
        const candidate = migrateCycleSettings(stored);
        const result = validateCycleSettings(candidate);
        if (!result.ok) return copyDefaultCycleSettings();

        if (stored && stored.version !== CYCLE_SETTINGS_VERSION) {
            try { localStorage.setItem(LS_CYCLE_SETTINGS, JSON.stringify(result.settings)); } catch (e) {}
        }
        return result.settings;
    }

    let activeCycleSettings = loadCycleSettings();

    function activeCycles() {
        return activeCycleSettings.configs[String(activeCycleSettings.selectedCycleCount)].cycles;
    }

    function activeCycleFilters() {
        const cycles = activeCycles();
        return cycles.map((cycle, index) => ({
            label: cycle.name,
            min: index === 0 ? 0 : timeToMinutes(cycles[index - 1].endTime),
            max: index === cycles.length - 1 ? Infinity : timeToMinutes(cycle.endTime)
        }));
    }

    function activeCycleDisplaySchedule() {
        return activeCycles().map((cycle) => ({ label: cycle.name, endTime: cycle.endTime }));
    }

    /** planner-input検索はFinal Dispatch時刻を使うため、保存されたCycle終了時刻から5分戻す */
    function activePlannerFinalDispatchSchedule() {
        return activeCycles().map((cycle) => {
            const targetMinutes = (timeToMinutes(cycle.endTime) - 5 + 1440) % 1440;
            return {
                label: cycle.name,
                jstHour: Math.floor(targetMinutes / 60),
                jstMin: targetMinutes % 60
            };
        });
    }

    function todayJst() {
        const d = new Date(Date.now() + 9 * 3600 * 1000);
        return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
    }

    function stampNow() {
        const d = new Date(Date.now() + 9 * 3600 * 1000);
        return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}_` +
               `${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}`;
    }

    /** artifactIdのパス (/YYYY/MM/DD/HH/mm/) からJSTの日付と時刻を復元 */
    function jstFromArtifactId(id) {
        const m = /\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})\/(\d{2})\//.exec(id || '');
        if (!m) return { date: '', time: '' };
        const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`);
        const d = new Date(ms + 9 * 3600 * 1000);
        return {
            date: `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`,
            time: `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`
        };
    }

    /** 有効なCycle設定の終了時刻に最も近いラベルを返す（±30分以内） */
    function ssdLabelFromJstTime(timeStr) {
        if (!timeStr) return 'Unknown';
        const [h, m] = timeStr.split(':').map(Number);
        const minutes = h * 60 + m;
        let best = null;
        let bestDiff = Infinity;
        for (const cycle of activeCycles()) {
            const diff = Math.abs(minutes - timeToMinutes(cycle.endTime));
            if (diff < bestDiff) { bestDiff = diff; best = cycle; }
        }
        return best && bestDiff <= 30 ? best.name : 'Unknown';
    }

    /** "2026-08-07 05:40:00 JST" / "5:40" / "05:40:00" → 0:00からの分数 */
    function parseTimeOfDayToMinutes(timeStr) {
        if (!timeStr || typeof timeStr !== 'string') return null;
        const match = timeStr.trim().match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
        if (!match) return null;
        return parseInt(match[1]) * 60 + parseInt(match[2]);
    }

    /** 分数から有効なCycle設定のラベルを判定 */
    function getSSDLabel(minutes) {
        if (minutes === null) return null;
        for (const filter of activeCycleFilters()) {
            if (minutes >= filter.min && minutes < filter.max) return filter.label;
        }
        return null;
    }

    /** Route Duration / Block Length などの所要時間文字列を分数に変換 */
    function parseDurationToMinutes(timeStr) {
        if (!timeStr || typeof timeStr !== 'string') return null;
        timeStr = timeStr.trim();

        // 値なし（"-", "–", "N/A" 等）は計算対象外
        if (/^(?:[-–—]+|n\/a|na|null)$/i.test(timeStr)) return null;

        // "Xh Ym Zs" or "Xh Ymin"
        let match = timeStr.match(/^(\d+)\s*h(?:r|rs|ours?)?\s*(\d+)\s*m(?:in|ins|inutes?)?/i);
        if (match) return parseInt(match[1]) * 60 + parseInt(match[2]);

        // "Xh Zs"（時間と秒のみ、分なし）
        match = timeStr.match(/^(\d+)\s*h(?:r|rs|ours?)?\s*(\d+)\s*s(?:ec|ecs|econds?)?/i);
        if (match) return parseInt(match[1]) * 60;

        // "Xh" のみ
        match = timeStr.match(/^(\d+)\s*h(?:r|rs|ours?)?$/i);
        if (match) return parseInt(match[1]) * 60;

        // "Ym Zs" or "Ym"
        match = timeStr.match(/^(\d+)\s*m(?:in|ins|inutes?)?/i);
        if (match) return parseInt(match[1]);

        // "H:MM:SS" or "H:MM"
        match = timeStr.match(/^(\d+):(\d+)(?::(\d+))?$/);
        if (match) return parseInt(match[1]) * 60 + parseInt(match[2]);

        // 数字のみ（分として扱う）
        match = timeStr.match(/^(\d+(?:\.\d+)?)$/);
        if (match) return parseFloat(match[1]);

        return null;
    }

    /** 差分を "+1h 20m" 形式に整形 */
    function minutesToDisplay(minutes) {
        if (minutes === null || minutes === undefined) return 'N/A';
        if (minutes === 0) return '0m';
        const h = Math.floor(Math.abs(minutes) / 60);
        const m = Math.round(Math.abs(minutes) % 60);
        const sign = minutes < 0 ? '-' : '+';
        if (h > 0) return `${sign}${h}h ${m}m`;
        return `${sign}${m}m`;
    }

    // --- Block Start 昇順ソート ---

    let _blockStartSortStarted = false;
    let _blockStartSortRoute = '';
    let _blockStartSortLifecycle = 0;
    let _blockStartSortInitialApplied = false;
    let _blockStartSortManualOverride = false;
    let _blockStartSortPending = false;
    let _blockStartSortFailures = 0;
    let _blockStartSortHandled = new WeakSet();
    let _blockStartSortAppliedControl = null;
    let _blockStartSortAppliedTable = null;
    let _blockStartSortStabilizeUntil = 0;
    let _blockStartSortRecoveries = 0;
    const _blockStartSortUnknown = new WeakSet();

    function syncBlockStartSortRoute() {
        const route = location.pathname + location.search + location.hash;
        if (route === _blockStartSortRoute) return;
        _blockStartSortRoute = route;
        _blockStartSortLifecycle += 1;
        _blockStartSortInitialApplied = false;
        _blockStartSortManualOverride = false;
        _blockStartSortPending = false;
        _blockStartSortFailures = 0;
        _blockStartSortHandled = new WeakSet();
        _blockStartSortAppliedControl = null;
        _blockStartSortAppliedTable = null;
        _blockStartSortStabilizeUntil = 0;
        _blockStartSortRecoveries = 0;
    }

    function isUsableSortControl(control) {
        if (!control || control.disabled) return false;
        const hidden = control.closest('[aria-hidden="true"], [hidden]');
        const disabled = control.closest('[aria-disabled="true"], [disabled]');
        return !hidden && !disabled && control.getClientRects().length > 0;
    }

    function firstUsableSortControl(controls) {
        return controls.find(isUsableSortControl) || null;
    }

    /** Block Start表示値を秒単位で比較する。空欄・プレースホルダ・不正値は除外する。 */
    function parseBlockStartTimeToSeconds(timeStr) {
        if (!timeStr || typeof timeStr !== 'string') return null;
        const text = timeStr.trim();
        if (!text || /^(?:[-–—]+|n\/?a|null|tbd|pending|unknown|not\s+available)$/i.test(text)) return null;
        const match = text.match(/(?:^|[\sT])(\d{1,2}):(\d{2})(?::(\d{2}))?(?=$|\s)/);
        if (!match) return null;
        const hours = Number(match[1]);
        const minutes = Number(match[2]);
        const seconds = match[3] === undefined ? 0 : Number(match[3]);
        if (hours > 23 || minutes > 59 || seconds > 59) return null;
        return hours * 3600 + minutes * 60 + seconds;
    }

    function getBlockStartRowOrder(control) {
        const headerCell = control && control.closest('th, [role="columnheader"]');
        const table = headerCell && headerCell.closest('table, [role="table"]');
        const headerRow = headerCell && headerCell.closest('tr, [role="row"]');
        if (!headerCell || !table || !headerRow) return { status: 'insufficient', table: null };

        const headerCells = Array.from(headerRow.children).filter((cell) =>
            cell.matches('th, [role="columnheader"]')
        );
        const columnIndex = headerCells.indexOf(headerCell);
        if (columnIndex < 0) return { status: 'insufficient', table };

        const times = [];
        for (const row of table.querySelectorAll('tbody tr, [role="rowgroup"] [role="row"]')) {
            if (row.closest('[aria-hidden="true"], [hidden]') || row.getClientRects().length === 0) continue;
            const cells = Array.from(row.children).filter((cell) => cell.matches('td, [role="cell"]'));
            const cell = cells[columnIndex];
            const seconds = parseBlockStartTimeToSeconds(cell && cell.textContent);
            if (seconds !== null) times.push(seconds);
        }
        if (times.length < 2) return { status: 'insufficient', table };
        for (let index = 1; index < times.length; index += 1) {
            if (times[index] < times[index - 1]) return { status: 'not-ascending', table };
        }
        return { status: 'ascending', table };
    }

    function markBlockStartSortApplied(control, table) {
        _blockStartSortFailures = 0;
        _blockStartSortInitialApplied = true;
        _blockStartSortAppliedControl = control;
        _blockStartSortAppliedTable = table;
        _blockStartSortStabilizeUntil = Date.now() + BLOCK_START_SORT_STABILIZE_MS;
    }

    /** data-focus-idを優先し、存在しない場合だけ見出しテキストから探す */
    function findBlockStartSortControl() {
        const primary = Array.from(document.querySelectorAll(BLOCK_START_SORT_SELECTOR));
        if (primary.length) return firstUsableSortControl(primary);

        const textElements = document.querySelectorAll(
            '[class*="header-cell-text_"], th div, [role="columnheader"] div'
        );
        const fallback = [];
        for (const textElement of textElements) {
            if ((textElement.textContent || '').trim() !== 'Block Start') continue;
            const headerCell = textElement.closest('th, [role="columnheader"]');
            if (!headerCell) continue;
            const explicitControl =
                textElement.closest('[data-focus-id^="sorting-control-"]') ||
                headerCell.querySelector('[data-focus-id^="sorting-control-"]');
            const textButton = textElement.closest('[role="button"]');
            const control = explicitControl || textButton;
            if (control && headerCell.contains(control) && !fallback.includes(control)) fallback.push(control);
        }
        return firstUsableSortControl(fallback);
    }

    /** Cloudscapeのaria-sort、方向クラス、標準caretの順に現在状態を判定する */
    function getBlockStartSortState(control) {
        const headerCell = control.closest('th, [role="columnheader"]');
        const ariaSort = (
            (headerCell && headerCell.getAttribute('aria-sort')) ||
            control.getAttribute('aria-sort') ||
            ''
        ).toLowerCase();
        if (ariaSort === 'ascending' || ariaSort === 'descending' || ariaSort === 'none') return ariaSort;

        const headerClass = headerCell ? String(headerCell.className || '') : '';
        if (headerClass.includes('header-cell-ascending_')) return 'ascending';
        if (headerClass.includes('header-cell-descending_')) return 'descending';

        const sortingIcon = control.querySelector('[class*="sorting-icon_"]');
        const namedIconClass = sortingIcon ? String(sortingIcon.querySelector('span')?.className || '') : '';
        if (namedIconClass.includes('name-caret-up-filled_')) return 'ascending';
        if (namedIconClass.includes('name-caret-down-filled_')) return 'descending';
        if (namedIconClass.includes('name-caret-down_')) return 'none';

        const path = sortingIcon && sortingIcon.querySelector('svg path[d]');
        if (path) {
            // ここに到達するのは aria-sort も方向クラスも named caret も無い場合のみ。
            // 実機は全列 aria-sort="none" で、ソートアイコンは filled も方向クラスも持たない
            // 下向き三角 path になる。この下向き三角は Cloudscape の「未ソート(ニュートラル)」
            // 状態のアイコンであり、明示シグナル(aria-sort / 方向クラス / filled / named caret)を
            // 伴わない限り単独で降順を意味しない。よって下向き三角単独は none(未ソート)と扱う。
            // 上向き三角は昇順シグナルとして ascending を返す。
            const d = (path.getAttribute('d') || '').replace(/\s+/g, '').toLowerCase();
            if (d === 'm8546h4l4-6z') return 'ascending';
            if (d === 'm8114-6h4l46z') return 'none';
        }

        // カスタムアイコン等で方向を確実に判別できない場合、推測クリックはしない。
        return 'unknown';
    }

    function applyBlockStartAscendingSort() {
        syncBlockStartSortRoute();
        if (
            _blockStartSortInitialApplied ||
            _blockStartSortManualOverride ||
            _blockStartSortPending ||
            _blockStartSortFailures >= 2
        ) return;

        const control = findBlockStartSortControl();
        if (!control || _blockStartSortHandled.has(control)) return;

        const rowOrder = getBlockStartRowOrder(control);
        if (rowOrder.status === 'ascending') {
            markBlockStartSortApplied(control, rowOrder.table);
            return;
        }

        const state = getBlockStartSortState(control);
        if (state === 'unknown') {
            if (!_blockStartSortUnknown.has(control)) {
                _blockStartSortUnknown.add(control);
                console.warn('[Ufraa] Block Startのソート状態を判別できないため操作しません');
            }
            return;
        }
        // aria-sortだけがascendingで実行順が未描画/非昇順の場合も、循環クリックはしない。
        if (state === 'ascending') return;
        // 行がまだ描画されていない、または一行しかない場合は順序を推測してクリックしない。
        if (rowOrder.status === 'insufficient') return;

        // Cloudscapeの列ソートはクリックで循環する(未ソート→昇順→降順…等)。
        // 実データが非昇順で、状態が確定している場合だけ安全上限内でクリックする。
        _blockStartSortHandled.add(control);
        _blockStartSortPending = true;
        const appliedRoute = _blockStartSortRoute;
        const appliedLifecycle = _blockStartSortLifecycle;

        const finishPending = () => { _blockStartSortPending = false; };

        const clickAndVerify = (clicks, prevState, activeControl) => {
            if (clicks >= BLOCK_START_SORT_MAX_CLICKS || !isUsableSortControl(activeControl)) {
                if (clicks >= BLOCK_START_SORT_MAX_CLICKS) {
                    _blockStartSortFailures += 1;
                    console.warn('[Ufraa] Block Startの昇順ソートを確認できませんでした');
                }
                finishPending();
                return;
            }

            activeControl.click();
            console.log(`[Ufraa] Block Startを昇順に設定 (変更前: ${prevState}, クリック ${clicks + 1})`);

            setTimeout(() => {
                syncBlockStartSortRoute();
                // ルート/世代が変わっていれば、このライフサイクルの状態は書き換えない。
                if (
                    _blockStartSortRoute !== appliedRoute ||
                    _blockStartSortLifecycle !== appliedLifecycle
                ) return;
                // 手動変更や別経路での完了を検知したら即中断。
                if (_blockStartSortManualOverride || _blockStartSortInitialApplied) {
                    finishPending();
                    return;
                }

                const current = findBlockStartSortControl();
                if (!current) {
                    finishPending();
                    return;
                }
                const currentOrder = getBlockStartRowOrder(current);
                if (currentOrder.status === 'ascending') {
                    markBlockStartSortApplied(current, currentOrder.table);
                    finishPending();
                    _blockStartSortHandled.delete(control);
                    return;
                }
                const nextState = getBlockStartSortState(current);
                // aria-sortだけがascendingでも、行が未描画/非昇順なら循環クリックしない。
                if (
                    currentOrder.status === 'insufficient' ||
                    nextState === 'unknown' ||
                    nextState === 'ascending'
                ) {
                    finishPending();
                    return;
                }
                // 実行順が非昇順で、none/descendingを確認できた場合だけ次のクリックへ進む。
                clickAndVerify(clicks + 1, nextState, current);
            }, BLOCK_START_SORT_CONFIRM_MS);
        };

        clickAndVerify(0, state, control);
    }

    /** 初期成功直後の要素置換だけ、同一routeで一度だけ回復する。 */
    function recoverBlockStartAscendingSort() {
        syncBlockStartSortRoute();
        if (
            !_blockStartSortInitialApplied ||
            _blockStartSortManualOverride ||
            _blockStartSortPending ||
            _blockStartSortRecoveries >= BLOCK_START_SORT_MAX_RECOVERIES ||
            Date.now() > _blockStartSortStabilizeUntil
        ) return;

        const control = findBlockStartSortControl();
        if (!control) return;
        const rowOrder = getBlockStartRowOrder(control);
        const wasReplaced =
            control !== _blockStartSortAppliedControl ||
            rowOrder.table !== _blockStartSortAppliedTable;
        const state = getBlockStartSortState(control);
        if (!wasReplaced || rowOrder.status !== 'not-ascending' || (state !== 'none' && state !== 'descending')) return;

        _blockStartSortRecoveries += 1;
        _blockStartSortInitialApplied = false;
        _blockStartSortHandled = new WeakSet();
        applyBlockStartAscendingSort();
    }

    function isSortControlClickTarget(target) {
        if (!(target instanceof Element)) return false;
        if (target.closest('[data-focus-id^="sorting-control-"]')) return true;

        const button = target.closest('[role="button"]');
        if (!button || !button.closest('th, [role="columnheader"]')) return false;
        return Boolean(button.querySelector('[class*="sorting-icon_"]'));
    }

    /** SPA再描画とテーブルの遅延描画を監視する */
    function startBlockStartSortFeature() {
        if (_blockStartSortStarted || !document.body) return;
        _blockStartSortStarted = true;

        document.addEventListener('click', (event) => {
            if (!event.isTrusted || !isSortControlClickTarget(event.target)) return;
            syncBlockStartSortRoute();
            _blockStartSortManualOverride = true;
            _blockStartSortPending = false;
            console.log('[Ufraa] 手動ソートを優先します');
        }, true);

        const observer = new MutationObserver(() => {
            clearTimeout(observer._timeout);
            observer._timeout = setTimeout(() => {
                syncBlockStartSortRoute();
                if (_blockStartSortInitialApplied) recoverBlockStartAscendingSort();
                else applyBlockStartAscendingSort();
            }, BLOCK_START_SORT_DEBOUNCE_MS);
        });
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['aria-sort', 'class', 'd', 'data-focus-id']
        });

        applyBlockStartAscendingSort();
        console.log('[Ufraa] Block Start昇順ソートを起動');
    }

    // --- CSV ---

    /** 画面テーブルそのまま出力用（改行・空白を保持） */
    function escapeCSV(text) {
        if (!text) return '';
        if (text.includes(',') || text.includes('"') || text.includes('\n')) {
            return '"' + text.replace(/"/g, '""') + '"';
        }
        return text;
    }

    /** バッチ収集データ用（連続空白を1つに畳む） */
    const csvEsc = (v) => {
        const s = v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    function arrToCsv(headers, rows) {
        const lines = [];
        if (headers && headers.length) lines.push(headers.map(csvEsc).join(','));
        for (const r of rows) lines.push(r.map(csvEsc).join(','));
        return '\uFEFF' + lines.join('\r\n');
    }

    function downloadText(text, fileName) {
        const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
    }

    // ===========================================================
    // 5. Preferences（表示カラム）＋ Filter 入力
    //    Live画面の「設定」ボタンとバッチ巡回の初回ページで共用する
    // ===========================================================

    function findPreferencesButton() {
        return (
            document.querySelector('button[aria-label="Preferences"]') ||
            document.querySelector('button[title="Preferences"]') ||
            document.querySelector('[class*="awsui_tools-preferences"] button')
        );
    }

    /** Preferencesダイアログを開いてDESIRED_COLUMNSのみ表示ONにする */
    async function configurePreferences() {
        const prefBtn = findPreferencesButton();
        if (!prefBtn) {
            console.warn('[Ufraa] Preferencesボタンが見つかりません');
            return { ok: false, message: '歯車ボタンが見つかりません' };
        }

        prefBtn.click();
        await sleep(800);

        // カラムオプション（label + toggle が兄弟要素になっている構造）
        const options = document.querySelectorAll('[class*="visible-content-option_"]');
        if (!options.length) {
            console.warn('[Ufraa] Preferencesのカラム一覧が見つかりません');
            return { ok: false, message: 'カラム一覧が見つかりません' };
        }

        let changed = 0;
        for (const opt of options) {
            const label = opt.querySelector('label');
            const checkbox = opt.querySelector('input[type="checkbox"]');
            if (!label || !checkbox) continue;

            const text = label.textContent.trim();
            const shouldBeChecked = DESIRED_COLUMNS.some((col) => text.toLowerCase() === col.toLowerCase());

            if (shouldBeChecked !== checkbox.checked) {
                // ラベルクリックでトグル（Reactのイベントが確実に発火する）
                label.click();
                changed++;
                await sleep(60);
            }
        }

        await sleep(300);

        // Confirmボタンを押す（ダイアログ/ドロップダウン内のprimaryボタン）
        const container =
            options[0].closest('[class*="modal"], [role="dialog"], [class*="dropdown-content_"]') || document;
        let confirmBtn = null;
        container.querySelectorAll('button').forEach((b) => {
            const t = (b.textContent || '').trim().toLowerCase();
            if (!confirmBtn && (t === 'confirm' || t === 'ok' || t === 'apply')) confirmBtn = b;
        });
        if (!confirmBtn) confirmBtn = container.querySelector('button[class*="variant-primary"]');

        if (confirmBtn) {
            confirmBtn.click();
            await sleep(500);
        }

        console.log(`[Ufraa] Preferences設定完了 (${changed}件変更)`);
        return { ok: true, changed };
    }

    function findFilterInput() {
        return (
            document.querySelector('input[placeholder="Filter"]') ||
            document.querySelector('input[type="search"][class*="awsui_input"]') ||
            document.querySelector('[class*="tools-filtering"] input')
        );
    }

    /**
     * React管理下のinputに値を反映させる
     * value直接代入ではReactのstateが更新されないため、
     * ネイティブsetterを使ってからinputイベントを発火させる
     */
    function setReactInputValue(input, value) {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        if (descriptor && descriptor.set) {
            descriptor.set.call(input, value);
        } else {
            input.value = value;
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    async function applyStatusFilter() {
        const input = findFilterInput();
        if (!input) {
            console.warn('[Ufraa] Filter入力欄が見つかりません');
            return { ok: false, message: 'Filter入力欄が見つかりません' };
        }

        try {
            input.focus({ preventScroll: true });
        } catch (e) {
            /* focus不可なら無視 */
        }

        setReactInputValue(input, FILTER_TEXT);
        await sleep(400);

        const applied = input.value === FILTER_TEXT;
        console.log(`[Ufraa] Filter入力 ${applied ? '成功' : '失敗'}: "${input.value}"`);
        return applied ? { ok: true } : { ok: false, message: 'Filterに値が反映されませんでした' };
    }

    // ===========================================================
    // 6. Live画面: Gap Check / SSDラベル / 行ハイライト
    // ===========================================================

    // 選択中のSSD（空文字は全件、CycleNameとは衝突しない）
    let selectedSSD = '';

    // スクリプトが追加したラベル類（クラス名）
    const INJECTED_SELECTOR = '.ufraa-gap-label, .ufraa-ssd-label';

    // 行ハイライト用クラス
    const HIGHLIGHT_CLASS = 'ufraa-highlight-row';

    /**
     * ハイライト用のCSSを一度だけ挿入する
     * Cloudscapeのtdが背景色を持つため、td側を !important で上書きする
     */
    function injectHighlightStyle() {
        if (!document.head) return;
        if (document.getElementById('ufraa-highlight-style')) return;
        const style = document.createElement('style');
        style.id = 'ufraa-highlight-style';
        style.textContent = `
            tr.${HIGHLIGHT_CLASS} > td {
                background-color: #fff3b0 !important;
            }
            tr.${HIGHLIGHT_CLASS} > td:first-child {
                box-shadow: inset 4px 0 0 #e8a400;
            }
        `;
        document.head.appendChild(style);
    }

    /** スクリプトが追加したラベルを全て除去する（計算前に必ず呼ぶ） */
    function clearInjectedLabels() {
        document.querySelectorAll(INJECTED_SELECTOR).forEach((el) => el.remove());
    }

    /** セルの元テキストを取得（スクリプト追加分を除外） */
    function getCellText(cell) {
        if (!cell) return null;
        if (!cell.querySelector(INJECTED_SELECTOR)) {
            return cell.textContent.trim();
        }
        const clone = cell.cloneNode(true);
        clone.querySelectorAll(INJECTED_SELECTOR).forEach((el) => el.remove());
        return clone.textContent.trim();
    }

    function findColumnIndices(table) {
        const headers = table.querySelectorAll('th, thead td');
        let routeDurationIdx = -1;
        let blockLengthIdx = -1;
        let routeNameIdx = -1;
        let blockStartIdx = -1;
        let readyToWorkIdx = -1;
        let assignmentStatusIdx = -1;

        headers.forEach((header, index) => {
            const text = header.textContent.trim().toLowerCase();
            if (text.includes('route duration') || text.includes('routeduration')) {
                routeDurationIdx = index;
            }
            if (text.includes('block length') || text.includes('blocklength') || text.includes('block len')) {
                blockLengthIdx = index;
            }
            if (text.includes('route') && text.includes('name') && !text.includes('duration')) {
                routeNameIdx = index;
            }
            if (routeNameIdx === -1 && text.includes('route') && text.includes('id')) {
                routeNameIdx = index;
            }
            if (text.includes('block start') || text.includes('blockstart')) {
                blockStartIdx = index;
            }
            if (text.includes('ready to work') || text.includes('readytowork')) {
                readyToWorkIdx = index;
            }
            if (text.includes('assignment status') || text.includes('assignmentstatus')) {
                assignmentStatusIdx = index;
            }
        });

        return {
            routeDurationIdx,
            blockLengthIdx,
            routeNameIdx,
            blockStartIdx,
            readyToWorkIdx,
            assignmentStatusIdx
        };
    }

    function extractData() {
        const results = [];
        const tables = document.querySelectorAll('table');

        for (const table of tables) {
            const {
                routeDurationIdx,
                blockLengthIdx,
                routeNameIdx,
                blockStartIdx,
                readyToWorkIdx,
                assignmentStatusIdx
            } = findColumnIndices(table);
            if (routeDurationIdx === -1 || blockLengthIdx === -1) continue;

            const rows = table.querySelectorAll('tbody tr, tr:not(:first-child)');
            rows.forEach((row) => {
                const cells = row.querySelectorAll('td');
                if (cells.length <= Math.max(routeDurationIdx, blockLengthIdx)) return;

                const routeDurationText = getCellText(cells[routeDurationIdx]);
                const blockLengthText = getCellText(cells[blockLengthIdx]);
                const blockStartText = blockStartIdx >= 0 ? getCellText(cells[blockStartIdx]) : null;
                const readyToWorkText = readyToWorkIdx >= 0 ? getCellText(cells[readyToWorkIdx]) : null;
                const assignmentStatusText =
                    assignmentStatusIdx >= 0 ? getCellText(cells[assignmentStatusIdx]) : null;

                const routeDuration = parseDurationToMinutes(routeDurationText);
                const blockLength = parseDurationToMinutes(blockLengthText);

                const hasDuration = routeDuration !== null && blockLength !== null;
                const hasBlockStart = blockStartText && parseTimeOfDayToMinutes(blockStartText) !== null;
                const hasHighlightData = readyToWorkText !== null && assignmentStatusText !== null;

                if (hasDuration || hasBlockStart || hasHighlightData) {
                    results.push({
                        difference: hasDuration ? routeDuration - blockLength : null,
                        row,
                        routeNameCell: routeNameIdx >= 0 ? cells[routeNameIdx] : null,
                        routeDurationCell: cells[routeDurationIdx] || null,
                        blockStartCell: blockStartIdx >= 0 ? cells[blockStartIdx] : null,
                        blockStartText,
                        readyToWorkText,
                        assignmentStatusText
                    });
                }
            });
        }

        return results;
    }

    /** Ready To Work が 👍 かつ Assignment Status が Waiting の行かどうか */
    function shouldHighlightRow(item) {
        if (!item.readyToWorkText || !item.assignmentStatusText) return false;
        const readyOk = item.readyToWorkText.includes('👍');
        const waiting = item.assignmentStatusText.trim().toLowerCase() === 'waiting';
        return readyOk && waiting;
    }

    /** 行ハイライトを全解除する（行が再利用されるため毎回リセットが必要） */
    function clearHighlights() {
        document
            .querySelectorAll(`tr.${HIGHLIGHT_CLASS}`)
            .forEach((row) => row.classList.remove(HIGHLIGHT_CLASS));
    }

    function displayGaps(results) {
        results.forEach((item) => {
            // Ready To Work 👍 かつ Waiting の行をハイライト
            if (shouldHighlightRow(item)) {
                item.row.classList.add(HIGHLIGHT_CLASS);
            }

            // SSDラベルを判定
            let ssdLabel = null;
            if (item.blockStartText) {
                const blockStartMinutes = parseTimeOfDayToMinutes(item.blockStartText);
                ssdLabel = getSSDLabel(blockStartMinutes);
            }

            // 選択したSSDに該当する行のSSDラベルを赤文字に
            if (selectedSSD && ssdLabel === selectedSSD) {
                item._highlightSSD = true;
            }

            // Gap表示（Route Durationセルの横）
            if (item.difference !== null && item.routeDurationCell) {
                const bodyCell = item.routeDurationCell.querySelector('[class*="awsui_body-cell-content"]');
                const container = bodyCell || item.routeDurationCell;

                container.style.display = 'flex';
                container.style.alignItems = 'center';

                const gapSpan = document.createElement('span');
                gapSpan.className = 'ufraa-gap-label';
                const color = item.difference < 0 ? '#d32f2f' : item.difference > 0 ? '#388e3c' : '#333';
                gapSpan.style.cssText = `color:${color};font-weight:bold;margin-left:16px;font-size:12px;white-space:nowrap;`;
                gapSpan.textContent = minutesToDisplay(item.difference);
                container.appendChild(gapSpan);
            }

            // SSDラベル表示（Block Startセルの横）
            if (item.blockStartCell && item.blockStartText && ssdLabel) {
                const bsBodyCell = item.blockStartCell.querySelector('[class*="awsui_body-cell-content"]');
                const bsContainer = bsBodyCell || item.blockStartCell;

                bsContainer.style.display = 'flex';
                bsContainer.style.alignItems = 'center';

                const ssdSpan = document.createElement('span');
                ssdSpan.className = 'ufraa-ssd-label';
                const ssdColor = item._highlightSSD ? '#d32f2f' : '#0073bb';
                ssdSpan.style.cssText = `color:${ssdColor};font-weight:bold;margin-left:12px;font-size:11px;white-space:nowrap;`;
                ssdSpan.textContent = ssdLabel;
                bsContainer.appendChild(ssdSpan);
            }
        });
    }

    /**
     * Live画面のみで実行する
     * 巡回対象のAssignment Planページでラベルを差し込むと
     * scrapeTable()が読むinnerTextが汚染されるため、必ずページ判定で守る
     */
    function runGapCheck() {
        if (!isLivePage() || !document.body) return;

        injectHighlightStyle();

        // 前回のラベルとハイライトを先に全消去してから計算する（残留値の再計算を防ぐ）
        clearInjectedLabels();
        clearHighlights();

        const results = extractData();
        displayGaps(results);
    }

    // ===========================================================
    // 7. Live画面: ツールバーUI（SSD絞り込み・CSV出力・設定）
    // ===========================================================

    /** ツールバー右側のコンテナ（歯車の手前に挿入する） */
    function toolbarAlignRight() {
        return document.querySelector('[class*="awsui_tools-align-right"]');
    }

    function insertBeforePrefs(alignRight, el) {
        alignRight.style.display = 'flex';
        alignRight.style.alignItems = 'center';
        const prefs = alignRight.querySelector('[class*="awsui_tools-preferences"]');
        if (prefs) {
            alignRight.insertBefore(el, prefs);
        } else {
            alignRight.appendChild(el);
        }
    }

    function fillCycleSelect(select, batchMode) {
        const previous = select.value;
        select.replaceChildren();

        const allOption = document.createElement('option');
        allOption.value = '';
        allOption.textContent = batchMode ? '全SSD' : 'SSD: 全て';
        select.appendChild(allOption);

        for (const cycle of activeCycleDisplaySchedule()) {
            const option = document.createElement('option');
            option.value = cycle.label;
            option.textContent = `${cycle.label} (${cycle.endTime})`;
            select.appendChild(option);
        }

        const names = activeCycles().map((cycle) => cycle.name);
        select.value = names.includes(previous) ? previous : '';
    }

    function refreshCycleOptions() {
        const liveSelect = document.getElementById('ssd-filter-select');
        if (liveSelect) {
            fillCycleSelect(liveSelect, false);
            selectedSSD = liveSelect.value;
        } else if (!activeCycles().some((cycle) => cycle.name === selectedSSD)) {
            selectedSSD = '';
        }

        document.querySelectorAll('[data-ufraa-batch-cycle-select]').forEach((batchSelect) => {
            fillCycleSelect(batchSelect, true);
        });
        runGapCheck();
    }

    function openCycleSettingsPanel() {
        const existing = document.getElementById('ufraa-cycle-settings-overlay');
        if (existing) return;

        const draft = JSON.parse(JSON.stringify(activeCycleSettings));
        const overlay = document.createElement('div');
        overlay.id = 'ufraa-cycle-settings-overlay';
        overlay.style.cssText =
            'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.35);' +
            'display:flex;align-items:center;justify-content:center;padding:20px;';

        const panel = document.createElement('div');
        panel.style.cssText =
            'width:560px;max-width:calc(100vw - 40px);max-height:calc(100vh - 40px);overflow:auto;' +
            'background:#fff;border:1px solid #aaa;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.3);' +
            'padding:16px;font-family:Arial,sans-serif;color:#16191f;';

        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;';
        const title = document.createElement('strong');
        title.textContent = 'Cycle設定';
        title.style.fontSize = '16px';
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.textContent = '×';
        closeBtn.title = '閉じる';
        closeBtn.style.cssText =
            'border:none;background:transparent;color:#555;font-size:24px;line-height:24px;cursor:pointer;padding:0 4px;';
        header.appendChild(title);
        header.appendChild(closeBtn);

        const modeRow = document.createElement('label');
        modeRow.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:12px;';
        const modeText = document.createElement('span');
        modeText.textContent = 'Cycle数';
        modeText.style.fontWeight = 'bold';
        const modeSelect = document.createElement('select');
        modeSelect.style.cssText =
            'height:32px;padding:4px 8px;border:1px solid #aaa;border-radius:4px;font-size:13px;';
        for (const count of [6, 8]) {
            const option = document.createElement('option');
            option.value = String(count);
            option.textContent = `${count} Cycle`;
            modeSelect.appendChild(option);
        }
        modeSelect.value = String(draft.selectedCycleCount);
        modeRow.appendChild(modeText);
        modeRow.appendChild(modeSelect);

        const columnHeader = document.createElement('div');
        columnHeader.style.cssText =
            'display:grid;grid-template-columns:36px 1fr 140px;gap:8px;margin-bottom:4px;' +
            'font-size:11px;font-weight:bold;color:#555;';
        for (const text of ['No.', 'CycleName', '終了時刻 (HH:MM)']) {
            const span = document.createElement('span');
            span.textContent = text;
            columnHeader.appendChild(span);
        }

        const rows = document.createElement('div');
        const error = document.createElement('div');
        error.style.cssText = 'min-height:18px;margin-top:8px;color:#d13212;font-size:12px;font-weight:bold;';

        const renderRows = () => {
            rows.replaceChildren();
            const count = draft.selectedCycleCount;
            draft.configs[String(count)].cycles.forEach((cycle, index) => {
                const row = document.createElement('div');
                row.style.cssText =
                    'display:grid;grid-template-columns:36px 1fr 140px;gap:8px;align-items:center;margin-bottom:6px;';
                const number = document.createElement('span');
                number.textContent = String(index + 1);
                number.style.cssText = 'font-size:12px;color:#555;text-align:center;';
                const nameInput = document.createElement('input');
                nameInput.type = 'text';
                nameInput.value = cycle.name;
                nameInput.style.cssText =
                    'height:32px;padding:4px 8px;border:1px solid #aaa;border-radius:4px;font-size:13px;box-sizing:border-box;';
                const timeInput = document.createElement('input');
                timeInput.type = 'time';
                timeInput.step = '60';
                timeInput.value = cycle.endTime;
                timeInput.style.cssText =
                    'height:32px;padding:4px 8px;border:1px solid #aaa;border-radius:4px;font-size:13px;box-sizing:border-box;';
                nameInput.addEventListener('input', () => { cycle.name = nameInput.value; });
                timeInput.addEventListener('input', () => { cycle.endTime = timeInput.value; });
                row.appendChild(number);
                row.appendChild(nameInput);
                row.appendChild(timeInput);
                rows.appendChild(row);
            });
        };

        modeSelect.addEventListener('change', () => {
            draft.selectedCycleCount = Number(modeSelect.value);
            error.textContent = '';
            renderRows();
        });

        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:8px;';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.textContent = 'キャンセル';
        cancelBtn.style.cssText =
            'height:32px;padding:0 14px;background:#fff;color:#0073bb;border:1px solid #0073bb;' +
            'border-radius:4px;cursor:pointer;font-size:13px;font-weight:bold;';
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.textContent = '保存';
        saveBtn.style.cssText =
            'height:32px;padding:0 16px;background:#0073bb;color:#fff;border:none;border-radius:4px;' +
            'cursor:pointer;font-size:13px;font-weight:bold;';
        actions.appendChild(cancelBtn);
        actions.appendChild(saveBtn);

        const close = () => overlay.remove();
        closeBtn.addEventListener('click', close);
        cancelBtn.addEventListener('click', close);
        saveBtn.addEventListener('click', () => {
            error.textContent = '';
            const result = validateCycleSettings(draft);
            if (!result.ok) {
                error.textContent = result.message;
                return;
            }
            try {
                localStorage.setItem(LS_CYCLE_SETTINGS, JSON.stringify(result.settings));
            } catch (e) {
                error.textContent = '設定を保存できませんでした。ブラウザの保存領域を確認してください。';
                return;
            }
            activeCycleSettings = result.settings;
            close();
            refreshCycleOptions();
        });

        panel.appendChild(header);
        panel.appendChild(modeRow);
        panel.appendChild(columnHeader);
        panel.appendChild(rows);
        panel.appendChild(error);
        panel.appendChild(actions);
        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        renderRows();
    }

    function makeCycleSettingsButton(id) {
        const btn = document.createElement('button');
        btn.id = id;
        btn.type = 'button';
        btn.textContent = '⚙';
        btn.title = 'Cycle設定';
        btn.setAttribute('aria-label', 'Cycle設定');
        btn.style.cssText =
            'padding:0 10px;background:#f2f3f3;color:#687078;border:1px solid #aab7b8;border-radius:4px;cursor:pointer;' +
            'font-size:18px;font-weight:bold;height:32px;line-height:30px;';
        btn.addEventListener('mouseover', () => (btn.style.background = '#e7e9ec'));
        btn.addEventListener('mouseout', () => (btn.style.background = '#f2f3f3'));
        btn.addEventListener('click', openCycleSettingsPanel);
        return btn;
    }

    function createCycleSettingsButton() {
        if (document.getElementById('ufraa-cycle-settings-btn')) return;
        const alignRight = toolbarAlignRight();
        if (!alignRight) return;
        const btn = makeCycleSettingsButton('ufraa-cycle-settings-btn');
        btn.style.marginRight = '8px';
        const csvButton = document.getElementById('csv-export-btn');
        if (csvButton && csvButton.parentElement === alignRight) {
            csvButton.insertAdjacentElement('afterend', btn);
        } else {
            insertBeforePrefs(alignRight, btn);
        }
    }

    function createSSDDropdown() {
        if (document.getElementById('ssd-filter-select')) return;
        const alignRight = toolbarAlignRight();
        if (!alignRight) return;

        const select = document.createElement('select');
        select.id = 'ssd-filter-select';
        select.style.cssText = `
            padding: 4px 8px;
            border: 1px solid #aaa;
            border-radius: 4px;
            font-size: 13px;
            font-weight: bold;
            height: 32px;
            margin-right: 8px;
            cursor: pointer;
        `;

        fillCycleSelect(select, false);
        select.value = activeCycles().some((cycle) => cycle.name === selectedSSD) ? selectedSSD : '';
        select.addEventListener('change', () => {
            selectedSSD = select.value;
            runGapCheck();
        });

        insertBeforePrefs(alignRight, select);
    }

    function createCSVButton() {
        if (document.getElementById('csv-export-btn')) return;
        const alignRight = toolbarAlignRight();
        if (!alignRight) return;

        const downloadBtn = document.createElement('button');
        downloadBtn.id = 'csv-export-btn';
        downloadBtn.textContent = 'CSV出力';
        downloadBtn.style.cssText = `
            padding: 6px 12px;
            background-color: #0073bb;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            font-weight: bold;
            height: 32px;
            margin-right: 8px;
        `;
        downloadBtn.addEventListener('click', downloadCSV);
        downloadBtn.addEventListener('mouseover', () => (downloadBtn.style.backgroundColor = '#005a8c'));
        downloadBtn.addEventListener('mouseout', () => (downloadBtn.style.backgroundColor = '#0073bb'));

        insertBeforePrefs(alignRight, downloadBtn);
    }

    function createPrefsButton() {
        if (document.getElementById('ufraa-prefs-btn')) return;
        const alignRight = toolbarAlignRight();
        if (!alignRight) return;

        const btn = document.createElement('button');
        btn.id = 'ufraa-prefs-btn';
        btn.textContent = '設定';
        btn.title = `表示カラムを設定し、Filterに "${FILTER_TEXT}" を入力します`;
        btn.style.cssText = `
            padding: 6px 12px;
            background-color: #7a1fa2;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            font-weight: bold;
            height: 32px;
            margin-right: 8px;
        `;
        btn.addEventListener('mouseover', () => {
            if (!btn.disabled) btn.style.backgroundColor = '#5c1780';
        });
        btn.addEventListener('mouseout', () => {
            if (!btn.disabled) btn.style.backgroundColor = '#7a1fa2';
        });

        btn.addEventListener('click', async () => {
            btn.disabled = true;
            btn.style.opacity = '0.6';
            btn.textContent = '設定中...';
            try {
                const prefsResult = await configurePreferences();
                await sleep(600);
                const filterResult = await applyStatusFilter();

                const errors = [];
                if (!prefsResult.ok) errors.push(`カラム設定: ${prefsResult.message}`);
                if (!filterResult.ok) errors.push(`Filter入力: ${filterResult.message}`);

                btn.textContent = errors.length === 0 ? '設定完了' : '設定失敗';
                if (errors.length > 0) alert(`設定に失敗しました\n${errors.join('\n')}`);

                // 再描画後にラベルとハイライトを再適用
                await sleep(1200);
                runGapCheck();
            } catch (e) {
                console.error('[Ufraa] 設定エラー:', e);
                btn.textContent = '設定失敗';
                alert(`設定でエラーが発生しました: ${e.message}`);
            } finally {
                await sleep(1500);
                btn.disabled = false;
                btn.style.opacity = '1';
                btn.style.backgroundColor = '#7a1fa2';
                btn.textContent = '設定';
            }
        });

        insertBeforePrefs(alignRight, btn);
    }

    /** Live画面のUIが欠けていたら作り直す */
    function ensureLiveUi() {
        createSSDDropdown();
        createCSVButton();
        createCycleSettingsButton();
        createPrefsButton();
    }

    /** 表示中のテーブルをそのままCSVに落とす（スクリプト追加ラベルは除外） */
    function downloadCSV() {
        const rows = [];

        // ヘッダーを取得
        const headerCells = document.querySelectorAll('[class*="header-cell_"]');
        if (headerCells.length > 0) {
            const headerRow = [];
            headerCells.forEach((cell) => {
                const text = cell.textContent.trim();
                if (text) headerRow.push(escapeCSV(text));
            });
            if (headerRow.length > 0) rows.push(headerRow.join(','));
        }

        // ボディを取得（スクリプトで追加した要素を除外）
        const allBodyCells = document.querySelectorAll('td[class*="body-cell_"]');
        if (allBodyCells.length > 0) {
            const rowMap = new Map();
            allBodyCells.forEach((cell) => {
                const row = cell.closest('tr');
                if (row) {
                    if (!rowMap.has(row)) rowMap.set(row, []);
                    // セルをクローンしてスクリプト追加要素を除去
                    const clone = cell.cloneNode(true);
                    clone.querySelectorAll(INJECTED_SELECTOR).forEach((el) => el.remove());
                    rowMap.get(row).push(escapeCSV(clone.textContent.trim()));
                }
            });
            rowMap.forEach((cellData) => {
                if (cellData.length > 0) rows.push(cellData.join(','));
            });
        }

        if (rows.length === 0) {
            alert('データが見つかりません。');
            return;
        }

        const now = new Date();
        const timestamp = now.toISOString().slice(0, 19).replace(/[:-]/g, '');
        downloadText('\uFEFF' + rows.join('\n'), `assignment_plan_${timestamp}.csv`);
    }

    // ===========================================================
    // 8. Batch: Assignment Planページの巡回収集
    // ===========================================================

    function readCollect() { return loadJson(LS_COLLECT) || {}; }
    function writeCollect(o) { try { localStorage.setItem(LS_COLLECT, JSON.stringify(o)); } catch (e) {} }
    function readSsdRouteCollect() { return loadJson(LS_SSD_ROUTE_COLLECT) || {}; }
    function writeSsdRouteCollect(o) { try { localStorage.setItem(LS_SSD_ROUTE_COLLECT, JSON.stringify(o)); } catch (e) {} }

    /** AWS UIのheader-cell/body-cellクラスからテーブルを読み取る */
    function scrapeTable() {
        const headers = [];
        document.querySelectorAll('[class*="header-cell_"]').forEach((cell) => {
            const text = (cell.innerText || cell.textContent || '').trim();
            if (text) headers.push(text);
        });

        const allBodyCells = document.querySelectorAll('td[class*="body-cell_"]');
        if (!allBodyCells.length) return null;

        const rowMap = new Map();
        allBodyCells.forEach((cell) => {
            const row = cell.closest('tr');
            if (!row) return;
            if (!rowMap.has(row)) rowMap.set(row, []);
            // 選択チェックボックスセルはスキップ
            if (cell.querySelector('input[type="checkbox"]')) return;
            rowMap.get(row).push((cell.innerText || cell.textContent || '').trim());
        });

        const rows = [];
        rowMap.forEach((cellData) => { if (cellData.length > 0) rows.push(cellData); });
        if (!rows.length) return null;

        // ヘッダーの余剰分を切る（行の列数に合わせる）
        const n = rows[0].length;
        let finalHeaders = headers;
        if (n && headers.length > n) finalHeaders = headers.slice(0, n);

        return { headers: finalHeaders, rows, count: rows.length };
    }

    function showBadge(text, color) {
        if (!document.body) return;
        let b = document.getElementById('ufraa-ssd-badge');
        if (!b) {
            b = document.createElement('div');
            b.id = 'ufraa-ssd-badge';
            b.style.cssText =
                'position:fixed;left:16px;bottom:16px;z-index:2147483647;font:bold 12px sans-serif;' +
                'color:#fff;padding:6px 10px;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.3)';
            document.body.appendChild(b);
        }
        b.style.background = color;
        b.textContent = text;
    }

    // 巡回状態
    let _wId = null;
    let _wCount = -1;
    let _wStable = 0;
    let _wAdv = false;
    let _wStart = 0;
    let _prefsRunning = false; // カラム設定処理の実行中フラグ

    function collectAssignmentPage() {
        const id = artifactIdFromPath();
        if (!id) return;

        // キューが存在し巡回中の場合のみ処理
        const q = loadJson(LS_QUEUE);
        if (!q || !q.active || q.mode === 'ssdRoute') return;
        if (!q.prefsApplied) {
            if (_prefsRunning) return;
            _prefsRunning = true;

            showBadge('⚙ Preferences設定を適用中...', '#7a1fa2');

            // テーブルが描画されるまで待つ
            let waited = 0;
            const waitTable = setInterval(async () => {
                waited += 500;
                const hasTable = !!document.querySelector('td[class*="body-cell_"]');
                if (!hasTable && waited <= 20000) return;

                clearInterval(waitTable);
                try { await configurePreferences(); } catch (e) { console.warn('[Ufraa] prefs error:', e); }

                // フラグを立てて以降はスキップ
                const cur = loadJson(LS_QUEUE);
                if (cur) {
                    cur.prefsApplied = true;
                    localStorage.setItem(LS_QUEUE, JSON.stringify(cur));
                }

                // テーブル再描画を待ってから収集開始
                await sleep(2000);
                _prefsRunning = false;
                _wId = null;
                _wCount = -1;
                _wStable = 0;
                _wStart = Date.now();
                showBadge('⚙ Preferences設定完了 → データ収集開始', '#1f7a3d');
            }, 500);
            return;
        }

        if (_prefsRunning) return;

        doCollect(id);
    }

    function advanceWorker(id, table) {
        if (_wAdv) return;

        const cnt = table ? table.count : 0;
        if (id !== _wId) { _wId = id; _wCount = -1; _wStable = 0; _wStart = Date.now(); }

        // 行数が安定し、かつ行のカラム数が十分あることを確認
        const colCount = table && table.rows.length > 0 ? table.rows[0].length : 0;
        const stableCheck = cnt > 0 && cnt === _wCount && colCount > 3;
        if (stableCheck) _wStable += 1; else _wStable = 0;
        _wCount = cnt;

        const stableEnough = _wStable >= 2; // 2秒安定で収集
        const pageTimeout = Date.now() - _wStart > 25000;
        if (!stableEnough && !pageTimeout) return;

        _wAdv = true;
        const q = loadJson(LS_QUEUE);
        if (!q || !q.active) return;

        q.idx = (q.idx || 0) + 1;
        if (q.idx < q.urls.length) {
            localStorage.setItem(LS_QUEUE, JSON.stringify(q));
            _wAdv = false;
            _wId = null;
            _wCount = -1;
            _wStable = 0;
            location.href = q.urls[q.idx];
        } else {
            // 全件完了
            q.active = false;
            localStorage.setItem(LS_QUEUE, JSON.stringify(q));
            showBadge('✅ 全SSD収集完了！タブを閉じます...', '#1f7a3d');
            setTimeout(() => { try { window.close(); } catch (e) {} }, 2000);
        }
    }

    function doCollect(id) {
        const jt = jstFromArtifactId(id);
        const ssdLabel = ssdLabelFromJstTime(jt.time);
        const t = scrapeTable();
        const cnt = t ? t.count : 0;

        if (cnt) {
            const store = readCollect();
            if (!store[id] || store[id].count !== cnt) {
                store[id] = {
                    date: jt.date,
                    time: jt.time,
                    ssd: ssdLabel,
                    headers: t.headers,
                    rows: t.rows,
                    count: cnt,
                    ts: Date.now()
                };
                writeCollect(store);
            }
            showBadge(`🗂 収集済: ${ssdLabel} ${jt.time} / ${cnt}行`, '#1f7a3d');
        } else {
            showBadge(`🗂 表を読込中... ${ssdLabel} ${jt.time}`, '#8a6d00');
        }

        advanceWorker(id, t);
    }

    function collectSsdRoutePage() {
        const id = ssdRoutePlanIdFromPath();
        if (!id) return;

        const q = loadJson(LS_QUEUE);
        if (!q || !q.active || q.mode !== 'ssdRoute') return;

        const t = scrapeTable();
        const cnt = t ? t.count : 0;
        if (cnt) {
            const item = Array.isArray(q.items) ? q.items[q.idx || 0] : null;
            const store = readSsdRouteCollect();
            if (!store[id] || store[id].count !== cnt) {
                store[id] = {
                    date: item?.date || '',
                    time: item?.time || '',
                    ssd: item?.ssd || '',
                    headers: t.headers,
                    rows: t.rows,
                    count: cnt,
                    ts: Date.now()
                };
                writeSsdRouteCollect(store);
            }

            const matchedBlockColIdx = t.headers.findIndex(
                (header) => header.trim().toLowerCase() === 'matched block'
            );
            const matchedCount = matchedBlockColIdx >= 0
                ? t.rows.filter((row) => (row[matchedBlockColIdx] || '').trim()).length
                : 0;
            showBadge(`🧩 SSD Route Plan収集済: ${cnt}行 / Matched Block ${matchedCount}行`, '#1f7a3d');
        } else {
            showBadge('🧩 SSD Route Plan表を読込中...', '#8a6d00');
        }

        advanceWorker(id, t);
    }

    // ===========================================================
    // 9. Batch: SPR集計と表示
    // ===========================================================

    const BLOCK_LENGTHS = ['5h', '4.5h', '4h', '3.5h', '3h', '2.5h', '2h', '1.5h'];

    /** 分数からBlock Lengthラベルに変換（±15分の幅で判定） */
    function minutesToBlockLabel(minutes) {
        if (minutes === null) return null;
        const labels = [
            { label: '5h',   min: 285 }, // 4h45m以上 → 5h
            { label: '4.5h', min: 255 }, // 4h15m以上 → 4.5h
            { label: '4h',   min: 225 }, // 3h45m以上 → 4h
            { label: '3.5h', min: 195 }, // 3h15m以上 → 3.5h
            { label: '3h',   min: 165 }, // 2h45m以上 → 3h
            { label: '2.5h', min: 135 }, // 2h15m以上 → 2.5h
            { label: '2h',   min: 105 }, // 1h45m以上 → 2h
            { label: '1.5h', min: 75 }   // 1h15m以上 → 1.5h
        ];
        for (const l of labels) {
            if (minutes >= l.min) return l.label;
        }
        return null;
    }

    function parseBlockLengthMinutes(value) {
        const text = String(value || '').trim();
        const direct = parseDurationToMinutes(text);
        if (direct !== null) return direct;

        // SSD Route PlanのMatched Blockは "FLEX, 2h 29m" のように種別を含む
        const duration = text.match(/\d+\s*h(?:r|rs|ours?)?(?:\s*\d+\s*m(?:in|ins|inutes?)?)?/i);
        return duration ? parseDurationToMinutes(duration[0]) : null;
    }

    /** SSDごとの package総数 / route数 と Block Lengthごとの内訳 */
    function calculateSPR(rows, pkgColIdx, blockLengthColIdx, excludeRowsWithoutBlockLength = false) {
        const ssdMap = Object.create(null);

        for (const row of rows) {
            const blockLengthLabel = blockLengthColIdx >= 0
                ? minutesToBlockLabel(parseBlockLengthMinutes((row[blockLengthColIdx] || '').trim()))
                : null;
            if (excludeRowsWithoutBlockLength && !blockLengthLabel) continue;

            const ssd = row[0] || 'Unknown';
            if (!ssdMap[ssd]) {
                ssdMap[ssd] = { totalPkg: 0, totalRoutes: 0, byBlock: {} };
                for (const bl of BLOCK_LENGTHS) ssdMap[ssd].byBlock[bl] = { pkg: 0, routes: 0 };
            }
            ssdMap[ssd].totalRoutes += 1;

            let pkgVal = 0;
            if (pkgColIdx >= 0) {
                pkgVal = parseFloat((row[pkgColIdx] || '0').replace(/[^\d.]/g, ''));
                if (isNaN(pkgVal)) pkgVal = 0;
                ssdMap[ssd].totalPkg += pkgVal;
            }

            if (blockLengthLabel && ssdMap[ssd].byBlock[blockLengthLabel] !== undefined) {
                ssdMap[ssd].byBlock[blockLengthLabel].pkg += pkgVal;
                ssdMap[ssd].byBlock[blockLengthLabel].routes += 1;
            }
        }

        const result = [];
        for (const ssd of Object.keys(ssdMap).sort()) {
            const d = ssdMap[ssd];
            const spr = d.totalRoutes > 0 ? (d.totalPkg / d.totalRoutes).toFixed(1) : '0';
            const byBlock = {};
            for (const bl of BLOCK_LENGTHS) {
                const b = d.byBlock[bl];
                byBlock[bl] = b.routes > 0 ? (b.pkg / b.routes).toFixed(1) : '-';
            }
            result.push({ ssd, totalPkg: d.totalPkg, totalRoutes: d.totalRoutes, spr, byBlock });
        }
        return result;
    }

    function escapeHtml(value) {
        const escapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
        return String(value).replace(/[&<>"']/g, (character) => escapes[character]);
    }

    function displaySPR(sprData, anchorPanel) {
        const displayId = anchorPanel?.id ? `${anchorPanel.id}-spr-display` : 'ufraa-spr-display';
        let container = document.getElementById(displayId);
        if (!container) {
            container = document.createElement('div');
            container.id = displayId;
            container.style.cssText =
                'margin-top:8px;padding:10px;background:#f0f7ff;border:1px solid #0073bb;border-radius:6px;font-size:12px;';

            const panel = anchorPanel || document.getElementById('ufraa-ssd-panel');
            if (panel && panel.parentElement) {
                panel.parentElement.insertAdjacentElement('afterend', container);
            } else {
                const toolsFiltering = document.querySelector('[class*="tools-filtering_"]');
                if (toolsFiltering && toolsFiltering.parentElement) {
                    toolsFiltering.parentElement.parentElement.appendChild(container);
                } else {
                    document.body.appendChild(container);
                }
            }
        }

        let html = '<div style="font-weight:bold;margin-bottom:6px;color:#0073bb;">📊 SPR by SSD &amp; Block Length</div>';
        html += '<table style="border-collapse:collapse;width:100%;font-size:11px;">';
        html += '<tr style="background:#0073bb;color:#fff;">';
        html += '<th style="padding:4px 6px;text-align:left">SSD</th>';
        html += '<th style="padding:4px 6px;text-align:right">Routes</th>';
        html += '<th style="padding:4px 6px;text-align:right">Pkgs</th>';
        for (const bl of BLOCK_LENGTHS) html += `<th style="padding:4px 6px;text-align:right">${bl}</th>`;
        html += '<th style="padding:4px 6px;text-align:right;background:#005a8c;">SPR</th>';
        html += '</tr>';

        let totalPkg = 0;
        let totalRoutes = 0;

        for (const d of sprData) {
            html += '<tr style="border-bottom:1px solid #ddd;">';
            html += `<td style="padding:3px 6px;font-weight:bold;">${escapeHtml(d.ssd)}</td>`;
            html += `<td style="padding:3px 6px;text-align:right">${d.totalRoutes}</td>`;
            html += `<td style="padding:3px 6px;text-align:right">${d.totalPkg}</td>`;
            for (const bl of BLOCK_LENGTHS) {
                html += `<td style="padding:3px 6px;text-align:right">${d.byBlock[bl]}</td>`;
            }
            html += `<td style="padding:3px 6px;text-align:right;font-weight:bold;background:#e8f5e9;">${d.spr}</td>`;
            html += '</tr>';
            totalPkg += d.totalPkg;
            totalRoutes += d.totalRoutes;
        }

        const totalSpr = totalRoutes > 0 ? (totalPkg / totalRoutes).toFixed(1) : '0';
        html += '<tr style="background:#e8f5e9;font-weight:bold;">';
        html += '<td style="padding:4px 6px;">TOTAL</td>';
        html += `<td style="padding:4px 6px;text-align:right">${totalRoutes}</td>`;
        html += `<td style="padding:4px 6px;text-align:right">${totalPkg}</td>`;
        for (let i = 0; i < BLOCK_LENGTHS.length; i++) html += '<td style="padding:4px 6px;text-align:right">-</td>';
        html += `<td style="padding:4px 6px;text-align:right;background:#c8e6c9;">${totalSpr}</td>`;
        html += '</tr>';
        html += '</table>';

        container.innerHTML = html;
    }

    // ===========================================================
    // 10. Batch: 収集データの結合CSV出力
    // ===========================================================

    function exportCombinedCsv(anchorPanel) {
        const store = readCollect();
        const entries = Object.keys(store)
            .map((k) => store[k])
            .sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1));
        if (!entries.length) return 0;

        // ヘッダーは最も列数が多いエントリから取る（部分描画エントリの誤採用を防ぐ）
        let base = [];
        for (const e of entries) {
            if (e.headers && e.headers.length > base.length) base = e.headers;
        }

        // DESIRED_COLUMNSに一致するカラムのインデックスを特定
        const colMapping = [];
        for (const desired of DESIRED_COLUMNS) {
            const idx = base.findIndex((h) => h.trim().toLowerCase() === desired.toLowerCase());
            if (idx >= 0) colMapping.push({ srcIdx: idx, name: base[idx] });
        }

        // フィルタ用のインデックス（元のbase配列でのインデックス）
        const readyToWorkBaseIdx = base.findIndex((h) => {
            const lower = h.trim().toLowerCase();
            return lower.includes('ready to work') || lower.includes('readytowork') || lower === 'rtw';
        });

        console.log('[Ufraa] base headers:', base, 'readyToWorkBaseIdx:', readyToWorkBaseIdx);

        const filteredHeaders = colMapping.map((c) => c.name);
        const headers = ['SSD', '日付(JST)', '時刻(JST)'].concat(filteredHeaders);

        // 全行を収集（フィルタ対象カラムの値は元のインデックスで参照）
        const rows = [];
        for (const e of entries) {
            // 日付・時刻が取れていない不正エントリはスキップ
            if (!e.date || !e.time) continue;
            for (const r of e.rows || []) {
                // 列数が基準より少ない不完全な行はスキップ
                if (r.length < base.length) continue;
                // Ready To Work フィルタ: 👍のみ
                if (readyToWorkBaseIdx >= 0) {
                    const val = (r[readyToWorkBaseIdx] || '').trim();
                    if (!val.includes('👍')) continue;
                }
                rows.push([e.ssd || '', e.date, e.time].concat(colMapping.map((c) => r[c.srcIdx] || '')));
            }
        }

        if (!rows.length) {
            console.log('[Ufraa] フィルタ後のデータが0行です');
            return 0;
        }

        // 出力CSV上の列位置（SSD/日付/時刻の3列オフセット）
        const offset = 3;
        const findCol = (needle) => {
            const i = filteredHeaders.findIndex((h) => h.toLowerCase().includes(needle));
            return i >= 0 ? i + offset : -1;
        };
        const blockStartColIdx = findCol('block start');
        const pkgColIdx = findCol('route package count');
        const blColIdx = findCol('block length');

        // SSD列をBlock Startの時刻から再判定（planner-input生成時刻ではなく実際の枠で分類する）
        if (blockStartColIdx >= 0) {
            rows.forEach((row) => {
                const label = getSSDLabel(parseTimeOfDayToMinutes((row[blockStartColIdx] || '').trim()));
                if (label) row[0] = label;
            });

            // ソート: Block Start 昇順
            rows.sort((a, b) => (a[blockStartColIdx] || '').trim().localeCompare((b[blockStartColIdx] || '').trim()));
        }

        displaySPR(calculateSPR(rows, pkgColIdx, blColIdx), anchorPanel);

        const sa = serviceAreaId() || 'sa';
        downloadText(arrToCsv(headers, rows), `ssd_batch_${sa.slice(0, 8)}_${stampNow()}.csv`);
        return rows.length;
    }

    /** SSD Route PlanのCurrent SSD Planned Routesを直接結合してCSV出力 */
    function exportSsdRouteCsv(anchorPanel) {
        const store = readSsdRouteCollect();
        const entries = Object.keys(store)
            .map((key) => store[key])
            .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
        if (!entries.length) return 0;

        const headers = ['SSD', '日付(JST)', '時刻(JST)'].concat(SSD_ROUTE_CSV_COLUMNS);
        const rows = [];

        for (const entry of entries) {
            const indexes = SSD_ROUTE_CSV_COLUMNS.map((column) =>
                entry.headers.findIndex((header) => header.trim().toLowerCase() === column.toLowerCase())
            );
            for (const sourceRow of entry.rows || []) {
                rows.push([
                    entry.ssd || '',
                    entry.date || '',
                    entry.time || '',
                    ...indexes.map((index) => (index >= 0 ? sourceRow[index] || '' : ''))
                ]);
            }
        }

        if (!rows.length) return 0;

        rows.sort((a, b) => {
            const byDateTime = `${a[1]}${a[2]}`.localeCompare(`${b[1]}${b[2]}`);
            return byDateTime || (a[3] || '').localeCompare(b[3] || '');
        });

        displaySPR(calculateSPR(rows, 7, 15, true), anchorPanel);

        const sa = serviceAreaId() || 'sa';
        downloadText(arrToCsv(headers, rows), `ssd_route_batch_${sa.slice(0, 8)}_${stampNow()}.csv`);
        return rows.length;
    }

    // ===========================================================
    // 11. Batch: planner-input解決とバッチ実行
    // ===========================================================

    /** SSDラベル（nullなら全件）→ planner-inputのFinal Dispatch "HH:MM" リスト */
    function ssdTimesForLabels(labels) {
        const schedule = activePlannerFinalDispatchSchedule();
        const targets = labels ? schedule.filter((s) => labels.includes(s.label)) : schedule;
        return targets.map((s) => `${p2(s.jstHour)}:${p2(s.jstMin)}`);
    }

    /** artifact-metadata APIから各SSD時刻に最も近いplanner-inputを解決 */
    async function resolveUrls(sa, dateStr, times) {
        const targets = times
            .map((t) => ({ t, ms: Date.parse(`${dateStr}T${t}:00+09:00`) }))
            .filter((x) => !Number.isNaN(x.ms));
        if (!targets.length) return [];

        const startSec = Math.floor(Math.min(...targets.map((x) => x.ms)) / 1000) - 1800;
        const endSec = Math.floor(Math.max(...targets.map((x) => x.ms)) / 1000) + 1800;
        const list = await fetchInputMeta(sa, startSec, endSec);
        const withMs = list.map((a) => ({ ms: Date.parse(a.creationTime) || 0, id: a.artifactId }));

        return targets.map((tg) => {
            let best = null;
            let bd = Infinity;
            for (const a of withMs) {
                const d = Math.abs(a.ms - tg.ms);
                if (d < bd) { bd = d; best = a; }
            }
            return {
                time: tg.t,
                id: best ? best.id : null,
                url: best ? `${location.origin}/assignment-plan/${encodeURIComponent(best.id)}` : null
            };
        });
    }

    /** artifact-metadata APIから各SSD時刻に最も近いSSD Route Planを解決 */
    async function resolveSsdRouteUrls(sa, dateStr, times) {
        const targets = times
            .map((t) => ({ t, ms: Date.parse(`${dateStr}T${t}:00+09:00`) }))
            .filter((x) => !Number.isNaN(x.ms));
        if (!targets.length) return [];

        const startSec = Math.floor(Math.min(...targets.map((x) => x.ms)) / 1000) - 1800;
        const endSec = Math.floor(Math.max(...targets.map((x) => x.ms)) / 1000) + 1800;
        const list = await fetchSsdRoutePlanMeta(sa, startSec, endSec);
        const withMs = list.map((a) => ({ ms: Date.parse(a.creationTime) || 0, id: a.artifactId }));

        return targets.map((tg) => {
            let best = null;
            let bd = Infinity;
            for (const a of withMs) {
                const d = Math.abs(a.ms - tg.ms);
                if (d < bd) { bd = d; best = a; }
            }
            return {
                time: tg.t,
                id: best ? best.id : null,
                url: best ? `${location.origin}/ssd-route-page/${encodeURIComponent(best.id)}` : null
            };
        });
    }

    /** 複数日付×SSD時刻を作業タブで巡回し、完了後に結合CSVを出力 */
    async function runBatchExport(sa, dates, ssdLabels, statusEl) {
        const sourcePanel = statusEl.closest('[data-ufraa-batch-panel]');
        const mode = sourcePanel?.dataset.ufraaBatchPanel === 'SSD Route Plans' ? 'ssdRoute' : 'assignment';
        console.log('[Ufraa] runBatchExport:', sa, dates, ssdLabels, { mode });
        if (!AUTH.creds || !AUTH.midway) {
            statusEl.textContent = '⏳ 認証が未取得です。ページをリロードしてください。';
            return;
        }

        const times = ssdTimesForLabels(ssdLabels);
        let items = [];

        for (let i = 0; i < dates.length; i++) {
            if (mode === 'ssdRoute') {
                statusEl.textContent = `SSD Route Plan検索中... (${i + 1}/${dates.length}日)`;
                try {
                    const resolved = await resolveSsdRouteUrls(sa, dates[i], times);
                    items = items.concat(
                        resolved
                            .filter((result) => result.url)
                            .map((result) => ({
                                url: result.url,
                                date: dates[i],
                                time: result.time,
                                ssd: ssdLabelFromJstTime(result.time)
                            }))
                    );
                } catch (e) {
                    console.warn('[Ufraa] SSD Route Plan resolve error for', dates[i], e);
                }
            } else {
                statusEl.textContent = `planner-input検索中... (${i + 1}/${dates.length}日)`;
                try {
                    const resolved = await resolveUrls(sa, dates[i], times);
                    items = items.concat(
                        resolved.filter((result) => result.url).map((result) => ({ url: result.url }))
                    );
                } catch (e) {
                    console.warn('[Ufraa] resolve error for', dates[i], e);
                }
            }
        }

        items = [...new Map(items.map((item) => [item.url, item])).values()];
        if (!items.length) {
            statusEl.textContent = mode === 'ssdRoute'
                ? '該当するSSD Route Planが見つかりませんでした。'
                : '該当するAssignment Planが見つかりませんでした。';
            return;
        }

        const allUrls = items.map((item) => item.url);

        // 収集ストアをクリアしてキューを設定
        if (mode === 'ssdRoute') writeSsdRouteCollect({});
        else writeCollect({});
        localStorage.setItem(
            LS_QUEUE,
            JSON.stringify({
                urls: allUrls,
                items,
                idx: 0,
                active: true,
                total: allUrls.length,
                mode,
                ts: Date.now()
            })
        );

        // 作業タブを開く
        const w = window.open(allUrls[0], 'ufraaSsdWorker', 'width=800,height=600,left=0,top=0');
        if (!w) {
            statusEl.textContent = '⚠️ ポップアップがブロックされました。このサイトのポップアップを許可してください。';
            return;
        }
        window.focus();

        statusEl.textContent = `0 / ${allUrls.length} 取得中...`;

        // メインタブでlocalStorageを監視して進捗表示
        const progressInterval = setInterval(() => {
            const q = loadJson(LS_QUEUE);
            if (!q) { clearInterval(progressInterval); return; }

            if (q.active) {
                statusEl.textContent = `${q.idx || 0} / ${q.total || allUrls.length} 取得中...`;
                return;
            }

            clearInterval(progressInterval);
            const collected = mode === 'ssdRoute' ? readSsdRouteCollect() : readCollect();
            const count = Object.keys(collected).length;
            const rowCount = mode === 'ssdRoute' ? exportSsdRouteCsv(sourcePanel) : exportCombinedCsv(sourcePanel);
            statusEl.textContent =
                rowCount > 0
                    ? `✅ 完了！ ${count}時刻 / 計${rowCount}行をCSV保存しました。`
                    : '⚠️ データを取得できませんでした。';
            localStorage.removeItem(LS_QUEUE);
        }, 1000);
    }

    // ===========================================================
    // 12. Batch: Service AreasページのパネルUI
    // ===========================================================

    function findSectionToolsFiltering(sectionTitle) {
        for (const heading of document.querySelectorAll('[class*="heading-text_"]')) {
            if (heading.textContent.trim() !== sectionTitle) continue;
            const container =
                heading.closest('[class*="variant-container_"]') ||
                heading.closest('[class*="header-controls_"]')?.parentElement;
            const toolsFiltering = container?.querySelector('[class*="tools-filtering_"]');
            if (toolsFiltering) return toolsFiltering;
        }
        return null;
    }

    function injectPanelForSection(sectionTitle, suffix) {
        const idSuffix = suffix ? `-${suffix}` : '';
        const panelId = `ufraa-ssd-panel${idSuffix}`;
        const cycleSettingsButtonId = `ufraa-batch-cycle-settings-btn${idSuffix}`;
        const existingPanel = document.getElementById(panelId);
        if (existingPanel) {
            if (!document.getElementById(cycleSettingsButtonId)) {
                existingPanel.appendChild(makeCycleSettingsButton(cycleSettingsButtonId));
                console.log(`[Ufraa v4.3] ${sectionTitle}のCycle設定ボタンを補完`);
            }
            return;
        }

        const toolsFiltering = findSectionToolsFiltering(sectionTitle);
        if (!toolsFiltering) return;

        const toolsRow = toolsFiltering.parentElement;
        if (!toolsRow) return;

        const panel = document.createElement('div');
        panel.id = panelId;
        panel.dataset.ufraaBatchPanel = sectionTitle;
        panel.style.cssText = 'display:flex;align-items:center;gap:8px;margin-left:auto;';

        // 認証状態
        const authSpan = document.createElement('span');
        authSpan.id = `ufraa-ssd-auth${idSuffix}`;
        authSpan.style.cssText = 'font-size:10px;margin-right:4px;';

        const mkLabel = (text) => {
            const s = document.createElement('span');
            s.textContent = text;
            s.style.cssText = 'font-size:11px;color:#333;';
            return s;
        };
        const mkDateInput = (id) => {
            const i = document.createElement('input');
            i.id = `${id}${idSuffix}`;
            i.type = 'date';
            i.value = todayJst();
            i.style.cssText = 'padding:4px 6px;border:1px solid #aaa;border-radius:4px;font-size:13px;height:32px;';
            return i;
        };

        const dateFromInput = mkDateInput('ufraa-ssd-date-from');
        const dateToInput = mkDateInput('ufraa-ssd-date-to');

        // SSDドロップダウン
        const select = document.createElement('select');
        select.id = `ufraa-ssd-select${idSuffix}`;
        select.dataset.ufraaBatchCycleSelect = 'true';
        select.style.cssText = 'padding:4px 6px;border:1px solid #aaa;border-radius:4px;font-size:13px;height:32px;';
        fillCycleSelect(select, true);

        // 実行ボタン
        const runBtn = document.createElement('button');
        runBtn.id = `ufraa-ssd-run${idSuffix}`;
        runBtn.textContent = 'CSV出力';
        runBtn.style.cssText =
            'padding:0 16px;background:#0073bb;color:#fff;border:none;border-radius:4px;cursor:pointer;' +
            'font-size:13px;font-weight:bold;height:32px;line-height:32px;';
        runBtn.addEventListener('mouseover', () => (runBtn.style.background = '#005a8c'));
        runBtn.addEventListener('mouseout', () => (runBtn.style.background = '#0073bb'));

        const cycleSettingsBtn = makeCycleSettingsButton(cycleSettingsButtonId);

        // ステータス
        const statusSpan = document.createElement('span');
        statusSpan.id = `ufraa-ssd-status${idSuffix}`;
        statusSpan.style.cssText = 'font-size:10px;color:#555;';

        runBtn.addEventListener('click', async () => {
            const sa = serviceAreaId();
            if (!sa) { statusSpan.textContent = 'service-areasページで実行してください。'; return; }

            const dateFrom = dateFromInput.value;
            const dateTo = dateToInput.value;
            if (!dateFrom || !dateTo) { statusSpan.textContent = '日付を選択してください。'; return; }
            if (dateFrom > dateTo) { statusSpan.textContent = 'From日付がTo日付より後です。'; return; }

            const labels = select.value ? [select.value] : null;

            // 日付範囲から全日付リストを生成
            const dates = [];
            const current = new Date(dateFrom + 'T00:00:00');
            const end = new Date(dateTo + 'T00:00:00');
            while (current <= end) {
                dates.push(`${current.getFullYear()}-${p2(current.getMonth() + 1)}-${p2(current.getDate())}`);
                current.setDate(current.getDate() + 1);
            }

            runBtn.disabled = true;
            runBtn.style.opacity = '0.6';
            try {
                await runBatchExport(sa, dates, labels, statusSpan);
            } catch (e) {
                console.error('[Ufraa] batch error:', e);
                statusSpan.textContent = 'エラー: ' + e.message;
            } finally {
                runBtn.disabled = false;
                runBtn.style.opacity = '1';
            }
        });

        panel.appendChild(authSpan);
        panel.appendChild(mkLabel('From:'));
        panel.appendChild(dateFromInput);
        panel.appendChild(mkLabel('To:'));
        panel.appendChild(dateToInput);
        panel.appendChild(select);
        panel.appendChild(runBtn);
        panel.appendChild(cycleSettingsBtn);
        panel.appendChild(statusSpan);

        toolsRow.style.display = 'flex';
        toolsRow.style.alignItems = 'center';
        toolsRow.appendChild(panel);

        // 認証状態を定期更新
        const updateAuth = () => {
            const ok = AUTH.creds && AUTH.midway;
            authSpan.textContent = ok ? '✅' : '⏳';
            authSpan.title = ok ? '認証取得済み' : '認証待ち（リロードで取得）';
        };
        updateAuth();
        setInterval(updateAuth, 1500);
    }

    function injectPanel() {
        if (!serviceAreaId() || !document.body) return;
        injectPanelForSection('Assignment Plans', '');
        injectPanelForSection('SSD Route Plans', 'route');
    }

    // ===========================================================
    // 13. 初期化
    //     SPA遷移でスクリプトは再実行されないため、
    //     ページ種別はtickごとに判定する
    // ===========================================================

    let _liveStarted = false;

    /** Live画面用の定期実行とDOM監視を一度だけ起動する */
    function startLiveFeatures() {
        if (_liveStarted || !document.body) return;
        _liveStarted = true;

        setInterval(runGapCheck, CHECK_INTERVAL_MS);

        const observer = new MutationObserver(() => {
            clearTimeout(observer._timeout);
            observer._timeout = setTimeout(() => {
                if (!isLivePage()) return;
                runGapCheck();
                ensureLiveUi();
            }, 1000);
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });

        console.log('[Ufraa] Live画面の Gap Check / CSV出力 を起動');
    }

    function tick() {
        if (!document.body) return;

        startBlockStartSortFeature();
        if (!_blockStartSortInitialApplied && !_blockStartSortPending) {
            applyBlockStartAscendingSort();
        }

        if (isLivePage()) {
            startLiveFeatures();
            ensureLiveUi();
        }
        if (serviceAreaId()) injectPanel();
        if (artifactIdFromPath()) collectAssignmentPage();
        if (ssdRoutePlanIdFromPath()) collectSsdRoutePage();
    }

    setInterval(tick, TICK_INTERVAL_MS);
    if (document.readyState !== 'loading') tick();
    document.addEventListener('DOMContentLoaded', tick);

    console.log('[Ufraa v4.3] 起動 (Assignment Plan + SSD Batch CSV)');
})();
