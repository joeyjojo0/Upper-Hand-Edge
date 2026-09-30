// Tells the Earth View page where the God's Eye View engine is hosted (set EARTH_VIEW_URL in Vercel).
import { send } from "./_lib/core.js";
export default function handler(req, res) { send(res, 200, { url: process.env.EARTH_VIEW_URL || "" }, 300, 3600); }
