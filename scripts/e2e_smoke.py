"""
Playwright E2E Smoke Test for OmniGuard Telemetry Web dApp.
Serves the built `web/dist/` bundle over a local HTTP server, exercises the full
10-second multi-tier escalation scenario on Desktop (1440x900) and Mobile (390x844),
and asserts ZERO console errors and ZERO uncaught page errors.
"""

import http.server
import json
import os
import socketserver
import sys
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DIST_DIR = ROOT / "web" / "dist"


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIST_DIR), **kwargs)

    def log_message(self, format, *args):
        pass


def start_server():
    # Bind inside Chromium-safe ephemeral range (avoids restricted ports like 6000/6665)
    for port in range(18410, 18510):
        try:
            server = socketserver.TCPServer(("127.0.0.1", port), QuietHandler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            return server, port
        except OSError:
            continue
    raise RuntimeError("No free Chromium-safe local port available in 18410-18509")


def main():
    if not (DIST_DIR / "index.html").exists():
        print(f"ERROR: {DIST_DIR / 'index.html'} not found. Run `npm run web:build` first.")
        sys.exit(1)

    server, port = start_server()
    url = f"http://127.0.0.1:{port}/index.html"
    console_errors = []
    page_errors = []

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)

            # 1. Desktop E2E Interactive Flow (1440x900)
            ctx = browser.new_context(viewport={"width": 1440, "height": 900})
            page = ctx.new_page()
            page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
            page.on("pageerror", lambda err: page_errors.append(str(err)))

            # Abort external RPC fetches quickly during offline-safe smoke test? No, allow real fetches or clean fallback
            page.goto(url, wait_until="domcontentloaded", timeout=15000)
            page.wait_for_selector('[data-testid="status-banner"]', timeout=10000)

            assert "OmniGuard Sentinel" in page.content(), "Missing main title"

            live_manifest = ROOT / "deployments" / "live.json"
            has_live_manifest = live_manifest.exists()
            if has_live_manifest:
                manifest = json.loads(live_manifest.read_text(encoding="utf-8"))
                proof = manifest.get("liveLoopProof") or {}
                # App boots directly into Live Testnet RPC tab when deployed=true
                assert page.locator("#vault-addr").is_visible()
                assert page.locator("#vault-addr").input_value() == manifest.get("originPriceVault")
                assert page.locator("#reactive-addr").input_value() == manifest.get("omniGuardReactive")
                for tx_key in ("originTx", "reactiveTx", "callbackTx"):
                    tx_hash = proof.get(tx_key)
                    if tx_hash:
                        assert page.locator(f'a[href*="{tx_hash}"]').count() >= 1, f"Missing live explorer link for {tx_key}"
                # Gap A: Live tab must show real measured 3-hop latencies (never 620ms/1.03s sim constants)
                hop2_txt = page.locator('[data-testid="hop2-latency"]').inner_text()
                total_txt = page.locator('[data-testid="total-omni-latency"]').inner_text()
                assert "7,060" in hop2_txt or "7060" in hop2_txt, f"Expected real live Hop 2 latency, got: {hop2_txt}"
                assert "10.46s" in total_txt, f"Expected real live 10.46s total latency, got: {total_txt}"
                # Gap B: Live tab vault metrics must match on-chain live state ($2,100 / 1.50x / 1 callback) + clear sandbox badge
                assert page.locator('[data-testid="metric-price"]').inner_text().strip() == "$2,100"
                assert page.locator('[data-testid="metric-hf"]').inner_text().strip() == "1.50x"
                assert page.locator('[data-testid="metric-callbacks"]').inner_text().strip() == "1"
                assert "INTERACTIVE SIMULATOR SANDBOX" in page.locator('[data-testid="sandbox-badge"]').inner_text()

                page.get_by_role("tab", name="Interactive Simulator").click()
                assert page.locator('[data-testid="sim-origin-tx"]').is_visible()
                assert page.locator('[data-testid="sim-reactive-tx"]').is_visible()

            assert page.locator('[data-testid="metric-callbacks"]').inner_text().strip() == "0"

            # Scenario 1: Mild Dip -> WARN (1/2), 0 callbacks
            page.click('[data-testid="btn-warn-1"]')
            assert page.locator('[data-testid="pipeline-tier"]').inner_text().strip() == "WARN"
            assert page.locator('[data-testid="metric-callbacks"]').inner_text().strip() == "0"

            # Scenario 2: 2nd Dip -> Auto-escalates to REBALANCE!
            page.click('[data-testid="btn-warn-2"]')
            assert page.locator('[data-testid="pipeline-tier"]').inner_text().strip() == "REBALANCE"
            assert page.locator('[data-testid="metric-callbacks"]').inner_text().strip() == "1"

            # Scenario 4: 200ms Burst (+3s, 15 Base blocks) -> Suppressed by wall-clock cooldown!
            page.click('[data-testid="btn-cooldown"]')
            assert page.locator('[data-testid="pipeline-tier"]').inner_text().strip() == "COOLDOWN_SUPPRESSED"
            assert page.locator('[data-testid="metric-suppressed"]').inner_text().strip() == "1"

            # Scenario 5: Flash Crash -> Bypasses cooldown -> EMERGENCY_FREEZE!
            page.click('[data-testid="btn-freeze"]')
            assert page.locator('[data-testid="pipeline-tier"]').inner_text().strip() == "EMERGENCY_FREEZE"
            assert "FROZEN" in page.locator('[data-testid="freeze-badge"]').inner_text().strip()
            assert page.locator('[data-testid="metric-callbacks"]').inner_text().strip() == "2"

            # Scenario 6: Top-Up & Unfreeze
            page.click('[data-testid="btn-recover"]')
            assert "ACTIVE" in page.locator('[data-testid="freeze-badge"]').inner_text().strip()

            # Verify audit table populated 4 rows
            rows = page.locator('[data-testid="audit-tbody"] tr').count()
            assert rows == 4, f"Expected 4 audit rows, got {rows}"

            # Verify simulated TX hashes in the audit table do NOT render as dead external explorer links
            dead_sim_tx_links = page.locator('[data-testid="audit-tbody"] a[href*="/tx/"]').count()
            assert dead_sim_tx_links == 0, f"Simulated TX hashes must not link to live explorers (found {dead_sim_tx_links})"
            if not has_live_manifest:
                assert page.locator('[data-testid="sim-origin-tx"]').is_visible()
                assert page.locator('[data-testid="sim-reactive-tx"]').is_visible()

            # Check Live Testnet tab renders cleanly
            page.get_by_role("tab", name="Live Testnet RPC").click()
            assert page.locator("#vault-addr").is_visible()
            page.get_by_role("tab", name="Interactive Simulator").click()
            ctx.close()

            # 2. Mobile Viewport Smoke Check (390x844)
            mctx = browser.new_context(viewport={"width": 390, "height": 844})
            mpage = mctx.new_page()
            mpage.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
            mpage.on("pageerror", lambda err: page_errors.append(str(err)))
            mpage.goto(url, wait_until="domcontentloaded", timeout=15000)
            if has_live_manifest:
                mpage.wait_for_selector("#vault-addr", timeout=10000)
                overflow_live = mpage.evaluate("document.documentElement.scrollWidth > window.innerWidth + 2")
                assert not overflow_live, "Detected horizontal overflow on 390px mobile viewport (Live Testnet tab)!"
                mpage.get_by_role("tab", name="Interactive Simulator").click()
            mpage.wait_for_selector('[data-testid="btn-rebalance"]', timeout=10000)
            mpage.click('[data-testid="btn-rebalance"]')
            assert mpage.locator('[data-testid="pipeline-tier"]').inner_text().strip() == "REBALANCE"
            # Verify no horizontal overflow on mobile viewport (both tabs)
            overflow = mpage.evaluate("document.documentElement.scrollWidth > window.innerWidth + 2")
            assert not overflow, "Detected horizontal overflow on 390px mobile viewport (Simulator tab)!"
            mpage.get_by_role("tab", name="Live Testnet RPC").click()
            assert mpage.locator("#vault-addr").is_visible()
            overflow_live = mpage.evaluate("document.documentElement.scrollWidth > window.innerWidth + 2")
            assert not overflow_live, "Detected horizontal overflow on 390px mobile viewport (Live Testnet tab)!"
            mctx.close()

            browser.close()
    finally:
        server.shutdown()

    if console_errors or page_errors:
        print("E2E FAILED with errors:")
        for e in console_errors:
            print("  CONSOLE ERROR:", e)
        for e in page_errors:
            print("  PAGE ERROR:", e)
        sys.exit(1)

    print("PLAYWRIGHT E2E PASS: Desktop (1440x900) + Mobile (390x844), 6 scenarios verified, 0 console errors, 0 page errors, 0 mobile overflow!")


if __name__ == "__main__":
    main()
