// Guia Local: descobre o lugar (foto + localização, ou nome digitado) e conta a história como um guia.
// Os fatos vêm da Wikipédia; o Gemini só reconhece o lugar e escreve no tom de guia em cima desse texto.

const UA = "partiuviajar/1.0 (https://partiuviajar.github.io)";
// mesmos modelos do robô (bot/ai.py): no plano grátis um deles às vezes responde "alta demanda"
const MODELS = ["gemini-3.5-flash", "gemini-3.8-flash", "gemini-flash-latest", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];
// para escrever a história o modelo leve basta e responde bem mais rápido (reconhecer a foto fica com os maiores)
const WRITE_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-flash-latest"];
const MAX_EXTRACT = 14000;
// no teste do GitHub os avisos viram anotações (o log da execução não abre deste Mac)
export const warn = (msg: string) => console.log(Deno.env.get("GITHUB_ACTIONS") ? `::warning::${msg}` : msg);

export type Input = {
  image?: string;        // foto em base64 (sem o prefixo data:)
  mime?: string;
  query?: string;        // nome digitado ("Templo Zu Lai")
  title?: string;        // título exato da Wikipédia (vindo de "Ver mais por perto")
  lang?: string;
  lat?: number;
  lon?: number;
  accuracy?: number;
  photoGps?: boolean;    // a localização veio da própria foto (EXIF), não do celular agora
};

export type Photo = { url: string; page?: string; credit?: string };

type Page = { lang: string; title: string; extract: string; url: string; image?: string; lat?: number; lon?: number; description?: string; other?: string; more?: string; web?: { text: string; sources: { title: string; url: string }[] } | null };
const SHORT_EXTRACT = 6000;

async function getJson(url: string, timeout = 15000) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "pt-BR" }, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`${new URL(url).host} respondeu ${r.status}`);
  return r.json();
}

const wiki = (lang: string, params: Record<string, string>) =>
  getJson(`https://${lang}.wikipedia.org/w/api.php?` + new URLSearchParams({ format: "json", formatversion: "2", ...params }));

export function distanceM(a: [number, number], b: [number, number]) {
  const rad = Math.PI / 180, dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(12742000 * Math.asin(Math.sqrt(h)));
}

