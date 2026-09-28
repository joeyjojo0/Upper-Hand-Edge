// Daily-bar metrics for all S&P 500 members. Slow (~500 requests), so it is cached at the edge for 3 hours.
import { scanHistCached, handle } from "./_lib/core.js";
export default handle(() => scanHistCached(), 10800, 86400);
