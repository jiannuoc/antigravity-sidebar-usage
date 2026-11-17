import hashlib
import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import install  # noqa: E402

BASELINE_PRELOAD_SIZE = 522006
BASELINE_PRELOAD_SHA256 = (
    "43510b80d359c236d87c2d9b7abcfa00844d255c5799e9cefb1a34baaba9bb20"
)


class SidebarUsageInstallerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.live_asar = install.default_asar_path()
        if not self.live_asar.exists():
            self.skipTest(f"Live app.asar not found at {self.live_asar}")

        tests_dir = Path(__file__).resolve().parent
        self.tmp_asar = tests_dir / ".tmp_app.asar"
        self.tmp_bak = Path(str(self.tmp_asar) + ".usage.bak")
        self.tmp_stage = Path(str(self.tmp_asar) + ".usage.tmp")
        self._cleanup_temps()
        live_bak = Path(str(self.live_asar) + ".usage.bak")
        source_asar = live_bak if live_bak.exists() else self.live_asar
        shutil.copy2(source_asar, self.tmp_asar)
        if install.inspect_status(self.tmp_asar)["installed"]:
            install.apply_action(self.tmp_asar, "uninstall")
            if self.tmp_bak.exists():
                self.tmp_bak.unlink()

    def tearDown(self) -> None:
        self._cleanup_temps()

    def _cleanup_temps(self) -> None:
        for p in (self.tmp_asar, self.tmp_bak, self.tmp_stage):
            if p.exists():
                p.unlink()

    def _read_preload_bytes(self, asar_path: Path) -> bytes:
        tree, payload = install.read_asar(asar_path)
        install.verify_asar(tree, payload)
        entry = install.get_preload_entry(tree)
        offset = int(entry["offset"])
        size = int(entry["size"])
        return payload[offset : offset + size]

    def test_baseline_status_and_verify(self) -> None:
        tree, payload = install.read_asar(self.tmp_asar)
        install.verify_asar(tree, payload)

        status = install.inspect_status(self.tmp_asar)
        self.assertFalse(status["installed"])
        self.assertTrue(status["has_cn_localization"])
        self.assertEqual(status["preload_size"], BASELINE_PRELOAD_SIZE)
        self.assertEqual(status["preload_sha256"], BASELINE_PRELOAD_SHA256)
        self.assertFalse(status["backup_exists"])

    def test_install_idempotent_and_uninstall_roundtrip(self) -> None:
        res1 = install.apply_action(self.tmp_asar, "install")
        self.assertEqual(res1["action"], "install")
        self.assertFalse(res1["dry_run"])
        self.assertTrue(res1["installed"])
        self.assertEqual(res1["old_size"], BASELINE_PRELOAD_SIZE)
        self.assertGreater(res1["new_size"], BASELINE_PRELOAD_SIZE)
        self.assertTrue(self.tmp_bak.exists())
        self.assertFalse(self.tmp_stage.exists())

        preload1 = self._read_preload_bytes(self.tmp_asar).decode("utf-8")
        self.assertIn("/* --- ANTIGRAVITY CHINESE LOCALIZATION START --- */", preload1)
        self.assertIn(install.START_MARKER, preload1)
        self.assertIn(install.END_MARKER, preload1)

        status_installed = install.inspect_status(self.tmp_asar)
        self.assertTrue(status_installed["installed"])
        self.assertTrue(status_installed["has_cn_localization"])
        self.assertTrue(status_installed["backup_exists"])
        self.assertEqual(status_installed["preload_size"], res1["new_size"])
        self.assertEqual(status_installed["preload_sha256"], res1["new_sha256"])

        res2 = install.apply_action(self.tmp_asar, "install")
        self.assertTrue(res2["installed"])
        self.assertEqual(res2["new_size"], res1["new_size"])
        self.assertEqual(res2["new_sha256"], res1["new_sha256"])
        self._read_preload_bytes(self.tmp_asar)

        res3 = install.apply_action(self.tmp_asar, "uninstall")
        self.assertEqual(res3["action"], "uninstall")
        self.assertFalse(res3["installed"])
        self.assertEqual(res3["new_size"], BASELINE_PRELOAD_SIZE)
        self.assertEqual(res3["new_sha256"], BASELINE_PRELOAD_SHA256)

        preload_restored = self._read_preload_bytes(self.tmp_asar)
        self.assertEqual(len(preload_restored), BASELINE_PRELOAD_SIZE)
        self.assertEqual(
            hashlib.sha256(preload_restored).hexdigest(), BASELINE_PRELOAD_SHA256
        )

        status_uninstalled = install.inspect_status(self.tmp_asar)
        self.assertFalse(status_uninstalled["installed"])
        self.assertTrue(status_uninstalled["has_cn_localization"])
        self.assertEqual(status_uninstalled["preload_size"], BASELINE_PRELOAD_SIZE)
        self.assertEqual(status_uninstalled["preload_sha256"], BASELINE_PRELOAD_SHA256)

    def test_dry_run_does_not_modify_asar(self) -> None:
        before_sha = hashlib.sha256(self.tmp_asar.read_bytes()).hexdigest()
        res = install.apply_action(self.tmp_asar, "install", dry_run=True)
        self.assertTrue(res["dry_run"])
        self.assertTrue(res["installed"])
        self.assertFalse(self.tmp_bak.exists())
        after_sha = hashlib.sha256(self.tmp_asar.read_bytes()).hexdigest()
        self.assertEqual(after_sha, before_sha)

    def test_widget_markers_and_cli_status(self) -> None:
        widget_text = install.DEFAULT_WIDGET_PATH.read_text(encoding="utf-8").strip()
        self.assertTrue(widget_text.startswith(install.START_MARKER))
        self.assertTrue(widget_text.endswith(install.END_MARKER))
        self.assertIn("__agySidebarUsageStarted", widget_text)
        self.assertIn("__agySidebarUsageRefresh", widget_text)
        self.assertIn("POLL_INTERVAL_MS = 10000", widget_text)
        self.assertIn("COUNTDOWN_TICK_MS = 10000", widget_text)
        self.assertIn("QUOTA_TRACKER_STORAGE_KEY", widget_text)
        self.assertIn("updateQuotaTracker", widget_text)
        self.assertIn("sparkline", widget_text)
        self.assertIn("TTFT", widget_text)
        self.assertIn("缓存命中率", widget_text)
        self.assertIn("timeToFirstToken", widget_text)
        self.assertIn("周额度", widget_text)
        self.assertIn("5小时额度", widget_text)
        self.assertNotIn("max-height: 230px", widget_text)
        self.assertNotIn("overflow-y: auto", widget_text)

        rc = install.main(["--asar", str(self.tmp_asar), "--action", "status"])
        self.assertEqual(rc, 0)

    def test_recent_quota_change_pins_model_without_chat_flip(self) -> None:
        widget_path = install.DEFAULT_WIDGET_PATH.as_posix()
        node_script = r"""
const fs = require('fs');
const assert = require('assert');

const origSetInterval = global.setInterval;
global.setInterval = (...args) => {
    const t = origSetInterval(...args);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
};
global.Element = class Element {};
global.MutationObserver = class MutationObserver {
    observe() {}
    disconnect() {}
};
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);

const lsStore = new Map();
function makeMockEl(tag = 'div') {
    const el = {
        tagName: tag.toUpperCase(),
        id: '',
        style: {},
        children: [],
        parentElement: null,
        nextElementSibling: null,
        _innerHTML: '',
        set innerHTML(v) { this._innerHTML = String(v); },
        get innerHTML() { return this._innerHTML; },
        addEventListener() {},
        appendChild(child) {
            child.parentElement = this;
            if (this.children.length) {
                this.children[this.children.length - 1].nextElementSibling = child;
            }
            child.nextElementSibling = null;
            this.children.push(child);
            return child;
        },
        insertBefore(newNode, refNode) {
            if (newNode.parentElement && newNode.parentElement.children) {
                const oldIdx = newNode.parentElement.children.indexOf(newNode);
                if (oldIdx !== -1) newNode.parentElement.children.splice(oldIdx, 1);
            }
            const idx = this.children.indexOf(refNode);
            if (idx === -1) return this.appendChild(newNode);
            newNode.parentElement = this;
            this.children.splice(idx, 0, newNode);
            for (let i = 0; i < this.children.length; i++) {
                this.children[i].nextElementSibling = this.children[i + 1] || null;
            }
            return newNode;
        },
        attachShadow() {
            const shadow = {
                host: el,
                children: [],
                addEventListener() {},
                appendChild(child) {
                    child.parentElement = shadow;
                    shadow.children.push(child);
                    return child;
                },
                getElementById(targetId) {
                    return shadow.children.find((c) => c.id === targetId) || null;
                },
            };
            return shadow;
        },
    };
    return el;
}

const sidebarFooter = makeMockEl('div');
const settingsBtn = makeMockEl('button');
sidebarFooter.appendChild(settingsBtn);
const mockBody = makeMockEl('body');
mockBody.appendChild(sidebarFooter);

global.window = global;
global.window.self = global.window;
global.window.top = global.window;
global.window.localStorage = {
    getItem(k) { return lsStore.has(k) ? lsStore.get(k) : null; },
    setItem(k, v) { lsStore.set(k, String(v)); },
    removeItem(k) { lsStore.delete(k); },
};
global.window.location = {
    pathname: '/c/11111111-1111-4111-8111-111111111111',
    search: '',
    origin: 'http://127.0.0.1',
};
global.window.addEventListener = () => {};

global.document = {
    readyState: 'complete',
    hidden: false,
    body: mockBody,
    documentElement: mockBody,
    cookie: '',
    addEventListener() {},
    createElement(tag) { return makeMockEl(tag); },
    querySelector(sel) {
        if (sel === '[data-testid="settings-button"]') return settingsBtn;
        return null;
    },
};

const stateMock = {
    gemini5h: 0.90,
    geminiWeekly: 0.95,
    claude5h: 0.85,
    claudeWeekly: 0.88,
    claudeResetSkewMs: 0,
    chatModelName: 'claude-sonnet-4-6',
    chatModelLabel: 'Claude 4.6 Sonnet',
    chatUsed: 120000,
};

global.window.__AGY_MOCK_RPC__ = async (method, body) => {
    const base = 1800000000000;
    if (method === 'RetrieveUserQuotaSummary') {
        return {
            groups: [
                {
                    displayName: 'Gemini models',
                    buckets: [
                        {
                            bucketId: 'gemini-5h',
                            window: '5h',
                            remainingFraction: stateMock.gemini5h,
                            resetTime: new Date(base + 3 * 3600000).toISOString(),
                        },
                        {
                            bucketId: 'gemini-weekly',
                            window: 'weekly',
                            remainingFraction: stateMock.geminiWeekly,
                            resetTime: new Date(base + 4 * 86400000).toISOString(),
                        },
                    ],
                },
                {
                    displayName: 'Claude models',
                    buckets: [
                        {
                            bucketId: 'claude-5h',
                            window: '5h',
                            remainingFraction: stateMock.claude5h,
                            resetTime: new Date(base + 4 * 3600000 + stateMock.claudeResetSkewMs).toISOString(),
                        },
                        {
                            bucketId: 'claude-weekly',
                            window: 'weekly',
                            remainingFraction: stateMock.claudeWeekly,
                            resetTime: new Date(base + 5 * 86400000).toISOString(),
                        },
                    ],
                },
            ],
        };
    }
    if (method === 'GetUserStatus') {
        return { userStatus: { userTier: { name: 'Google AI Pro', availableCredits: 420 } } };
    }
    if (method === 'GetAvailableModels') {
        return {
            models: {
                'gemini-3.8-pro-high': { maxTokens: 1048576, displayName: 'Gemini 3.8 Pro' },
                'claude-sonnet-4-6': { maxTokens: 250000, displayName: 'Claude 4.6 Sonnet' },
            },
        };
    }
    if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
        return {
            generatorMetadata: [
                {
                    plannerConfig: { modelName: stateMock.chatModelName },
                    chatModel: {
                        modelDisplayName: stateMock.chatModelLabel,
                        chatStartMetadata: {
                            contextWindowMetadata: {
                                maxContextTokens: 256000,
                                tokenBreakdown: { totalTokens: stateMock.chatUsed, groups: [] },
                            },
                        },
                    },
                },
            ],
        };
    }
    return {};
};

// Intercept shadow container creation for reading rendered HTML
const origCreateElement = global.document.createElement;
let capturedContainer = null;
global.document.createElement = (tag) => {
    const el = origCreateElement(tag);
    if (tag.toLowerCase() === 'div') {
        const origAttach = el.attachShadow;
        el.attachShadow = (...a) => {
            const sh = origAttach.call(el, ...a);
            const origGetById = sh.getElementById;
            sh.getElementById = (id) => {
                const found = origGetById.call(sh, id);
                if (id === 'agy-usage-container' && found) capturedContainer = found;
                return found;
            };
            return sh;
        };
    }
    return el;
};

async function run() {
    eval(fs.readFileSync(WIDGET_PATH, 'utf8'));
    await new Promise((r) => setTimeout(r, 30));
    await global.window.__agySidebarUsageRefresh(true);

    assert.strictEqual(sidebarFooter.children[0].id, 'agy-sidebar-usage-host');
    assert.strictEqual(sidebarFooter.children[1], settingsBtn);

    // Initial seed: Claude 5h (0.85) < Gemini 5h (0.90) -> pinned to Claude models
    let html = capturedContainer.innerHTML;
    assert.ok(html.includes('周额度 · Claude models'), 'Initial weekly should pin Claude models');
    assert.ok(html.includes('5小时额度 · Claude models'), 'Initial 5h should pin Claude models');

    // Step 2: Consume Gemini quota while active conversation is still Claude -> switches to Gemini
    stateMock.gemini5h = 0.86;
    stateMock.geminiWeekly = 0.94;
    await global.window.__agySidebarUsageRefresh(true);
    html = capturedContainer.innerHTML;
    assert.ok(html.includes('周额度 · Gemini models'), 'Weekly should switch to Gemini after Gemini quota changes');
    assert.ok(html.includes('5小时额度 · Gemini models'), '5h should switch to Gemini after Gemini quota changes');
    assert.ok(html.includes('94% 剩余'), 'Should render new Gemini weekly percentage');
    assert.ok(html.includes('86% 剩余'), 'Should render new Gemini 5h percentage');

    // Step 3: Switch chat conversation & jitter resetTime without quota consumption -> stays on Gemini
    stateMock.chatModelName = 'claude-sonnet-4-6';
    stateMock.chatModelLabel = 'Claude 4.6 Sonnet';
    stateMock.chatUsed = 180000;
    stateMock.claudeResetSkewMs = 45000;
    global.window.location.pathname = '/c/22222222-2222-4222-8222-222222222222';
    await global.window.__agySidebarUsageRefresh(true);
    html = capturedContainer.innerHTML;
    assert.ok(html.includes('周额度 · Gemini models'), 'Chat switch & reset jitter must NOT switch away from Gemini');
    assert.ok(html.includes('5小时额度 · Gemini models'), 'Chat switch & reset jitter must NOT switch away from Gemini');
    assert.ok(html.includes('180.0k/250.0k'), 'Context bar should still update for active Claude chat');

    // Step 4: Navigate to home page (no active conversation) -> quota still stays on Gemini
    global.window.location.pathname = '/';
    await global.window.__agySidebarUsageRefresh(true);
    html = capturedContainer.innerHTML;
    assert.ok(html.includes('周额度 · Gemini models'), 'Home navigation must keep Gemini weekly pinned');
    assert.ok(html.includes('5小时额度 · Gemini models'), 'Home navigation must keep Gemini 5h pinned');
    assert.ok(html.includes('未打开对话'), 'Context should reflect home page state');

    // Step 5: Consume Claude quota -> immediately switches persistent display to Claude
    stateMock.claude5h = 0.78;
    stateMock.claudeWeekly = 0.84;
    await global.window.__agySidebarUsageRefresh(true);
    html = capturedContainer.innerHTML;
    assert.ok(html.includes('周额度 · Claude models'), 'Weekly should switch to Claude after Claude quota changes');
    assert.ok(html.includes('5小时额度 · Claude models'), '5h should switch to Claude after Claude quota changes');
    assert.ok(html.includes('84% 剩余'), 'Should render new Claude weekly percentage');
    assert.ok(html.includes('78% 剩余'), 'Should render new Claude 5h percentage');

    // Step 6: Open Gemini conversation with NO quota change -> stays pinned to Claude
    stateMock.chatModelName = 'gemini-3.8-pro-high';
    stateMock.chatModelLabel = 'Gemini 3.8 Pro';
    stateMock.chatUsed = 64000;
    global.window.location.pathname = '/c/33333333-3333-4333-8333-333333333333';
    await global.window.__agySidebarUsageRefresh(true);
    html = capturedContainer.innerHTML;
    assert.ok(html.includes('周额度 · Claude models'), 'Opening Gemini chat without quota change must keep Claude weekly');
    assert.ok(html.includes('5小时额度 · Claude models'), 'Opening Gemini chat without quota change must keep Claude 5h');

    // Step 7: Tracker persisted to localStorage
    const saved = JSON.parse(lsStore.get('agy_sidebar_usage_quota_tracker_v1') || '{}');
    assert.strictEqual(saved.pinnedSeriesKey, 'Claude models');
    console.log('NODE_QUOTA_PIN_TEST_OK');
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
"""
        full_js = f"const WIDGET_PATH = {json.dumps(widget_path)};\n" + node_script
        proc = subprocess.run(
            ["node", "-"],
            input=full_js,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        self.assertEqual(
            proc.returncode,
            0,
            f"Node behavioral test failed: stdout={proc.stdout!r}, stderr={proc.stderr!r}",
        )
        self.assertIn("NODE_QUOTA_PIN_TEST_OK", proc.stdout)

    def test_token_speed_sparkline_live_and_idle_metrics(self) -> None:
        widget_path = install.DEFAULT_WIDGET_PATH.as_posix()
        node_script = r"""
const fs = require('fs');
const assert = require('assert');

const origSetInterval = global.setInterval;
global.setInterval = (...args) => {
    const t = origSetInterval(...args);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
};
global.Element = class Element {};
global.MutationObserver = class MutationObserver {
    observe() {}
    disconnect() {}
};
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);

const lsStore = new Map();
let capturedContainer = null;
let shadowClickHandler = null;

function makeMockEl(tag = 'div') {
    const el = {
        tagName: tag.toUpperCase(),
        id: '',
        style: {},
        children: [],
        parentElement: null,
        nextElementSibling: null,
        _innerHTML: '',
        set innerHTML(v) { this._innerHTML = String(v); },
        get innerHTML() { return this._innerHTML; },
        addEventListener() {},
        appendChild(child) {
            child.parentElement = this;
            if (this.children.length) {
                this.children[this.children.length - 1].nextElementSibling = child;
            }
            child.nextElementSibling = null;
            this.children.push(child);
            return child;
        },
        insertBefore(newNode, refNode) {
            if (newNode.parentElement && newNode.parentElement.children) {
                const oldIdx = newNode.parentElement.children.indexOf(newNode);
                if (oldIdx !== -1) newNode.parentElement.children.splice(oldIdx, 1);
            }
            const idx = this.children.indexOf(refNode);
            if (idx === -1) return this.appendChild(newNode);
            newNode.parentElement = this;
            this.children.splice(idx, 0, newNode);
            for (let i = 0; i < this.children.length; i++) {
                this.children[i].nextElementSibling = this.children[i + 1] || null;
            }
            return newNode;
        },
        attachShadow() {
            const shadow = {
                host: el,
                children: [],
                addEventListener(type, fn) {
                    if (type === 'click') shadowClickHandler = fn;
                },
                appendChild(child) {
                    child.parentElement = shadow;
                    shadow.children.push(child);
                    return child;
                },
                getElementById(targetId) {
                    const found = shadow.children.find((c) => c.id === targetId) || null;
                    if (targetId === 'agy-usage-container' && found) capturedContainer = found;
                    return found;
                },
            };
            return shadow;
        },
    };
    return el;
}

const sidebarFooter = makeMockEl('div');
const settingsBtn = makeMockEl('button');
sidebarFooter.appendChild(settingsBtn);
const mockBody = makeMockEl('body');
mockBody.appendChild(sidebarFooter);

global.window = global;
global.window.self = global.window;
global.window.top = global.window;
global.window.localStorage = {
    getItem(k) { return lsStore.has(k) ? lsStore.get(k) : null; },
    setItem(k, v) { lsStore.set(k, String(v)); },
    removeItem(k) { lsStore.delete(k); },
};
global.window.location = {
    pathname: '/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    search: '',
    origin: 'http://127.0.0.1',
};
global.window.addEventListener = () => {};

global.document = {
    readyState: 'complete',
    hidden: false,
    body: mockBody,
    documentElement: mockBody,
    cookie: '',
    addEventListener() {},
    createElement(tag) { return makeMockEl(tag); },
    querySelector(sel) {
        if (sel === '[data-testid="settings-button"]') return settingsBtn;
        return null;
    },
};

const turn1 = {
    plannerConfig: { modelName: 'claude-sonnet-4-6' },
    chatModel: {
        modelDisplayName: 'Claude 4.6 Sonnet',
        timeToFirstToken: '1.82s',
        streamingDuration: '4.00s',
        usage: {
            inputTokens: 2049,
            outputTokens: 570,
            thinkingOutputTokens: 206,
            responseOutputTokens: 364,
            cacheReadTokens: 180434,
            cacheWriteTokens: 24,
        },
        chatStartMetadata: {
            contextWindowMetadata: {
                maxContextTokens: 250000,
                tokenBreakdown: { totalTokens: 182507, groups: [] },
            },
        },
    },
};

const turns = [turn1];

global.window.__AGY_MOCK_RPC__ = async (method, body) => {
    const base = 1800000000000;
    if (method === 'RetrieveUserQuotaSummary') {
        return {
            groups: [
                {
                    displayName: 'Claude models',
                    buckets: [
                        {
                            bucketId: 'claude-5h',
                            window: '5h',
                            remainingFraction: 0.72,
                            resetTime: new Date(base + 3 * 3600000).toISOString(),
                        },
                        {
                            bucketId: 'claude-weekly',
                            window: 'weekly',
                            remainingFraction: 0.85,
                            resetTime: new Date(base + 5 * 86400000).toISOString(),
                        },
                    ],
                },
            ],
        };
    }
    if (method === 'GetUserStatus') {
        return { userStatus: { userTier: { name: 'Google AI Pro', availableCredits: 420 } } };
    }
    if (method === 'GetAvailableModels') {
        return {
            models: {
                'claude-sonnet-4-6': { maxTokens: 250000, displayName: 'Claude 4.6 Sonnet' },
            },
        };
    }
    if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
        const offset = Number(body.generatorMetadataOffset) || 0;
        return { generatorMetadata: turns.slice(offset) };
    }
    return {};
};

async function run() {
    eval(fs.readFileSync(WIDGET_PATH, 'utf8'));
    await new Promise((r) => setTimeout(r, 30));
    await global.window.__agySidebarUsageRefresh(true);

    // 1. Completed turn telemetry in idle speed pill
    let html = capturedContainer.innerHTML;
    assert.ok(html.includes('speed-pill'), 'Speed pill should render below context');
    assert.ok(html.includes('最近 <strong>142.5</strong> tok/s'), 'Should render 570/4.00s = 142.5 tok/s');
    assert.ok(html.includes('TTFT 1.8s'), 'Should format 1.82s as TTFT 1.8s');
    assert.strictEqual((html.match(/class="spark-bar/g) || []).length, 10, 'Sparkline should render 10 bars');

    // 2. Buffered single-chunk tool-call spike guard (streamingDuration = 0.001s)
    turns.push({
        plannerConfig: { modelName: 'claude-sonnet-4-6' },
        chatModel: {
            modelDisplayName: 'Claude 4.6 Sonnet',
            timeToFirstToken: '2.00s',
            streamingDuration: '0.001s',
            usage: {
                inputTokens: 1000,
                outputTokens: 200,
                cacheReadTokens: 150000,
                cacheWriteTokens: 0,
            },
            chatStartMetadata: {
                contextWindowMetadata: {
                    maxContextTokens: 250000,
                    tokenBreakdown: { totalTokens: 151000, groups: [] },
                },
            },
        },
    });
    await global.window.__agySidebarUsageRefresh(true);
    html = capturedContainer.innerHTML;
    assert.ok(!html.includes('200000'), 'Must guard against 1ms decode spike');
    assert.ok(html.includes('最近 <strong>100.0</strong> tok/s'), 'Should fall back to total latency 200/(2.001s) = 100.0 tok/s');

    // 3. Live streaming transition (prefill -> streaming -> settled idle)
    const ctrl = global.window.__agySidebarUsageStreamControl;
    assert.ok(ctrl, '__agySidebarUsageStreamControl should be exposed');
    ctrl.startPrefill();
    html = capturedContainer.innerHTML;
    assert.ok(html.includes('预热中'), 'Prefill state should display 预热中');

    ctrl.pushChunk(42, 250);
    html = capturedContainer.innerHTML;
    assert.ok(html.includes('实时 <strong>'), 'Live streaming should display 实时 tok/s');
    assert.ok(html.includes('spark-bar live'), 'Live streaming should animate green spark bars');

    turns.push(turn1);
    await ctrl.finish(true);
    html = capturedContainer.innerHTML;
    assert.ok(html.includes('最近 <strong>142.5</strong> tok/s'), 'Finish should return to latest completed turn telemetry');

    // 4. Expanded details: 生成性能 (缓存命中率 + 本轮输出)
    assert.ok(typeof shadowClickHandler === 'function', 'Shadow click listener should be registered');
    shadowClickHandler({
        target: Object.assign(new global.Element(), {
            closest(sel) { return sel.includes('toggle') ? {} : null; },
        }),
        stopPropagation() {},
    });
    html = capturedContainer.innerHTML;
    assert.ok(html.includes('生成性能'), 'Expanded details should include 生成性能');
    assert.ok(html.includes('缓存命中率') && html.includes('98.9%'), 'Should render 98.9% cache hit rate');
    assert.ok(html.includes('本轮输出') && html.includes('回复 364 · 思考 206'), 'Should render response + thinking split');

    console.log('NODE_TOKEN_SPEED_TEST_OK');
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
"""
        full_js = f"const WIDGET_PATH = {json.dumps(widget_path)};\n" + node_script
        proc = subprocess.run(
            ["node", "-"],
            input=full_js,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        self.assertEqual(
            proc.returncode,
            0,
            f"Node speed test failed: stdout={proc.stdout!r}, stderr={proc.stderr!r}",
        )
        self.assertIn("NODE_TOKEN_SPEED_TEST_OK", proc.stdout)

    def test_project_files_present(self) -> None:
        for rel in (
            "src/sidebar-usage-widget.js",
            "install.py",
            "install.bat",
            "uninstall.bat",
            "preview.html",
        ):
            self.assertTrue((PROJECT_ROOT / rel).exists(), f"Missing {rel}")

    def test_bat_files_pure_ascii_crlf_and_runnable(self) -> None:
        for name in ("install.bat", "uninstall.bat"):
            bat = PROJECT_ROOT / name
            raw = bat.read_bytes()
            self.assertTrue(all(b < 128 for b in raw), f"{name} contains non-ASCII bytes")
            self.assertIn(b"\r\n", raw, f"{name} must use CRLF line endings")
            self.assertNotIn(b"\n", raw.replace(b"\r\n", b""), f"{name} contains bare LF")

            cmd = f'cmd.exe /c ""{bat}" --asar "{self.tmp_asar}" --dry-run < nul"'
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            self.assertEqual(
                proc.returncode,
                0,
                f"{name} failed (rc={proc.returncode}): stdout={proc.stdout!r}, stderr={proc.stderr!r}",
            )
            self.assertNotIn("not recognized", proc.stderr)
            self.assertNotIn("not recognized", proc.stdout)


if __name__ == "__main__":
    unittest.main()
