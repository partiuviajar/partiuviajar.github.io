// Teste do guia fora do Supabase (workflow "Testar Guia Local"): mostra o resultado como anotações.
import { buildGuide, findPage, identify, whereAmI, type Input } from "./guia.ts";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const [query, imageUrl, lat, lon] = Deno.args;
const note = (title: string, msg: string) => console.log(`::notice title=${title}::${String(msg).replace(/\r?\n/g, "%0A").slice(0, 3800)}`);
const inp: Input = { query: query || undefined, lat: lat ? Number(lat) : undefined, lon: lon ? Number(lon) : undefined };
if (imageUrl) {
  const r = await fetch(imageUrl, { headers: { "User-Agent": "partiuviajar/1.0 (https://partiuviajar.github.io)" } });
  inp.image = encodeBase64(new Uint8Array(await r.arrayBuffer()));
  inp.mime = r.headers.get("content-type") || "image/jpeg";
}
const t0 = Date.now();
const geo = inp.lat != null ? await whereAmI(inp.lat, inp.lon!) : null;
const id = await identify(inp, geo);
note("1 identificação", `${((Date.now() - t0) / 1000).toFixed(1)} s · onde: ${geo?.label} · ${JSON.stringify({ ...id, near: id.near.slice(0, 5).map((p: any) => p.title) })}`);
if (!id.found) Deno.exit(0);
const src = await findPage(id);
note("2 fonte", src ? `${src.lang}:${src.title} · ${src.extract.length} letras · ${src.url}${src.more ? ` · +${src.more.length} letras do outro idioma` : ""}${src.web ? `\nWEB: ${src.web.sources.map((x: any) => x.title).join(", ")}\n${src.web.text.slice(0, 1500)}` : ""}` : "sem fonte");
const g: any = await buildGuide(inp, src, id.name, geo);
note("3 guia", `${((Date.now() - t0) / 1000).toFixed(1)} s · ${g.model}\n${g.title} — ${g.subtitle}\n${g.intro}\n\n${g.story}`);
note("4 destaques", g.highlights.map((h: any) => `• ${h.name} («${h.q}»): ${h.desc} [foto: ${h.photo?.page || "nenhuma"}]`).join("\n") + `\n\nGaleria: ${g.gallery.length} fotos · capa: ${g.photo?.url}`);
note("5 curiosidades e dicas", [...g.curiosities.map((c: string) => "★ " + c), ...g.tips.map((t: string) => "→ " + t)].join("\n"));
note("6 falado", g.spoken);