// ---------------------------------------------------------------------------
// Onde a pessoa está (OpenStreetMap)
// ---------------------------------------------------------------------------
export async function whereAmI(lat: number, lon: number) {
  try {
    const j = await getJson(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&addressdetails=1&accept-language=pt-BR&lat=${lat}&lon=${lon}`, 8000);
    const a = j.address || {};
    const bairro = a.neighbourhood || a.suburb || a.quarter || a.city_district || "";
    const city = a.city || a.town || a.village || a.municipality || "";
    return {
      bairro, city, state: a.state || "", country: a.country || "", cc: (a.country_code || "").toUpperCase(),
      road: a.road || a.pedestrian || "",
      label: [bairro, city].filter(Boolean).join(", ") || j.display_name || "",
    };
  } catch { return null; }
}

// pontos da Wikipédia perto de um lugar (com foto e distância)
export async function nearby(lang: string, lat: number, lon: number, radius = 1000, limit = 25) {
  try {
    const j = await wiki(lang, {
      action: "query", generator: "geosearch", ggscoord: `${lat}|${lon}`, ggsradius: String(radius), ggslimit: String(limit),
      prop: "coordinates|pageimages|description", piprop: "thumbnail", pithumbsize: "500",
    });
    return (j.query?.pages || []).map((p: any) => ({
      title: p.title, description: p.description || "", thumb: p.thumbnail?.source || null,
      lat: p.coordinates?.[0]?.lat, lon: p.coordinates?.[0]?.lon,
      dist: p.coordinates?.[0] ? distanceM([lat, lon], [p.coordinates[0].lat, p.coordinates[0].lon]) : null,
    })).sort((a: any, b: any) => (a.dist ?? 1e9) - (b.dist ?? 1e9));
  } catch (e) { warn(`[perto] ${e}`); return []; }
}

async function search(lang: string, term: string, limit = 5) {
  try {
    const j = await wiki(lang, { action: "query", list: "search", srsearch: term, srlimit: String(limit), srprop: "snippet" });
    return (j.query?.search || []).map((s: any) => ({ title: s.title, snippet: String(s.snippet || "").replace(/<[^>]+>/g, "") }));
  } catch { return []; }
}

async function page(lang: string, title: string): Promise<Page | null> {
  if (!title) return null;
  try {
    const j = await wiki(lang, {
      action: "query", titles: title, redirects: "1", prop: "extracts|pageimages|coordinates|info|description|langlinks", lllang: lang === "pt" ? "en" : "pt",
      explaintext: "1", exsectionformat: "plain", piprop: "original|thumbnail", pithumbsize: "1280", inprop: "url",
    });
    const p = j.query?.pages?.[0];
    if (!p || p.missing || !p.extract) return null;
    // página de desambiguação não serve como fonte
    if (/\(desambigua|\(disambiguation/i.test(p.title) || /pode referir-se a|may refer to/i.test(p.extract.slice(0, 300))) return null;
    return {
      lang, title: p.title, url: p.fullurl, description: p.description,
      extract: p.extract.split(/\n\s*(Referências|Ver também|Ligações externas|Bibliografia|References|See also|External links)\s*\n/)[0].slice(0, MAX_EXTRACT),
      image: p.thumbnail?.source || p.original?.source, lat: p.coordinates?.[0]?.lat, lon: p.coordinates?.[0]?.lon,
      other: p.langlinks?.[0]?.title,
    };
  } catch { return null; }
}

// fotos que estão na própria página (para a galeria do lugar)
async function pagePhotos(lang: string, title: string, max = 8): Promise<Photo[]> {
  try {
    const j = await wiki(lang, {
      action: "query", generator: "images", titles: title, gimlimit: "40", prop: "imageinfo", iiprop: "url|mime", iiurlwidth: "960",
    });
    return (j.query?.pages || [])
      .filter((p: any) => /jpe?g|png|webp/.test(p.imageinfo?.[0]?.mime || "") && !/flag|bandeira|logo|icon|ícone|map|mapa|coa|bras[aã]o|signature|assinatura/i.test(p.title))
      .slice(0, max)
      .map((p: any) => ({ url: p.imageinfo[0].thumburl || p.imageinfo[0].url, page: p.imageinfo[0].descriptionurl, credit: "Wikimedia Commons" }));
  } catch { return []; }
}

// fotos da Wikimedia Commons ("Templo Zu Lai Buddha", "Escadaria Selarón tiles"…)
async function commons(term: string, limit = 3): Promise<Photo[]> {
  try {
    const j = await getJson("https://commons.wikimedia.org/w/api.php?" + new URLSearchParams({
      action: "query", format: "json", formatversion: "2", generator: "search", gsrnamespace: "6", gsrsearch: `${term} filetype:bitmap`,
      gsrlimit: String(limit), prop: "imageinfo", iiprop: "url|extmetadata", iiurlwidth: "960", iiextmetadatafilter: "Artist|LicenseShortName",
    }), 10000);
    return (j.query?.pages || []).sort((a: any, b: any) => a.index - b.index).filter((p: any) => p.imageinfo?.[0]).map((p: any) => {
      const ii = p.imageinfo[0];
      const artist = String(ii.extmetadata?.Artist?.value || "").replace(/<[^>]+>/g, "").trim();
      const lic = ii.extmetadata?.LicenseShortName?.value || "";
      return { url: ii.thumburl || ii.url, page: ii.descriptionurl, credit: [artist.slice(0, 60), lic].filter(Boolean).join(" · ") || "Wikimedia Commons" };
    });
  } catch { return []; }
}
// uma foto por destaque: primeiro a busca sugerida pela IA, depois "lugar + nome do destaque"
async function highlightPhoto(h: { name: string; photo_query: string }, place: string) {
  return (await commons(h.photo_query, 1))[0] || (await commons(`${place} ${h.name}`, 1))[0] || null;
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------
async function gemini(parts: unknown[], schema: unknown, temperature = 0.4, timeout = 25000, models = MODELS) {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY não configurada");
  const body = JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature } });
  let last: unknown;
  for (const model of models) {
    const t0 = Date.now();
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", headers: { "x-goog-api-key": key, "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(timeout),
      });
      const d = await r.json();
      if (!d.candidates) throw new Error(String(d.error?.message || JSON.stringify(d)).slice(0, 160));
      const out = JSON.parse(d.candidates[0].content.parts[0].text);
      warn(`[gemini] ${model}: ok em ${Date.now() - t0} ms`);
      return { ...out, _model: model };
    } catch (e) {
      last = e;
      warn(`[gemini] ${model}: falhou em ${Date.now() - t0} ms: ${String(e).slice(0, 140)}`);
    }
  }
  throw new Error(`A IA está sobrecarregada agora. Tente de novo em alguns instantes. (${String(last).slice(0, 80)})`);
}

// pesquisa no Google pelo Gemini, para lugares com pouco texto na Wikipédia (o que tem lá dentro, obras, salas…)
export async function webFacts(name: string, where: string) {
  const key = Deno.env.get("GEMINI_API_KEY");
  const body = JSON.stringify({
    contents: [{ parts: [{ text: `Pesquise e liste, em português, fatos concretos e verificáveis sobre "${name}"${where ? ` (${where})` : ""}: história, quem construiu e quando, e principalmente o que o visitante encontra lá (salas, estátuas, obras, portões, detalhes, com tamanhos e materiais quando houver). Só fatos que estejam nas fontes, em tópicos curtos.` }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.2 },
  });
  for (const model of WRITE_MODELS) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", headers: { "x-goog-api-key": key!, "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(25000),
      });
      const d = await r.json();
      const c = d.candidates?.[0];
      if (!c) throw new Error(String(d.error?.message || JSON.stringify(d)).slice(0, 160));
      const text = (c.content?.parts || []).map((p: any) => p.text || "").join("").trim();
      const sources = (c.groundingMetadata?.groundingChunks || []).map((g: any) => ({ title: g.web?.title, url: g.web?.uri })).filter((x: any) => x.url).slice(0, 6);
      if (text && sources.length) return { text: text.slice(0, 8000), sources };
      return null;  // sem fonte da web: não serve
    } catch (e) { warn(`[pesquisa] ${model}: ${String(e).slice(0, 160)}`); }
  }
  return null;
}

const S = (description = "") => ({ type: "string", description });
const IDENTIFY = {
  type: "object",
  properties: {
    found: { type: "boolean" },
    name: S("nome usual do lugar em português"),
    wiki_pt: S("título exato do artigo na Wikipédia em português, de preferência um dos candidatos; vazio se não souber"),
    wiki_en: S("título exato do artigo na Wikipédia em inglês; vazio se não souber"),
    confidence: { type: "number", description: "0 a 1" },
    what_i_see: S("uma frase sobre o que aparece na foto ou o que a pessoa pediu"),
    alternatives: { type: "array", items: S(), description: "até 3 outros lugares que podem ser, nomes em português" },
  },
  required: ["found", "name", "wiki_pt", "wiki_en", "confidence", "what_i_see", "alternatives"],
};

const NARRATE = {
  type: "object",
  properties: {
    title: S(), subtitle: S("bairro · cidade"), intro: S(), story: S(),
    highlights: { type: "array", items: { type: "object", properties: { name: S(), desc: S(), photo_query: S() }, required: ["name", "desc", "photo_query"] } },
    curiosities: { type: "array", items: S() },
    tips: { type: "array", items: S() },
    spoken: S(),
  },
  required: ["title", "subtitle", "intro", "story", "highlights", "curiosities", "tips", "spoken"],
};

const imagePart = (inp: Input) => (inp.image ? [{ inline_data: { mime_type: inp.mime || "image/jpeg", data: inp.image } }] : []);

// ---------------------------------------------------------------------------
// 1) Que lugar é esse?
// ---------------------------------------------------------------------------
export async function identify(inp: Input, geo: Awaited<ReturnType<typeof whereAmI>>) {
  const hasLoc = inp.lat != null && inp.lon != null;
  const [near, found] = await Promise.all([
    hasLoc ? nearby("pt", inp.lat!, inp.lon!, inp.accuracy && inp.accuracy > 500 ? 5000 : 1000) : Promise.resolve([]),
    inp.query ? Promise.all([search("pt", inp.query), search("en", inp.query)]).then(([a, b]) => [...a, ...b]) : Promise.resolve([]),
  ]);
  const lines = [
    "Você é um guia local que conhece muito bem a cidade. Identifique o ponto turístico, monumento, prédio, obra de arte, templo ou lugar que a pessoa quer conhecer.",
    inp.image ? "A pessoa mandou a foto acima." : `A pessoa escreveu: "${inp.query}".`,
    hasLoc ? `Localização ${inp.photoGps ? "registrada na própria foto" : inp.image ? "atual do celular (a foto pode ter sido tirada em outro lugar, se veio da galeria)" : "atual do celular (pode não ter relação com o que ela escreveu)"}: ${geo?.road ? geo.road + ", " : ""}${geo?.label || ""}${geo?.state ? ", " + geo.state : ""}${geo?.country ? ", " + geo.country : ""} (${inp.lat!.toFixed(5)}, ${inp.lon!.toFixed(5)}${inp.accuracy ? `, precisão ~${Math.round(inp.accuracy)} m` : ""}).` : "Sem localização.",
    near.length ? "Artigos da Wikipédia em português sobre lugares perto dessa localização (título — descrição — distância):\n" + near.slice(0, 25).map((p: any) => `- ${p.title}${p.description ? " — " + p.description : ""}${p.dist != null ? ` — ${p.dist} m` : ""}`).join("\n") : "",
    found.length ? "Resultados da busca na Wikipédia pelo que ela escreveu:\n" + found.map((s: any) => `- ${s.title}: ${s.snippet.slice(0, 120)}`).join("\n") : "",
    "Regras: se o lugar estiver entre os candidatos, use exatamente aquele título em wiki_pt. Corrija erros de digitação do nome. found=false só se for impossível saber (ex.: foto de uma parede qualquer sem nada que identifique). Seja honesto na confiança.",
  ];
  const out = await gemini([...imagePart(inp), { text: lines.filter(Boolean).join("\n\n") }], IDENTIFY, 0.2);
  return { ...out, near };
}

// ---------------------------------------------------------------------------
// 2) A história, contada como guia
// ---------------------------------------------------------------------------
export async function findPage(id: { name?: string; wiki_pt?: string; wiki_en?: string }, title?: string, lang = "pt") {
  const src = title ? await page(lang, title)
    : await page("pt", id.wiki_pt || "") || await page("en", id.wiki_en || "")
      || await (async () => { const s = await search("pt", id.name || ""); return s[0] ? page("pt", s[0].title) : null; })();
  // artigo curto: completa com o mesmo artigo no outro idioma (o de inglês costuma ter mais detalhes)
  if (src && src.extract.length < SHORT_EXTRACT && src.other) {
    const o = await page(src.lang === "pt" ? "en" : "pt", src.other);
    if (o) src.more = o.extract.slice(0, MAX_EXTRACT - src.extract.length);
  }
  // a pesquisa no Google não entra no plano grátis do Gemini: ligue com o segredo GUIA_PESQUISA_WEB=1 se tiver plano pago
  if (Deno.env.get("GUIA_PESQUISA_WEB") === "1" && src && src.extract.length + (src.more?.length || 0) < SHORT_EXTRACT) src.web = await webFacts(src.title, src.description || "");
  return src;
}

export async function narrate(inp: Input, src: Page | null, name: string, geo: Awaited<ReturnType<typeof whereAmI>>) {
  const prompt = [
    `Você é um guia local simpático e apaixonado pela sua cidade, falando com um turista brasileiro que está na frente de "${src?.title || name}"${geo?.label ? ` (a pessoa está em ${geo.label})` : ""}.`,
    "Escreva em português do Brasil, em tom de conversa, como quem está falando ao vivo. Sem markdown, sem emojis, sem listas dentro do texto corrido.",
    src
      ? `Use SOMENTE os fatos do texto de referência abaixo (Wikipédia, ${src.lang === "pt" ? "em português" : "em inglês: traduza"}) para datas, nomes, números, autores e história. O que não estiver no texto, NÃO afirme. Não invente datas.\n\nTEXTO DE REFERÊNCIA — ${src.title}:\n${src.extract}${src.more ? `\n\nMESMO ARTIGO NA WIKIPÉDIA EM ${src.lang === "pt" ? "INGLÊS (traduza)" : "PORTUGUÊS"}:\n${src.more}` : ""}${src.web ? `\n\nPESQUISA NA WEB (também vale como referência):\n${src.web.text}` : ""}`
      : "ATENÇÃO: não achamos nenhum texto de referência sobre esse lugar. Descreva com cautela apenas o que se vê ou o que é de conhecimento muito geral, sem datas, nomes ou números específicos, e diga claramente que não encontrou registros confiáveis sobre a história dele.",
    `Campos:
- title: nome do lugar.
- subtitle: "bairro · cidade" (ou "cidade · país" se for melhor).
- intro: uma frase de abertura, tipo "Você está diante da …".
- Em todos os campos escreva datas e números com algarismos (1990, 215 degraus).
- story: 3 a 5 parágrafos curtos separados por linha em branco (150 a 300 palavras no total): o que é, quem fez e quando, por que é importante, como é hoje.
- highlights: até 6 coisas concretas para ver ou reparar DENTRO do próprio lugar (partes, obras, salas, estátuas, portões, detalhes; nunca outros pontos turísticos vizinhos, nunca números como área ou tamanho do terreno), só as que aparecem no texto${inp.image ? " ou estão claramente visíveis na foto" : ""}. Se não houver nada concreto, devolva menos itens ou nenhum. Cada uma com name (curto), desc (1 ou 2 frases) e photo_query (2 a 4 palavras para achar uma foto daquela parte na Wikimedia Commons: nome curto do lugar + a parte em inglês, ex.: "Selaron steps tiles", "Zu Lai Buddha").
- curiosities: 2 a 4 curiosidades curtas tiradas do texto.
- tips: 2 a 4 dicas práticas de visita (melhor horário, como chegar, cuidados, o que combinar por perto). Podem ser conhecimento geral; sem preços nem horários exatos.
- spoken: versão para ser LIDA EM VOZ ALTA pelo celular, 120 a 220 palavras, em primeira pessoa como guia ("Olha só, essa é a …"), frases curtas, sem parênteses e sem siglas soltas.`,
  ].join("\n\n");
  return await gemini([...imagePart(inp), { text: prompt }], NARRATE, 0.6, 40000, WRITE_MODELS);
}

export async function photosFor(highlights: { name: string; photo_query: string }[], src: Page | null, name: string) {
  const place = src?.title || name;
  const [hl, own, more] = await Promise.all([
    Promise.all(highlights.slice(0, 6).map((h) => highlightPhoto(h, place))),
    src ? pagePhotos(src.lang, src.title) : Promise.resolve([]),
    commons(place, 10),
  ]);
  // galeria: fotos da página + da Commons, sem repetir as dos destaques
  const used = new Set(hl.filter(Boolean).map((p) => p!.url));
  const gallery = [...own, ...more].filter((p) => !used.has(p.url) && used.add(p.url));
  return { hl, gallery };
}

// ---------------------------------------------------------------------------
// Tudo junto
// ---------------------------------------------------------------------------
export const placeKey = (src: Page | null, name: string) => (src ? `${src.lang}:${src.title}` : `x:${name.toLowerCase().trim()}`);

export async function buildGuide(inp: Input, src: Page | null, name: string, geo: Awaited<ReturnType<typeof whereAmI>>) {
  const n = await narrate(inp, src, name, geo);
  const { hl, gallery } = await photosFor(n.highlights || [], src, name);
  const hero = src?.image ? { url: src.image, page: src.url, credit: "Wikipédia" } : gallery[0] || null;
  return {
    key: placeKey(src, name),
    title: n.title || src?.title || name,
    subtitle: n.subtitle || geo?.label || "",
    intro: n.intro, story: n.story, spoken: n.spoken,
    highlights: (n.highlights || []).slice(0, 6).map((h: any, i: number) => ({ name: h.name, desc: h.desc, q: h.photo_query, photo: hl[i] })),
    curiosities: n.curiosities || [], tips: n.tips || [],
    photo: hero,
    gallery: gallery.filter((g) => g.url !== hero?.url).slice(0, 10),
    place: src?.lat != null ? { lat: src.lat, lon: src.lon } : inp.image && inp.lat != null ? { lat: inp.lat, lon: inp.lon } : null,
    wiki: src ? { url: src.url, lang: src.lang, title: src.title } : null,
    sources: src?.web?.sources || [],
    sourced: !!src,
    model: n._model,
    created_at: new Date().toISOString(),
  };
}
