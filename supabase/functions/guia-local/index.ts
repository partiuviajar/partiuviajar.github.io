// Função do Supabase "guia-local": o app manda a foto (ou o nome) + localização e recebe o guia pronto.
// Roda aqui (e não no GitHub Actions) para responder em segundos. Lugares já explicados ficam guardados
// em local_places e servem para todo mundo, sem gastar a IA de novo.
import { buildGuide, distanceM, findPage, identify, placeKey, whereAmI, type Input } from "./guia.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const DAILY_LIMIT = 60;
const CACHE_DAYS = 90;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const auth = req.headers.get("Authorization") || "";
  const apikey = req.headers.get("apikey") || Deno.env.get("SUPABASE_ANON_KEY") || "";
  // banco com as permissões de quem está usando o app (as mesmas regras de sempre)
  const rest = (path: string, init: RequestInit = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init, headers: { apikey, Authorization: auth, "Content-Type": "application/json", ...(init.headers || {}) },
  });

  try {
    const u = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey, Authorization: auth } });
    if (!u.ok) return reply({ error: "Entre no app de novo para usar o guia." }, 401);
    const user = await u.json();
    const prof = await (await rest(`profiles?id=eq.${user.id}&select=status`)).json().catch(() => []);
    if (Array.isArray(prof) && prof[0] && prof[0].status !== "active") return reply({ error: "Sua conta ainda não foi liberada." }, 403);
    const since = new Date(Date.now() - 86400000).toISOString();
    const used = await (await rest(`local_visits?user_id=eq.${user.id}&created_at=gte.${since}&select=id&limit=${DAILY_LIMIT}`)).json().catch(() => []);
    if (Array.isArray(used) && used.length >= DAILY_LIMIT) return reply({ error: `Você já usou o guia ${DAILY_LIMIT} vezes nas últimas 24 h. Volte mais tarde.` }, 429);

    const inp: Input = await req.json();
    if (!inp.image && !inp.query?.trim() && !inp.title) return reply({ error: "Mande uma foto ou escreva o nome do lugar." }, 400);
    const hasLoc = Number.isFinite(inp.lat) && Number.isFinite(inp.lon);
    if (!hasLoc) { delete inp.lat; delete inp.lon; }
    const geo = hasLoc ? await whereAmI(inp.lat!, inp.lon!) : null;

    let id: any = { name: inp.title || "", confidence: 1, alternatives: [], what_i_see: "" };
    if (!inp.title) {
      id = await identify(inp, geo);
      if (!id.found || !id.name) return reply({ found: false, what_i_see: id.what_i_see, alternatives: id.alternatives || [], where: geo?.label || "" });
    }
    const src = await findPage(id, inp.title, inp.lang || "pt");
    const key = placeKey(src, id.name);

    // já explicado antes? usa o guardado
    let guide: any = null;
    const hit = await (await rest(`local_places?key=eq.${encodeURIComponent(key)}&select=data,updated_at`)).json().catch(() => []);
    if (Array.isArray(hit) && hit[0] && Date.now() - new Date(hit[0].updated_at).getTime() < CACHE_DAYS * 86400000) guide = hit[0].data;
    if (!guide) {
      // a localização só entra na história se a pessoa estiver mesmo no lugar
      const near = !!inp.image || (hasLoc && src?.lat != null && distanceM([inp.lat!, inp.lon!], [src.lat, src.lon!]) < 20000);
      guide = await buildGuide(inp, src, id.name, near ? geo : null);
      await rest("local_places?on_conflict=key", {
        method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key, title: guide.title, data: guide, updated_at: new Date().toISOString() }),
      });
    }
    await rest("local_visits", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ user_id: user.id, place_key: key, title: guide.title, subtitle: guide.subtitle, photo: guide.photo?.url || null,
        mode: inp.image ? "photo" : inp.title ? "nearby" : "text", query: inp.query || null }),
    });
    return reply({ found: true, ...guide, confidence: id.confidence, alternatives: id.alternatives || [], what_i_see: id.what_i_see, where: geo?.label || "" });
  } catch (e) {
    console.error(e);
    return reply({ error: String((e as Error)?.message || e).slice(0, 300) }, 500);
  }
});
