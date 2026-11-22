// 실제 장소 기반 추천·루트 생성 검증 (jsdom)
// 실행: NODE_PATH=<jsdom 있는 곳> node tests/route-live.test.js
// · 국내(경주): 카카오 SDK를 스텁으로 세우고 실제 상호·좌표·카카오맵 링크 확인
// · 해외(도쿄·파리): Overpass/Nominatim/위키백과를 스텁으로 세우고 카카오 미호출 확인
// · 가짜 이름('실내 식당가'·'백화점 카페'·'쇼핑몰 맛집'·'로컬 맛집' 등) 0건 확인
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

process.on("unhandledRejection", () => {});

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

const FAKE_RE = /실내 식당가|백화점 식당가|백화점 카페|쇼핑몰 맛집|쇼핑몰 카페|로컬 맛집|시장 먹거리|국밥·분식집|소문난 식당|실내 카페|서점 카페|감성 카페$|로스터리 카페$|시내 도착|대표 실내 미술관|핵심 랜드마크|일차 여유|일차 실내 전시|현지 인기 맛집|감성 카페로|여유로운 오후/;

const results = [];
const ok = (name, cond, extra) => results.push({ name, pass: !!cond, extra: extra === undefined ? "" : String(extra) });

/* ── 스텁 데이터: 도시별 실제 상호처럼 생긴 이름 + 좌표 ─────────── */
const CITY_POOLS = {
  경주: {
    food: ["황남손칼국수", "교리김밥 본점", "보문국밥", "성건동 한정식", "황리단길 불고기", "동궁찜닭", "남산가든", "용강동 곰탕", "충효동 막국수", "경주손두부"],
    cafe: ["대릉원 로스터리", "황리단길 한옥찻집", "보문호수 커피", "동부사적지 카페", "경주 디저트랩", "첨성대 커피"],
    sight: ["대릉원 산책로", "동궁과 월지", "첨성대", "무열왕릉", "경주향교", "계림 숲길"],
    indoorSight: ["국립경주박물관", "경주미술관", "경주전시관", "경주문화관"]
  },
  도쿄: {
    food: ["스시 사이토", "라멘 이치란 신주쿠", "우동 칸노", "야키토리 도리키조", "소바 마츠야", "돈카츠 스즈키", "텐동 코마츠", "오코노미야키 사쿠라"],
    cafe: ["블루보틀 긴자", "카페 키츠네", "커피 아오야마", "베이커리 분겐", "키무라 찻집"],
    sight: ["센소지", "메이지 신궁", "신주쿠 공원", "도쿄 타워", "시부야 스카이", "아사쿠사 거리"],
    indoorSight: ["도쿄 국립박물관", "국립서양미술관", "에도-도쿄 박물관", "타카시마야 쇼핑몰"]
  },
  파리: {
    food: ["르 콩투아", "부이용 샤르티에", "셰즈 르네", "라 메종 뒤 라멘", "르 뷔송", "비스트로 폴"],
    cafe: ["카페 드 플로르", "카페 소브렌", "베이커리 푸아송", "카페 키츠네 파리", "카페 드 라 팍스"],
    sight: ["에펠탑", "개선문", "몽마르트르 언덕", "튈르리 정원", "노트르담 대성당"],
    indoorSight: ["루브르 박물관", "오르세 미술관", "퐁피두 센터", "갤러리 라파예트"]
  }
};

const coordsOf = (city) => (city === "도쿄" ? { lat: 35.68, lng: 139.76 } : city === "파리" ? { lat: 48.86, lng: 2.35 } : { lat: 35.84, lng: 129.21 });
const cityFromCoords = (lat, lng) => (lat > 40 ? "파리" : lat > 30 && lng > 130 ? "도쿄" : "경주");

function makeRows(city, kind, lat, lng, radius, limit) {
  const pool = (CITY_POOLS[city] || CITY_POOLS["경주"])[kind] || [];
  return pool.slice(0, Math.max(1, limit)).map((name, i) => {
    const dLat = (((i % 4) - 1.5) * 0.006) * (radius > 3000 ? 2 : 1);
    const dLng = ((Math.floor(i / 4) - 0.5) * 0.006) * (radius > 3000 ? 2 : 1);
    return { name, lat: lat + dLat, lng: lng + dLng, kind, i };
  });
}

const jsonRes = (data) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });

let kakaoCalls = 0;
let overpassCalls = 0;

