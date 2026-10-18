# UI smoke test for /update against the mock dev server (mock PIN: demo-pin-123).
#   MOCK=1 PORT=3100 node dev/server.mjs &   then   python3 dev/ui/update.py [base_url] [out_dir]
# Unlock, ask Claude (a round that hands back mid-way), review the diff, push, watch the deploy go live,
# run the data engine, undo, plus the wrong-PIN, error, conflict and Stop paths. Screenshots go to dev/shots/.
import asyncio, os, sys, json
from playwright.async_api import async_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3100"
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "..", "shots")
os.makedirs(OUT, exist_ok=True)
OVF = """(w=>{const out=[];for(const el of document.querySelectorAll('body *')){const r=el.getBoundingClientRect();if(r.right>w+1&&r.width>0){let p=el.parentElement,clipped=false;while(p&&p!==document.body){const s=getComputedStyle(p);if(['auto','scroll','hidden'].includes(s.overflowX)){clipped=true;break}p=p.parentElement}if(!clipped&&getComputedStyle(el).position!=='fixed')out.push(el.tagName+'.'+el.className+' '+Math.round(r.right))}}return out.slice(0,12)})"""

async def idle(pg, timeout=30000):
    await pg.wait_for_function("() => !document.querySelector('.upd-typing') && document.querySelector('#send').textContent.trim() === 'Send to Claude'", timeout=timeout)

async def ask(pg, text, stop_after=None):
    n = await pg.locator(".upd-round").count()
    await pg.fill("#prompt", text); await pg.click("#send")
    await pg.wait_for_function(f"() => document.querySelectorAll('.upd-round').length > {n}")
    if stop_after is not None:
        await pg.wait_for_selector(".upd-typing"); await pg.wait_for_timeout(stop_after); await pg.click("#stop")
    await idle(pg)

