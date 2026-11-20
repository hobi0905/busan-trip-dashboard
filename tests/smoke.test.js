// 대시보드 회귀 테스트 (jsdom)
// 준비: npm i jsdom  (node 18 이상)
// 실행: node tests/smoke.test.js
// jsdom 스모크 테스트: 룰렛 데이터/경비 계산, 교통수단 예매 알림 억제, 추천 모드 전환
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

// 테스트는 오프라인 — 클라우드 fetch 실패로 생기는 미처리 rejection은 무시한다
process.on("unhandledRejection", () => {});

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
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
    window.fetch = () => Promise.reject(new Error("offline-test"));
    window.structuredClone = (o) => JSON.parse(JSON.stringify(o));
    window.Notification = class { static permission = "denied"; static requestPermission() { return Promise.resolve("denied"); } };
    window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    window.HTMLElement.prototype.scrollIntoView = () => {};
    window.scrollTo = () => {};
    window.print = () => {};
    window.alert = (m) => { (window.__alerts = window.__alerts || []).push(String(m)); };
    window.confirm = () => true;
    if (!window.navigator.clipboard) {
      Object.defineProperty(window.navigator, "clipboard", { value: { writeText: () => Promise.resolve() } });
    }
  },
});

const w = dom.window;
const ev = (code) => w.eval(code);
const results = [];
const ok = (name, cond, extra) => results.push({ name, pass: !!cond, extra });