function installStubs(window) {
  // 🗺️ 카카오 SDK 스텁 (국내 전용)
  const kakao = {
    maps: {
      LatLng: function (lat, lng) { this.lat = lat; this.lng = lng; },
      services: {
        Status: { OK: "OK", ZERO_RESULT: "ZERO_RESULT", ERROR: "ERROR" },
        SortBy: { DISTANCE: "distance", ACCURACY: "accuracy" },
        Places: function () {}
      }
    }
  };
  const docOf = (row, city, code, category) => ({
    place_name: row.name,
    address_name: `${city} 어딘가 ${row.i + 1}`,
    road_address_name: `${city} 실제로 ${row.i + 1}`,
    category_name: category,
    category_group_code: code,
    x: String(row.lng), y: String(row.lat),
    distance: String(80 + row.i * 140),
    place_url: "https://place.map.kakao.com/" + (10000000 + row.i),
    phone: ""
  });
  kakao.maps.services.Places.prototype.categorySearch = function (code, cb, params) {
    kakaoCalls++;
    const city = cityFromCoords(params.location.lat, params.location.lng);
    const kind = code === "FD6" ? "food" : code === "CE7" ? "cafe" : code === "CT1" ? "indoorSight" : "sight";
    const cat = code === "FD6" ? "음식점 > 한식" : code === "CE7" ? "음식점 > 카페" : "문화,예술 > 박물관";
    const rows = makeRows(city, kind, params.location.lat, params.location.lng, params.radius || 2000, params.size || 10);
    cb(rows.map(r => docOf(r, city, code, cat)), "OK");
  };
  kakao.maps.services.Places.prototype.keywordSearch = function (q, cb, params) {
    kakaoCalls++;
    if (!params || !params.location) return cb([], "OK");
    const city = cityFromCoords(params.location.lat, params.location.lng);
    const kw = String(q);
    const kind = /박물관|미술관|전시/.test(kw) ? "indoorSight" : /공원|산책/.test(kw) ? "sight" : /카페/.test(kw) ? "cafe" : "food";
    const cat = kind === "cafe" ? "음식점 > 카페" : kind === "food" ? "음식점 > 한식" : "문화,예술 > 박물관";
    const rows = makeRows(city, kind, params.location.lat, params.location.lng, params.radius || 2000, params.size || 10);
    cb(rows.map(r => docOf(r, city, "", cat)), "OK");
  };
  window.kakao = kakao;

  // 🌐 OSM·Nominatim·위키백과 스텁 (해외 경로 — 카카오는 부르면 안 됨)
  window.fetch = (url) => {
    const u = String(url);
    if (u.includes("overpass")) {
      overpassCalls++;
      const body = decodeURIComponent((u.split("?data=")[1] || "").replace(/\+/g, " "));
      const m = body.match(/around:(\d+),(-?[\d.]+),(-?[\d.]+)/);
      if (!m) return jsonRes({ elements: [] });
      const radius = Number(m[1]), lat = Number(m[2]), lng = Number(m[3]);
      const city = cityFromCoords(lat, lng);
      const pool = CITY_POOLS[city] || CITY_POOLS["경주"];
      const elements = [];
      let id = 1000;
      const add = (name, i, tags) => elements.push({
        type: "node", id: id++, lat: lat + (((i % 3) - 1) * 0.0035), lon: lng + ((Math.floor(i / 3) - 1) * 0.0035),
        tags: { name, "addr:street": `${city} 중앙로 ${i + 1}`, opening_hours: "10:00-22:00", ...tags }
      });
      pool.food.forEach((n, i) => add(n, i, { amenity: "restaurant", cuisine: "korean" }));
      pool.cafe.forEach((n, i) => add(n, i, { amenity: "cafe" }));
      pool.sight.forEach((n, i) => add(n, i, { tourism: "attraction", wikidata: "Q1" }));
      pool.indoorSight.forEach((n, i) => add(n, i, { tourism: "museum", wikidata: "Q2" }));
      add(`${city} 시민공원`, 1, { leisure: "park", wikidata: "Q3" });
      return jsonRes({ elements });
    }
    if (u.includes("nominatim.openstreetmap.org")) {
      let q = "";
      try { q = decodeURIComponent((u.match(/[?&]q=([^&]*)/) || [])[1] || "").replace(/\+/g, " "); } catch (e) { q = ""; }
      if (/에펠탑|eiffel/i.test(q)) return jsonRes([{ lat: "48.8584", lon: "2.2945", name: "에펠탑", class: "tourism", type: "attraction", extratags: {} }]);
      if (/루브르|louvre/i.test(q)) return jsonRes([{ lat: "48.8606", lon: "2.3376", name: "루브르 박물관", class: "tourism", type: "museum", extratags: {} }]);
      if (/restaurants in|restaurants /i.test(q)) return jsonRes([]);
      return jsonRes([{ lat: "48.8566", lon: "2.3522", name: "파리", class: "place", type: "city", address: { city: "Paris" }, extratags: {} }]);
    }
    if (u.includes("wikipedia.org")) {
      let coord = "";
      try { coord = decodeURIComponent((u.match(/gscoord=([^&]*)/) || [])[1] || ""); } catch (e) { coord = ""; }
      const parts = coord.split("|").map(Number);
      const lat = parts[0] || 0, lng = parts[1] || 0;
      const city = lat ? cityFromCoords(lat, lng) : "경주";
      const marks = {
        도쿄: ["도쿄 타워", "센소지", "메이지 신궁"],
        파리: ["에펠탑", "루브르 박물관"],
        경주: []
      }[city] || [];
      return jsonRes({
        query: {
          geosearch: marks.map((title, i) => ({
            title, lat: lat + 0.002 * (i + 1), lon: lng + 0.002 * (i + 1), dist: 300 + i * 400
          }))
        }
      });
    }
    if (u.includes("photon.komoot.io")) return jsonRes({ features: [] });
    return Promise.reject(new Error("offline-test"));
  };
}