async def main():
    report = {}
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for name, w, h in [("desktop", 1440, 900), ("mobile", 390, 844)]:
            errs, r = [], {}
            ctx = await b.new_context(viewport={"width": w, "height": h}, timezone_id="Europe/London", device_scale_factor=1)
            pg = await ctx.new_page()
            pg.on("pageerror", lambda e: errs.append("pageerror: " + str(e)))
            pg.on("console", lambda m: errs.append("console." + m.type + ": " + m.text) if m.type == "error" and "fonts" not in m.text else None)
            await pg.goto(BASE + "/update", wait_until="domcontentloaded")
            await pg.wait_for_selector("#pinIn")
            await pg.screenshot(path=f"{OUT}/update-{name}-locked.png")
            await pg.fill("#pinIn", "wrong-pin"); await pg.click("#unlockForm button")
            await pg.wait_for_function("() => document.querySelector('#lockMsg').textContent.length > 0")
            r["wrongPin"] = await pg.text_content("#lockMsg")
            await pg.fill("#pinIn", "demo-pin-123"); await pg.click("#unlockForm button")
            await pg.wait_for_selector("#app:not([hidden])")
            r["chips"] = await pg.text_content("#chips")
            r["ideas"] = await pg.locator(".upd-idea").count()
            await pg.wait_for_timeout(600)
            await pg.screenshot(path=f"{OUT}/update-{name}-unlocked.png", full_page=True)
            # a round that hands back mid-way ("continue") and edits two files
            await pg.click(".upd-idea >> nth=0")
            await pg.fill("#prompt", (await pg.input_value("#prompt")) + " (long)")
            await pg.click("#send")
            await pg.wait_for_selector(".upd-typing")
            await pg.wait_for_timeout(1200)
            await pg.screenshot(path=f"{OUT}/update-{name}-working.png")
            await idle(pg)
            r["round"] = await pg.evaluate("""()=>({acts:[...document.querySelectorAll('.upd-act')].map(e=>e.textContent),final:(document.querySelector('.upd-say.final')||{}).textContent,
              files:[...document.querySelectorAll('.upd-file .upd-path')].map(e=>e.textContent),pm:[...document.querySelectorAll('.upd-pm')].map(e=>e.textContent),count:document.querySelector('#revCount').textContent,
              msg:document.querySelector('#msg')&&document.querySelector('#msg').value,cost:document.querySelector('#cost').textContent,goto:!!document.querySelector('.upd-goto')})""")
            await pg.click('.upd-file-h >> nth=1'); await pg.wait_for_timeout(200)
            r["diff"] = await pg.evaluate("()=>({add:document.querySelectorAll('.dl.add').length,del:document.querySelectorAll('.dl.del').length,ctx:document.querySelectorAll('.dl:not(.add):not(.del)').length})")
            await pg.locator("#review").scroll_into_view_if_needed()
            await pg.screenshot(path=f"{OUT}/update-{name}-review.png", full_page=True)
            # reload keeps the staged changes and the conversation
            await pg.reload(wait_until="domcontentloaded"); await pg.wait_for_selector("#app:not([hidden])")
            await pg.wait_for_timeout(300)
            r["afterReload"] = await pg.evaluate("()=>({files:document.querySelectorAll('.upd-file').length,rounds:document.querySelectorAll('.upd-round').length})")
            # push (two taps), then watch the deploy until it's live
            await pg.click("#pushBtn"); r["armed"] = await pg.text_content("#pushBtn"); await pg.click("#pushBtn")
            await pg.wait_for_selector(".upd-pushed"); r["pushing"] = await pg.text_content(".upd-pushed .chip")
            await pg.wait_for_function("() => /Live on the site/.test((document.querySelector('.upd-pushed .chip')||{}).textContent||'')", timeout=40000)
            r["pushed"] = await pg.evaluate("()=>({chip:document.querySelector('.upd-pushed .chip').textContent,title:document.querySelector('.upd-pushed b').textContent,changes:document.querySelectorAll('.upd-file').length,live:document.querySelector('#chips').textContent,toast:document.querySelector('#toast').textContent})")
            await pg.screenshot(path=f"{OUT}/update-{name}-pushed.png", full_page=True)
            # data engine: pick two jobs and run
            await pg.click('#engMode button[data-m="pick"]'); await pg.click('.upd-job[data-j="news"]'); await pg.click('.upd-job[data-j="patterns"]')
            await pg.click("#engRun")
            await pg.wait_for_selector(".upd-run"); await pg.wait_for_timeout(5500)
            r["engineMid"] = await pg.evaluate("()=>({chip:document.querySelector('.upd-run .chip').textContent,steps:document.querySelectorAll('.upd-steps li').length,ok:document.querySelectorAll('.upd-steps li.ok').length,btn:document.querySelector('#engRun').textContent})")
            await pg.locator("#engine").scroll_into_view_if_needed(); await pg.screenshot(path=f"{OUT}/update-{name}-engine-running.png")
            await pg.wait_for_function("() => /Done/.test((document.querySelector('.upd-run .chip')||{}).textContent||'')", timeout=40000)
            await pg.wait_for_timeout(600)
            r["engine"] = await pg.evaluate("()=>({chip:document.querySelector('.upd-run .chip').textContent,log:document.querySelectorAll('.upd-log li').length,bad:document.querySelectorAll('.upd-log li.bad').length,runs:document.querySelectorAll('.upd-runrow').length})")
            await pg.locator("#engine").screenshot(path=f"{OUT}/update-{name}-engine.png")
            # undo the push
            await pg.click("#undoPush"); await pg.click("#undoPush")
            await pg.wait_for_function("() => /^Undo: /.test((document.querySelector('.upd-pushed b')||{}).textContent||'')", timeout=15000)
            r["undo"] = await pg.text_content(".upd-pushed b")
            # error path and Stop
            await ask(pg, "please fail")
            r["error"] = await pg.evaluate("()=>[...document.querySelectorAll('.upd-err')].map(e=>e.textContent)")
            await ask(pg, "Make the ring amber", stop_after=500)
            r["stopped"] = await pg.evaluate("()=>[...document.querySelectorAll('.upd-note')].map(e=>e.textContent).slice(-1)")
            # conflict path: the mock refuses a push whose message mentions "conflict"
            await ask(pg, "Make the ring amber")
            await pg.fill("#msg", "conflict test"); await pg.click("#pushBtn"); await pg.click("#pushBtn")
            await pg.wait_for_selector(".upd-conflict"); r["conflict"] = await pg.text_content(".upd-conflict b")
            await pg.screenshot(path=f"{OUT}/update-{name}-conflict.png", full_page=True)
            await pg.click("#freshStart"); await pg.wait_for_timeout(300)
            r["fresh"] = await pg.evaluate("()=>({files:document.querySelectorAll('.upd-file').length,rounds:document.querySelectorAll('.upd-round').length})")
            r["overflow"] = await pg.evaluate(OVF, w)
            r["errors"] = errs[:10]
            report[name] = r
            await ctx.close()
        await b.close()
    print(json.dumps(report, indent=1, ensure_ascii=False))
asyncio.run(main())
