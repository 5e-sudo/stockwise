// Vercel serverless function: fetches end-of-day data from FMP and keeps your API key private.
const BASE = "https://financialmodelingprep.com/stable";
const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
const round = (v, d) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

module.exports = async (req, res) => {
  const symbol = String(req.query.symbol || "").toUpperCase().trim();
  if (!/^[A-Z.\-]{1,10}$/.test(symbol)) {
    return res.status(400).json({ error: "Enter a valid ticker, like AAPL." });
  }
  const key = process.env.FMP_API_KEY;
  if (!key) {
    return res.status(500).json({ error: "Missing FMP_API_KEY. Add it in your Vercel project settings." });
  }

  const get = async (path) => {
    const url = `${BASE}/${path}${path.includes("?") ? "&" : "?"}apikey=${encodeURIComponent(key)}`;
    const r = await fetch(url);
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) {}
    if (!r.ok || !Array.isArray(data)) throw new Error("FMP returned no data (status " + r.status + ").");
    return data;
  };

  try {
    const [quote, income] = await Promise.all([
      get(`quote?symbol=${symbol}`),
      get(`income-statement?symbol=${symbol}&limit=5`),
    ]);
    let ratios = [];
    try { ratios = await get(`ratios-ttm?symbol=${symbol}`); } catch (e) {} // optional

    const q = quote[0];
    if (!q || !income.length) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(404).json({ error: `No data for ${symbol}. The free plan may not cover it.` });
    }
    const a = income[0], b = income[1], oldest = income[income.length - 1];
    const eps = num(a.epsDiluted ?? a.eps);
    const price = num(q.price);
    if (eps == null || price == null) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(404).json({ error: `Not enough data for ${symbol}.` });
    }

    // Growth = the company's own past EPS growth per year (change it in the app to use your view).
    const oldEps = num(oldest.epsDiluted ?? oldest.eps);
    const yrs = income.length - 1;
    let g = 8;
    if (eps > 0 && oldEps > 0 && yrs > 0) g = (Math.pow(eps / oldEps, 1 / yrs) - 1) * 100;
    g = Math.max(-10, Math.min(30, g));

    const m = a.revenue ? (a.netIncome / a.revenue) * 100 : null;
    const r = b && b.revenue ? (a.revenue / b.revenue - 1) * 100 : null;
    const rt = ratios[0] || {};
    const d = num(rt.debtToEquityRatioTTM ?? rt.debtEquityRatioTTM ?? rt.debtToEquityRatio);

    // End-of-day data only changes once a day, so let the CDN cache it for 12 hours (saves your 250 daily calls).
    res.setHeader("Cache-Control", "public, s-maxage=43200, stale-while-revalidate=86400");
    return res.status(200).json({
      n: q.name || symbol,
      p: round(price, 2),
      e: round(eps, 2),
      g: round(g, 1),
      m: round(m, 1) ?? 0,
      r: round(r, 1) ?? 0,
      d: round(d, 2),
    });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: `Could not load ${symbol}. ${e.message}` });
  }
};