const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => errors.push("jsdomError: " + ((e.detail && e.detail.stack) || e.stack || e.message)));
vc.on("error", (...a) => errors.push("console.error: " + a.join(" ")));

const dom = new JSDOM(html, {
  runScripts: "dangerously",
  url: "https://hobi0905.github.io/busan-trip-dashboard/",
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    window.structuredClone = (o) => JSON.parse(JSON.stringify(o));
    window.Notification = class { static permission = "denied"; static requestPermission() { return Promise.resolve("denied"); } };
    window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    window.HTMLElement.prototype.scrollIntoView = () => {};
    window.scrollTo = () => {};
    window.print = () => {};
    window.alert = (m) => { (window.__alerts = window.__alerts || []).push(String(m)); };
    window.confirm = () => true;
    if (!window.navigator.clipboard) Object.defineProperty(window.navigator, "clipboard", { value: { writeText: () => Promise.resolve() } });
    installStubs(window);
  }
});

const w = dom.window;
const ev = (code) => w.eval(code);

function planItems() {
  const plan = ev("window._generatedRoutePlan");
  const out = [];
  (plan?.days || []).forEach(d => (d.items || []).forEach(it => out.push({ day: d.day, label: d.label, ...it })));
  return out;
}

function setTrip(opts) {
  ev(`state.meta = ${JSON.stringify({
    title: opts.title, destination: opts.dest, startDate: opts.start, endDate: opts.end,
    travelers: 2, tripType: opts.tripType || "domestic", country: opts.country || "대한민국"
  })};
  state.days = ${JSON.stringify(opts.days)};
  state.bookings = []; state.expenses = []; state.weather = []; state.savedPlaces = [];
  currentDay = 1; saveState();`);
}

const dayStub = (start, n) => Array.from({ length: n }, (_, i) => {
  const dt = new Date(start + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + i);
  const iso = dt.toISOString().slice(0, 10);
  return { day: i + 1, date: iso, label: `${i + 1}일차`, items: [] };
});

async function runRoute(dest, start, end) {
  ev("MAP_ENGINE.kakao = 'ready'; MAP_ENGINE.kakaoPromise = null;");
  w.setRecommendMode("route");
  w.document.getElementById("route-dest").value = dest;
  w.document.getElementById("route-start").value = start;
  w.document.getElementById("route-end").value = end;
  await w.generateNewRoute();
}

