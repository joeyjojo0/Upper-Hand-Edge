// Live quotes for every market, the context series and the ETFs used for the futures nowcast. Polled every ~5 s.
import { liveQuotes, handle } from "./_lib/core.js";
export default handle(liveQuotes, 4, 30);
