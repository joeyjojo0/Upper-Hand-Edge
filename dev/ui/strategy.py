# UI smoke test for /strategy against the mock dev server (MOCK=1 PORT=3100 node dev/server.mjs).
import asyncio, json, os, sys
from playwright.async_api import async_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3100"
OUT = os.path.join(os.path.dirname(__file__), "..", "shots"); os.makedirs(OUT, exist_ok=True)
async def main():
    rep = {}
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for name, w, h in [("desktop", 1440, 900), ("mobile", 390, 844)]:
            ctx = await b.new_context(viewport={"width": w, "height": h}, timezone_id="Europe/London")
            pg = await ctx.new_page(); errs = []
            pg.on("pageerror", lambda e: errs.append("pageerror: " + str(e) + " @ " + (e.stack or "")[:300]))
            pg.on("console", lambda m: errs.append("console: " + m.text) if m.type == "error" else None)
            await pg.goto(BASE + "/strategy"); await pg.wait_for_timeout(2500)
            r = rep[name] = {}
            r["rows"] = await pg.locator(".st-row:not(.st-head)").count()
            r["chips"] = await pg.locator("#feedChips .chip").all_inner_texts()
            r["phase"] = await pg.locator(".ph-title").inner_text()
            r["overflow"] = await pg.evaluate("document.documentElement.scrollWidth > innerWidth + 1")
            r["navActive"] = await pg.locator("nav.jump a[aria-current=page]").inner_text()
            await pg.screenshot(path=f"{OUT}/strat-{name}.png", full_page=False)
            await pg.click(".st-row:not(.st-head) .st-main >> nth=0"); await pg.wait_for_timeout(300)
            r["detail"] = await pg.locator(".st-detail .dt-c").count()
            await pg.screenshot(path=f"{OUT}/strat-{name}-detail.png", full_page=False)
            await pg.click('#modeTabs button[data-m="long"]'); await pg.wait_for_timeout(300)
            r["longRows"] = await pg.locator(".st-row:not(.st-head)").count()
            r["longHead"] = await pg.locator(".st-head .st-checks").inner_text() if name == "desktop" else ""
            await pg.click('#univTabs button[data-u="Q"]'); await pg.wait_for_timeout(300)
            r["nasdaqRows"] = await pg.locator(".st-row:not(.st-head)").count()
            await pg.click('#modeTabs button[data-m="day"]'); await pg.click('#univTabs button[data-u="S"]'); await pg.wait_for_timeout(300)
            await pg.click("#rulesBtn"); await pg.wait_for_timeout(200)
            r["ruleInputs"] = await pg.locator("#rulesForm input").count()
            await pg.click("#rulesBtn")
            # broker unlock (mock PIN)
            await pg.fill("#pinIn", "wrong-pin-000"); await pg.click("#unlockForm button"); await pg.wait_for_timeout(500)
            r["badPin"] = await pg.locator("#brMsg").inner_text()
            await pg.fill("#pinIn", "demo-pin-123"); await pg.click("#unlockForm button"); await pg.wait_for_timeout(600)
            r["balance"] = await pg.locator(".br-kv").inner_text()
            # ticket
            await pg.click(".st-row:not(.st-head) .st-trade >> nth=0"); await pg.wait_for_timeout(400)
            r["ticket"] = await pg.locator(".tk-title").inner_text()
            await pg.fill("#tkUsd", "1500"); await pg.wait_for_timeout(100)
            r["kv"] = await pg.locator(".tk-kv").inner_text()
            await pg.screenshot(path=f"{OUT}/strat-{name}-ticket.png", full_page=False)
            await pg.click("#tkSend"); await pg.wait_for_timeout(900)
            r["result"] = await pg.locator("#tkMsg").inner_text()
            await pg.keyboard.press("Escape"); await pg.wait_for_timeout(400)
            r["positions"] = await pg.locator(".br-p").count()
            if r["positions"]:
                await pg.click(".br-p [data-close] >> nth=0"); await pg.click(".br-p [data-close] >> nth=0"); await pg.wait_for_timeout(800)
            r["afterClose"] = await pg.locator(".br-p").count()
            await pg.locator("#broker").screenshot(path=f"{OUT}/strat-{name}-broker.png")
            r["errors"] = errs[:8]
            await ctx.close()
        await b.close()
    print(json.dumps(rep, indent=1))
asyncio.run(main())
