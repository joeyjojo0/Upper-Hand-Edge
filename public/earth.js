// Earth View: embeds the self-hosted God's Eye View app inside the UHE shell.
const $ = s => document.querySelector(s);
const UK = "Europe/London", NY = "America/New_York";
const fmt = tz => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(new Date());
const clocks = () => { const a = $("#clkUK"), b = $("#clkNY"); if (a) a.textContent = fmt(UK); if (b) b.textContent = fmt(NY); };
clocks(); setInterval(clocks, 1000);
const live = $("#liveChip"); if (live) { live.className = "live on"; live.querySelector("span").textContent = "EARTH VIEW"; }
const state = (cls, txt) => { const el = $("#earthState"); el.className = "chip " + cls; el.innerHTML = `<span class="dot"></span>${txt}`; };

async function source() {
  const q = new URLSearchParams(location.search).get("src");
  if (q) return q;
  try { const r = await fetch("/api/earth-config", { cache: "no-cache" }); const j = await r.json(); return j.url || ""; } catch { return ""; }
}
let url = "", frame = null, timer = 0;
function mount() {
  const box = $("#earthFrame"), loader = $("#earthLoader");
  if (frame) frame.remove();
  loader.hidden = false; state("warn", "Connecting…");
  $("#earthMsg").textContent = "Waking the globe…";
  frame = document.createElement("iframe");
  frame.src = url; frame.title = "Earth View";
  frame.allow = "fullscreen; microphone; geolocation; clipboard-write; autoplay";
  frame.referrerPolicy = "no-referrer";
  frame.addEventListener("load", () => { clearTimeout(timer); loader.hidden = true; state("ok", "Live"); });
  box.append(frame);
  clearTimeout(timer);
  timer = setTimeout(() => { $("#earthMsg").textContent = "Still starting…"; $("#earthSub").textContent = "If nothing appears, use “Open in new tab”."; }, 60000);
}
(async () => {
  url = await source();
  if (!url) {
    state("bad", "Not connected");
    $("#earthMsg").textContent = "Earth View isn’t connected yet";
    $("#earthSub").innerHTML = "Deploy the globe engine, then set <code>EARTH_VIEW_URL</code> in Vercel. Steps are in the README.";
    $("#earthOpen").hidden = true; return;
  }
  $("#earthOpen").href = url;
  mount();
})();
$("#earthReload").addEventListener("click", () => url && mount());
$("#earthFull").addEventListener("click", () => { const el = $("#earthFrame"); (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el); });
