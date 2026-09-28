# UI smoke test against the mock dev server: screenshots, console errors, overflow, live ticking, drawers.
#   MOCK=1 PORT=3100 node dev/server.mjs &   then   python3 dev/ui/shots.py [base_url] [out_dir]
import asyncio, os, sys, json
from playwright.async_api import async_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3100"
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "..", "shots")
os.makedirs(OUT, exist_ok=True)
OVF = """(w=>{const out=[];for(const el of document.querySelectorAll('body *')){const r=el.getBoundingClientRect();if(r.right>w+1&&r.width>0){let p=el.parentElement,clipped=false;while(p&&p!==document.body){const s=getComputedStyle(p);if(['auto','scroll','hidden'].includes(s.overflowX)){clipped=true;break}p=p.parentElement}if(!clipped&&getComputedStyle(el).position!=='fixed')out.push(el.tagName+'.'+el.className+' '+Math.round(r.right)+' :: '+(el.textContent||'').slice(0,50))}}return out.slice(0,12)})"""
async def main():
    report = {}
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for name, w, h in [("desktop", 1440, 900), ("mobile", 390, 844)]:
            errs = []
            ctx = await b.new_context(viewport={"width": w, "height": h}, timezone_id="Europe/London", device_scale_factor=1)
            pg = await ctx.new_page()
            pg.on("pageerror", lambda e: errs.append("pageerror: " + str(e)))
            pg.on("console", lambda m: errs.append("console." + m.type + ": " + m.text) if m.type in ("error",) and "tradingview" not in m.text.lower() and "ERR_" not in m.text else None)
            await pg.goto(BASE + "/", wait_until="domcontentloaded")
            await pg.wait_for_timeout(4500)
            first = await pg.evaluate("""()=>({cards:document.querySelectorAll('.icard').length,edges:document.querySelectorAll('.edge-card').length,tiles:document.querySelectorAll('.tm').length,live:document.querySelector('#liveChip').textContent,liveCls:document.querySelector('#liveChip').className,px:[...document.querySelectorAll('#matrix [data-pxid]')].slice(0,3).map(e=>e.textContent),brief:document.querySelector('#briefText').textContent.slice(0,80),status:document.querySelector('#status').textContent,snap:document.querySelector('#snap').textContent.slice(0,90),srcTags:[...document.querySelectorAll('#matrix .src')].slice(0,8).map(e=>e.textContent),scroll:document.documentElement.scrollWidth})""")
            await pg.wait_for_timeout(6000)
            later = await pg.evaluate("""()=>({px:[...document.querySelectorAll('#matrix [data-pxid]')].slice(0,3).map(e=>e.textContent),flashes:document.querySelectorAll('.fl-up,.fl-dn').length})""")
            report[name] = {"first": first, "later": later, "overflow": await pg.evaluate(OVF, w)}
            await pg.screenshot(path=f"{OUT}/{name}-full.png", full_page=True)
            await pg.screenshot(path=f"{OUT}/{name}-top.png")
            await pg.click("#matrix .icard >> nth=0"); await pg.wait_for_timeout(700)
            await pg.screenshot(path=f"{OUT}/{name}-drawer.png")
            report[name]["drawer"] = await pg.evaluate("()=>({sym:document.querySelector('#drSym')&&document.querySelector('#drSym').textContent,levels:document.querySelectorAll('#drBody .lv').length,chart:!!document.querySelector('#drChart .tradingview-widget-container')})")
            await pg.wait_for_timeout(5500)  # survive a live tick with the drawer open
            report[name]["drawerAfterTick"] = await pg.evaluate("()=>({open:!document.querySelector('#drawer').hidden,closeBtn:!!document.querySelector('#drClose')})")
            await pg.click("#drClose"); await pg.wait_for_timeout(300)
            await pg.locator("#stocks").scroll_into_view_if_needed(); await pg.wait_for_timeout(300)
            await pg.locator("#stocks").screenshot(path=f"{OUT}/{name}-stocks.png")
            await pg.click("#spPlay .srow >> nth=0"); await pg.wait_for_timeout(600)
            await pg.screenshot(path=f"{OUT}/{name}-stock-drawer.png")
            await pg.keyboard.press("Escape"); await pg.wait_for_timeout(300)
            # journal round trip
            await pg.fill("#jSym", "US500"); await pg.fill("#jEntry", "7760"); await pg.fill("#jStop", "7740"); await pg.fill("#jExit", "7800"); await pg.fill("#jQty", "2")
            await pg.click("#jSave"); await pg.wait_for_timeout(300)
            report[name]["journal"] = await pg.evaluate("()=>({msg:document.querySelector('#jMsg').textContent,rows:document.querySelectorAll('#jBody tr').length,stored:(JSON.parse(localStorage.getItem('uhe.journal')||'[]')).length})")
            await pg.click("#snapNow"); await pg.wait_for_timeout(1500)
            report[name]["snap"] = await pg.evaluate("()=>({cards:document.querySelectorAll('#snapBody .sn').length,head:document.querySelector('#snapHead').textContent.slice(0,120)})")
            await pg.locator("#edges").screenshot(path=f"{OUT}/{name}-edges.png")
            report[name]["errors"] = errs[:10]
            await ctx.close()
        await b.close()
    print(json.dumps(report, indent=1))
asyncio.run(main())
