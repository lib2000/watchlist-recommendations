// lookup: title / IMDb / JustWatch / Netflix(OTT) / Wikipedia URL -> candidates or details. Never fabricates.
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const UA = { "User-Agent": "Mozilla/5.0 (watchlist-lookup)", "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8" };
const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const TYPE: Record<string, string> = { movie: "영화", tvMovie: "영화", short: "영화", video: "영화", tvSeries: "TV", tvMiniSeries: "TV", tvSpecial: "TV" };

async function imdbSuggest(q: string) {
  const s = q.trim().toLowerCase();
  const r = await fetch(`https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(s)}.json?includeVideos=0`, { headers: UA });
  if (!r.ok) return [];
  const d = await r.json();
  return (d.d || []).filter((x: any) => /^tt\d+$/.test(x.id) && TYPE[x.qid]).slice(0, 8).map((x: any) => ({
    imdb_id: x.id, title: x.l, year: x.y ? String(x.y) : "", type: TYPE[x.qid], poster: x.i?.imageUrl || "", stars: x.s || "" }));
}
async function search(q: string) {
  const a = await imdbSuggest(q).catch(() => []);
  if (a.length || !/[가-힣]/.test(q)) return a;
  // Korean title: Wikidata label search -> entities that carry an IMDb ID
  const r = await fetch(`https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=ko&uselang=ko&type=item&limit=10&search=${encodeURIComponent(q)}`, { headers: UA });
  const ids = r.ok ? ((await r.json()).search || []).map((x: any) => x.id) : [];
  const E = await wdEntities(ids, "labels|claims"); const out: any[] = [];
  for (const id of ids) { const e = E[id]; const imdb = e?.claims?.P345?.[0]?.mainsnak?.datavalue?.value; if (!imdb || !/^tt/.test(imdb)) continue;
    const s2 = (await imdbSuggest(imdb).catch(() => [])).find((x: any) => x.imdb_id === imdb);
    out.push(s2 ? { ...s2, ko_title: lab(e) } : { imdb_id: imdb, title: e?.labels?.en?.value || lab(e), ko_title: lab(e), year: "", type: "", poster: "", stars: "" }); }
  return out.slice(0, 8);
}
async function wdEntities(ids: string[], props = "labels|claims") {
  if (!ids.length) return {};
  const r = await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&ids=${ids.slice(0, 50).join("|")}&props=${props}&languages=ko|en`, { headers: UA });
  return r.ok ? (await r.json()).entities || {} : {};
}
const lab = (e: any) => e?.labels?.ko?.value || e?.labels?.en?.value || "";
const cl = (e: any, p: string, n = 10) => (e?.claims?.[p] || []).map((c: any) => c.mainsnak?.datavalue?.value?.id).filter(Boolean).slice(0, n);
async function wikidata(imdb: string) {
  const r = await fetch(`https://www.wikidata.org/w/api.php?action=query&list=search&format=json&srsearch=haswbstatement:P345=${imdb}`, { headers: UA });
  const q = r.ok ? (await r.json()).query?.search?.[0]?.title : null;
  if (!q) return null;
  const e = (await wdEntities([q]))[q];
  const dir = cl(e, "P57"), cre = cl(e, "P170"), cast = cl(e, "P161", 6), gen = cl(e, "P136", 4);
  const L = await wdEntities([...dir, ...cre, ...cast, ...gen], "labels");
  const names = (a: string[]) => a.map((i) => lab(L[i])).filter(Boolean);
  return { qid: q, ko_title: e?.labels?.ko?.value || "", en_title: e?.labels?.en?.value || "", director: [...new Set(names([...dir, ...cre]))].join(", "), cast: names(cast).join(", "), genre: names(gen).join("/") };
}
const JWQ = `query($c:Country!,$l:Language!,$q:String!){popularTitles(country:$c,first:8,filter:{searchQuery:$q}){edges{node{objectType content(country:$c,language:$l){title originalReleaseYear fullPath externalIds{imdbId}} offers(country:$c,platform:WEB){monetizationType standardWebURL package{clearName}}}}}}`;
async function justwatch(q: string, imdb?: string) {
  const r = await fetch("https://apis.justwatch.com/graphql", { method: "POST", headers: { ...UA, "Content-Type": "application/json" }, body: JSON.stringify({ query: JWQ, variables: { c: "KR", l: "ko", q } }) });
  if (!r.ok) return { nodes: [], hit: null };
  const nodes = ((await r.json()).data?.popularTitles?.edges || []).map((e: any) => e.node);
  const hit = imdb ? nodes.find((n: any) => n.content?.externalIds?.imdbId === imdb) : null;
  return { nodes, hit };
}
function offers(n: any) {
  const M: Record<string, string> = { FLATRATE: "구독", FREE: "무료", ADS: "무료(광고)", RENT: "대여", BUY: "구매" };
  const seen = new Set<string>(); const out: any[] = [];
  for (const o of n?.offers || []) { const k = o.package?.clearName + o.monetizationType; if (seen.has(k) || !o.standardWebURL) continue; seen.add(k); out.push({ service: o.package?.clearName, type: M[o.monetizationType] || o.monetizationType, url: o.standardWebURL }); }
  return out;
}
async function details(imdb: string, hint?: { title?: string; year?: string; type?: string }) {
  const sug = (await imdbSuggest(imdb)).find((x: any) => x.imdb_id === imdb) || hint || {};
  const wd = await wikidata(imdb).catch(() => null);
  let jw: any = null;
  for (const q of [sug.title, wd?.en_title, wd?.ko_title].filter(Boolean)) { jw = (await justwatch(q!, imdb).catch(() => ({ hit: null }))).hit; if (jw) break; }
  return { imdb_id: imdb, imdb_url: `https://www.imdb.com/title/${imdb}/`, title: sug.title || wd?.en_title || "", ko_title: wd?.ko_title || jw?.content?.title || "",
    year: sug.year || (jw?.content?.originalReleaseYear ? String(jw.content.originalReleaseYear) : ""), type: sug.type || (jw ? (jw.objectType === "MOVIE" ? "영화" : "TV") : ""),
    genre: wd?.genre || "", director: wd?.director || "", cast: wd?.cast || sug.stars || "", poster: sug.poster || "",
    justwatch_url: jw?.content?.fullPath ? "https://www.justwatch.com" + jw.content.fullPath : "", ott: jw ? offers(jw) : [], sources: { wikidata: wd?.qid || null, justwatch: !!jw } };
}
const unesc = (x: string) => x.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
const STRIP = /\s*[|\-–:]\s*(넷플릭스|Netflix|TVING|티빙|Disney\+|디즈니\+|웨이브|wavve|쿠팡플레이|Coupang Play|왓챠|WATCHA|Apple TV.*|Prime Video).*$/i;
async function pageTitles(url: string): Promise<string[]> {
  const r = await fetch(url, { headers: { ...UA, "User-Agent": "Googlebot/2.1 (+http://www.google.com/bot.html)" }, redirect: "follow" }); if (!r.ok) return [];
  const h = await r.text(); const out: string[] = [];
  const og = h.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1]; const tt = h.match(/<title>([^<]+)<\/title>/i)?.[1];
  for (const m of [og, tt]) if (m) out.push(unesc(m).replace(STRIP, "").replace(/\s*(시청하기|보기|Watch)\s*$/i, "").trim());
  for (const m of h.matchAll(/"title":"((?:[^"\\]|\\.){1,120})"/g)) { out.push(unesc(m[1]).trim()); if (out.length > 6) break; }
  return [...new Set(out.filter((t) => t && !/^(netflix|넷플릭스|tving|티빙|disney\+|wavve|watcha|왓챠|coupang play|쿠팡플레이)$/i.test(t)))].slice(0, 3);
}
// OTT link: read page title, then confirm via JustWatch that an offer URL contains the link's content id
async function fromOtt(url: string) {
  const u = new URL(url); const tok = u.pathname.split("/").filter(Boolean).pop() || "";
  const titles = await pageTitles(url);
  for (const t of titles) {
    const { nodes } = await justwatch(t).catch(() => ({ nodes: [] as any[] }));
    const n = tok.length >= 4 ? nodes.find((x: any) => (x.offers || []).some((o: any) => (o.standardWebURL || "").includes(tok))) : null;
    const imdb = n?.content?.externalIds?.imdbId;
    if (imdb) return { kind: "details", item: await details(imdb), matched_by: "justwatch_offer_url" };
  }
  if (!titles.length) return null;
  return { kind: "candidates", items: await search(titles[0]), page_title: titles[0], ott_hint: url, note: "링크의 작품을 자동으로 확정하지 못했어요. 후보에서 골라 주세요." };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  // logged-in users only
  const auth = req.headers.get("Authorization") || "";
  const u = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, { headers: { Authorization: auth, apikey: Deno.env.get("SUPABASE_ANON_KEY")! } });
  if (!auth.startsWith("Bearer ") || !u.ok) return j({ error: "로그인이 필요해요." }, 401);
  let body: any = {}; try { body = await req.json(); } catch { /* */ }
  const q = String(body.q || "").trim().slice(0, 500);
  try {
    if (body.imdb_id && /^tt\d+$/.test(body.imdb_id)) return j({ kind: "details", item: await details(body.imdb_id) });
    if (!q) return j({ error: "제목이나 링크를 입력해 주세요." }, 400);
    const tt = q.match(/tt\d{5,}/)?.[0];
    if (tt) return j({ kind: "details", item: await details(tt) });
    if (/^https?:\/\//i.test(q)) {
      const url = new URL(q);
      if (/wikipedia\.org$/.test(url.hostname)) {
        const lang = url.hostname.split(".")[0], t = decodeURIComponent(url.pathname.replace(/^\/wiki\//, ""));
        const r = await (await fetch(`https://${lang}.wikipedia.org/w/api.php?action=query&prop=pageprops&format=json&redirects=1&titles=${encodeURIComponent(t)}`, { headers: UA })).json();
        const qid = (Object.values(r.query?.pages || {})[0] as any)?.pageprops?.wikibase_item;
        const e = qid ? (await wdEntities([qid], "claims"))[qid] : null;
        const imdb = e?.claims?.P345?.[0]?.mainsnak?.datavalue?.value;
        if (imdb) return j({ kind: "details", item: await details(imdb) });
        return j({ kind: "candidates", items: await search(t.replace(/_/g, " ").replace(/\s*\(.*\)$/, "")), note: "위키백과 문서에 IMDb ID가 없어 제목으로 찾았어요." });
      }
      if (/justwatch\.com$/.test(url.hostname)) {
        const slug = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "").replace(/-\d{4}$/, "").replace(/-/g, " ");
        const { nodes } = await justwatch(slug);
        const n = nodes.find((x: any) => x.content?.fullPath && decodeURIComponent(x.content.fullPath) === decodeURIComponent(url.pathname)) || null;
        const imdb = n?.content?.externalIds?.imdbId;
        if (imdb) return j({ kind: "details", item: await details(imdb) });
        return j({ kind: "candidates", items: await imdbSuggest(slug), note: "JustWatch 링크에서 작품을 정확히 찾지 못해 제목으로 찾았어요." });
      }
      const res = await fromOtt(q);
      if (!res) return j({ error: "링크에서 작품 제목을 읽지 못했어요. 제목으로 검색해 주세요." }, 422);
      return j(res);
    }
    return j({ kind: "candidates", items: await search(q) });
  } catch (e) { return j({ error: "조회 중 오류: " + (e as Error).message }, 502); }
});
