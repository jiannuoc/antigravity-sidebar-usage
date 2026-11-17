/* --- ANTIGRAVITY SIDEBAR USAGE START --- */
(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    if (window.__agySidebarUsageStarted) return;
    window.__agySidebarUsageStarted = true;

    const pPath = window.location.pathname || '';
    if (
        pPath.startsWith('/settings-standalone') ||
        pPath.startsWith('/artifact') ||
        pPath.startsWith('/terminal-standalone')
    ) {
        return;
    }
    try {
        if (window.self !== window.top && !window.__AGY_USAGE_PREVIEW__) {
            return;
        }
    } catch {
        return;
    }

    const HOST_ID = 'agy-sidebar-usage-host';
    const EXPANDED_STORAGE_KEY = 'agy_sidebar_usage_expanded';
    const QUOTA_TRACKER_STORAGE_KEY = 'agy_sidebar_usage_quota_tracker_v1';
    const POLL_INTERVAL_MS = 10000;
    const COUNTDOWN_TICK_MS = 10000;
    const STREAM_SAMPLE_MS = 250;
    const SPARKLINE_BARS = 10;
    const CATALOG_TTL_MS = 10 * 60 * 1000;
    const UUID_RE = /^\/(?:c|forked\/[^/]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

    const TOKEN_TYPE_MAP = {
        1: 'SYSTEM_PROMPT',
        2: 'TOOLS',
        3: 'RULES',
        4: 'MCP_TOOLS',
        5: 'SKILLS',
        6: 'SUBAGENTS',
        7: 'CHAT_MESSAGES',
        8: 'WORKFLOWS',
        9: 'PLUGINS',
        10: 'FLOWS',
    };

    const NATIVE_CONTEXT_WINDOWS = [
        ['claude-opus-4-6', 250000],
        ['claude-sonnet-4-6', 250000],
        ['claude-', 1000000],
        ['gpt-oss-', 131072],
        ['gemini-', 1048576],
    ];

    const state = {
        expanded: readExpandedPref(),
        loading: true,
        refreshing: false,
        error: null,
        quota: null,
        context: { active: false },
        lastPerf: null,
        lastUpdatedAt: 0,
        lastLocationKey: (window.location.pathname || '') + (window.location.search || ''),
    };

    const liveStream = {
        active: false,
        phase: 'idle',
        startedAt: 0,
        firstTokenAt: 0,
        ttftSec: 0,
        lastGrowthAt: 0,
        pendingTickAt: 0,
        lastCharCount: -1,
        lastLocationSwitchAt: Date.now(),
        ewmaTps: 0,
        samples: [],
        sparkline: [],
        domMutated: false,
    };

    let cachedCsrfToken = '';
    let catalogCache = { fetchedAt: 0, map: {} };
    const genMetaCache = new Map(); // cascadeId -> Array<CortexStepGeneratorMetadata>
    let hostEl = null;
    let shadowRoot = null;
    let lastRenderedKey = '';
    let refreshTimer = null;
    let countdownTimer = null;
    let urlCheckTimer = null;
    let streamSamplerTimer = null;
    let mountRaf = 0;
    let inFlightRefresh = null;
    let quotaTracker = readQuotaTracker();

    function readExpandedPref() {
        try {
            return window.localStorage?.getItem(EXPANDED_STORAGE_KEY) === '1';
        } catch {
            return false;
        }
    }

    function writeExpandedPref(val) {
        try {
            window.localStorage?.setItem(EXPANDED_STORAGE_KEY, val ? '1' : '0');
        } catch {
            // ignore storage failure
        }
    }

    function createEmptyQuotaTracker() {
        return {
            pinnedSeriesKey: '',
            pinnedWeeklyKey: '',
            pinnedFiveHourKey: '',
            series: {},
            buckets: {},
        };
    }

    function readQuotaTracker() {
        const empty = createEmptyQuotaTracker();
        try {
            const raw = window.localStorage?.getItem(QUOTA_TRACKER_STORAGE_KEY);
            if (!raw) return empty;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return empty;
            return {
                pinnedSeriesKey: typeof parsed.pinnedSeriesKey === 'string' ? parsed.pinnedSeriesKey : '',
                pinnedWeeklyKey: typeof parsed.pinnedWeeklyKey === 'string' ? parsed.pinnedWeeklyKey : '',
                pinnedFiveHourKey: typeof parsed.pinnedFiveHourKey === 'string' ? parsed.pinnedFiveHourKey : '',
                series: parsed.series && typeof parsed.series === 'object' && !Array.isArray(parsed.series) ? parsed.series : {},
                buckets: parsed.buckets && typeof parsed.buckets === 'object' && !Array.isArray(parsed.buckets) ? parsed.buckets : {},
            };
        } catch {
            return empty;
        }
    }

    function pruneQuotaTrackerMap(mapObj, maxKeys = 64) {
        const entries = Object.entries(mapObj || {});
        if (entries.length <= maxKeys) return mapObj || {};
        entries.sort((a, b) => {
            const ta = Math.max(Number(a[1]?.changedAt) || 0, Number(a[1]?.consumedAt) || 0);
            const tb = Math.max(Number(b[1]?.changedAt) || 0, Number(b[1]?.consumedAt) || 0);
            return tb - ta;
        });
        const next = {};
        for (let i = 0; i < maxKeys && i < entries.length; i++) {
            next[entries[i][0]] = entries[i][1];
        }
        return next;
    }

    function writeQuotaTracker(tracker) {
        try {
            if (!tracker || typeof tracker !== 'object') return;
            tracker.series = pruneQuotaTrackerMap(tracker.series, 64);
            tracker.buckets = pruneQuotaTrackerMap(tracker.buckets, 64);
            window.localStorage?.setItem(QUOTA_TRACKER_STORAGE_KEY, JSON.stringify(tracker));
        } catch {
            // ignore storage failure
        }
    }

    function escapeHtml(str) {
        return String(str == null ? '' : str).replace(/[&<>"']/g, (ch) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
        }[ch]));
    }

    function formatTokens(n) {
        const val = Number(n) || 0;
        if (val >= 1e6) {
            const m = val / 1e6;
            return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
        }
        if (val >= 1e3) {
            return `${(val / 1e3).toFixed(1)}k`;
        }
        return String(Math.round(val));
    }

    function formatWindowLabel(rawWindow) {
        const w = String(rawWindow || '').trim().toLowerCase();
        if (!w) return '';
        if (w === 'daily') return '每日';
        if (w === 'weekly') return '每周';
        const m = /^(\d+)\s*([smhd])$/i.exec(w);
        if (m) {
            const unitMap = { s: '秒', m: '分钟', h: '小时', d: '天' };
            return `${m[1]}${unitMap[m[2].toLowerCase()] || m[2]}`;
        }
        return rawWindow;
    }

    function parseTimestampMs(ts) {
        if (!ts) return null;
        if (typeof ts === 'number') return ts > 1e12 ? ts : ts * 1000;
        if (typeof ts === 'string') {
            const ms = Date.parse(ts);
            return Number.isFinite(ms) ? ms : null;
        }
        if (typeof ts === 'object' && ts.seconds != null) {
            const sec = Number(ts.seconds) || 0;
            const nanos = Number(ts.nanos) || 0;
            return sec * 1000 + Math.floor(nanos / 1e6);
        }
        return null;
    }

    function formatResetCountdown(resetTimeMs) {
        if (!resetTimeMs) return '';
        const diffMs = resetTimeMs - Date.now();
        if (diffMs <= 0) return '<1分钟后重置';
        const totalMins = Math.floor(diffMs / 60000);
        const days = Math.floor(totalMins / 1440);
        const hours = Math.floor((totalMins % 1440) / 60);
        const mins = totalMins % 60;
        if (days > 0) return hours > 0 ? `${days}天${hours}小时后重置` : `${days}天后重置`;
        if (hours > 0) return mins > 0 ? `${hours}小时${mins}分后重置` : `${hours}小时后重置`;
        if (mins > 0) return `${mins}分钟后重置`;
        return '<1分钟后重置';
    }

    function quotaTone(pct, disabled) {
        if (disabled) return 'muted';
        if (pct == null) return 'primary';
        if (pct > 50) return 'success';
        if (pct >= 20) return 'warning';
        return 'error';
    }

    function contextTone(pct) {
        if (pct >= 85) return 'error';
        if (pct >= 65) return 'warning';
        return 'primary';
    }

    async function readMainWorldCsrf() {
        try {
            if (window.__APP_CONFIG__ && window.__APP_CONFIG__.csrfToken) {
                return String(window.__APP_CONFIG__.csrfToken);
            }
        } catch {
            // ignore
        }
        try {
            if (typeof require === 'function') {
                const electronMod = require('electron');
                if (electronMod?.webFrame?.executeJavaScript) {
                    const tok = await electronMod.webFrame.executeJavaScript(
                        '(function(){try{return window.__APP_CONFIG__&&window.__APP_CONFIG__.csrfToken||""}catch(e){return ""}})()'
                    );
                    if (tok) return String(tok);
                }
            }
        } catch {
            // ignore when outside Electron preload
        }
        return '';
    }

    async function fetchCsrfFromPage() {
        try {
            const res = await fetch(`${window.location.origin}/`, {
                credentials: 'include',
                cache: 'no-store',
            });
            if (!res.ok) return '';
            const html = await res.text();
            const match = html.match(/"?csrfToken"?\s*:\s*"([^"]+)"/);
            return match ? match[1] : '';
        } catch {
            return '';
        }
    }

    async function getCsrfToken(forceRefresh = false) {
        if (!forceRefresh && cachedCsrfToken) return cachedCsrfToken;

        const mainTok = await readMainWorldCsrf();
        if (mainTok) {
            cachedCsrfToken = mainTok;
            return cachedCsrfToken;
        }

        try {
            const lsTok = window.localStorage?.getItem('agy_session_csrf_token');
            if (lsTok) {
                cachedCsrfToken = lsTok;
                return cachedCsrfToken;
            }
        } catch {
            // ignore
        }

        try {
            const cookieMatch = document.cookie.match(/(?:^|;\s*)csrfToken=([^;]+)/);
            if (cookieMatch && cookieMatch[1]) {
                cachedCsrfToken = decodeURIComponent(cookieMatch[1]);
                return cachedCsrfToken;
            }
        } catch {
            // ignore
        }

        if (forceRefresh || !cachedCsrfToken) {
            const pageTok = await fetchCsrfFromPage();
            if (pageTok) {
                cachedCsrfToken = pageTok;
                return cachedCsrfToken;
            }
        }

        return cachedCsrfToken;
    }

    async function lsRpc(method, body = {}) {
        if (typeof window.__AGY_MOCK_RPC__ === 'function') {
            return await window.__AGY_MOCK_RPC__(method, body);
        }

        const attempt = async (forceTokenRefresh) => {
            const token = await getCsrfToken(forceTokenRefresh);
            const headers = {
                'Content-Type': 'application/json',
                'Connect-Protocol-Version': '1',
            };
            if (token) {
                headers['x-codeium-csrf-token'] = token;
            }
            const res = await fetch(
                `${window.location.origin}/exa.language_server_pb.LanguageServerService/${method}`,
                {
                    method: 'POST',
                    credentials: 'include',
                    headers,
                    body: JSON.stringify(body),
                }
            );
            return res;
        };

        let res = await attempt(false);
        if (res.status === 401 || res.status === 403 || res.status === 412) {
            cachedCsrfToken = '';
            res = await attempt(true);
        }
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            if (text.toLowerCase().includes('csrf')) {
                cachedCsrfToken = '';
                res = await attempt(true);
            }
            if (!res.ok) {
                throw new Error(`${method}: HTTP ${res.status}`);
            }
        }
        return await res.json();
    }

    function getActiveCascadeId() {
        const pathname = window.location.pathname || '';
        const match = UUID_RE.exec(pathname);
        if (match && match[1]) return match[1];
        const params = new URLSearchParams(window.location.search || '');
        const qId = params.get('cascadeId') || params.get('conversationId') || '';
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(qId)) {
            return qId;
        }
        return '';
    }

    const GENERIC_QUOTA_NAMES = new Set([
        '',
        '模型配额',
        '每周限额',
        '每日限额',
        '5小时限额',
        '每周',
        '每日',
        '5小时',
        'weekly',
        '5h',
        'daily',
        '7d',
        '1w',
        'quota',
    ]);

    function stripWindowSuffix(str) {
        return String(str || '')
            .trim()
            .replace(/\(\s*(?:5h|300m|weekly|daily|7d|1w|5小时|每周|每日|7天)\s*\)$/i, '')
            .replace(/(?:5小时限额|每周限额|每日限额)$/i, '')
            .trim();
    }

    function isGenericQuotaName(str) {
        return GENERIC_QUOTA_NAMES.has(String(str || '').trim().toLowerCase());
    }

    function extractQuotaSeriesKey(groupDisplayName, title) {
        const g = stripWindowSuffix(groupDisplayName);
        if (!isGenericQuotaName(g)) return g;
        const t = stripWindowSuffix(title);
        if (!isGenericQuotaName(t)) return t;
        return String(groupDisplayName || '').trim() || '模型配额';
    }

    function normalizeBucket(bucket, groupDisplayName) {
        const rawWindow = String(bucket.window || '').trim();
        const windowLabel = formatWindowLabel(rawWindow);
        let frac = null;
        if (typeof bucket.remainingFraction === 'number') {
            frac = bucket.remainingFraction;
        } else if (typeof bucket.remainingFraction === 'string' && bucket.remainingFraction !== '') {
            frac = Number(bucket.remainingFraction);
        } else if (bucket.remaining && bucket.remaining.case === 'remainingFraction') {
            frac = Number(bucket.remaining.value);
        }
        if (frac != null && !Number.isFinite(frac)) frac = null;
        const pct = frac != null ? Math.round(Math.max(0, Math.min(1, frac)) * 100) : null;
        const resetTimeMs = parseTimestampMs(bucket.resetTime);

        let title = bucket.displayName || '';
        const lowerWin = rawWindow.toLowerCase();
        if (!title) {
            if (lowerWin === 'daily') title = '每日限额';
            else if (lowerWin === 'weekly') title = '每周限额';
            else if (/^\d+[smhd]$/i.test(lowerWin)) title = `${windowLabel}限额`;
            else title = groupDisplayName || bucket.bucketId || '模型配额';
        }

        const shortLabel = groupDisplayName && groupDisplayName !== title
            ? (windowLabel ? `${groupDisplayName} (${windowLabel})` : `${groupDisplayName} · ${title}`)
            : (windowLabel && !title.includes(windowLabel) ? `${title} (${windowLabel})` : title);

        const seriesKey = extractQuotaSeriesKey(groupDisplayName, title);
        const trackerKey = `${groupDisplayName || ''}::${bucket.bucketId || title}::${lowerWin}`;

        return {
            id: bucket.bucketId || `${groupDisplayName || ''}:${title}:${rawWindow}`,
            trackerKey,
            seriesKey,
            title,
            groupName: groupDisplayName || '',
            rawWindow: lowerWin,
            windowLabel,
            shortLabel,
            remainingFraction: frac,
            remainingPct: pct,
            remainingAmount: bucket.remainingAmount != null ? Number(bucket.remainingAmount) : null,
            resetTimeMs,
            description: bucket.description || '',
            disabled: Boolean(bucket.disabled),
        };
    }

    function extractCredits(userTier) {
        if (!userTier) return null;
        const raw = userTier.availableCredits;
        if (raw == null) return null;
        if (typeof raw === 'number' || typeof raw === 'string') {
            const n = Number(raw);
            return Number.isFinite(n) ? n : null;
        }
        if (Array.isArray(raw)) {
            let total = 0;
            let found = false;
            for (const item of raw) {
                const v = Number(item?.amount ?? item?.remaining ?? item?.credits ?? item?.creditAmount);
                if (Number.isFinite(v)) {
                    total += v;
                    found = true;
                }
            }
            return found ? total : null;
        }
        if (typeof raw === 'object') {
            const v = Number(raw.amount ?? raw.remaining ?? raw.credits ?? raw.creditAmount ?? raw.availableCredits);
            return Number.isFinite(v) ? v : null;
        }
        return null;
    }

    function hasBucketQuotaChanged(prev, curr) {
        if (!prev || !curr) return false;
        if (Boolean(prev.disabled) !== Boolean(curr.disabled)) {
            return true;
        }
        if (prev.remainingFraction != null && curr.remainingFraction != null) {
            return Math.abs(curr.remainingFraction - prev.remainingFraction) >= 1e-6;
        }
        if (prev.remainingAmount != null && curr.remainingAmount != null) {
            return curr.remainingAmount !== prev.remainingAmount;
        }
        if (prev.remainingPct != null && curr.remainingPct != null) {
            return curr.remainingPct !== prev.remainingPct;
        }
        return false;
    }

    function computeBucketDelta(prev, curr) {
        if (!prev || !curr) return 0;
        if (prev.remainingFraction != null && curr.remainingFraction != null) {
            return curr.remainingFraction - prev.remainingFraction;
        }
        if (prev.remainingAmount != null && curr.remainingAmount != null) {
            return curr.remainingAmount - prev.remainingAmount;
        }
        if (prev.remainingPct != null && curr.remainingPct != null) {
            return (curr.remainingPct - prev.remainingPct) / 100;
        }
        if (Boolean(prev.disabled) !== Boolean(curr.disabled)) {
            return curr.disabled ? -1 : 1;
        }
        return 0;
    }

    function nextTrackerTimestamp(tracker) {
        let maxTs = Date.now();
        for (const rec of Object.values(tracker.buckets || {})) {
            const t = Math.max(Number(rec?.changedAt) || 0, Number(rec?.consumedAt) || 0);
            if (t >= maxTs) maxTs = t + 1;
        }
        for (const rec of Object.values(tracker.series || {})) {
            const t = Math.max(Number(rec?.changedAt) || 0, Number(rec?.consumedAt) || 0);
            if (t >= maxTs) maxTs = t + 1;
        }
        return maxTs;
    }

    function isWeeklyBucket(b) {
        if (!b) return false;
        const win = String(b.rawWindow || '').toLowerCase();
        if (win === 'weekly' || win === '7d' || win === '1w' || win === '1week') {
            return true;
        }
        if (b.windowLabel === '每周' || b.windowLabel === '7天') {
            return true;
        }
        const text = `${b.id || ''} ${b.title || ''} ${b.shortLabel || ''}`;
        if (/weekly|每周|周额度|7\s*d|7\s*天|1\s*w/i.test(text)) {
            return true;
        }
        if (!win && b.resetTimeMs && (b.resetTimeMs - Date.now() > 24 * 3600 * 1000)) {
            return true;
        }
        return false;
    }

    function isFiveHourBucket(b) {
        if (!b || isWeeklyBucket(b)) return false;
        const win = String(b.rawWindow || '').toLowerCase();
        if (win === '5h' || win === '300m') {
            return true;
        }
        if (b.windowLabel === '5小时') {
            return true;
        }
        const text = `${b.id || ''} ${b.title || ''} ${b.shortLabel || ''}`;
        if (/5\s*h|5\s*小时|300\s*m/i.test(text)) {
            return true;
        }
        if (!win && (!b.resetTimeMs || (b.resetTimeMs - Date.now() <= 24 * 3600 * 1000))) {
            return true;
        }
        return false;
    }

    function updateQuotaTracker(allBuckets) {
        const list = Array.isArray(allBuckets) ? allBuckets : [];
        if (!list.length) return;

        const now = nextTrackerTimestamp(quotaTracker);
        const changedThisTick = [];

        for (const b of list) {
            const prev = quotaTracker.buckets[b.trackerKey];
            if (prev && hasBucketQuotaChanged(prev, b)) {
                const delta = computeBucketDelta(prev, b);
                const consumed = delta < -1e-6;
                quotaTracker.buckets[b.trackerKey] = {
                    remainingFraction: b.remainingFraction,
                    remainingAmount: b.remainingAmount,
                    remainingPct: b.remainingPct,
                    disabled: Boolean(b.disabled),
                    changedAt: now,
                    consumedAt: consumed ? now : (Number(prev.consumedAt) || 0),
                    lastDelta: delta,
                };
                const prevSeries = quotaTracker.series[b.seriesKey] || {};
                quotaTracker.series[b.seriesKey] = {
                    changedAt: now,
                    consumedAt: consumed ? now : (Number(prevSeries.consumedAt) || 0),
                    lastDelta: delta,
                };
                changedThisTick.push({ bucket: b, delta, consumed });
            } else {
                quotaTracker.buckets[b.trackerKey] = {
                    remainingFraction: b.remainingFraction,
                    remainingAmount: b.remainingAmount,
                    remainingPct: b.remainingPct,
                    disabled: Boolean(b.disabled),
                    changedAt: Number(prev?.changedAt) || 0,
                    consumedAt: Number(prev?.consumedAt) || 0,
                    lastDelta: Number(prev?.lastDelta) || 0,
                };
            }
        }

        if (changedThisTick.length > 0) {
            changedThisTick.sort((a, b) => {
                if (a.consumed !== b.consumed) return a.consumed ? -1 : 1;
                const aSpec = !isGenericQuotaName(a.bucket.seriesKey);
                const bSpec = !isGenericQuotaName(b.bucket.seriesKey);
                if (aSpec !== bSpec) return aSpec ? -1 : 1;
                return Math.abs(b.delta) - Math.abs(a.delta);
            });
            const topSeries = changedThisTick[0].bucket.seriesKey;
            quotaTracker.pinnedSeriesKey = topSeries;

            const weeklyChanged = changedThisTick.filter((x) => isWeeklyBucket(x.bucket));
            if (weeklyChanged.length > 0) {
                const chosenW = weeklyChanged.find((x) => x.bucket.seriesKey === topSeries) || weeklyChanged[0];
                quotaTracker.pinnedWeeklyKey = chosenW.bucket.trackerKey;
            }
            const fiveHourChanged = changedThisTick.filter((x) => isFiveHourBucket(x.bucket));
            if (fiveHourChanged.length > 0) {
                const chosen5h = fiveHourChanged.find((x) => x.bucket.seriesKey === topSeries) || fiveHourChanged[0];
                quotaTracker.pinnedFiveHourKey = chosen5h.bucket.trackerKey;
            }
        } else {
            const hasPinned = Boolean(quotaTracker.pinnedSeriesKey) &&
                list.some((b) => b.seriesKey === quotaTracker.pinnedSeriesKey);
            if (!hasPinned) {
                const recordedSeriesBuckets = list
                    .filter((b) => (Number(quotaTracker.series[b.seriesKey]?.changedAt) || 0) > 0)
                    .sort((a, b) => {
                        const sa = quotaTracker.series[a.seriesKey] || {};
                        const sb = quotaTracker.series[b.seriesKey] || {};
                        if ((sb.changedAt || 0) !== (sa.changedAt || 0)) {
                            return (sb.changedAt || 0) - (sa.changedAt || 0);
                        }
                        return (sb.consumedAt || 0) - (sa.consumedAt || 0);
                    });

                let seed = recordedSeriesBuckets[0] || null;
                if (!seed) {
                    const pickPartial = (pool) => pool
                        .filter((b) => !b.disabled && b.remainingFraction != null && b.remainingFraction < 0.999999)
                        .sort((a, b) => a.remainingFraction - b.remainingFraction)[0];
                    seed = pickPartial(list.filter(isFiveHourBucket))
                        || pickPartial(list.filter(isWeeklyBucket))
                        || pickPartial(list)
                        || list.find((b) => !isGenericQuotaName(b.seriesKey))
                        || list[0];
                }

                if (seed) {
                    quotaTracker.pinnedSeriesKey = seed.seriesKey;
                    const matchW = list.find((b) => isWeeklyBucket(b) && b.seriesKey === seed.seriesKey);
                    const match5h = list.find((b) => isFiveHourBucket(b) && b.seriesKey === seed.seriesKey);
                    if (matchW) quotaTracker.pinnedWeeklyKey = matchW.trackerKey;
                    if (match5h) quotaTracker.pinnedFiveHourKey = match5h.trackerKey;
                }
            }
        }

        writeQuotaTracker(quotaTracker);
    }

    function pickBestTrackedBucket(candidates, pinnedSeriesKey, pinnedBucketKey) {
        if (!candidates.length) return null;

        const sortByActivity = (pool) => pool.slice().sort((a, b) => {
            const ta = Number(quotaTracker.buckets[a.trackerKey]?.changedAt) || 0;
            const tb = Number(quotaTracker.buckets[b.trackerKey]?.changedAt) || 0;
            if (tb !== ta) return tb - ta;
            if (pinnedBucketKey) {
                const aPin = a.trackerKey === pinnedBucketKey ? 1 : 0;
                const bPin = b.trackerKey === pinnedBucketKey ? 1 : 0;
                if (bPin !== aPin) return bPin - aPin;
            }
            return (a.remainingPct ?? 101) - (b.remainingPct ?? 101);
        });

        if (pinnedSeriesKey) {
            const seriesMatches = candidates.filter((b) => b.seriesKey === pinnedSeriesKey);
            if (seriesMatches.length) {
                return sortByActivity(seriesMatches)[0];
            }
        }

        const changedMatches = candidates.filter((b) => (Number(quotaTracker.buckets[b.trackerKey]?.changedAt) || 0) > 0);
        if (changedMatches.length) {
            return sortByActivity(changedMatches)[0];
        }

        if (pinnedBucketKey) {
            const exact = candidates.find((b) => b.trackerKey === pinnedBucketKey);
            if (exact) return exact;
        }

        const enabled = candidates.filter((b) => !b.disabled);
        const pool = enabled.length ? enabled : candidates;
        return pool.slice().sort((a, b) => (a.remainingPct ?? 101) - (b.remainingPct ?? 101))[0];
    }

    function pickPersistentQuotaBuckets(allBuckets) {
        const list = Array.isArray(allBuckets) ? allBuckets : [];
        const weeklyCandidates = list.filter(isWeeklyBucket);
        const fiveHourCandidates = list.filter(isFiveHourBucket);
        const weeklyBucket = pickBestTrackedBucket(
            weeklyCandidates,
            quotaTracker.pinnedSeriesKey,
            quotaTracker.pinnedWeeklyKey
        );
        const fiveHourBucket = pickBestTrackedBucket(
            fiveHourCandidates,
            quotaTracker.pinnedSeriesKey,
            quotaTracker.pinnedFiveHourKey
        );
        return {
            weeklyBucket,
            fiveHourBucket,
            primaryBucket: fiveHourBucket || weeklyBucket || list[0] || null,
        };
    }

    async function fetchQuotaData(forceRefresh) {
        const [quotaResult, userStatusResult] = await Promise.allSettled([
            lsRpc('RetrieveUserQuotaSummary', { forceRefresh: Boolean(forceRefresh) }),
            lsRpc('GetUserStatus', { metadata: { ideName: 'antigravity', extensionName: 'antigravity' } }),
        ]);

        const quotaResp = quotaResult.status === 'fulfilled' ? quotaResult.value : null;
        const userStatusResp = userStatusResult.status === 'fulfilled' ? userStatusResult.value : null;

        if (!quotaResp && !userStatusResp) {
            throw quotaResult.reason || userStatusResult.reason || new Error('配额接口不可用');
        }

        const rawPayload = quotaResp?.response || quotaResp || {};
        let rawGroups = Array.isArray(rawPayload.groups) ? rawPayload.groups : [];
        if (!rawGroups.length && Array.isArray(rawPayload.buckets) && rawPayload.buckets.length) {
            rawGroups = [{ displayName: '模型配额', buckets: rawPayload.buckets }];
        }

        const groups = [];
        const allBuckets = [];

        for (const g of rawGroups) {
            const gName = g.displayName || '';
            const rawBuckets = Array.isArray(g.buckets) ? g.buckets : [];
            if (!rawBuckets.length) continue;
            const buckets = rawBuckets.map((b) => normalizeBucket(b, gName));
            groups.push({
                displayName: gName || '模型配额',
                description: g.description || '',
                buckets,
            });
            allBuckets.push(...buckets);
        }

        const userStatus = userStatusResp?.userStatus || userStatusResp?.response?.userStatus || null;
        if (!groups.length && userStatus?.cascadeModelConfigData?.clientModelConfigs) {
            const fallbackBuckets = [];
            const seen = new Set();
            for (const cfg of userStatus.cascadeModelConfigData.clientModelConfigs) {
                if (!cfg?.quotaInfo) continue;
                const label = cfg.label || '模型';
                if (seen.has(label)) continue;
                seen.add(label);
                fallbackBuckets.push(normalizeBucket({
                    bucketId: label,
                    displayName: label,
                    remainingFraction: cfg.quotaInfo.remainingFraction,
                    resetTime: cfg.quotaInfo.resetTime,
                    disabled: cfg.disabled,
                }, '模型配额'));
            }
            if (fallbackBuckets.length) {
                groups.push({ displayName: '模型配额', description: '', buckets: fallbackBuckets });
                allBuckets.push(...fallbackBuckets);
            }
        }

        const userTier = userStatus?.userTier || null;
        const planInfo = userStatusResp?.planInfo || userStatus?.planInfo || null;
        const planName = userTier?.name || planInfo?.planName || '';
        const credits = extractCredits(userTier);

        return {
            groups,
            allBuckets,
            planName,
            credits,
        };
    }

    async function ensureModelCatalog() {
        const now = Date.now();
        if (now - catalogCache.fetchedAt < CATALOG_TTL_MS && Object.keys(catalogCache.map).length) {
            return catalogCache.map;
        }
        try {
            const resp = await lsRpc('GetAvailableModels', {
                metadata: { ideName: 'antigravity', extensionName: 'antigravity' },
            });
            const models = resp?.response?.models || resp?.models || {};
            const map = {};
            for (const [id, m] of Object.entries(models)) {
                const maxTokens = Number(m?.maxTokens) || 0;
                if (maxTokens > 0) {
                    map[id] = {
                        maxTokens,
                        displayName: m.displayName || '',
                    };
                }
            }
            if (Object.keys(map).length) {
                catalogCache = { fetchedAt: now, map };
            }
        } catch {
            // fallback to built-in context window prefixes
        }
        return catalogCache.map;
    }

    function inferContextLimit(modelId, requestBudgetTokens, catalog) {
        if (modelId && catalog[modelId]?.maxTokens) {
            return catalog[modelId].maxTokens;
        }
        if (modelId) {
            for (const [prefix, limit] of NATIVE_CONTEXT_WINDOWS) {
                if (modelId.startsWith(prefix)) return limit;
            }
        }
        return requestBudgetTokens || 1048576;
    }

    function normalizeTokenType(rawType) {
        if (typeof rawType === 'number') return TOKEN_TYPE_MAP[rawType] || '';
        const s = String(rawType || '').replace(/^TOKEN_TYPE_/, '');
        return s;
    }

    async function fetchGeneratorMetadata(cascadeId) {
        const cached = genMetaCache.get(cascadeId) || [];
        let offset = cached.length > 0 ? cached.length - 1 : 0;
        const list = cached.slice(0, offset);

        for (let page = 0; page < 20; page++) {
            const resp = await lsRpc('GetCascadeTrajectoryGeneratorMetadata', {
                cascadeId,
                generatorMetadataOffset: offset,
                includeMessages: false,
            });
            const payload = resp?.response || resp || {};
            const items = Array.isArray(payload.generatorMetadata) ? payload.generatorMetadata : [];
            if (!items.length) break;
            list.push(...items);
            offset += items.length;
            if (items.length < 50) break;
        }

        genMetaCache.set(cascadeId, list);
        if (genMetaCache.size > 12) {
            const oldestKey = genMetaCache.keys().next().value;
            if (oldestKey && oldestKey !== cascadeId) genMetaCache.delete(oldestKey);
        }
        return list;
    }

    function parseDurationSec(raw) {
        if (raw == null || raw === '') return 0;
        if (typeof raw === 'number') {
            return Number.isFinite(raw) && raw > 0 ? raw : 0;
        }
        if (typeof raw === 'string') {
            const s = raw.trim();
            const m = /^(-?(?:\d+\.?\d*|\.\d+))s$/i.exec(s);
            if (m) {
                const v = Number(m[1]);
                return Number.isFinite(v) && v > 0 ? v : 0;
            }
            const n = Number(s);
            return Number.isFinite(n) && n > 0 ? n : 0;
        }
        if (typeof raw === 'object') {
            const sec = Number(raw.seconds) || 0;
            const nanos = Number(raw.nanos) || 0;
            const total = sec + nanos / 1e9;
            return Number.isFinite(total) && total > 0 ? total : 0;
        }
        return 0;
    }

    function formatLatency(sec) {
        const val = Number(sec);
        if (!Number.isFinite(val) || val <= 0) return '--';
        if (val < 1) return `${Math.round(val * 1000)}ms`;
        if (val < 10) return `${val.toFixed(1)}s`;
        return `${Math.round(val)}s`;
    }

    function extractStepPerf(genEntry) {
        const chat = genEntry?.chatModel;
        if (!chat) return null;
        const u = chat.usage || {};
        const outputTokens = Number(u.outputTokens) || 0;
        const thinkingTokens = Number(u.thinkingOutputTokens ?? u.thinkingTokens) || 0;
        const responseTokens = Number(u.responseOutputTokens ?? u.responseTokens) || Math.max(0, outputTokens - thinkingTokens);
        const inputTokens = Number(u.inputTokens) || 0;
        const cacheReadTokens = Number(u.cacheReadTokens) || 0;
        const cacheWriteTokens = Number(u.cacheWriteTokens) || 0;
        const ttftSec = parseDurationSec(chat.timeToFirstToken);
        const streamSec = parseDurationSec(chat.streamingDuration);

        let tokPerSec = 0;
        if (outputTokens > 0) {
            if (streamSec >= 0.08 && (outputTokens / streamSec) <= 1200) {
                tokPerSec = outputTokens / streamSec;
            } else if (ttftSec + streamSec >= 0.08) {
                tokPerSec = outputTokens / (ttftSec + streamSec);
            }
        }

        const totalPrompt = inputTokens + cacheReadTokens + cacheWriteTokens;
        const cacheHitPct = totalPrompt > 0 ? (cacheReadTokens / totalPrompt) * 100 : null;

        if (!outputTokens && !totalPrompt && !ttftSec && !streamSec) {
            return null;
        }

        return {
            tokPerSec,
            ttftSec,
            streamSec,
            outputTokens,
            thinkingTokens,
            responseTokens,
            inputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            cacheHitPct,
        };
    }

    function parseContextFromGenMeta(metaList, catalog) {
        let lastGen = null;
        const historySeries = [];
        let latestPerf = null;

        for (let i = 0; i < metaList.length; i++) {
            const entry = metaList[i];
            if (entry?.chatModel) {
                lastGen = entry;
            }
            const stepPerf = extractStepPerf(entry);
            if (stepPerf) {
                latestPerf = stepPerf;
                if (stepPerf.tokPerSec > 0) {
                    historySeries.push(stepPerf.tokPerSec);
                }
            }
        }

        const perf = latestPerf
            ? { ...latestPerf, historySeries: historySeries.slice(-SPARKLINE_BARS) }
            : null;

        if (!lastGen) {
            return {
                active: true,
                empty: true,
                modelLabel: '当前对话',
                usedTokens: 0,
                limitTokens: 1048576,
                requestBudgetTokens: 0,
                usedPct: 0,
                breakdown: null,
                perf,
            };
        }

        const chat = lastGen.chatModel;
        const planner = lastGen.plannerConfig || {};
        const modelId = planner.modelName || '';
        const modelLabel = chat.modelDisplayName || catalog[modelId]?.displayName || modelId || chat.responseModel || '当前模型';
        const chatStart = chat.chatStartMetadata || {};
        const cwm = chatStart.contextWindowMetadata || {};
        const requestBudgetTokens = Number(cwm.maxContextTokens) || 0;
        const limitTokens = inferContextLimit(modelId, requestBudgetTokens, catalog);

        const stats = {
            user: 0,
            agent: 0,
            tool: 0,
            system: 0,
            custom: 0,
        };

        let breakdownTotal = 0;
        const groups = Array.isArray(cwm.tokenBreakdown?.groups) ? cwm.tokenBreakdown.groups : [];
        if (groups.length) {
            for (const g of groups) {
                const gType = normalizeTokenType(g.type);
                const gTok = Number(g.numTokens) || 0;
                if (gType === 'SYSTEM_PROMPT') {
                    let extracted = 0;
                    for (const child of (g.children || [])) {
                        const cTok = Number(child.numTokens) || 0;
                        if (child.name === 'flows' || child.name === 'skills' || child.name === 'subagents') {
                            stats.custom += cTok;
                            extracted += cTok;
                        }
                    }
                    stats.system += Math.max(0, gTok - extracted);
                } else if (gType === 'TOOLS') {
                    stats.system += gTok;
                } else if (['RULES', 'MCP_TOOLS', 'SKILLS', 'SUBAGENTS', 'WORKFLOWS', 'PLUGINS', 'FLOWS'].includes(gType)) {
                    stats.custom += gTok;
                } else if (gType === 'CHAT_MESSAGES') {
                    const children = Array.isArray(g.children) ? g.children : [];
                    if (children.length) {
                        for (const item of children) {
                            const name = String(item.name || '');
                            const tok = Number(item.numTokens) || 0;
                            const stepType = name.includes(': ') ? name.split(': ').slice(1).join(': ') : '';
                            if (stepType === 'USER_INPUT') stats.user += tok;
                            else if (stepType === 'PLANNER_RESPONSE' || stepType === 'CHECKPOINT') stats.agent += tok;
                            else if (!stepType || ['UNSPECIFIED', 'DUMMY', 'FINISH', 'SYSTEM_MESSAGE'].includes(stepType)) stats.system += tok;
                            else stats.tool += tok;
                        }
                    } else {
                        stats.agent += gTok;
                    }
                }
            }
            breakdownTotal = stats.user + stats.agent + stats.tool + stats.system + stats.custom;
        }

        const apiUsage = chat.usage || {};
        const usageTotal =
            (Number(apiUsage.inputTokens) || 0) +
            (Number(apiUsage.cacheReadTokens) || 0) +
            (Number(apiUsage.outputTokens) || 0);
        const estimatedUsed = Number(cwm.estimatedTokensUsed) || 0;
        const rawTotal = Number(cwm.tokenBreakdown?.totalTokens) || 0;
        const usedTokens = breakdownTotal || rawTotal || estimatedUsed || usageTotal;
        const usedPct = limitTokens > 0 ? Math.min(100, (usedTokens / limitTokens) * 100) : 0;

        return {
            active: true,
            empty: false,
            modelId,
            modelLabel,
            usedTokens,
            limitTokens,
            requestBudgetTokens,
            usedPct,
            breakdown: breakdownTotal > 0 ? stats : null,
            perf,
        };
    }

    async function fetchContextData(cascadeId) {
        if (!cascadeId) return { active: false };
        const [catalog, metaList] = await Promise.all([
            ensureModelCatalog(),
            fetchGeneratorMetadata(cascadeId),
        ]);
        return parseContextFromGenMeta(metaList, catalog);
    }

    async function refreshData(forceRefresh = false) {
        if (inFlightRefresh && !forceRefresh) return inFlightRefresh;
        state.refreshing = true;
        renderCard();

        inFlightRefresh = (async () => {
            const cascadeId = getActiveCascadeId();
            const [quotaRes, contextRes] = await Promise.allSettled([
                fetchQuotaData(forceRefresh),
                fetchContextData(cascadeId),
            ]);

            if (quotaRes.status === 'fulfilled') {
                state.quota = quotaRes.value;
                state.error = null;
                updateQuotaTracker(quotaRes.value?.allBuckets);
            } else if (!state.quota) {
                state.error = quotaRes.reason?.message || '获取用量失败';
            }

            if (contextRes.status === 'fulfilled') {
                state.context = contextRes.value;
                if (contextRes.value?.perf && contextRes.value.perf.tokPerSec > 0) {
                    state.lastPerf = contextRes.value.perf;
                }
            } else {
                state.context = cascadeId ? { active: true, error: contextRes.reason?.message || '上下文读取失败' } : { active: false };
            }

            state.loading = false;
            state.refreshing = false;
            state.lastUpdatedAt = Date.now();
            renderCard();
        })();

        try {
            await inFlightRefresh;
        } finally {
            inFlightRefresh = null;
        }
    }

    function isInsideElement(node, container) {
        let cur = node;
        while (cur) {
            if (cur === container) return true;
            cur = cur.parentElement;
        }
        return false;
    }

    function isStopButtonVisible() {
        if (typeof document.querySelectorAll !== 'function') return false;
        const nav = typeof document.querySelector === 'function'
            ? (document.querySelector('[role="navigation"][aria-label="Sidebar"]') || document.querySelector('[role="navigation"]'))
            : null;
        try {
            const btns = document.querySelectorAll(
                'button[aria-label*="Stop" i], button[aria-label*="Cancel" i], button[aria-label*="停止"], button[aria-label*="终止"], [data-testid*="stop" i], [data-testid*="cancel-button" i]'
            );
            for (const el of btns) {
                if (hostEl && isInsideElement(el, hostEl)) continue;
                if (nav && isInsideElement(el, nav)) continue;
                if (el.disabled) continue;
                return true;
            }
        } catch {
            // ignore selector issues in stripped mocks
        }
        return false;
    }

    function measureConversationText() {
        const hasQs = typeof document.querySelector === 'function';
        const root = (hasQs
            ? (document.querySelector('main') || document.querySelector('[data-testid="conversation-view"]') || document.querySelector('[role="main"]'))
            : null) || document.body;
        if (!root) return { len: -1, text: '' };
        const text = String(root.textContent || '');
        let effectiveLen = text.length;
        if (root === document.body && hasQs) {
            const nav = document.querySelector('[role="navigation"]');
            if (nav && nav.textContent) {
                effectiveLen = Math.max(0, effectiveLen - String(nav.textContent).length);
            }
        }
        return { len: effectiveLen, text };
    }

    function estimateTokensForDelta(deltaSlice) {
        const s = String(deltaSlice || '');
        if (!s.length) return 0;
        const cjkMatches = s.match(/[\u3400-\u9fff\uf900-\ufaff]/g);
        const cjkCount = cjkMatches ? cjkMatches.length : 0;
        const nonCjk = s.length - cjkCount;
        return Math.max(0.5, cjkCount * 0.65 + nonCjk * 0.26);
    }

    function pushLiveStreamSample(tokens, stepMs = STREAM_SAMPLE_MS) {
        const now = Date.now();
        if (!liveStream.active) {
            liveStream.active = true;
            liveStream.startedAt = now - 600;
        }
        if (liveStream.phase === 'prefill' || !liveStream.firstTokenAt) {
            liveStream.phase = 'streaming';
            liveStream.firstTokenAt = now;
            liveStream.ttftSec = Math.max(0.05, (now - liveStream.startedAt) / 1000);
        }
        const tok = Math.max(0.5, Number(tokens) || 0.5);
        liveStream.samples.push({ ts: now, tokens: tok });
        liveStream.samples = liveStream.samples.filter((s) => s.ts >= now - 2500);
        const sumTok = liveStream.samples.reduce((acc, s) => acc + s.tokens, 0);
        const spanSec = Math.max(
            stepMs / 1000,
            ((now - liveStream.samples[0].ts) / 1000) + (stepMs / 1000)
        );
        const instTps = sumTok / spanSec;
        liveStream.ewmaTps = liveStream.ewmaTps > 0 ? (liveStream.ewmaTps * 0.62 + instTps * 0.38) : instTps;
        liveStream.lastGrowthAt = now;
        if (liveStream.ewmaTps > 0) {
            liveStream.sparkline.push(liveStream.ewmaTps);
            if (liveStream.sparkline.length > SPARKLINE_BARS) {
                liveStream.sparkline = liveStream.sparkline.slice(-SPARKLINE_BARS);
            }
        }
    }

    function tickLiveStreamSampler() {
        const now = Date.now();
        if (now - liveStream.lastLocationSwitchAt < 1000) {
            liveStream.lastCharCount = -1;
            liveStream.domMutated = false;
            return;
        }

        const stopVisible = isStopButtonVisible();
        if (!stopVisible && !liveStream.active && !liveStream.domMutated) {
            return;
        }

        const { len, text } = measureConversationText();
        liveStream.domMutated = false;
        if (len < 0) return;

        if (liveStream.lastCharCount < 0) {
            liveStream.lastCharCount = len;
            if (stopVisible) {
                liveStream.active = true;
                liveStream.phase = 'prefill';
                liveStream.startedAt = now;
                liveStream.firstTokenAt = 0;
                liveStream.ttftSec = 0;
                liveStream.lastGrowthAt = now;
                liveStream.pendingTickAt = 0;
                liveStream.ewmaTps = 0;
                liveStream.samples = [];
                liveStream.sparkline = [];
                renderCard();
            }
            return;
        }

        const deltaChars = len - liveStream.lastCharCount;
        liveStream.lastCharCount = len;

        if ((!stopVisible && deltaChars > 3000) || deltaChars < 0) {
            if (!liveStream.active) {
                liveStream.pendingTickAt = 0;
                return;
            }
        }

        if (stopVisible && !liveStream.active) {
            liveStream.active = true;
            liveStream.startedAt = now;
            liveStream.firstTokenAt = 0;
            liveStream.ttftSec = 0;
            liveStream.lastGrowthAt = now;
            liveStream.pendingTickAt = 0;
            liveStream.ewmaTps = 0;
            liveStream.samples = [];
            liveStream.sparkline = [];
            liveStream.phase = deltaChars > 0 ? 'streaming' : 'prefill';
        } else if (!liveStream.active && deltaChars > 0 && deltaChars <= 3000) {
            if (liveStream.pendingTickAt && (now - liveStream.pendingTickAt) <= 1200) {
                liveStream.active = true;
                liveStream.phase = 'streaming';
                liveStream.startedAt = liveStream.pendingTickAt;
                liveStream.firstTokenAt = now;
                liveStream.ttftSec = Math.max(0.05, (now - liveStream.pendingTickAt) / 1000);
                liveStream.lastGrowthAt = now;
                liveStream.pendingTickAt = 0;
                liveStream.ewmaTps = 0;
                liveStream.samples = [];
                liveStream.sparkline = [];
            } else {
                liveStream.pendingTickAt = now;
                return;
            }
        }

        if (!liveStream.active) return;

        if (deltaChars > 0 && deltaChars <= 8000) {
            const tail = text.slice(-Math.min(deltaChars, text.length));
            const approxTokens = estimateTokensForDelta(tail);
            pushLiveStreamSample(approxTokens, STREAM_SAMPLE_MS);
        } else {
            liveStream.samples = liveStream.samples.filter((s) => s.ts >= now - 2500);
            if (liveStream.samples.length && liveStream.phase === 'streaming') {
                const sumTok = liveStream.samples.reduce((acc, s) => acc + s.tokens, 0);
                const windowSec = Math.max(0.35, (now - liveStream.samples[0].ts) / 1000 + 0.25);
                const instTps = sumTok / windowSec;
                liveStream.ewmaTps = liveStream.ewmaTps > 0 ? (liveStream.ewmaTps * 0.62 + instTps * 0.38) : instTps;
            }
        }

        if (!stopVisible && (now - Math.max(liveStream.lastGrowthAt, liveStream.startedAt)) > 1600) {
            liveStream.active = false;
            liveStream.phase = 'idle';
            liveStream.pendingTickAt = 0;
            liveStream.samples = [];
            renderCard();
            refreshData(false);
            return;
        }

        renderCard();
    }

    function findSettingsButton() {
        const byTestId = document.querySelector('[data-testid="settings-button"]');
        if (byTestId) return byTestId;

        const nav = document.querySelector('[role="navigation"][aria-label="Sidebar"]') || document.querySelector('[role="navigation"]');
        if (!nav) return null;
        const candidates = nav.querySelectorAll('button, a');
        for (const el of candidates) {
            const text = (el.textContent || '').trim();
            const label = (el.getAttribute('aria-label') || '').trim();
            if (text === 'Settings' || text === '设置' || text === '設定' || label === 'Settings' || label === '设置') {
                return el;
            }
        }
        return null;
    }

    function ensureShadowRoot() {
        if (!hostEl) {
            hostEl = document.createElement('div');
            hostEl.id = HOST_ID;
            hostEl.style.display = 'block';
            hostEl.style.width = '100%';
            hostEl.style.marginBottom = '6px';
        }
        if (!shadowRoot) {
            shadowRoot = hostEl.attachShadow({ mode: 'open' });
            const style = document.createElement('style');
            style.textContent = `
                :host {
                    display: block;
                    width: 100%;
                    font-family: inherit;
                    color: var(--foreground, #cccccc);
                    box-sizing: border-box;
                }
                * { box-sizing: border-box; }
                .card {
                    background: var(--sidebar-secondary, var(--card, rgba(255,255,255,0.04)));
                    border: 1px solid var(--card-border, var(--border, rgba(128,128,128,0.22)));
                    border-radius: 8px;
                    padding: 8px 9px;
                    font-size: 11.5px;
                    line-height: 1.35;
                    user-select: none;
                    transition: border-color 150ms ease, background-color 150ms ease;
                }
                .card:hover {
                    border-color: color-mix(in srgb, var(--muted-foreground, #888) 45%, transparent);
                }
                .header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 6px;
                    margin-bottom: 7px;
                    cursor: pointer;
                }
                .title-wrap {
                    display: flex;
                    align-items: center;
                    gap: 5px;
                    min-width: 0;
                    flex: 1;
                }
                .dot {
                    width: 6px;
                    height: 6px;
                    border-radius: 999px;
                    background: var(--success, #7aae66);
                    flex: none;
                }
                .dot.err { background: var(--error, #de5555); }
                .dot.loading { background: var(--warning, #e8975f); }
                .title {
                    font-weight: 600;
                    font-size: 11.5px;
                    color: var(--foreground, #cccccc);
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .plan-badge {
                    font-size: 10px;
                    color: var(--muted-foreground, #8c8c8c);
                    background: color-mix(in srgb, var(--foreground, #ccc) 8%, transparent);
                    border-radius: 4px;
                    padding: 0 4px;
                    white-space: nowrap;
                    max-width: 72px;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .actions {
                    display: flex;
                    align-items: center;
                    gap: 2px;
                    flex: none;
                }
                .icon-btn {
                    appearance: none;
                    background: transparent;
                    border: none;
                    color: var(--muted-foreground, #8c8c8c);
                    width: 20px;
                    height: 20px;
                    border-radius: 4px;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                    padding: 0;
                    font-size: 12px;
                }
                .icon-btn:hover {
                    color: var(--foreground, #ffffff);
                    background: color-mix(in srgb, var(--foreground, #ccc) 10%, transparent);
                }
                .spin {
                    animation: agy-spin 0.9s linear infinite;
                }
                @keyframes agy-spin {
                    from { transform: rotate(0deg); }
                    to { transform: rotate(360deg); }
                }
                .metric + .metric {
                    margin-top: 7px;
                }
                .metric-row {
                    display: flex;
                    align-items: baseline;
                    justify-content: space-between;
                    gap: 6px;
                    margin-bottom: 3px;
                }
                .metric-name {
                    color: var(--foreground, #cccccc);
                    font-size: 11px;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    min-width: 0;
                }
                .metric-val {
                    color: var(--muted-foreground, #8c8c8c);
                    font-size: 10.5px;
                    font-variant-numeric: tabular-nums;
                    white-space: nowrap;
                    flex: none;
                }
                .metric-val strong {
                    color: var(--foreground, #cccccc);
                    font-weight: 600;
                }
                .bar-track {
                    width: 100%;
                    height: 5px;
                    border-radius: 999px;
                    background: color-mix(in srgb, var(--foreground, #888) 12%, transparent);
                    overflow: hidden;
                    display: flex;
                }
                .bar-fill {
                    height: 100%;
                    border-radius: 999px;
                    transition: width 260ms ease;
                }
                .tone-success { background: var(--success, #7aae66); }
                .tone-warning { background: var(--warning, #e8975f); }
                .tone-error { background: var(--error, #de5555); }
                .tone-primary { background: var(--primary, #007acc); }
                .tone-muted { background: var(--muted-foreground, #6e6e6e); }

                .sub-reset {
                    margin-top: 2px;
                    font-size: 10px;
                    color: var(--muted-foreground, #8c8c8c);
                    display: flex;
                    justify-content: space-between;
                    gap: 4px;
                }

                .details {
                    margin-top: 8px;
                    padding-top: 7px;
                    border-top: 1px solid var(--border, rgba(128,128,128,0.18));
                }
                .sec-label {
                    font-size: 10px;
                    font-weight: 600;
                    color: var(--muted-foreground, #8c8c8c);
                    margin: 6px 0 4px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
                .sec-label:first-child { margin-top: 0; }
                .detail-item {
                    margin-bottom: 5px;
                }
                .detail-item:last-child { margin-bottom: 0; }
                .detail-row {
                    display: flex;
                    justify-content: space-between;
                    align-items: baseline;
                    gap: 6px;
                    font-size: 10.5px;
                    margin-bottom: 2px;
                }
                .detail-name {
                    color: var(--foreground, #cccccc);
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .detail-meta {
                    color: var(--muted-foreground, #8c8c8c);
                    font-size: 10px;
                    font-variant-numeric: tabular-nums;
                    white-space: nowrap;
                }
                .ctx-grid {
                    display: grid;
                    grid-template-columns: 1fr auto;
                    gap: 2px 8px;
                    font-size: 10.5px;
                    color: var(--muted-foreground, #8c8c8c);
                }
                .ctx-grid .num {
                    color: var(--foreground, #cccccc);
                    font-variant-numeric: tabular-nums;
                    text-align: right;
                }
                .empty-hint {
                    color: var(--muted-foreground, #8c8c8c);
                    font-size: 10.5px;
                    padding: 2px 0;
                }
                .err-box {
                    color: var(--error, #de5555);
                    font-size: 10.5px;
                    padding: 2px 0;
                    word-break: break-word;
                }
                @keyframes agy-pulse {
                    0%, 100% { opacity: 1; transform: scale(1); }
                    50% { opacity: 0.35; transform: scale(0.8); }
                }
                .speed-pill {
                    margin-top: 7px;
                    padding: 5px 7px;
                    border-radius: 6px;
                    border: 1px solid color-mix(in srgb, var(--border, rgba(128,128,128,0.22)) 80%, transparent);
                    background: color-mix(in srgb, var(--foreground, #ccc) 4%, transparent);
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 6px;
                    cursor: pointer;
                }
                .speed-left {
                    display: flex;
                    align-items: center;
                    gap: 5px;
                    min-width: 0;
                    flex: 1;
                }
                .speed-dot {
                    width: 6px;
                    height: 6px;
                    border-radius: 999px;
                    background: var(--muted-foreground, #6e6e6e);
                    flex: none;
                }
                .speed-dot.idle { background: var(--primary, #007acc); }
                .speed-dot.live {
                    background: var(--success, #7aae66);
                    animation: agy-pulse 1.1s ease-in-out infinite;
                }
                .speed-dot.prefill {
                    background: var(--warning, #e8975f);
                    animation: agy-pulse 0.9s ease-in-out infinite;
                }
                .speed-text {
                    font-size: 10.5px;
                    color: var(--muted-foreground, #8c8c8c);
                    font-variant-numeric: tabular-nums;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .speed-text strong {
                    color: var(--foreground, #cccccc);
                    font-weight: 600;
                }
                .speed-right {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    flex: none;
                }
                .sparkline {
                    display: inline-flex;
                    align-items: flex-end;
                    gap: 2px;
                    height: 14px;
                }
                .spark-bar {
                    width: 3px;
                    min-height: 2px;
                    border-radius: 1px;
                    background: var(--primary, #007acc);
                    opacity: 0.85;
                    transition: height 180ms ease;
                }
                .spark-bar.live {
                    background: var(--success, #7aae66);
                    opacity: 0.95;
                }
                .spark-bar.empty {
                    background: color-mix(in srgb, var(--foreground, #888) 18%, transparent);
                    opacity: 0.55;
                }
                .ttft-tag {
                    font-size: 10px;
                    color: var(--muted-foreground, #8c8c8c);
                    font-variant-numeric: tabular-nums;
                    white-space: nowrap;
                }
            `;
            const container = document.createElement('div');
            container.id = 'agy-usage-container';
            shadowRoot.appendChild(style);
            shadowRoot.appendChild(container);

            shadowRoot.addEventListener('click', (ev) => {
                const target = ev.target instanceof Element ? ev.target : null;
                if (!target) return;
                if (target.closest('[data-action="refresh"]')) {
                    ev.stopPropagation();
                    refreshData(true);
                    return;
                }
                if (target.closest('[data-action="toggle"]')) {
                    ev.stopPropagation();
                    state.expanded = !state.expanded;
                    writeExpandedPref(state.expanded);
                    renderCard();
                }
            });
        }
        return shadowRoot.getElementById('agy-usage-container');
    }

    function ensureMounted() {
        const settingsBtn = findSettingsButton();
        if (!settingsBtn || !settingsBtn.parentElement) return false;
        ensureShadowRoot();
        const parent = settingsBtn.parentElement;
        if (hostEl.parentElement !== parent || hostEl.nextElementSibling !== settingsBtn) {
            parent.insertBefore(hostEl, settingsBtn);
        }
        return true;
    }

    function renderBarHtml(pct, tone) {
        const width = pct == null ? 0 : Math.max(0, Math.min(100, pct));
        return `<div class="bar-track"><div class="bar-fill tone-${tone}" style="width:${width.toFixed(1)}%"></div></div>`;
    }

    function renderSparklineHtml(series, isLive) {
        const raw = Array.isArray(series) ? series.slice(-SPARKLINE_BARS) : [];
        const padCount = Math.max(0, SPARKLINE_BARS - raw.length);
        const padded = Array(padCount).fill(0).concat(raw);
        const validVals = padded.filter((n) => Number.isFinite(n) && n > 0);
        const maxVal = Math.max(60, ...validVals);
        const bars = padded.map((v) => {
            if (!Number.isFinite(v) || v <= 0) {
                return '<span class="spark-bar empty" style="height:2px"></span>';
            }
            const pct = Math.max(18, Math.min(100, Math.round((v / maxVal) * 100)));
            return `<span class="spark-bar${isLive ? ' live' : ''}" style="height:${pct}%"></span>`;
        });
        return `<div class="sparkline" aria-hidden="true">${bars.join('')}</div>`;
    }

    function renderSpeedPillHtml(ctx) {
        let leftHtml = '';
        let rightHtml = '';
        if (liveStream.active) {
            if (liveStream.phase === 'prefill') {
                const elapsedSec = Math.max(0.1, (Date.now() - liveStream.startedAt) / 1000);
                leftHtml = `<span class="speed-dot prefill"></span><span class="speed-text">预热中 <strong>${elapsedSec.toFixed(1)}s</strong></span>`;
                rightHtml = `${renderSparklineHtml(liveStream.sparkline, true)}<span class="ttft-tag">TTFT …</span>`;
            } else {
                leftHtml = `<span class="speed-dot live"></span><span class="speed-text">实时 <strong>${liveStream.ewmaTps.toFixed(1)}</strong> tok/s</span>`;
                rightHtml = `${renderSparklineHtml(liveStream.sparkline, true)}<span class="ttft-tag">TTFT ${escapeHtml(formatLatency(liveStream.ttftSec))}</span>`;
            }
        } else {
            const perf = (ctx && ctx.active && ctx.perf && ctx.perf.tokPerSec > 0) ? ctx.perf : state.lastPerf;
            if (perf && perf.tokPerSec > 0) {
                const series = perf.historySeries && perf.historySeries.length ? perf.historySeries : [perf.tokPerSec];
                leftHtml = `<span class="speed-dot idle"></span><span class="speed-text">最近 <strong>${perf.tokPerSec.toFixed(1)}</strong> tok/s</span>`;
                rightHtml = `${renderSparklineHtml(series, false)}<span class="ttft-tag">TTFT ${escapeHtml(formatLatency(perf.ttftSec))}</span>`;
            } else {
                leftHtml = `<span class="speed-dot"></span><span class="speed-text">速率 <strong>--</strong> tok/s</span>`;
                rightHtml = `${renderSparklineHtml([], false)}<span class="ttft-tag">TTFT --</span>`;
            }
        }
        return `
            <div class="speed-pill" data-action="toggle" title="点击展开或收起生成性能详情">
                <div class="speed-left">${leftHtml}</div>
                <div class="speed-right">${rightHtml}</div>
            </div>
        `;
    }

    function renderQuotaMetricHtml(labelPrefix, bucket, isQuotaLoading) {
        if (!bucket) {
            return `
                <div class="metric" data-action="toggle" style="cursor:pointer">
                    <div class="metric-row">
                        <span class="metric-name">${escapeHtml(labelPrefix)}</span>
                        <span class="metric-val">${isQuotaLoading ? '读取中…' : '暂无数据'}</span>
                    </div>
                    ${renderBarHtml(0, 'muted')}
                </div>
            `;
        }
        const pctStr = bucket.remainingPct != null
            ? `${bucket.remainingPct}% 剩余`
            : (bucket.disabled ? '已耗尽' : '可用');
        const barPct = bucket.remainingPct != null
            ? bucket.remainingPct
            : (bucket.disabled ? 0 : 100);
        const resetStr = formatResetCountdown(bucket.resetTimeMs);
        const tone = quotaTone(bucket.remainingPct, bucket.disabled);
        const rawSub = !isGenericQuotaName(bucket.seriesKey)
            ? bucket.seriesKey
            : (!isGenericQuotaName(bucket.groupName)
                ? bucket.groupName
                : (!isGenericQuotaName(bucket.title) && bucket.title !== labelPrefix ? bucket.title : ''));
        const displayLabel = rawSub ? `${labelPrefix} · ${rawSub}` : labelPrefix;
        return `
            <div class="metric" data-action="toggle" style="cursor:pointer">
                <div class="metric-row">
                    <span class="metric-name" title="${escapeHtml(bucket.shortLabel || displayLabel)}">${escapeHtml(displayLabel)}</span>
                    <span class="metric-val"><strong>${escapeHtml(pctStr)}</strong></span>
                </div>
                ${renderBarHtml(barPct, tone)}
                ${resetStr ? `<div class="sub-reset"><span>${escapeHtml(bucket.windowLabel || labelPrefix)}</span><span>${escapeHtml(resetStr)}</span></div>` : ''}
            </div>
        `;
    }

    function renderCard() {
        if (!ensureMounted()) return;
        const container = ensureShadowRoot();
        if (!container) return;

        const quota = state.quota;
        const ctx = state.context;
        const { weeklyBucket, fiveHourBucket } = quota
            ? pickPersistentQuotaBuckets(quota.allBuckets)
            : { weeklyBucket: null, fiveHourBucket: null };

        let dotClass = 'dot';
        if (state.error && !quota) dotClass += ' err';
        else if (state.loading || state.refreshing) dotClass += ' loading';

        const planBadge = quota?.planName
            ? `<span class="plan-badge" title="${escapeHtml(quota.planName)}">${escapeHtml(quota.planName.replace(/^Google\s+/i, ''))}</span>`
            : '';

        let quotaHtml = '';
        if (state.error && !quota) {
            quotaHtml = `<div class="err-box">${escapeHtml(state.error)}</div>`;
        } else {
            const isQuotaLoading = state.loading && !quota;
            quotaHtml = [
                renderQuotaMetricHtml('周额度', weeklyBucket, isQuotaLoading),
                renderQuotaMetricHtml('5小时额度', fiveHourBucket, isQuotaLoading),
            ].join('');
        }

        let ctxHtml = '';
        if (ctx && ctx.active) {
            if (ctx.error) {
                ctxHtml = `
                    <div class="metric" data-action="toggle" style="cursor:pointer">
                        <div class="metric-row">
                            <span class="metric-name">上下文</span>
                            <span class="metric-val">读取失败</span>
                        </div>
                        ${renderBarHtml(0, 'muted')}
                    </div>
                `;
            } else {
                const usedStr = formatTokens(ctx.usedTokens);
                const limitStr = formatTokens(ctx.limitTokens);
                const pctNum = Number(ctx.usedPct) || 0;
                const tone = contextTone(pctNum);
                ctxHtml = `
                    <div class="metric" data-action="toggle" style="cursor:pointer">
                        <div class="metric-row">
                            <span class="metric-name" title="${escapeHtml(ctx.modelLabel)}">上下文 · ${escapeHtml(usedStr)}/${escapeHtml(limitStr)}</span>
                            <span class="metric-val"><strong>${pctNum.toFixed(1)}%</strong></span>
                        </div>
                        ${renderBarHtml(pctNum, tone)}
                    </div>
                `;
            }
        } else {
            ctxHtml = `
                <div class="metric" data-action="toggle" style="cursor:pointer">
                    <div class="metric-row">
                        <span class="metric-name">上下文</span>
                        <span class="metric-val">未打开对话</span>
                    </div>
                    ${renderBarHtml(0, 'muted')}
                </div>
            `;
        }

        const speedHtml = renderSpeedPillHtml(ctx);

        let detailsHtml = '';
        if (state.expanded) {
            const parts = [];
            if (quota && quota.allBuckets.length) {
                const creditsText = quota.credits != null ? `<span>AI 额度: ${escapeHtml(quota.credits)}</span>` : '';
                parts.push(`<div class="sec-label"><span>全部模型配额</span>${creditsText}</div>`);
                for (const b of quota.allBuckets) {
                    const pStr = b.remainingPct != null ? `${b.remainingPct}%` : '--';
                    const rStr = formatResetCountdown(b.resetTimeMs);
                    const bTone = quotaTone(b.remainingPct, b.disabled);
                    parts.push(`
                        <div class="detail-item">
                            <div class="detail-row">
                                <span class="detail-name" title="${escapeHtml(b.shortLabel)}">${escapeHtml(b.shortLabel)}</span>
                                <span class="detail-meta">${escapeHtml(pStr)}${rStr ? ` · ${escapeHtml(rStr)}` : ''}</span>
                            </div>
                            ${renderBarHtml(b.remainingPct ?? 0, bTone)}
                        </div>
                    `);
                }
            }

            if (ctx && ctx.active && !ctx.error) {
                const budgetPart = ctx.requestBudgetTokens
                    ? `<span>单次上限 ${escapeHtml(formatTokens(ctx.requestBudgetTokens))}</span>`
                    : '';
                parts.push(`<div class="sec-label"><span>上下文构成 (${escapeHtml(ctx.modelLabel)})</span>${budgetPart}</div>`);
                if (ctx.breakdown) {
                    parts.push(`
                        <div class="ctx-grid">
                            <span>用户消息</span><span class="num">${escapeHtml(formatTokens(ctx.breakdown.user))}</span>
                            <span>智能体回复</span><span class="num">${escapeHtml(formatTokens(ctx.breakdown.agent))}</span>
                            <span>工具调用</span><span class="num">${escapeHtml(formatTokens(ctx.breakdown.tool))}</span>
                            <span>系统提示与工具</span><span class="num">${escapeHtml(formatTokens(ctx.breakdown.system))}</span>
                            <span>规则 / 技能 / MCP</span><span class="num">${escapeHtml(formatTokens(ctx.breakdown.custom))}</span>
                        </div>
                    `);
                } else {
                    parts.push(`<div class="empty-hint">${ctx.empty ? '等待首轮生成后统计明细' : `已估算使用 ${escapeHtml(formatTokens(ctx.usedTokens))} tokens`}</div>`);
                }
            }

            const detailPerf = (ctx && ctx.active && ctx.perf) ? ctx.perf : state.lastPerf;
            if (detailPerf || liveStream.active) {
                parts.push('<div class="sec-label"><span>生成性能</span></div>');
                const speedValStr = liveStream.active && liveStream.phase === 'streaming' && liveStream.ewmaTps > 0
                    ? `${liveStream.ewmaTps.toFixed(1)} tok/s (实时)`
                    : (detailPerf && detailPerf.tokPerSec > 0 ? `${detailPerf.tokPerSec.toFixed(1)} tok/s` : '--');
                const ttftStr = liveStream.active && liveStream.phase === 'streaming'
                    ? formatLatency(liveStream.ttftSec)
                    : (liveStream.active && liveStream.phase === 'prefill'
                        ? '等待首字'
                        : (detailPerf ? formatLatency(detailPerf.ttftSec) : '--'));
                const cacheStr = detailPerf && detailPerf.cacheHitPct != null
                    ? `${detailPerf.cacheHitPct.toFixed(1)}%`
                    : '--';
                let outStr = '--';
                if (detailPerf && detailPerf.outputTokens > 0) {
                    outStr = detailPerf.thinkingTokens > 0
                        ? `回复 ${formatTokens(detailPerf.responseTokens)} · 思考 ${formatTokens(detailPerf.thinkingTokens)}`
                        : `${formatTokens(detailPerf.outputTokens)} tokens`;
                }
                parts.push(`
                    <div class="ctx-grid">
                        <span>生成速度</span><span class="num">${escapeHtml(speedValStr)}</span>
                        <span>首字延迟 (TTFT)</span><span class="num">${escapeHtml(ttftStr)}</span>
                        <span>缓存命中率</span><span class="num">${escapeHtml(cacheStr)}</span>
                        <span>本轮输出</span><span class="num">${escapeHtml(outStr)}</span>
                    </div>
                `);
            }

            if (parts.length) {
                detailsHtml = `<div class="details">${parts.join('')}</div>`;
            }
        }

        const nextHtml = `
            <div class="card" data-testid="sidebar-usage-card">
                <div class="header" data-action="toggle" title="点击展开或收起详细用量">
                    <div class="title-wrap">
                        <span class="${dotClass}"></span>
                        <span class="title">实时用量</span>
                        ${planBadge}
                    </div>
                    <div class="actions">
                        <button type="button" class="icon-btn ${state.refreshing ? 'spin' : ''}" data-action="refresh" title="立即刷新用量" aria-label="刷新用量">↻</button>
                        <button type="button" class="icon-btn" data-action="toggle" title="${state.expanded ? '收起详情' : '展开详情'}" aria-label="切换详情">${state.expanded ? '▴' : '▾'}</button>
                    </div>
                </div>
                ${quotaHtml}
                ${ctxHtml}
                ${speedHtml}
                ${detailsHtml}
            </div>
        `;

        if (nextHtml !== lastRenderedKey) {
            lastRenderedKey = nextHtml;
            container.innerHTML = nextHtml;
        }
    }

    function handleLocationChanged(curLoc) {
        state.lastLocationKey = curLoc;
        liveStream.lastLocationSwitchAt = Date.now();
        liveStream.lastCharCount = -1;
        liveStream.pendingTickAt = 0;
        if (!isStopButtonVisible()) {
            liveStream.active = false;
            liveStream.phase = 'idle';
        }
        refreshData(false);
    }

    function scheduleMountAndCheckUrl() {
        const curLoc = (window.location.pathname || '') + (window.location.search || '');
        if (curLoc !== state.lastLocationKey) {
            handleLocationChanged(curLoc);
        }
        if (mountRaf) return;
        mountRaf = requestAnimationFrame(() => {
            mountRaf = 0;
            if (ensureMounted() && !lastRenderedKey) {
                renderCard();
            }
        });
    }

    function start() {
        const rootTarget = document.body || document.documentElement;
        if (!rootTarget) return;

        const observer = new MutationObserver((mutations) => {
            if (Array.isArray(mutations)) {
                for (let i = 0; i < mutations.length; i++) {
                    if (!hostEl || !isInsideElement(mutations[i]?.target, hostEl)) {
                        liveStream.domMutated = true;
                        break;
                    }
                }
            }
            scheduleMountAndCheckUrl();
        });
        observer.observe(rootTarget, { childList: true, subtree: true, characterData: true });

        window.addEventListener('popstate', () => scheduleMountAndCheckUrl());
        window.addEventListener('hashchange', () => scheduleMountAndCheckUrl());
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) refreshData(false);
        });

        ensureMounted();
        renderCard();
        refreshData(false);

        if (!refreshTimer) {
            refreshTimer = setInterval(() => {
                if (!document.hidden) refreshData(false);
            }, POLL_INTERVAL_MS);
        }
        if (!countdownTimer) {
            countdownTimer = setInterval(() => {
                if (!document.hidden && state.quota) renderCard();
            }, COUNTDOWN_TICK_MS);
        }
        if (!urlCheckTimer) {
            urlCheckTimer = setInterval(() => {
                const cur = (window.location.pathname || '') + (window.location.search || '');
                if (cur !== state.lastLocationKey) {
                    handleLocationChanged(cur);
                }
            }, 800);
        }
        if (!streamSamplerTimer) {
            streamSamplerTimer = setInterval(() => {
                if (!document.hidden) tickLiveStreamSampler();
            }, STREAM_SAMPLE_MS);
        }
    }

    window.__agySidebarUsageRefresh = (force) => refreshData(Boolean(force));
    window.__agySidebarUsageStreamControl = {
        startPrefill() {
            const now = Date.now();
            liveStream.active = true;
            liveStream.phase = 'prefill';
            liveStream.startedAt = now;
            liveStream.firstTokenAt = 0;
            liveStream.ttftSec = 0;
            liveStream.lastGrowthAt = now;
            liveStream.pendingTickAt = 0;
            liveStream.ewmaTps = 0;
            liveStream.samples = [];
            liveStream.sparkline = [];
            renderCard();
        },
        pushChunk(tokens = 24, dtMs = STREAM_SAMPLE_MS) {
            pushLiveStreamSample(tokens, dtMs);
            renderCard();
        },
        finish(shouldRefresh = true) {
            liveStream.active = false;
            liveStream.phase = 'idle';
            liveStream.pendingTickAt = 0;
            liveStream.samples = [];
            renderCard();
            if (shouldRefresh) return refreshData(false);
            return Promise.resolve();
        },
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
    window.addEventListener('load', () => {
        ensureMounted();
        renderCard();
    });
})();
/* --- ANTIGRAVITY SIDEBAR USAGE END --- */
