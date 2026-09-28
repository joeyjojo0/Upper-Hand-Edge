// Session statistics, levels and NY-open history for all 24 markets (daily 1y + 15-minute 60d bars).
import { markets, handle } from "./_lib/core.js";
export default handle(markets, 300, 900);