setTimeout(() => {
  try {
    const DOM = w.eval("ROULETTE_SPOTS.domestic");
    const OVER = w.eval("ROULETTE_SPOTS.overseas");
    const THEMES = w.eval("ROULETTE_THEMES");

    // 1) 데이터 로드
    ok("룰렛 데이터 로드", DOM.length >= 15 && OVER.length >= 15, `국내 ${DOM.length} / 해외 ${OVER.length}`);

    // 2) 모든 여행지 필드 검증
    const bad = [];
    const walk = (list, region) => list.forEach((d) => {
      if (!d.name || !d.blurb || !d.transit || !d.best) bad.push(d.name + ":필드");
      if (!Array.isArray(d.themes) || !d.themes.length) bad.push(d.name + ":취향");
      d.themes.forEach((t) => { if (!THEMES.some((x) => x.key === t)) bad.push(d.name + ":취향키 " + t); });
      if (!(d.nights >= 1)) bad.push(d.name + ":박수");
      if (region === "overseas" && !d.country) bad.push(d.name + ":국가");
      if (region === "domestic" && !d.mode) bad.push(d.name + ":이동수단");
      ["transport", "lodging", "food", "activity"].forEach((k) => { if (!((d.cost || {})[k] > 0)) bad.push(d.name + ":" + k); });
    });
    walk(DOM, "domestic");
    walk(OVER, "overseas");
    ok("여행지 데이터 정합성", bad.length === 0, bad.slice(0, 8).join(", "));

    // 취향 6종이 국내·해외 양쪽에 최소 2곳씩 있는지
    const thin = [];
    THEMES.forEach((t) => {
      [["국내", DOM], ["해외", OVER]].forEach(([label, list]) => {
        const n = list.filter((d) => d.themes.includes(t.key)).length;
        if (n < 2) thin.push(`${label}:${t.label}=${n}`);
      });
    });
    ok("취향 6종 커버리지", thin.length === 0, thin.join(", "));

    // 3) 경비 계산 (부산 2박3일)
    const busan = DOM.find((d) => d.name === "부산");
    const cost = w.rouletteCost(busan);
    ok("경비 계산(부산 2박3일)",
      cost.parts.transport === 120000 && cost.parts.lodging === 130000 && cost.parts.food === 126000 && cost.parts.activity === 60000 && cost.total === 436000,
      JSON.stringify(cost.parts) + " total=" + cost.total);

    // 4) 예매 불필요 수단 판정
    const cases = [
      ["지하철·전철", true], ["시내·광역버스", true], ["도보", true], ["자차", true], ["택시", true], ["기타", true],
      ["KTX", false], ["KTX/SRT", false], ["시외·고속버스", false], ["시외/고속버스", false], ["항공편", false], ["기차", false], ["버스", false]
    ];
    const failCases = cases.filter(([m, want]) => w.isBookingFreeTransit(m) !== want).map(([m, want]) => `${m}(want ${want})`);
    ok("예매 필요/불필요 판정", failCases.length === 0, failCases.join(", "));

    // 5) 가는 날/오는 날 교통수단 알림
    const n0 = ev("(state.bookingAlerts||[]).length");
    const a1 = w.addTransportBookingAlert("2027-03-06", "지하철·전철", "가는 날");
    const a2 = w.addTransportBookingAlert("2027-03-08", "시내·광역버스", "오는 날");
    const n1 = ev("(state.bookingAlerts||[]).length");
    const a3 = w.addTransportBookingAlert("2027-03-06", "기차", "가는 날");
    const n2 = ev("(state.bookingAlerts||[]).length");
    ok("대중교통은 알림 미생성", a1 === null && a2 === null && n1 === n0, `생성 ${n1 - n0}건`);
    ok("기차는 알림 생성", a3 !== null && n2 === n1 + 1, a3 && a3.title);

    // 6) 예약(교통편) 내역 알림
    const bSub = { type: "transit", mode: "지하철·전철", name: "2호선", from: "부산역", to: "광안역", depDate: "2027-03-06", depTime: "10:00" };
    const bKtx = { type: "transit", mode: "KTX", name: "KTX 25", from: "서울역", to: "부산역", depDate: "2027-03-06", depTime: "10:00" };
    ok("예약 내역 알림(지하철 X / KTX O)", w.autoAlertForBooking(bSub) === null && w.autoAlertForBooking(bKtx) !== null, "");

    // 7) 일정 항목으로 추가했을 때
    const dayObj = ev("state.days[0]");
    const itemSub = { id: "t1", time: "10:00", place: "부산역 → 광안역 (2호선)", fromPlace: "부산역", toPlace: "광안역", transitType: "지하철·전철", bookingFree: true, badges: ["지하철·전철", "예매 불필요"] };
    const itemKtx = { id: "t2", time: "11:00", place: "서울역 → 부산역 (KTX 25)", fromPlace: "서울역", toPlace: "부산역", transitType: "KTX", badges: ["KTX", "직접 추가"] };
    ok("일정 이동 알림(지하철 X / KTX O)", w.autoAlertForItem(dayObj, itemSub) === null && w.autoAlertForItem(dayObj, itemKtx) !== null, "");
    ok("예매 불필요 항목엔 예약 배지 없음", w.applyAutoBookingBadge(Object.assign({}, itemSub, { place: "해운대 전망대 → 광안리" })) === "", "");

    // 8) 추첨 로직
    let prob = [];
    for (let k = 0; k < 200; k++) prob.push(w.pickRouletteTop3(DOM, "healing"));
    const allThree = prob.every((p) => p.length === 3 && new Set(p.map((x) => x.name)).size === 3);
    const primaryFirst = prob.filter((p) => p[0].themes[0] === "healing").length;
    ok("룰렛 3곳 추첨·중복없음", allThree, "");
    ok("취향 1순위 우선", primaryFirst / prob.length > 0.8, `적중 ${primaryFirst}/200`);

    const noCountry = [];
    for (let k = 0; k < 100; k++) w.pickRouletteTop3(OVER, "city").forEach((d) => { if (!d.country) noCountry.push(d.name); });
    ok("해외 추첨 결과 국가 있음", noCountry.length === 0, [...new Set(noCountry)].join(","));

    // 9) ✨ 추천 탭은 3개 모드만 (룰렛은 새 여행 기본 설정 안으로 이동)
    ok("추천 탭 3모드만", !w.document.getElementById("rec-mode-roulette") && !w.document.getElementById("rec-roulette-panel")
      && !!w.document.getElementById("rec-mode-spot") && !!w.document.getElementById("rec-mode-route") && !!w.document.getElementById("rec-mode-must"), "");
    w.setRecommendMode("route");
    ok("추천 모드 전환", w.document.getElementById("rec-route-panel").style.display === "" && w.document.getElementById("rec-spot-panel").style.display === "none",
      `route=${w.document.getElementById("rec-route-panel").style.display} spot=${w.document.getElementById("rec-spot-panel").style.display}`);
    ok("추천 모드 버튼 3열", /\.rec-modes \{ display: grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/.test(html), "");

    // 10) 새 여행 기본 설정 모달 안 룰렛 — 국내/해외 자동 반영
    w.openNewTripSetupModal();
    const nts = w.document.getElementById("new-trip-setup-modal");
    const block = w.document.getElementById("roul-block");
    ok("국내 설정 모달에 룰렛 탑재", nts.classList.contains("open") && !!block.closest("#new-trip-setup-modal") && block.style.display !== "none", "");
    ok("국내 룰렛 기본 선택", w.document.querySelector("#roul-region-seg .roul-seg-btn.active").getAttribute("data-region") === "domestic", "");
    ok("룰렛은 기본 접힘", w.document.getElementById("roul-body").style.display === "none" && w.document.getElementById("roul-toggle-ic").textContent === "펼치기 ▾", "");
    w.openOverseasSetupModal();
    ok("해외 설정 모달에 룰렛 탑재·해외 자동 선택", !!block.closest("#overseas-setup-modal")
      && w.document.querySelector("#roul-region-seg .roul-seg-btn.active").getAttribute("data-region") === "overseas", "");
    w.closeOverseasSetupModal();

    // 11) 취향 복수 선택
    w.openNewTripSetupModal();
    w.eval("toggleRouletteBox(true)");
    ok("취향 칩 6개 렌더", w.document.querySelectorAll("#roul-theme-chips .roul-theme").length === 6,
      String(w.document.querySelectorAll("#roul-theme-chips .roul-theme").length));
    w.eval("clearRouletteThemes()");
    w.eval("setRouletteTheme('healing')");
    w.eval("setRouletteTheme('food')");
    const activeChips = w.document.querySelectorAll("#roul-theme-chips .roul-theme.active");
    ok("취향 복수 선택(2개)", ev("roulThemes.length") === 2 && activeChips.length === 2, `themes=${ev("JSON.stringify(roulThemes)")}`);
    ok("복수 선택 안내 문구", /여러 개 고를 수 있어요/.test(w.document.getElementById("roul-block").textContent)
      && w.document.getElementById("roul-theme-clear").style.display !== "none", "");

    // 12) 복수 취향 추첨: 겹치는 취향이 많은 순으로 Top 3
    const keys2 = ["healing", "food"];
    const cand2 = DOM.filter((d) => keys2.some((k) => d.themes.includes(k)));
    const counts2 = [];
    for (let k = 0; k < 60; k++) {
      const p = w.pickRouletteTop3(cand2, keys2);
      const c = p.map((d) => keys2.filter((x) => d.themes.includes(x)).length);
      if (!(p.length === 3 && new Set(p.map((x) => x.name)).size === 3 && c[0] >= c[1] && c[1] >= c[2] && c[2] >= 1)) { counts2.push(c.join("")); break; }
    }
    ok("복수 취향 추첨(겹침 많은 순)", counts2.length === 0, counts2.join(","));
    const multiPicks = w.pickRouletteTop3(cand2, keys2);
    ok("복수 취향 적합도", w.rouletteFit({ themes: ["healing", "food"] }, keys2) > w.rouletteFit({ themes: ["healing"] }, keys2), "");

    // 13) 결과 렌더(복수 취향)
    w.renderRouletteResults(multiPicks, keys2);
    const cards = w.document.querySelectorAll("#roul-results .roul-card");
    const text = w.document.getElementById("roul-results").textContent;
    ok("결과 카드 3장 + 경비·겹침 표시", cards.length === 3 && /1인 예상 경비/.test(text) && /₩/.test(text) && /박 \d일/.test(text) && /취향 적합/.test(text) && /겹침/.test(text),
      `cards=${cards.length}`);

    // 14) '이 여행지로 채우기' — 모달을 닫지 않고 폼에 자동 입력
    const top = multiPicks[0];
    w.fillTripSetupFromRoulette("domestic", top.name);
    ok("이 여행지로 채우기(모달 유지)", nts.classList.contains("open")
      && w.document.getElementById("nts-dest").value === top.name
      && /박/.test(w.document.getElementById("nts-title").value)
      && w.document.getElementById("nts-start").value !== ""
      && !!block.closest("#new-trip-setup-modal"),
      `dest=${w.document.getElementById("nts-dest").value} title=${w.document.getElementById("nts-title").value} start=${w.document.getElementById("nts-start").value}`);
    ok("채움 안내 문구", /채웠어요/.test(w.document.getElementById("roul-fill-note").textContent), "");

    // 해외 추천을 고르면 해외 설정 모달로 옮겨 채운다
    const overTop = w.pickRouletteTop3(OVER, ["city", "food"])[0];
    w.fillTripSetupFromRoulette("overseas", overTop.name);
    ok("해외 추천 → 해외 설정 모달 전환·입력", w.document.getElementById("overseas-setup-modal").classList.contains("open")
      && !nts.classList.contains("open")
      && /박/.test(w.document.getElementById("os-title").value)
      && !!block.closest("#overseas-setup-modal"),
      `title=${w.document.getElementById("os-title").value}`);
    w.closeOverseasSetupModal();

    // 12) 교통수단 옵션
    const ntsOpts = [...w.document.querySelectorAll("#nts-out-mode option")].map((o) => o.value);
    const bkOpts = [...w.document.querySelectorAll("#bk-mode option")].map((o) => o.value);
    const trOpts = [...w.document.querySelectorAll("#tr-type option")].map((o) => o.value);
    ok("새 여행 교통수단 옵션", ntsOpts.includes("지하철·전철") && ntsOpts.includes("시내·광역버스"), ntsOpts.join("|"));
    ok("예약 교통편 옵션", bkOpts.includes("지하철·전철") && bkOpts.includes("시내·광역버스"), bkOpts.join("|"));
    ok("일정 교통편 옵션", trOpts.includes("지하철·전철") && trOpts.includes("시내·광역버스") && trOpts.includes("도보"), trOpts.join("|"));


    // 16) 실제 저장 경로: 일정 교통편 모달로 지하철 추가 → 알림/배지 미생성
    const alertCount = () => ev("(state.bookingAlerts||[]).length");
    const itemsBefore = ev("state.days[0].items.length");
    const nBefore = alertCount();
    const d0 = w.document;
    w.openTransitModal();
    d0.getElementById("tr-pos").value = String(ev("state.days[0].items.length"));
    d0.getElementById("tr-type").value = "지하철·전철";
    d0.getElementById("tr-code").value = "2호선";
    d0.getElementById("tr-from").value = "부산역";
    d0.getElementById("tr-to").value = "광안역";
    d0.getElementById("tr-dep").value = "10:00";
    d0.getElementById("tr-arr").value = "10:35";
    d0.getElementById("tr-cost").value = "1700";
    w.eval('currentDay = 1');
    w.saveTransitItem();
    const added = ev("state.days[0].items.find(i => i.transitType === '지하철·전철')");
    ok("지하철 저장: 일정에 추가됨", ev("state.days[0].items.length") > itemsBefore && ev("state.days[0].items.some(i => i.transitType === '지하철·전철')"),
      `items ${itemsBefore} → ${ev("state.days[0].items.length")}`);
    ok("지하철 저장: 예매 알림 미생성", alertCount() === nBefore, `${nBefore} → ${alertCount()}`);
    ok("지하철 저장: '예매 불필요' 배지", (added.badges || []).includes("예매 불필요") && !(added.badges || []).some(b => /예매 필수/.test(b)),
      (added.badges || []).join("|"));

    // KTX는 같은 경로에서 알림이 생겨야 한다
    d0.getElementById("tr-type").value = "KTX/SRT";
    d0.getElementById("tr-code").value = "KTX 101";
    d0.getElementById("tr-from").value = "서울역";
    d0.getElementById("tr-to").value = "부산역";
    d0.getElementById("tr-dep").value = "09:00";
    d0.getElementById("tr-arr").value = "11:30";
    d0.getElementById("tr-cost").value = "59800";
    w.saveTransitItem();
    const ktxItem = ev("state.days[0].items.filter(i => i.transitType === 'KTX/SRT')[0]");
    const ktxAlert = w.autoAlertForItem(ev("state.days[0]"), ktxItem);
    ok("KTX 저장: 예매 알림 연결됨", ktxAlert !== null && /예매/.test(ktxAlert.title), ktxAlert && ktxAlert.title);
    ok("KTX 저장: '직접 추가' 배지 유지", (ktxItem.badges || []).includes("직접 추가") && !(ktxItem.badges || []).includes("예매 불필요"),
      (ktxItem.badges || []).join("|"));

    // 15) 룰렛 없이 바로 직접 입력해 여행 만들기
    w.setRecommendMode("spot");
    w.openNewTripSetupModal();
    w.document.getElementById("nts-title").value = "직접 입력 여행";
    w.document.getElementById("nts-dest").value = "강릉";
    w.document.getElementById("nts-start").value = "2027-03-06";
    w.document.getElementById("nts-end").value = "2027-03-08";
    w.document.getElementById("nts-travelers").value = "2";
    w.createGuidedTrip();
    ok("룰렛 없이 직접 입력해 여행 개설", ev("state.meta.title") === "직접 입력 여행"
      && ev("state.meta.destination") === "강릉"
      && ev("(state.days||[]).length") === 3
      && !nts.classList.contains("open"),
      `title=${ev("state.meta.title")} days=${ev("(state.days||[]).length")}`);

    // 13) 홈 지도 클릭 팝업 제거 + 확대/축소 설정
    const homeMapBlock = html.slice(html.indexOf('L.map("home-map"'), html.indexOf('L.map("home-map"') + 900);
    ok("홈 지도 클릭 팝업 제거", !/homeMap\.on\("click"/.test(html), "");
    ok("홈 지도 확대·축소·드래그", /zoomControl:\s*true/.test(homeMapBlock) && /scrollWheelZoom:\s*true/.test(homeMapBlock) && /dragging:\s*true/.test(homeMapBlock), "");

    // 14) 큰 지도 모달 z-index · PC 추천 폭
    ok("큰 지도 모달 z-index 상향", /id="big-map-modal"[^>]*z-index:3000/.test(html), "");
    ok("PC 추천 탭 1120px 규칙", /body\.view-pc #tab-recommend\.active \{ max-width: 1120px; \}/.test(html), "");
  } catch (e) {
    results.push({ name: "테스트 실행 오류", pass: false, extra: e.stack });
  }

  let failed = 0;
  results.forEach((r) => {
    if (!r.pass) failed++;
    console.log(`${r.pass ? "✅" : "❌"} ${r.name}${r.extra ? "  — " + r.extra : ""}`);
  });
  console.log(`\n${results.length - failed}/${results.length} 통과`);
  if (errors.length) console.log("\n[페이지 오류]\n" + errors.slice(0, 8).join("\n"));
  process.exit(failed ? 1 : 0);
}, 1200);
