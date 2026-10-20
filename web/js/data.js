// Dados das rotas já resumidos para as telas (Home e Rotas usam o mesmo cálculo).
import { sb, q, isoDaysAgo, todayIso, median, loadDestinations, cached } from "./core.js";
import { inScope, lastCheck, cheapest, dayChange, buyVerdict, tripStart } from "./ui.js";

export const loadRouteStats = (days = 10) => cached(`routes:${days}`, () => load(days));

async function load(days) {
  const [routes, latest, totals, trend] = await Promise.all([
    q(sb.from("routes").select("*").order("created_at")),
    q(sb.from("route_latest").select("route_id,depart_date,return_date,price,normal_price,checked_at,airline,stops").is("leg", null).gte("depart_date", todayIso()).limit(2000)),
    q(sb.from("route_latest").select("route_id,leg,depart_date,return_date,price,normal_price,checked_at,airline,stops").in("leg", ["rt", "combo"]).eq("direct_only", false).gte("checked_at", isoDaysAgo(2)).limit(1000)),
    q(sb.from("route_trend").select("route_id,checked_at,best_price").gte("checked_at", isoDaysAgo(days)).order("checked_at").limit(3000)),
  ]);
  const dests = await loadDestinations(routes.map((r) => r.destination), "code,name,country_code,country_name,thumb,lat,lon");
  const stats = routes.map((r) => {
    const rows = r.date_mode === "long"
      ? lastCheck(totals.filter((x) => x.route_id === r.id && inScope(r, x)))
      : latest.filter((x) => x.route_id === r.id && inScope(r, x));
    const best = cheapest(rows);
    const normal = best?.normal_price != null ? Number(best.normal_price) : r.date_mode === "month" ? median(rows.map((x) => Number(x.price))) : null;
    const points = trend.filter((t) => t.route_id === r.id).map((t) => ({ t: new Date(t.checked_at), y: Number(t.best_price) }));
    const low = points.length ? Math.min(...points.map((p) => p.y)) : null;
    const start = tripStart(r, best);
    return {
      r, best, normal, points, low, start,
      price: best ? Number(best.price) : null,
      change: dayChange(points),
      verdict: best && r.active ? buyVerdict(best.price, normal, low, start) : null,
      dest: dests[r.destination],
    };
  });
  return { stats, dests };
}