function checkRealPlaces(label, dest, opts) {
  const items = planItems();
  const text = w.document.getElementById("route-results").textContent;
  const fakes = items.filter(it => FAKE_RE.test(String(it.place || "")));
  ok(`${label}: 가짜 이름 0건`, fakes.length === 0, fakes.map(x => x.place).join(", "));
  ok(`${label}: 화면에도 가짜 이름 없음`, !FAKE_RE.test(text), (text.match(FAKE_RE) || [""])[0]);
  ok(`${label}: 3일 모두 최소 4곳`, ev("window._generatedRoutePlan.days").every(d => d.items.length >= 4),
    ev("window._generatedRoutePlan.days").map(d => d.items.length).join(","));
  ok(`${label}: 모든 장소에 좌표`, items.every(it => typeof it.lat === "number" && typeof it.lng === "number"),
    items.filter(it => typeof it.lat !== "number").map(it => it.place).join(", "));
  ok(`${label}: 여행 전체 중복 없음`, new Set(items.map(it => it.place)).size === items.length, `${new Set(items.map(it => it.place)).size}/${items.length}`);
  const needsMeal = ev("window._generatedRoutePlan.days").every(d => {
    const b = d.items.map(it => (it.badges || []).join(" "));
    return b.some(t => /점심/.test(t)) && b.some(t => /식후 카페/.test(t)) && b.some(t => /저녁/.test(t));
  });
  ok(`${label}: 매일 점심·카페·저녁`, needsMeal, ev("window._generatedRoutePlan.days").map(d => d.items.map(i => (i.badges || [])[0]).join("/")).join(" | "));
  if (opts.domestic) {
    ok(`${label}: 지도 링크가 카카오맵`, items.every(it => /^https:\/\/map\.kakao\.com\//.test(String(it.mapUrl || ""))),
      items.filter(it => !/^https:\/\/map\.kakao\.com\//.test(String(it.mapUrl || ""))).slice(0, 3).map(it => it.mapUrl).join(", "));
    ok(`${label}: 카카오에서 실제 상호를 받아옴`, kakaoCalls > 0, `kakaoCalls=${kakaoCalls}`);
  } else {
    ok(`${label}: 카카오 미호출`, kakaoCalls === 0, `kakaoCalls=${kakaoCalls}`);
    ok(`${label}: 지도 링크에 카카오 없음`, items.every(it => !/kakao/.test(String(it.mapUrl || "")) && /^https:\/\//.test(String(it.mapUrl || ""))),
      items.slice(0, 2).map(it => it.mapUrl).join(", "));
    ok(`${label}: OSM에서 실제 상호를 받아옴`, overpassCalls > 0, `overpassCalls=${overpassCalls}`);
  }
  const stubNames = new Set(Object.values(CITY_POOLS[dest] || {}).flat());
  const fromLive = items.filter(it => stubNames.has(it.place)).length;
  ok(`${label}: 실제 API 결과가 일정에 반영`, fromLive >= 6, `live=${fromLive}/${items.length}`);
  return items;
}

setTimeout(async () => {
  try {
    await new Promise(r => setTimeout(r, 1200));
    // ── 1) 국내 경주 3일 (기본) ──────────────────────────────
    setTrip({ title: "경주", dest: "경주", start: "2027-04-02", end: "2027-04-04", days: dayStub("2027-04-02", 3) });
    ev("recWeatherMode = 'none'");
    await runRoute("경주", "2027-04-02", "2027-04-04");
    const gyeongju = checkRealPlaces("경주 기본", "경주", { domestic: true });

    // ── 2) 국내 경주 3일 (폭염 실내 위주) ─────────────────────
    ev("recWeatherMode = 'heat'");
    await runRoute("경주", "2027-04-02", "2027-04-04");
    const gyeongjuHeat = checkRealPlaces("경주 폭염", "경주", { domestic: true });
    const badOutdoor = gyeongjuHeat.filter(it => it.indoor !== true);
    ok("경주 폭염: 모두 실내 장소", badOutdoor.length === 0, badOutdoor.map(x => x.place).join(", "));
    ok("경주 폭염: 실내 배지", gyeongjuHeat.some(it => (it.badges || []).includes("🏠 실내")), "");

    // ── 3) 해외 도쿄 3일 (기본) ──────────────────────────────
    const kakaoBefore = kakaoCalls;
    ev("recWeatherMode = 'none'");
    ev("ROUTE_PLACE_CACHE.clear()");
    setTrip({ title: "도쿄", dest: "도쿄", start: "2027-05-01", end: "2027-05-03", tripType: "overseas", country: "JP", days: dayStub("2027-05-01", 3) });
    kakaoCalls = 0;
    await runRoute("도쿄", "2027-05-01", "2027-05-03");
    const tokyoItems = checkRealPlaces("도쿄 기본", "도쿄", { domestic: false });
    ok("도쿄 기본: 위키백과 알려진 명소 포함", tokyoItems.some(i => ["도쿄 타워", "센소지", "메이지 신궁"].includes(i.place)), tokyoItems.map(i => i.place).join(", "));

    // ── 4) 해외 도쿄 3일 (폭염 실내 위주) ────────────────────
    ev("recWeatherMode = 'heat'");
    ev("ROUTE_PLACE_CACHE.clear()");
    kakaoCalls = 0;
    await runRoute("도쿄", "2027-05-01", "2027-05-03");
    const tokyoHeat = checkRealPlaces("도쿄 폭염", "도쿄", { domestic: false });
    ok("도쿄 폭염: 모두 실내 장소", tokyoHeat.every(it => it.indoor === true), tokyoHeat.filter(it => it.indoor !== true).map(x => x.place).join(", "));

    // ── 5) 해외 파리 3일 (기본) ──────────────────────────────
    ev("recWeatherMode = 'none'");
    ev("ROUTE_PLACE_CACHE.clear()");
    setTrip({ title: "파리", dest: "파리", start: "2027-06-04", end: "2027-06-06", tripType: "overseas", country: "FR", days: dayStub("2027-06-04", 3) });
    kakaoCalls = 0;
    await runRoute("파리", "2027-06-04", "2027-06-06");
    checkRealPlaces("파리 기본", "파리", { domestic: false });

    // ── 6) 동선 맞춤 추천 — 해외 파리 '카페' ─────────────────
    setTrip({ title: "파리", dest: "파리", start: "2027-06-04", end: "2027-06-06", tripType: "overseas", country: "FR", days: dayStub("2027-06-04", 3) });
    ev(`state.days = window._generatedRoutePlan.days.map(d => ({ ...d })); currentDay = 1; saveState();`);
    w.initRecommendSelectors();
    ev("recWeatherMode = 'none'");
    kakaoCalls = 0;
    w.document.getElementById("rec-purpose").value = "카페";
    w.document.getElementById("rec-day").value = "1";
    w.updateRecommendAfterOptions();
    await w.runPlaceRecommend();
    const recTxt = w.document.getElementById("rec-results").textContent;
    ok("파리 추천: 카드 5곳", w.document.querySelectorAll("#rec-results .rec-pick").length === 5, String(w.document.querySelectorAll("#rec-results .rec-pick").length));
    ok("파리 추천: 가짜 이름 없음", !/주변 실측 장소|실내 식당가|백화점 카페|로컬 맛집/.test(recTxt), "");
    ok("파리 추천: 카카오 미호출", kakaoCalls === 0, `kakaoCalls=${kakaoCalls}`);
    const recLinks = [...w.document.querySelectorAll("#rec-results a")].map(a => a.getAttribute("href") || "");
    ok("파리 추천: 카카오 링크 없음", recLinks.length > 0 && recLinks.every(h => !/kakao/.test(h)), recLinks.slice(0, 2).join(", "));
    ok("파리 추천: 실제 카페 이름", CITY_POOLS["파리"].cafe.some(n => recTxt.includes(n)), recTxt.replace(/\s+/g, " ").slice(0, 90));

    // ── 7) 동선 맞춤 추천 — 국내 경주 '음식점' ───────────────
    setTrip({ title: "경주", dest: "경주", start: "2027-04-02", end: "2027-04-04", days: dayStub("2027-04-02", 3) });
    ev("recWeatherMode = 'none'");
    await runRoute("경주", "2027-04-02", "2027-04-04");
    ev(`state.days = window._generatedRoutePlan.days.map(d => ({ ...d })); currentDay = 1; saveState();`);
    w.initRecommendSelectors();
    ev("MAP_ENGINE.kakao = 'ready'");
    ev("recWeatherMode = 'none'");
    kakaoCalls = 0;
    w.document.getElementById("rec-purpose").value = "음식점";
    w.document.getElementById("rec-day").value = "1";
    w.updateRecommendAfterOptions();
    await w.runPlaceRecommend();
    const recKr = w.document.getElementById("rec-results").textContent;
    ok("경주 추천: 카드 5곳", w.document.querySelectorAll("#rec-results .rec-pick").length === 5, String(w.document.querySelectorAll("#rec-results .rec-pick").length));
    ok("경주 추천: 카카오로 실제 식당", kakaoCalls > 0 && CITY_POOLS["경주"].food.some(n => recKr.includes(n)), recKr.replace(/\s+/g, " ").slice(0, 90));
    ok("경주 추천: 가짜 이름 없음", !/주변 실측 장소|실내 식당가|백화점 카페|로컬 맛집/.test(recKr), "");
    const krLinks = [...w.document.querySelectorAll("#rec-results a")].map(a => a.getAttribute("href") || "");
    ok("경주 추천: 카카오맵 링크", krLinks.length > 0 && krLinks.every(h => /^https:\/\/map\.kakao\.com\//.test(h)), krLinks.slice(0, 2).join(", "));

    // ── 8) 필수 장소 코스 — 해외 파리 (에펠탑·루브르) ─────────
    setTrip({ title: "파리", dest: "파리", start: "2027-06-04", end: "2027-06-06", tripType: "overseas", country: "FR", days: dayStub("2027-06-04", 3) });
    ev("ROUTE_PLACE_CACHE.clear()");
    kakaoCalls = 0;
    w.setRecommendMode("must");
    w.document.getElementById("must-dest").value = "파리";
    w.document.getElementById("must-start").value = "2027-06-04";
    w.document.getElementById("must-end").value = "2027-06-06";
    ev("mustVisitSpots = [{ name: '에펠탑' }, { name: '루브르 박물관' }]");
    await w.optimizeMustVisitRoute();
    const mustItems = planItems();
    const mustTxt = w.document.getElementById("must-results").textContent;
    ok("필수 코스: 에펠탑·루브르 포함", mustItems.some(i => /에펠탑/.test(i.place)) && mustItems.some(i => /루브르/.test(i.place)), mustItems.map(i => i.place).join(", "));
    ok("필수 코스: 가짜 이름 없음", !FAKE_RE.test(mustItems.map(i => i.place).join(" ")) && !FAKE_RE.test(mustTxt), "");
    ok("필수 코스: 매일 점심·카페·저녁", ev("window._generatedRoutePlan.days").every(d => {
      const b = d.items.map(it => (it.badges || []).join(" "));
      return b.some(t => /점심/.test(t)) && b.some(t => /저녁/.test(t));
    }), ev("window._generatedRoutePlan.days").map(d => d.items.map(i => (i.badges || [])[0]).join("/")).join(" | "));
    ok("필수 코스: 카카오 미호출·링크에 카카오 없음", kakaoCalls === 0 && mustItems.every(i => !/kakao/.test(String(i.mapUrl || ""))), `kakaoCalls=${kakaoCalls}`);
    ok("필수 코스: 모든 장소에 좌표", mustItems.every(i => typeof i.lat === "number" && typeof i.lng === "number"), "");

    // ── 9) 오프라인(네트워크 실패) — 가짜 이름 대신 안내 문구 ─────────
    const liveFetch = w.fetch;
    w.fetch = () => Promise.reject(new Error("offline-test"));
    ev("ROUTE_PLACE_CACHE.clear(); ROUTE_BUNDLE_CACHE.clear(); ROUTE_BUNDLE_PENDING.clear(); ROUTE_WIKI_CACHE.clear();");
    setTrip({ title: "오사카", dest: "오사카", start: "2027-07-01", end: "2027-07-02", tripType: "overseas", country: "JP", days: dayStub("2027-07-01", 2) });
    await runRoute("오사카", "2027-07-01", "2027-07-02");
    const offTxt = w.document.getElementById("route-results").textContent;
    ok("오프라인: 가짜 이름 없음", !FAKE_RE.test(offTxt), offTxt.replace(/\s+/g, " ").slice(0, 80));
    ok("오프라인: 안내 문구 표시", /실제 장소를 불러오지 못했어요/.test(offTxt) && ev("window._generatedRoutePlan") === null, offTxt.replace(/\s+/g, " ").slice(0, 120));
    w.fetch = liveFetch;

    ok("스크립트 오류 없음", errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    ok("테스트 실행", false, e && (e.stack || e.message));
  }
  results.forEach(r => console.log(`${r.pass ? "✅" : "❌"} ${r.name}${r.extra ? "  — " + r.extra : ""}`));
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} 통과`);
  process.exit(failed ? 1 : 0);
}, 60);
