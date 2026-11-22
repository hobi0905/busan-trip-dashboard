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

setTimeout(async () => {
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
    ok("새 여행 교통수단 옵션: 대중교통 통합", ntsOpts.includes("대중교통") && !ntsOpts.includes("지하철·전철") && !ntsOpts.includes("시내·광역버스"), ntsOpts.join("|"));
    const osOpts = [...w.document.querySelectorAll("#os-out-mode option")].map((o) => o.value);
    ok("해외 새 여행 교통수단 옵션: 대중교통 통합", osOpts.includes("대중교통") && !osOpts.includes("지하철·전철"), osOpts.join("|"));
    ok("예약 교통편 옵션: 대중교통 통합", bkOpts.includes("대중교통") && !bkOpts.includes("지하철·전철") && !bkOpts.includes("시내·광역버스"), bkOpts.join("|"));
    ok("일정 교통편 옵션: 대중교통 통합", trOpts.includes("대중교통") && !trOpts.includes("지하철·전철") && !trOpts.includes("시내·광역버스") && trOpts.includes("도보"), trOpts.join("|"));
    ok("대중교통은 예매 불필요 판정", w.isBookingFreeTransit("대중교통") === true, "");


    // 16) 실제 저장 경로: 일정 교통편 모달로 지하철 추가 → 알림/배지 미생성
    const alertCount = () => ev("(state.bookingAlerts||[]).length");
    const itemsBefore = ev("state.days[0].items.length");
    const nBefore = alertCount();
    const d0 = w.document;
    w.openTransitModal();
    d0.getElementById("tr-pos").value = String(ev("state.days[0].items.length"));
    d0.getElementById("tr-type").value = "대중교통";
    d0.getElementById("tr-code").value = "2호선";
    d0.getElementById("tr-from").value = "부산역";
    d0.getElementById("tr-to").value = "광안역";
    d0.getElementById("tr-dep").value = "10:00";
    d0.getElementById("tr-arr").value = "10:35";
    d0.getElementById("tr-cost").value = "1700";
    w.eval('currentDay = 1');
    w.saveTransitItem();
    const added = ev("state.days[0].items.find(i => i.transitType === '대중교통')");
    ok("대중교통 저장: 일정에 추가됨", ev("state.days[0].items.length") > itemsBefore && ev("state.days[0].items.some(i => i.transitType === '대중교통')"),
      `items ${itemsBefore} → ${ev("state.days[0].items.length")}`);
    ok("대중교통 저장: 예매 알림 미생성", alertCount() === nBefore, `${nBefore} → ${alertCount()}`);
    ok("대중교통 저장: '예매 불필요' 배지", (added.badges || []).includes("예매 불필요") && !(added.badges || []).some(b => /예매 필수/.test(b)),
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
    ok("KTX 저장: '직접 추가' 꼬리표 없이 수단만", (ktxItem.badges || []).includes("KTX/SRT") && !(ktxItem.badges || []).some(b => /직접\s*추가/.test(String(b))) && !(ktxItem.badges || []).includes("예매 불필요"),
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
    /* ================= 2026-11-21 추가 요구사항 ================= */

    // 17) 🚌🚇 대중교통 통합 — 기존 저장 데이터('지하철·전철','시내·광역버스')도 예매 불필요로 유지
    ok("대중교통 통합 + 하위 호환", w.isBookingFreeTransit("대중교통") && w.isBookingFreeTransit("지하철·전철") && w.isBookingFreeTransit("시내·광역버스"), "");
    ok("대중교통 정적 안내 문구", /대중교통·자차는 알림 없이/.test(html), "");

    // 18) 📱 빈 여행에서는 고정 부산 앱(블루라인파크)이 뜨지 않는다
    ev("state.meta = { title:'빈 여행', destination:'강릉', startDate:'2027-06-01', endDate:'2027-06-02', travelers:2 }; state.days = buildDateRangeDays('2027-06-01','2027-06-02','강릉'); state.bookings = []; saveState();");
    w.renderBookingAppLinks();
    const emptyApp = w.document.getElementById("booking-apps-links").textContent;
    ok("빈 여행 앱: 블루라인 없음", !/블루라인/.test(emptyApp), emptyApp.trim().slice(0, 60));
    ok("빈 여행 앱: 안내 문구", /예매가 필요한 장소를 추가하면/.test(emptyApp), emptyApp.trim().slice(0, 60));
    ok("정적 HTML에도 고정 앱 없음", !/bluelinepark/.test(html.slice(html.indexOf('id="booking-apps-links"'), html.indexOf('id="booking-apps-links"') + 400)), "");

    // 19) 🎰 룰렛 인원·일정 길이·동행 유형
    w.openNewTripSetupModal();
    w.toggleRouletteBox(true);
    ok("룰렛 인원/길이 UI", !!w.document.getElementById("roul-people") && !!w.document.getElementById("roul-length"), "");
    ok("동행 유형 칩 6개", w.document.querySelectorAll("#roul-party-chips .roul-party").length === 6, String(w.document.querySelectorAll("#roul-party-chips .roul-party").length));
    const busanSpot = ev("ROULETTE_SPOTS.domestic.find(d=>d.name==='부산')");
    const costDefault = w.rouletteCost(busanSpot);
    const cost4n3 = w.rouletteCost(busanSpot, { nights: 4, travelers: 3 });
    ok("경비: 4박·3명 반영", cost4n3.nights === 4 && cost4n3.travelers === 3 && cost4n3.total > costDefault.total && cost4n3.groupTotal === cost4n3.total * 3,
      `기본 ${costDefault.total} → ${cost4n3.total} (합계 ${cost4n3.groupTotal})`);
    w.setRoulettePeople("3");
    w.setRouletteLength("4");
    w.setRouletteParty("friends");
    ok("인원/길이/유형 선택 저장", ev("roulPeople") === 3 && ev("roulNights") === 4 && ev("roulParty") === "friends",
      `${ev("roulPeople")}/${ev("roulNights")}/${ev("roulParty")}`);
    w.renderRouletteResults([busanSpot], []);
    const roulTxt = w.document.getElementById("roul-results").textContent;
    ok("결과: 4박5일·3명·총액 표시", /4박 5일/.test(roulTxt) && /3명 합계/.test(roulTxt) && /1인 예상 경비/.test(roulTxt), roulTxt.replace(/\s+/g, " ").slice(0, 90));
    ok("결과: 동행 유형 태그", /친구들과 함께/.test(roulTxt), "");
    w.fillTripSetupFromRoulette("domestic", "부산");
    ok("채우기: 인원·날짜·제목 반영", w.document.getElementById("nts-travelers").value === "3"
      && w.document.getElementById("nts-title").value === "부산 4박 5일"
      && (new Date(w.document.getElementById("nts-end").value) - new Date(w.document.getElementById("nts-start").value)) / 86400000 === 4,
      `${w.document.getElementById("nts-title").value} / ${w.document.getElementById("nts-travelers").value}명 / ${w.document.getElementById("nts-start").value}~${w.document.getElementById("nts-end").value}`);
    const partySorted = w.pickRouletteTop3(ev("ROULETTE_SPOTS.domestic"), [], "family");
    ok("동행 유형이 추첨에 반영", partySorted.length === 3 && partySorted.every(d => w.roulettePartyFit(d, "family") >= 1), partySorted.map(d => d.name).join(","));
    w.closeNewTripSetupModal();

    // 20) 🇰🇷 내장 지명·역 DB + 검색 정확도
    ok("내장 지명 DB 100곳 이상", ev("KR_PLACES.length") >= 100, String(ev("KR_PLACES.length")));
    const myeong = w.krGazetteerSearch("명동역", 5);
    ok("'명동역' → 명동역 최상단", myeong[0] && myeong[0].name === "명동역" && /4호선/.test(myeong[0].sub), JSON.stringify(myeong[0]));
    ok("'서울역' 정확 매칭", w.krGazetteerSearch("서울역", 3)[0].name === "서울역", "");
    ok("'해운대' 역·해변 매칭", w.krGazetteerSearch("해운대", 4).some(x => /해운대역|해운대해수욕장/.test(x.name)), w.krGazetteerSearch("해운대", 4).map(x => x.name).join(","));
    ok("'만사장' 오타에도 결과 없음·안전", Array.isArray(w.krGazetteerSearch("ㅁㄴㅇㄹ", 3)), "");

    // 21) 🔎 연관검색어 자동완성 — 입력 후 목록 → 클릭 시 좌표 입력
    const acInput = w.document.getElementById("pm-search-q");
    ok("자동완성 래퍼 부착", acInput.parentElement.classList.contains("ac-wrap") && !!w.document.getElementById("ac-pm-search-q"), "");
    w.openPlaceModal(null);
    acInput.value = "명동역";
    acInput.dispatchEvent(new w.Event("input"));
    await new Promise(r => setTimeout(r, 420));
    const acList = w.document.getElementById("ac-pm-search-q");
    ok("자동완성 목록 열림", acList.classList.contains("open") && /명동역/.test(acList.textContent), acList.textContent.replace(/\s+/g, " ").slice(0, 60));
    acList.querySelector(".ac-item").dispatchEvent(new w.MouseEvent("mousedown", { bubbles: true }));
    ok("자동완성 클릭 → 입력·좌표", acInput.value === "명동역" && ev("pickedLat") === 37.5609 && ev("pickedLng") === 126.9863,
      `${acInput.value} / ${ev("pickedLat")},${ev("pickedLng")}`);
    w.closePlaceModal();
    ok("검색칸 자동완성 전수 부착", ["pm-place", "pm-from", "pm-to", "tr-from", "tr-to", "bk-sched-search", "bk-hotel-search-q", "place-address", "nts-dest", "route-dest", "must-dest"].every(id => w.document.getElementById("ac-" + id)), "");

    // 22) 🗺️ 국내 빈 여행 지도는 대한민국 전체 뷰
    ev("state.meta = { title:'서울 빈 여행', destination:'서울', startDate:'2027-05-01', endDate:'2027-05-03', travelers:2 }; state.days = buildDateRangeDays('2027-05-01','2027-05-03','서울'); state.bookings=[]; state.expenses=[]; saveState();");
    const dv = w.defaultMapView();
    ok("국내 빈 여행 기본 지도 뷰", dv.center[0] === 36.35 && dv.center[1] === 127.85 && dv.zoom >= 6 && dv.zoom <= 7, JSON.stringify(dv));
    ev("state.meta.tripType='overseas'; state.meta.country='일본';");
    ok("해외 여행은 대한민국 뷰 아님", w.defaultMapView().zoom < 4, JSON.stringify(w.defaultMapView()));
    ev("state.meta.tripType='domestic'; delete state.meta.country;");

    // 23) ✨ 서울 추천 탭 — 부산/바다 오인 제거
    ok("추천 목적지 자동 동기화", w.document.getElementById("route-dest").value === "서울" && w.document.getElementById("must-dest").value === "서울",
      `${w.document.getElementById("route-dest").value} / ${w.document.getElementById("must-dest").value}`);
    ev("state.days[0].items = [{id:'se1',time:'10:00',place:'경복궁',lat:37.5796,lng:126.9770,costTotal:0},{id:'se2',time:'13:00',place:'익선동',lat:37.5746,lng:126.9900,costTotal:0}]; saveState();");
    w.setRecommendMode("spot");
    const recDaySel = w.document.getElementById("rec-day");
    recDaySel.value = "1";
    w.updateRecommendAfterOptions();
    w.document.getElementById("rec-after").value = "1";
    await w.runPlaceRecommend();
    const seoulRec = w.document.getElementById("rec-results").textContent;
    ok("서울 추천에 부산·바다 없음", !/광안리|해운대|광안대교|민락/.test(seoulRec), seoulRec.replace(/\s+/g, " ").slice(0, 80));
    ok("서울 추천 결과 5곳", w.document.querySelectorAll("#rec-results .rec-pick").length === 5, String(w.document.querySelectorAll("#rec-results .rec-pick").length));
    ok("서울 전용 추천 풀", ev("curatedSpotsForCity('서울').length") >= 15 && ev("curatedSpotsForCity('서울')").every(x => x.lat > 37 && x.lng > 126 && x.lng < 127.2), "");

    // 24) 🗺️ 서울 2박 3일 신규 루트 — 3곳만 나오거나 전 일차 중복 금지
    w.setRecommendMode("route");
    w.document.getElementById("route-dest").value = "서울";
    w.document.getElementById("route-start").value = "2027-03-06";
    w.document.getElementById("route-end").value = "2027-03-08";
    await w.generateNewRoute();
    const plan = ev("window._generatedRoutePlan");
    const allNames = plan.days.flatMap(d => d.items.map(i => i.place));
    ok("서울 루트: 일차마다 3~4곳", plan.days.length === 3 && plan.days.every(d => d.items.length >= 3), plan.days.map(d => d.items.length).join(","));
    ok("서울 루트: 전 일차 중복 없음", new Set(allNames).size === allNames.length && allNames.length >= 10, `${new Set(allNames).size}/${allNames.length}`);
    ok("서울 루트: 서울 장소만", !/광안리|해운대|부산/.test(allNames.join(" ")), allNames.join(", ").slice(0, 100));

    // 25) 🏨 숙박 미예약 동선 맞춤 권역 Top 3
    w.renderTimeline();
    const lodgingTxt = w.document.getElementById("lodging-rec-box").textContent;
    ok("숙박 권역 추천 카드", /동선 맞춤 숙박 권역 추천 Top 3/.test(lodgingTxt), lodgingTxt.replace(/\s+/g, " ").slice(0, 80));
    ok("권역 3곳 + 평균 이동거리", w.document.querySelectorAll("#lodging-rec-box .lr-row").length === 3 && /평균 이동/.test(lodgingTxt), "");
    ok("권역 추천은 서울 역·권역", /서울역|명동|종로3가|홍대입구|강남|잠실|성수|이태원/.test(lodgingTxt), lodgingTxt.replace(/\s+/g, " ").slice(0, 120));
    const lodgTop = w.recommendLodgingAreas(3);
    ok("권역 점수 정렬", lodgTop.length === 3 && lodgTop[0].score <= lodgTop[1].score && lodgTop[1].score <= lodgTop[2].score, lodgTop.map(a => a.name).join(","));

    // 26) ✏️ 편집 모드 — 컴팩트 행 [−][카드][≡] + 순서 변경
    const d0items = ev("state.days[0].items.length");
    w.toggleEditMode();
    const editRows = w.document.querySelectorAll("#timeline-list .tl-edit-row[data-item-id]");
    ok("편집 행 렌더", editRows.length === d0items, `${editRows.length}/${d0items}`);
    ok("편집 행 구성: 삭제·복사·핸들", w.document.querySelectorAll("#timeline-list .tl-edit-del").length === d0items
      && w.document.querySelectorAll("#timeline-list .tl-edit-copy").length === d0items
      && w.document.querySelectorAll("#timeline-list .tl-edit-handle").length === d0items, "");
    ok("편집 모드에 사진·메뉴 버튼 숨김", w.document.querySelectorAll("#timeline-list .ph-slot").length === 0
      && !/메뉴 선택/.test(w.document.getElementById("timeline-list").textContent), "");
    const beforeOrder = ev("state.days[0].items.map(i=>i.place)");
    const beforeTimesById = ev("JSON.stringify(state.days[0].items.map(i=>[String(i.id), i.time]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0))");
    const listEl = w.document.getElementById("timeline-list");
    const rowsArr = [...listEl.querySelectorAll(".tl-edit-row[data-item-id]")];
    listEl.insertBefore(rowsArr[rowsArr.length - 1], rowsArr[0]);
    w.commitTimelineEditOrder();
    const afterOrder = ev("state.days[0].items.map(i=>i.place)");
    ok("드래그 순서 반영", afterOrder[0] === beforeOrder[beforeOrder.length - 1] && afterOrder.length === beforeOrder.length,
      `${beforeOrder.join(">")} → ${afterOrder.join(">")}`);
    // 🕒 이제 순서가 기준 — 시간 값은 각 일정에 그대로 붙어 있고, 화면도 시간이 아니라 배열 순서를 따른다
    ok("순서 변경 후 각 일정의 시간은 그대로", ev("JSON.stringify(state.days[0].items.map(i=>[String(i.id), i.time]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0))") === beforeTimesById,
      `${beforeTimesById} → ${ev("JSON.stringify(state.days[0].items.map(i=>[String(i.id), i.time]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0))")}`);
    w.toggleEditMode();

    // 27) 📅 일반 일정 카드: 메모만 기본, 메뉴·가격은 펼치면
    const plainCard = w.document.querySelector("#timeline-list .card.tl-collapsible");
    ok("카드 기본 접힘", plainCard && !plainCard.classList.contains("tl-open") && !!plainCard.querySelector(".tl-extra") && /더 보기/.test(plainCard.textContent), "");
    ok("접힘 CSS: 세부는 접히고 펼치면 보인다", /\.tl-extra \{ display: none; \}/.test(html) && /\.card\.tl-open \.tl-extra \{ display: block; \}/.test(html)
      && !/\.tl-stay/.test(html), "");
    plainCard.querySelector(".tl-place").click();
    ok("카드 탭 → 펼침", plainCard.classList.contains("tl-open") && /접기/.test(plainCard.textContent), "");
    plainCard.querySelector(".tl-place").click();
    ok("다시 탭 → 접힘", !plainCard.classList.contains("tl-open"), "");

    // 28) 📝 메모 입력칸 확대
    const memoEl = w.document.getElementById("pm-memo");
    ok("메모 textarea", memoEl.tagName === "TEXTAREA" && memoEl.getAttribute("rows") === "3" && /\.pm-memo \{[^}]*min-height: 88px/.test(html.replace(/\n/g, " ")), memoEl.tagName);

    // 29) 🏨 숙소 검색 → 좌표 → 지도/카드 반영
    w.openBookingModal(null, "hotel");
    ok("숙소 검색칸 열림", w.document.getElementById("bk-hotel-search-wrap").style.display === "block" && !!w.document.getElementById("bk-hotel-search-q"), "");
    w.document.getElementById("bk-hotel-search-q").value = "명동역";
    await w.searchBookingHotelByName();
    ok("숙소 이름 검색 결과", /명동역/.test(w.document.getElementById("bk-hotel-search-results").textContent), "");
    w.pickBookingHotelName(0);
    ok("숙소 좌표 선택", ev("bkSchedCoords && bkSchedCoords.lat") === 37.5609 && ev("bkSchedCoords.lng") === 126.9863, ev("JSON.stringify(bkSchedCoords)"));
    w.document.getElementById("bk-name").value = "명동 테스트 호텔";
    w.document.getElementById("bk-price").value = "200000";
    w.document.getElementById("bk-booker").value = "__custom";
    w.document.getElementById("bk-booker-name").value = "테스터";
    w.document.getElementById("bk-in-date").value = "2027-05-01";
    w.document.getElementById("bk-out-date").value = "2027-05-03";
    await w.saveBooking();
    const savedHotel = ev("(state.bookings||[]).find(b=>b.type==='hotel')");
    ok("숙소 저장: 이름·좌표", savedHotel && savedHotel.name === "명동 테스트 호텔" && savedHotel.lat === 37.5609 && savedHotel.lng === 126.9863,
      savedHotel && `${savedHotel.name} ${savedHotel.lat},${savedHotel.lng}`);
    ok("숙소 좌표로 지도 핀 계산", (() => { const c = w.hotelCoordsForBooking(savedHotel); return c && c.lat === 37.5609; })(), "");
    w.renderTimeline();
    ok("숙소 저장 후 권역 추천 숨김", w.document.getElementById("lodging-rec-box").textContent.trim() === "", "");
    ok("일정에 숙소 카드 반영", /명동 테스트 호텔/.test(w.document.getElementById("timeline-list").textContent), "");

    /* ================= 2026-11-21 (요구 4건) ================= */

    // 30) 🖼️ 일정 카드마다 대표 사진 딱 1장 (이동 카드는 목적지 사진)
    ev("state.meta = { title:'사진 테스트', destination:'부산', startDate:'2027-01-31', endDate:'2027-02-02', travelers:2 }; state.days = [{day:1,date:'2027-01-31',label:'1일차 (일)', items:[{id:'p1',time:'08:11',place:'숭의역 → 광명역',fromPlace:'숭의역',toPlace:'광명역',moveMode:'수인분당선',moveMin:80,moveCost:4900,costTotal:4900},{id:'p2',time:'12:55',place:'본전돼지국밥'},{id:'p3',time:'15:40',place:'카페 차선책 (광안리)'}]}]; state.bookings = []; state.expenses = []; currentDay = 1; saveState();");
    w.renderTimeline();
    const photoCards = [...w.document.querySelectorAll("#timeline-list .card")];
    ok("카드마다 사진 1장", photoCards.length === 3 && photoCards.every(c => c.querySelectorAll(".ph-slot").length === 1),
      `${photoCards.length}장 카드 / 슬롯 ${photoCards.map(c => c.querySelectorAll(".ph-slot").length).join(",")}`);
    ok("사진 칸이 비지 않음(폴백 SVG 데이터 URI)", photoCards.every(c => {
      const img = c.querySelector(".ph-slot img.ph-thumb");
      return img && /^data:image\/svg\+xml/.test(img.getAttribute("src") || "");
    }), "");
    ok("이동 카드 사진 = 도착지", w.photoSubjectOf({ place: "숭의역 → 광명역", fromPlace: "숭의역", toPlace: "광명역" }) === "광명역"
      && w.photoSubjectOf({ place: "광명역 → 부산역 (KTX 25)" }) === "부산역"
      && w.photoSubjectOf({ place: "🏨 호텔 아쿠아 펠리스 복귀" }) === "호텔 아쿠아 펠리스",
      [w.photoSubjectOf({ place: "숭의역 → 광명역", toPlace: "광명역" }), w.photoSubjectOf({ place: "광명역 → 부산역 (KTX 25)" }), w.photoSubjectOf({ place: "🏨 호텔 아쿠아 펠리스 복귀" })].join(" / "));
    ok("접힌 카드에서도 사진 표시", !/\.card\.tl-collapsible:not\(\.tl-open\) \.ph-slot \{ display: none; \}/.test(html)
      && /\.card\.tl-collapsible:not\(\.tl-open\) \.ph-slot \.ph-thumb/.test(html)
      && photoCards.filter(c => !c.classList.contains("tl-open")).every(c => c.querySelectorAll(".ph-slot img").length === 1), "");
    const photoBtnCount = w.document.querySelectorAll("#timeline-list .ph-btn").length;
    ok("빈 사진 버튼 대신 사진 타일", photoBtnCount === 0, `ph-btn ${photoBtnCount}`);

    // 31) 🎨 방문시간 배지 카테고리 색상
    const catCases = [["스타벅스 광안리점", "cafe"], ["어니언 성수", "cafe"], ["광장시장", "food"], ["하이라오", "food"],
      ["서울역", "transit"], ["부산역", "transit"], ["KTX 25", "transit"], ["대중교통 2호선", "transit"],
      ["경복궁", "sight"], ["남산타워", "sight"], ["롯데월드 전망대", "sight"], ["국립중앙박물관", "sight"],
      ["미미라인", "shopping"], ["더현대 서울", "shopping"], ["쇼핑 아울렛", "shopping"], ["호텔 롯데", "stay"]];
    const badCat = catCases.filter(([p, want]) => w.tlTimeCat({ place: p }) !== want).map(([p, want]) => `${p}→${w.tlTimeCat({ place: p })}(기대 ${want})`);
    ok("카테고리 분류(스펙 예시 전부)", badCat.length === 0, badCat.join(", "));
    ok("이동·교통 카드는 교통색", w.tlTimeCat({ place: "A → B", fromPlace: "A", toPlace: "B" }) === "transit"
      && w.tlTimeCat({ place: "숭의역 → 광명역" }) === "transit", "");
    const timeClasses = [...w.document.querySelectorAll("#timeline-list .tl-time")].map(e => e.className);
    ok("방문시간 배지에 카테고리 클래스", timeClasses.length === 3 && timeClasses.every(c => /tt-(cafe|food|transit|sight|shopping|stay|etc)/.test(c)), timeClasses.join("|"));
    ok("카테고리 색상 CSS 6종+기타", ["tt-cafe", "tt-food", "tt-transit", "tt-sight", "tt-shopping", "tt-stay", "tt-etc"]
      .every(c => new RegExp("\\.tl-time\\." + c + " \\{").test(html)), "");
    ok("펼친 카드에서도 색상 유지", w.document.querySelector("#timeline-list .tl-time.tt-food") !== null, "");

    // 32) 🗂️ 내 여행 목록 모달 — 지도·바텀시트 위, 화면 정중앙
    const backdropZ = Number((html.match(/\.modal-backdrop \{[^}]*z-index:\s*(\d+)/) || [])[1]);
    ok("모달 z-index가 지도·시트보다 위", backdropZ >= 2000, `modal z-index=${backdropZ} (지도 pane 400~800, 홈시트 620)`);
    ok("여행목록 모달 z-index 지정", /#trips-modal \{ z-index: 2400; \}/.test(html), "");
    ok("모달 정중앙 정렬 CSS", /\.modal-backdrop\.center \{ align-items: center; \}/.test(html)
      && /\.modal-backdrop\.center \.modal-sheet \{ margin: auto; \}/.test(html), "");
    w.openTripsModal();
    const tripsModal = w.document.getElementById("trips-modal");
    ok("여행목록 모달 열림·body 직속", tripsModal.classList.contains("open") && tripsModal.parentElement === w.document.body, "");
    w.closeTripsModal();
    ok("여행목록 모달 닫힘", !tripsModal.classList.contains("open"), "");

    // 33) 🧾 상단 고정 요약 제거 → 경비/체크 탭으로
    const headerHtml = html.slice(html.indexOf("<header class=\"sticky-header\""), html.indexOf("</header>"));
    ok("헤더에서 경비·예약 요약 제거", !/summary-strip/.test(headerHtml) && !/총 예상 경비/.test(headerHtml) && !/예약 완료/.test(headerHtml), "");
    const expCard = w.document.querySelector("#tab-expenses #exp-sum-card");
    ok("경비 탭에 총예상·1인당", expCard && expCard.querySelector("#sum-total") && expCard.querySelector("#sum-per") && /총 예상 경비/.test(expCard.textContent), "");
    const chkCard = w.document.querySelector("#tab-checklist #chk-resv-card");
    ok("체크 탭에 예약 완료 진행률", chkCard && chkCard.querySelector("#sum-done") && chkCard.querySelector("#resv-bar-fill"), "");
    ok("PC 사이드바 요약에서 경비·예약 제거", !/pcs-sum-total|pcs-sum-per|pcs-sum-done/.test(html) && !/예약 완료<\/span>/.test(html), "");
    ok("다른 탭엔 요약 없음", ["tab-home", "tab-timeline", "tab-recommend", "tab-weather-packing", "tab-mypage"].every(id => {
      const el = w.document.getElementById(id);
      return el && !el.querySelector(".summary-strip") && !el.querySelector("#sum-done") && !el.querySelector("#sum-total");
    }), "");
    ev("state.expenses = [{cat:'교통',name:'KTX',amount:104400,status:'완료'},{cat:'숙소',name:'호텔',amount:200000,status:'예정'}]; saveState();");
    w.renderHeader();
    const doneTxt = w.document.getElementById("sum-done").textContent;
    ok("예약 완료 건수·진행률 갱신", /\d+\/\d+건/.test(doneTxt) && /%$/.test(w.document.getElementById("resv-bar-fill").style.width || ""),
      `${doneTxt} / bar=${w.document.getElementById("resv-bar-fill").style.width}`);

    /* ================= 2026-11-21 (≡ 터치 드래그 · 들림 효과) ================= */

    // 34) 🖐️ iOS Safari 터치 대응 — 손잡이 CSS·이벤트 경로
    ok("손잡이 터치 제스처 차단 CSS", /\.tl-edit-handle, \.tl-drag-handle \{[^}]*touch-action: none;/.test(html)
      && /\.tl-edit-handle, \.tl-drag-handle \{[^}]*user-select: none;/.test(html)
      && /\.tl-edit-handle, \.tl-drag-handle \{[^}]*user-select: none;[^}]*-webkit-touch-callout: none;/.test(html), "");
    ok("touchstart·touchmove·touchend + 마우스 경로 등록",
      /addEventListener\("touchstart", tlEditTouchStart, \{ passive: false \}\)/.test(html)
      && /addEventListener\("touchmove", tlEditTouchMove, \{ passive: false \}\)/.test(html)
      && /addEventListener\("touchend", tlEditTouchEnd/.test(html)
      && /addEventListener\("mousedown", tlEditMouseDown\)/.test(html)
      && /addEventListener\("mousemove", tlEditMouseMove\)/.test(html)
      && /addEventListener\("mouseup", tlEditMouseUp\)/.test(html), "");
    ok("들림 효과 CSS (scale·그림자·흰 배경·z-index)", /\.tl-drag-ghost \{[^}]*z-index: 100;/.test(html)
      && /\.tl-drag-ghost-in \{[^}]*background: #ffffff;/.test(html)
      && /\.tl-drag-ghost-in \{[^}]*box-shadow: 0 14px 30px rgba\(15, 23, 42, 0\.18\)/.test(html)
      && /\.tl-drag-ghost-in \{[^}]*transform: scale\(1\.03\)/.test(html)
      && /\.tl-edit-row \{ transition: transform 0\.15s/.test(html), "");

    // 35) 🖐️ 터치 드래그 실제 동작 — 들린 카드 생성 · 순서 변경 · 놓으면 저장
    ev("state.meta = { title:'드래그 테스트', destination:'부산', startDate:'2027-01-31', endDate:'2027-02-02', travelers:2 }; state.days = [{day:1,date:'2027-01-31',label:'1일차 (일)', items:[{id:'d1',time:'09:00',place:'가'},{id:'d2',time:'10:00',place:'나'},{id:'d3',time:'11:00',place:'다'},{id:'d4',time:'12:00',place:'라'}]}]; state.bookings = []; state.expenses = []; currentDay = 1; saveState();");
    w.toggleEditMode();
    const dragList = w.document.getElementById("timeline-list");
    let dragRows = [...dragList.querySelectorAll(".tl-edit-row[data-item-id]")];
    // jsdom 은 레이아웃이 없으므로 행 상자를 70px 간격으로 가짜 지정
    dragRows.forEach((r, i) => {
      r.getBoundingClientRect = () => ({ top: i * 70, bottom: i * 70 + 60, height: 60, left: 8, right: 382, width: 374, x: 8, y: i * 70 });
    });
    const touchEvent = (type, target, y) => {
      const e = new w.Event(type, { bubbles: true, cancelable: true });
      const t = { identifier: 7, target, clientX: 360, clientY: y, pageX: 360, pageY: y };
      e.touches = type === "touchend" ? [] : [t];
      e.changedTouches = [t];
      e.targetTouches = e.touches;
      return e;
    };
    const handle0 = dragRows[0].querySelector(".tl-edit-handle");
    const started = !handle0.dispatchEvent(touchEvent("touchstart", handle0, 30));   // preventDefault 되었는가
    const ghost = w.document.querySelector(".tl-drag-ghost");
    ok("터치 시작 → 즉시 들린 카드(고스트)", started && !!ghost && !!ghost.querySelector(".tl-drag-ghost-in")
      && /가/.test(ghost.textContent), ghost ? ghost.textContent.trim() : "고스트 없음");
    ok("드래그 중 원래 행은 빈 자리로", dragRows[0].classList.contains("tl-drag-slot") && w.document.body.classList.contains("tl-dragging"), "");
    w.document.dispatchEvent(touchEvent("touchmove", w.document, 190));
    const ghostAfter = w.document.querySelector(".tl-drag-ghost");
    ok("손가락을 따라 이동(translateY)", ghostAfter && /translate3d\(8px, 160px/.test(ghostAfter.style.transform), ghostAfter && ghostAfter.style.transform);
    const orderDuring = [...dragList.querySelectorAll(".tl-edit-row[data-item-id]")].map(r => r.getAttribute("data-item-id"));
    ok("지나간 자리로 순서가 바뀜", orderDuring.join(",") !== "d1,d2,d3,d4", orderDuring.join(","));
    const firstAfterMove = orderDuring[0];
    w.document.dispatchEvent(touchEvent("touchend", w.document, 190));
    const savedOrder = ev("state.days[0].items.map(i=>i.id)");
    ok("손을 떼면 그 순서대로 저장", savedOrder.join(",") === orderDuring.join(",") && savedOrder[0] === firstAfterMove, savedOrder.join(","));
    ok("놓은 뒤 시간은 각 일정에 그대로 (순서가 기준)", ev("state.days[0].items.map(i=>i.time).join(',')") === "10:00,11:00,09:00,12:00", ev("state.days[0].items.map(i=>i.time).join(',')"));
    await new Promise(r => setTimeout(r, 220));   // 떠 있던 카드는 0.13초 페이드아웃 뒤 제거된다
    ok("놓은 뒤 고스트·드래그 상태 정리", !w.document.querySelector(".tl-drag-ghost") && !w.document.querySelector(".tl-drag-slot")
      && !w.document.body.classList.contains("tl-dragging"), "");
    w.toggleEditMode();

    // 36) 🌀 드래그 중에 목록이 다시 그려지는 경우(날씨·동기화)에도 순서가 깨지지 않는다
    ev("state.meta = { title:'드래그 재렌더', destination:'부산', startDate:'2027-01-31', endDate:'2027-02-02', travelers:2 }; state.days = [{day:1,date:'2027-01-31',label:'1일차 (일)', items:[{id:'r1',time:'09:00',place:'가'},{id:'r2',time:'10:00',place:'나'},{id:'r3',time:'11:00',place:'다'},{id:'r4',time:'12:00',place:'라'}]}]; state.bookings = []; currentDay = 1; saveState();");
    w.toggleEditMode();
    const rList = w.document.getElementById("timeline-list");
    let rRows = [...rList.querySelectorAll(".tl-edit-row[data-item-id]")];
    rRows.forEach((r, i) => {
      r.getBoundingClientRect = () => ({ top: i * 70, bottom: i * 70 + 60, height: 60, left: 8, right: 382, width: 374, x: 8, y: i * 70 });
    });
    const rEvt = (type, y) => {
      const e = new w.Event(type, { bubbles: true, cancelable: true });
      const t = { identifier: 9, target: rRows[0], clientX: 360, clientY: y };
      e.touches = type === "touchend" ? [] : [t];
      e.changedTouches = [t];
      e.targetTouches = e.touches;
      return e;
    };
    rRows[0].querySelector(".tl-edit-handle").dispatchEvent(rEvt("touchstart", 30));
    w.document.dispatchEvent(rEvt("touchmove", 190));
    w.renderTimeline();   // 날씨 갱신 등으로 드래그 도중 목록이 다시 그려지는 상황
    await new Promise(r => setTimeout(r, 250));
    ok("드래그 중 재렌더: 행 중복 없음", w.document.querySelectorAll("#timeline-list .tl-edit-row[data-item-id]").length === 4
      && !w.document.querySelector(".tl-drag-ghost") && !w.document.querySelector(".tl-drag-slot"),
      `rows=${w.document.querySelectorAll("#timeline-list .tl-edit-row[data-item-id]").length}`);
    ok("드래그 중 재렌더: 순서 유지", ev("state.days[0].items.map(i=>i.id).join(',')") === "r2,r3,r1,r4",
      ev("state.days[0].items.map(i=>i.id).join(',')"));
    w.document.dispatchEvent(rEvt("touchend", 190));
    w.toggleEditMode();

    /* ================= 2026-11-21 (예약 연동 카드도 접힘/펼침) ================= */

    // 37) 🏨 자동 추가된 호텔 카드(복귀·출발)도 일반 카드처럼 접힘/펼침
    ev("state.meta = { title:'호텔 카드 테스트', destination:'부산', startDate:'2027-01-31', endDate:'2027-02-02', travelers:2 }; state.days = [{day:1,date:'2027-01-31',label:'1일차 (일)', items:[{id:'h1',time:'12:55',place:'본전돼지국밥'},{id:'h2',time:'15:40',place:'광안대교 야경'}]},{day:2,date:'2027-02-01',label:'2일차 (월)', items:[{id:'h3',time:'10:00',place:'감천문화마을'}]}]; state.bookings = [{id:'hb1',type:'hotel',name:'호텔 아쿠아 펠리스',inDate:'2027-01-31',outDate:'2027-02-02',inTime:'15:00',outTime:'11:00',price:200000,payStatus:'reserved',room:'디럭스 오션뷰 더블'}]; state.expenses = []; currentDay = 1; saveState();");
    w.renderTimeline();
    const vCards = [...w.document.querySelectorAll("#timeline-list .card.tl-virtual")];
    ok("호텔 연동 카드 생성", vCards.length >= 1, `${vCards.length}장`);
    ok("호텔 카드 기본은 접힘", vCards.every(c => c.classList.contains("tl-collapsible") && !c.classList.contains("tl-open")), vCards.map(c => c.className).join(" | "));
    ok("호텔 카드에 더 보기 표시", vCards.every(c => /더 보기/.test((c.querySelector(".tl-fold-cue") || {}).textContent || "")), "");
    ok("호텔 카드: 제목·메모·사진 1장", vCards.every(c => !!c.querySelector(".tl-place") && !!c.querySelector(".tl-memo")
      && c.querySelectorAll(".ph-slot").length === 1 && !!c.querySelector(".tl-extra")), "");
    ok("호텔 카드: 일반 카드와 같은 모양(파란 띠·배경 없음)", !/\.tl-virtual\s*\{[^}]*border-left: 4px/.test(html)
      && !/\.tl-virtual\s*\{[^}]*background: var\(--ocean-soft\)/.test(html)
      && !/\.card\.tl-virtual\.tl-collapsible:not\(\.tl-open\) \.tl-memo/.test(html), "");
    ok("호텔 카드: 상세는 .tl-extra 안", vCards.every(c => !!c.querySelector(".tl-extra .tl-meta")),
      vCards.map(c => c.querySelectorAll(".tl-extra .tl-meta").length).join(","));
    const vCard = vCards[0];
    const vId = vCard.getAttribute("data-card-id");
    vCard.querySelector(".tl-place").click();
    ok("호텔 카드 탭 → 펼침", vCard.classList.contains("tl-open") && /접기/.test(vCard.querySelector(".tl-fold-cue").textContent)
      && ev(`expandedTimelineCards.has(${JSON.stringify(vId)})`), vCard.className);
    vCard.querySelector(".tl-place").click();
    ok("다시 탭 → 접힘", !vCard.classList.contains("tl-open") && /더 보기/.test(vCard.querySelector(".tl-fold-cue").textContent), "");
    ok("호텔 카드: 펼치면 지도 버튼, 금액·결제 문구는 없음", (() => {
      w.renderTimeline();
      const c = w.document.querySelector(`#timeline-list .card[data-card-id="${vId}"]`);
      c.querySelector(".tl-place").click();
      const extra = c.querySelector(".tl-extra");
      const card = c.textContent;
      return !!extra.querySelector(".tl-meta .map-btn") && !extra.querySelector(".tl-cost")
        && !/₩|결제 예정|결제 완료/.test(card);
    })(), "");

    /* ================= 2026-11-21 (폭염·한파 실내 위주 코스) ================= */

    // 38) 🌡️ 야외/실내 분류 + 두 추천 모드 칩
    ok("실내·야외 분류", w.spotIndoorInfo({ name: "여의도 한강공원" }).outdoor && w.spotIndoorInfo({ name: "광안리 해수욕장 & 해변산책" }).outdoor
      && w.spotIndoorInfo({ name: "남산 둘레길 (백범광장)" }).outdoor && !w.spotIndoorInfo({ name: "여의도 한강공원" }).indoor
      && w.spotIndoorInfo({ name: "더현대 서울" }).indoor && w.spotIndoorInfo({ name: "국립중앙박물관" }).indoor
      && w.spotIndoorInfo({ name: "코엑스 아쿠아리움" }).indoor && w.spotIndoorInfo({ name: "부산역 & 본전돼지국밥" }).indoor, "");
    const wChips = [...w.document.querySelectorAll(".rec-weather-chips")];
    ok("동선 맞춤·신규 루트 양쪽에 날씨 칩", wChips.length === 2 && wChips.every(b => b.querySelectorAll(".style-chip").length === 3),
      `${wChips.length}박스 / ${wChips.map(b => b.querySelectorAll(".style-chip").length).join(",")}`);
    w.pickRecWeatherMode("heat");
    ok("폭염 모드 선택·칩 활성", ev("recWeatherMode") === "heat"
      && w.document.querySelectorAll(".rec-weather-chips .style-chip.active").length === 2
      && /폭염/.test(w.document.querySelector(".rec-weather-chips .style-chip.active").textContent), "");

    // 39) 📍 1. 동선 맞춤 — 실내 모드에서 산책(야외) 대신 실내 장소가 나온다
    ev("state.meta = { title:'실내 추천 테스트', destination:'서울', startDate:'2027-03-06', endDate:'2027-03-08', travelers:2 }; state.days = [{day:1,date:'2027-03-06',label:'1일차 (토)', items:[{id:'w1',time:'10:00',place:'경복궁',lat:37.5796,lng:126.9770}]},{day:2,date:'2027-03-07',label:'2일차 (일)', items:[]},{day:3,date:'2027-03-08',label:'3일차 (월)', items:[]}]; state.bookings = []; state.expenses = []; currentDay = 1; saveState();");
    w.setRecommendMode("spot");
    w.document.getElementById("rec-day").value = "1";
    w.updateRecommendAfterOptions();
    w.document.getElementById("rec-purpose").value = "산책";
    await w.runPlaceRecommend();
    const heatPicks = ev("window._lastRecSpots").map(s => s.name);
    ok("동선 맞춤(폭염): 5곳 나옴", heatPicks.length === 5, heatPicks.join(", "));
    ok("동선 맞춤(폭염): 한강공원·해변·산책로 없음", heatPicks.every(n => !/한강|공원|해수욕|해변|산책|둘레길|숲|골목|거리|야경/.test(n)), heatPicks.join(", "));
    ok("동선 맞춤(폭염): 실내 우선 정렬", ev("window._lastRecSpots.slice(0,3).every(s => spotIndoorInfo(s).indoor)"), heatPicks.slice(0, 3).join(", "));
    ok("동선 맞춤(폭염): 안내 문구·실내 배지", /폭염 대비 실내/.test(w.document.getElementById("rec-results").textContent)
      && /🏠 실내/.test(w.document.getElementById("rec-results").textContent), "");

    // 40) 🗺️ 2. 신규 루트 — 실내 모드에서 야외 명소가 빠진다
    w.setRecommendMode("route");
    w.pickRecWeatherMode("heat");
    w.document.getElementById("route-dest").value = "서울";
    w.document.getElementById("route-start").value = "2027-03-06";
    w.document.getElementById("route-end").value = "2027-03-08";
    await w.generateNewRoute();
    const heatPlan = ev("window._generatedRoutePlan");
    const heatNames = heatPlan.days.flatMap(d => d.items.map(i => i.place));
    ok("신규 루트(폭염): 야외 장소 없음", heatNames.length >= 6 && heatNames.every(n => !/한강|공원|해수욕|해변|산책|둘레길|숲|골목|거리|야경/.test(n)), heatNames.join(", "));
    ok("신규 루트(폭염): 일차 중복 없음", new Set(heatNames).size === heatNames.length, `${new Set(heatNames).size}/${heatNames.length}`);
    ok("신규 루트(폭염): 결과 안내 문구", /폭염 대비 실내/.test(w.document.getElementById("route-results").textContent), "");

    // 41) 🌡️ 기본으로 되돌리면 다시 야외 장소도 후보에 들어온다
    w.pickRecWeatherMode("none");
    ok("기본 모드 복귀", ev("recWeatherMode") === "none" && w.document.querySelectorAll(".rec-weather-chips .style-chip.active").length === 2
      && /기본/.test(w.document.querySelector(".rec-weather-chips .style-chip.active").textContent)
      && ev("recWeatherFilterSpots([{name:'여의도 한강공원'}]).length") === 1, "");
    w.pickRecWeatherMode("cold");
    ok("한파 모드도 필터 동작", ev("recWeatherMode") === "cold" && ev("recWeatherFilterSpots([{name:'여의도 한강공원'},{name:'더현대 서울'}]).length") === 1, "");
    w.pickRecWeatherMode("none");

    /* ================= 2026-11-21 (여행 전환 시 추천 상태 초기화) ================= */

    // A 여행(서울 3일)과 B 여행(부산 2일)을 기기에 저장해 두고,
    // A에서 추천(신규 루트·동선 맞춤·필수 장소)을 돌린 뒤 B로 전환한다.
    ev(`(() => {
      const mk = (title, dest, start, end) => ({
        meta: { title, destination: dest, startDate: start, endDate: end, travelers: 2, hostId: myProfile.id },
        days: buildDateRangeDays(start, end, dest),
        expenses: [], weather: [], bookingAlerts: [], checklist: [], members: [], joinRequests: []
      });
      const A = mk('A 서울 여행', '서울', '2027-03-06', '2027-03-08');
      A.days[0].items.push({ id: 'a1', time: '10:00', place: '경복궁', stay: '체류 60분', lat: 37.5796, lng: 126.9770, badges: ['관광'] });
      const B = mk('B 부산 여행', '부산', '2027-04-10', '2027-04-11');
      localStorage.setItem(STORAGE_KEY + '_qa-reca', JSON.stringify(A));
      localStorage.setItem(STORAGE_KEY + '_qa-recb', JSON.stringify(B));
      registerMyTrip('qa-reca', A.meta);
      registerMyTrip('qa-recb', B.meta);
    })()`);

    await w.switchTrip("qa-reca");
    ok("A 여행(서울) 전환", ev("state.meta.destination") === "서울" && ev("currentSyncId") === "qa-reca", ev("state.meta.destination"));

    // A에서 추천 3종 모두 돌리기
    w.setRecommendMode("route");
    w.pickRouteStyle("landmark");
    w.markRecommendDestEdited("route-dest");
    w.document.getElementById("route-dest").value = "서울";
    w.document.getElementById("route-start").value = "2027-03-06";
    w.document.getElementById("route-end").value = "2027-03-08";
    await w.generateNewRoute();
    const aRouteNames = ev("(window._generatedRoutePlan && window._generatedRoutePlan.days || []).flatMap(d => d.items.map(i => i.place))");
    ok("A 여행 신규 루트 미리보기 생성",
      ev("window._generatedRoutePlan && window._generatedRoutePlan.dest") === "서울" && aRouteNames.length >= 6,
      aRouteNames.join(", "));

    w.setRecommendMode("spot");
    w.document.getElementById("rec-day").value = "1";
    w.updateRecommendAfterOptions();
    w.document.getElementById("rec-purpose").value = "카페";
    await w.runPlaceRecommend();
    const aSpotNames = ev("(window._lastRecSpots || []).map(s => s.name)");
    ok("A 여행 동선 맞춤 추천 생성", aSpotNames.length === 5, aSpotNames.join(", "));

    w.setRecommendMode("must");
    w.document.getElementById("must-dest").value = "서울";
    w.document.getElementById("must-spot-input").value = "경복궁";
    w.addMustSpot();
    ok("A 여행 필수 장소 입력", ev("mustVisitSpots.length") === 1 && /경복궁/.test(w.document.getElementById("must-spots-list").textContent), ev("mustVisitSpots.length"));

    // ── B 여행으로 전환 ──
    await w.switchTrip("qa-recb");
    const bText = ["rec-results", "route-results", "must-results"]
      .map(id => w.document.getElementById(id).textContent.trim()).join("|");
    ok("B 여행 전환 후 이전 추천 결과·미리보기 비움",
      bText === "||" && ev("window._generatedRoutePlan") === null && ev("window._lastRecSpots") === null && ev("window._lastRecTarget") === null,
      JSON.stringify(bText.slice(0, 80)));
    ok("B 여행 전환 후 이전 추천 장소 재등장 없음", !/경복궁|광장시장|북촌|남산골/.test(bText), bText.slice(0, 80));
    ok("B 여행 목적지·날짜로 다시 세팅",
      w.document.getElementById("route-dest").value === "부산"
      && w.document.getElementById("must-dest").value === "부산"
      && w.document.getElementById("route-start").value === "2027-04-10"
      && w.document.getElementById("route-end").value === "2027-04-11"
      && w.document.getElementById("must-start").value === "2027-04-10"
      && w.document.getElementById("must-end").value === "2027-04-11",
      ["route-dest", "must-dest", "route-start", "route-end", "must-start", "must-end"]
        .map(id => id + "=" + w.document.getElementById(id).value).join(" "));
    ok("B 여행 전환 후 필수 장소·스타일 초기화",
      ev("mustVisitSpots.length") === 0 && ev("routeStyleKey") === "balanced"
      && !/경복궁/.test(w.document.getElementById("must-spots-list").textContent)
      && w.document.querySelectorAll("#route-style-chips .style-chip").length >= 5
      && w.document.querySelectorAll("#route-style-chips .style-chip.active").length === 1
      && /균형/.test(w.document.querySelector("#route-style-chips .style-chip.active").textContent),
      ev("mustVisitSpots.length") + " / " + ev("routeStyleKey"));
    ok("B 여행 전환 후 동선 맞춤 일차 선택 정상",
      w.document.getElementById("rec-day").options.length === 2
      && w.document.getElementById("rec-day").value === "1"
      && w.document.getElementById("rec-after").options.length >= 1,
      `${w.document.getElementById("rec-day").options.length}일 / value=${w.document.getElementById("rec-day").value}`);
    ok("B 여행 전환 후 추천 탭 기본 모드",
      w.document.getElementById("rec-spot-panel").style.display === ""
      && w.document.getElementById("rec-route-panel").style.display === "none"
      && w.document.getElementById("rec-must-panel").style.display === "none"
      && w.document.getElementById("rec-mode-spot").className.includes("btn-primary"), "");

    // 사라진 미리보기로 B 일정을 덮어쓰지 않는다
    const bDaysBefore = ev("JSON.stringify(state.days)");
    w.applyGeneratedRoute();
    ok("이전 여행 미리보기로 B 일정 덮어쓰지 않음",
      ev("JSON.stringify(state.days)") === bDaysBefore && ev("state.meta.destination") === "부산", "");

    // B에서 새로 추천을 돌리면 B 목적지 기준으로 나온다
    w.setRecommendMode("route");
    await w.generateNewRoute();
    const bRouteNames = ev("(window._generatedRoutePlan && window._generatedRoutePlan.days || []).flatMap(d => d.items.map(i => i.place))");
    ok("B 여행 신규 루트는 부산 기준",
      ev("window._generatedRoutePlan && window._generatedRoutePlan.dest") === "부산" && bRouteNames.length >= 6
      && !/경복궁/.test(bRouteNames.join(",")), bRouteNames.slice(0, 6).join(", "));

    // A로 되돌아가도 추천 화면은 미리보기 없이 깨끗하다 (A 일정 자체는 그대로)
    await w.switchTrip("qa-reca");
    ok("A 여행 복귀: 추천 상태 다시 초기화·일정 보존",
      w.document.getElementById("route-results").textContent.trim() === ""
      && ev("window._generatedRoutePlan") === null
      && ev("state.meta.destination") === "서울"
      && ev("state.days[0].items.length") === 1
      && w.document.getElementById("route-dest").value === "서울", "");

    /* ================= 2026-11-21 (여유 있는 하루 곡격 · 점심/식후 카페/저녁) ================= */

    // 42) 🍽️ 신규 루트 2박 3일 — 매일 점심·식후 카페·저녁, 60분 이상 간격, 중복 없음
    const t42mins = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m; };
    const t42stay = (it) => { const m = String(it.stay || "").match(/(\d+)\s*분/); return m ? Number(m[1]) : 0; };
    const t42has = (it, re) => (it.badges || []).some(b => re.test(b));
    const t42end = (it) => t42mins(it.time) + t42stay(it);
    w.setRecommendMode("route");
    w.pickRecWeatherMode("none");
    ev("routeStyleKey = 'balanced'");
    w.document.getElementById("route-dest").value = "서울";
    w.markRecommendDestEdited("route-dest");
    w.document.getElementById("route-start").value = "2027-03-06";
    w.document.getElementById("route-end").value = "2027-03-08";
    await w.generateNewRoute();
    const plan42 = ev("window._generatedRoutePlan");
    const d42 = plan42 ? plan42.days : [];
    const all42 = d42.flatMap(d => d.items.map(i => i.place));
    ok("여유 루트: 3일 모두 4~6곳", d42.length === 3 && d42.every(d => d.items.length >= 4 && d.items.length <= 6),
      d42.map(d => d.items.length).join(","));
    ok("여유 루트: 매일 점심 포함", d42.every(d => d.items.some(it => t42has(it, /점심/))), "");
    ok("여유 루트: 매일 식후 카페 포함", d42.every(d => d.items.some(it => t42has(it, /카페/))), "");
    ok("여유 루트: 매일 저녁 포함", d42.every(d => d.items.some(it => t42has(it, /저녁/))), "");
    ok("여유 루트: 점심 12시대·카페 13:20~15:10",
      d42.every(d => {
        const l = d.items.find(it => t42has(it, /점심/));
        const c = d.items.find(it => t42has(it, /카페/));
        return l && c && t42mins(l.time) >= 12 * 60 && t42mins(l.time) <= 13 * 60 + 30
          && t42mins(c.time) >= 13 * 60 + 20 && t42mins(c.time) <= 15 * 60 + 10;
      }),
      d42.map(d => (d.items.find(it => t42has(it, /카페/)) || {}).time).join(","));
    ok("여유 루트: 저녁 18시대(귀가일은 16~17시 마무리)",
      d42.every((d, di) => {
        const dinner = d.items.find(it => t42has(it, /저녁/));
        if (!dinner) return false;
        if (di === d42.length - 1) return t42mins(dinner.time) <= 16 * 60 && t42end(dinner) >= 16 * 60 && t42end(dinner) <= 17 * 60;
        return t42mins(dinner.time) >= 18 * 60 && t42mins(dinner.time) <= 19 * 60 + 30;
      }),
      d42.map(d => { const x = d.items.find(it => t42has(it, /저녁/)); return x ? x.time + "~" + Math.floor(t42end(x) / 60) + ":" + String(t42end(x) % 60).padStart(2, "0") : "없음"; }).join(" "));
    ok("여유 루트: 둘째 날 10:00 시작·첫날은 점심부터",
      t42mins(d42[1].items[0].time) >= 10 * 60 && t42mins(d42[1].items[0].time) <= 10 * 60 + 30
      && t42mins(d42[0].items[0].time) >= 11 * 60,
      `${d42[0].items[0].time} / ${d42[1].items[0].time} / ${d42[2].items[0].time}`);
    ok("여유 루트: 일정 간격 60분 이상",
      d42.every(d => d.items.slice(1).every((it, i) => t42mins(it.time) - t42mins(d.items[i].time) >= 60)),
      d42.map(d => d.items.map(i => i.time).join(">")).join(" | "));
    ok("여유 루트: 체류 60~120분",
      d42.every(d => d.items.every(it => t42stay(it) >= 60 && t42stay(it) <= 120)),
      d42.flatMap(d => d.items.map(i => t42stay(i))).join(","));
    ok("여유 루트: 전 일차 중복 없음", new Set(all42).size === all42.length && all42.length >= 12, `${new Set(all42).size}/${all42.length}`);
    const mealNames42 = d42.flatMap(d => d.items.filter(it => t42has(it, /점심|저녁|카페/)).map(i => i.place));
    ok("여유 루트: 식사·카페가 실제 서울 장소", mealNames42.length === 9 && !mealNames42.some(n => /로컬 맛집|시장 먹거리|감성 카페|실내 카페/.test(n)),
      mealNames42.join(", "));
    ok("여유 루트: 결과 안내 문구", /점심 → ☕ 식후 카페 → 관광 → 저녁/.test(w.document.getElementById("route-results").textContent)
      && /체류 시간은 정해 두지 않았어요/.test(w.document.getElementById("route-results").textContent), "");
    const routeResEl = w.document.getElementById("route-results");
    const routeNums = [...routeResEl.querySelectorAll(".tl-stop-num")].map(e => e.textContent.trim());
    ok("추천 미리보기: 카드마다 1·2·3 번호", routeNums.length === d42.reduce((n, d) => n + d.items.length, 0) && routeNums.slice(0, 3).join(",") === "1,2,3",
      `${routeNums.length}개 / ${routeNums.join(",").slice(0, 30)}`);
    ok("추천 미리보기: 방문시간·체류 없음", !/체류\s*\d/.test(routeResEl.textContent) && !/\d{1,2}:\d{2}/.test(routeResEl.textContent),
      routeResEl.textContent.replace(/\s+/g, " ").slice(0, 80));

    // 43) 🐢 여유 코스 — 하루 관광 1곳, 체류는 더 길게
    w.pickRouteStyle("relaxed");
    ok("여유 코스 칩 추가", w.document.querySelectorAll("#route-style-chips .style-chip").length >= 6
      && [...w.document.querySelectorAll("#route-style-chips .style-chip")].some(b => /여유 코스/.test(b.textContent)), "");
    await w.generateNewRoute();
    const plan43 = ev("window._generatedRoutePlan");
    const sights43 = plan43.days.map(d => d.items.filter(it => (it.badges || []).some(b => /관광|산책/.test(b))).length);
    ok("여유 코스: 하루 관광 1곳 이하", sights43.every(n => n <= 1), sights43.join(","));
    ok("여유 코스: 점심·카페·저녁 유지", plan43.days.every(d => d.items.some(it => t42has(it, /점심/)) && d.items.some(it => t42has(it, /카페/)) && d.items.some(it => t42has(it, /저녁/))), "");
    ok("여유 코스: 체류 70분 이상", plan43.days.every(d => d.items.every(it => t42stay(it) >= 70)), plan43.days.flatMap(d => d.items.map(i => t42stay(i))).join(","));
    w.pickRouteStyle("balanced");

    // 44) 📌 필수 장소 코스 — 필수 장소 사이에 점심·식후 카페·저녁이 끼워진다
    ev("mustVisitSpots = [{name:'경복궁',closed:''},{name:'남산서울타워',closed:''},{name:'광장시장',closed:''}];");
    w.document.getElementById("must-dest").value = "서울";
    w.document.getElementById("must-start").value = "2027-03-06";
    w.document.getElementById("must-end").value = "2027-03-08";
    await w.optimizeMustVisitRoute();
    const plan44 = ev("window._generatedRoutePlan");
    const names44 = plan44.days.flatMap(d => d.items.map(i => i.place));
    ok("필수 장소 코스: 필수 3곳 모두 포함", ["경복궁", "남산서울타워", "광장시장"].every(n => names44.some(x => x.includes(n))), names44.join(", "));
    ok("필수 장소 코스: 매일 점심·카페·저녁", plan44.days.every(d => d.items.some(it => t42has(it, /점심/)) && d.items.some(it => t42has(it, /카페/)) && d.items.some(it => t42has(it, /저녁/))),
      plan44.days.map(d => d.items.map(i => (i.badges || [])[0]).join("/")).join(" | "));
    ok("필수 장소 코스: 필수 배지 표시", plan44.days.flatMap(d => d.items).some(it => (it.badges || []).includes("📌 필수")), "");
    ok("필수 장소 코스: 간격 60분 이상·중복 없음",
      plan44.days.every(d => d.items.slice(1).every((it, i) => t42mins(it.time) - t42mins(d.items[i].time) >= 60))
      && new Set(names44).size === names44.length, `${new Set(names44).size}/${names44.length}`);
    ok("필수 장소 코스: 안내 문구", /식후 카페/.test(w.document.getElementById("must-results").textContent), "");
    const mustResEl = w.document.getElementById("must-results");
    const mustNums = [...mustResEl.querySelectorAll(".tl-stop-num")].map(e => e.textContent.trim());
    ok("필수 코스 미리보기: 1·2·3 번호 + 체류 없음", mustNums.length === plan44.days.reduce((n, d) => n + d.items.length, 0)
      && mustNums.slice(0, 3).join(",") === "1,2,3" && !/체류\s*\d/.test(mustResEl.textContent) && !/\d{1,2}:\d{2}/.test(mustResEl.textContent),
      `${mustNums.length}개 / ${mustResEl.textContent.replace(/\s+/g, " ").slice(0, 60)}`);

    // 45) ☀️ 폭염 실내위주 + 여유 곡격 — 실내 식사·카페를 지키면서 밥·카페를 빼먹지 않는다
    w.setRecommendMode("route");
    w.pickRecWeatherMode("heat");
    w.document.getElementById("route-dest").value = "서울";
    w.document.getElementById("route-start").value = "2027-03-06";
    w.document.getElementById("route-end").value = "2027-03-08";
    await w.generateNewRoute();
    const plan45 = ev("window._generatedRoutePlan");
    const outdoor45 = /한강|공원|해수욕|해변|산책|둘레길|숲|골목|거리|야경/;
    ok("폭염 루트: 매일 점심·카페·저녁", plan45.days.every(d => d.items.some(it => t42has(it, /점심/)) && d.items.some(it => t42has(it, /카페/)) && d.items.some(it => t42has(it, /저녁/))),
      plan45.days.map(d => d.items.map(i => (i.badges || [])[0]).join("/")).join(" | "));
    ok("폭염 루트: 식사·카페도 실내", plan45.days.flatMap(d => d.items).filter(it => t42has(it, /점심|저녁|카페/)).every(it => !outdoor45.test(it.place)),
      plan45.days.flatMap(d => d.items.filter(it => t42has(it, /점심|저녁|카페/)).map(i => i.place)).join(", "));
    ok("폭염 루트: 실내 배지", plan45.days.flatMap(d => d.items).some(it => (it.badges || []).includes("🏠 실내")), "");
    w.pickRecWeatherMode("none");

    // 46) 🍽️ 일정 카드에도 점심·식후 카페·저녁 칩이 보인다
    ev("(function(){ const p = window._generatedRoutePlan; if (p && p.days) { state.days = JSON.parse(JSON.stringify(p.days)); state.meta.destination = p.dest; saveState(); } })()");
    ev("currentDay = 1");
    w.renderTimeline();
    const mealChips = [...w.document.querySelectorAll("#timeline-list .tl-meal")].map(e => e.textContent);
    ok("카드에 점심·카페·저녁 칩", mealChips.some(t => /점심/.test(t)) && mealChips.some(t => /카페/.test(t)) && mealChips.some(t => /저녁/.test(t)),
      mealChips.join(","));
    ok("칩 색 구분(식사·카페)", w.document.querySelectorAll("#timeline-list .tl-meal.food").length > 0
      && w.document.querySelectorAll("#timeline-list .tl-meal.cafe").length > 0, "");

    /* ================= 2026-11-22 📝 메모 추가 · 플랜 B/일정 편집 자리 교환 ================= */
    // 47) 일정 탭 — 시간 없는 '메모' 추가·수정·이동·삭제 + 지도·이동시간·경비 비간섭
    {
      const seedItems = [
        { id: "mm-a", time: "09:00", place: "부산역", memo: "", stay: "체류 20분", moveMode: "도보", moveMin: 10, moveCost: 0, costTotal: 12000, lat: 35.1157, lng: 129.0403, badges: [] },
        { id: "mm-b", time: "18:00", place: "광안리", memo: "", stay: "체류 60분", moveMode: "택시", moveMin: 15, moveCost: 9000, costTotal: 20000, lat: 35.1532, lng: 129.1187, badges: [] }
      ];
      ev(`currentDay = 1;
        state.meta = { title:'메모 테스트', destination:'부산', startDate:'2027-03-06', endDate:'2027-03-07', travelers:2 };
        state.days = [{ day:1, label:'1일차', date:'2027-03-06', items: ${JSON.stringify(seedItems)} }, { day:2, label:'2일차', date:'2027-03-07', items: [] }];
        state.bookings = []; state.expenses = []; state.bookingAlerts = []; state.weather = []; state.checklist = [];
        saveState();`);

      ok("메모 버튼(+ 메모 추가) · 모달 · 카드 CSS",
        /<button class="btn btn-memo"[^>]*onclick="openMemoModal\(null\)">📝 메모 추가<\/button>/.test(html)
        && /id="memo-modal"/.test(html) && /id="memo-body"/.test(html)
        && /\.card\.tl-memo-card/.test(html),
        "");

      const travelBefore = w.document.getElementById("hdr-travel-time").textContent;
      const expBefore = ev("getSyncedExpenses().reduce((s,e)=>s+(Number(e.amount)||0),0)");
      const pinsBefore = ev("homeGeoPts().length");
      const bigBefore = ev("activeDayGeoPts().length");

      // 추가 — 시간 칸이 없는 모달, 저장하면 그날 맨 위
      w.openMemoModal(null);
      const memoModal = w.document.getElementById("memo-modal");
      ok("메모 모달: 시간 입력 없음", memoModal.classList.contains("open")
        && !memoModal.querySelector('input[type="time"]') && !/id="memo-time"/.test(memoModal.innerHTML),
        "");
      w.document.getElementById("memo-title").value = "체크인 준비";
      w.document.getElementById("memo-body").value = "15시 체크인\n우산 챙기기";
      w.saveMemoItem();
      const memo = ev("state.days[0].items[0]");
      ok("메모 추가: 그날 맨 위(index 0)·시간 없음", ev("state.days[0].items.length") === 3
        && memo.kind === "memo" && memo.time === "" && ev("state.days[0].items[1].id") === "mm-a",
        ev("state.days[0].items.map(i=>i.kind||i.id).join(',')"));
      ok("메모 저장 필드(place·memo·0원·좌표없음·📝 배지)", memo.place === "체크인 준비"
        && /우산 챙기기/.test(memo.memo) && memo.moveMin === 0 && memo.costTotal === 0 && memo.moveCost === 0
        && memo.lat === null && memo.lng === null && (memo.badges || []).includes("📝 메모"),
        JSON.stringify({ place: memo.place, badges: memo.badges }));

      const listHtml = () => w.document.getElementById("timeline-list").innerHTML;
      const memoCard = () => w.document.querySelector("#timeline-list .tl-memo-card");
      ok("메모 카드가 맨 위에 따뜻한 메모 스타일로", !!memoCard()
        && listHtml().indexOf("tl-memo-card") < listHtml().indexOf('data-card-id="mm-a"')
        && /📝 메모/.test(memoCard().textContent) && /체크인 준비/.test(memoCard().textContent)
        && /우산 챙기기/.test(memoCard().textContent),
        memoCard() ? memoCard().textContent.trim().slice(0, 40) : "카드 없음");
      ok("메모 카드 조작 버튼(위로·아래로·수정·삭제)", !!memoCard()
        && !!memoCard().querySelector('button[onclick*="moveMemo"]')
        && !!memoCard().querySelector('button[onclick*="openMemoModal"]')
        && !!memoCard().querySelector('button[onclick*="deleteItem"]'),
        "");

      // 비간섭 — 지도 핀·큰 지도 스텝·총 이동 시간·경비
      ok("메모는 지도 핀·동선에 안 잡힘", ev("homeGeoPts().length") === pinsBefore
        && ev("activeDayGeoPts().length") === bigBefore && ev("coordsOfItem(state.days[0].items[0])") === null
        && !ev("homeGeoPts().some(p => p.it.kind === 'memo')"),
        `핀 ${pinsBefore} → ${ev("homeGeoPts().length")}`);
      ok("메모는 총 이동 시간에 안 잡힘", w.document.getElementById("hdr-travel-time").textContent === travelBefore,
        `${travelBefore} → ${w.document.getElementById("hdr-travel-time").textContent}`);
      ok("메모는 경비에 안 잡힘", ev("getSyncedExpenses().reduce((s,e)=>s+(Number(e.amount)||0),0)") === expBefore
        && !ev("getSyncedExpenses().some(e => /체크인 준비/.test(String(e.name||'')))"),
        `${expBefore} → ${ev("getSyncedExpenses().reduce((s,e)=>s+(Number(e.amount)||0),0)")}`);

      // 순서 — 아래로/위로 옮기면 화면·저장까지 따라온다
      w.moveMemo(memo.id, 1);
      ok("메모 아래로 이동(배열·화면·저장)", ev("state.days[0].items[1].id") === memo.id
        && listHtml().indexOf('data-card-id="mm-a"') < listHtml().indexOf("tl-memo-card")
        && JSON.parse(w.localStorage.getItem(w.getLocalKey())).days[0].items[1].id === memo.id,
        ev("state.days[0].items.map(i=>i.kind||i.id).join(',')"));
      w.moveMemo(memo.id, -1);
      ok("메모 위로 이동", ev("state.days[0].items[0].id") === memo.id
        && JSON.parse(w.localStorage.getItem(w.getLocalKey())).days[0].items[0].id === memo.id, "");

      // 수정 — 위치 유지, 제목을 비우면 내용만
      w.openMemoModal(memo.id);
      ok("메모 수정 프리필", /수정/.test(w.document.getElementById("memo-modal-title").textContent)
        && w.document.getElementById("memo-title").value === "체크인 준비"
        && /우산 챙기기/.test(w.document.getElementById("memo-body").value), "");
      w.document.getElementById("memo-title").value = "";
      w.document.getElementById("memo-body").value = "15시 체크인\n우산·보조배터리";
      w.saveMemoItem();
      ok("메모 수정(위치·개수 유지)", ev("state.days[0].items.length") === 3 && ev("state.days[0].items[0].id") === memo.id
        && ev("state.days[0].items[0].memoTitle") === "" && /보조배터리/.test(ev("state.days[0].items[0].memo")),
        "");
      ok("제목 없는 메모는 내용만 보인다", !!memoCard() && /보조배터리/.test(memoCard().textContent)
        && !memoCard().querySelector(".tl-memo-title"), "");

      // 편집 모드 — 메모 행에서도 드래그 손잡이·수정·삭제가 그대로 동작
      w.toggleEditMode();
      const memoRow = w.document.querySelector(`#timeline-list .tl-edit-row[data-item-id="${memo.id}"]`);
      ok("편집 모드 메모 행 + ≡ 손잡이", !!memoRow && /📝 메모/.test(memoRow.textContent)
        && !!memoRow.querySelector('[data-drag-handle="1"]')
        && !!memoRow.querySelector(".tl-edit-del"), "");
      if (memoRow) memoRow.querySelector(".tl-edit-card").click();
      ok("편집 행 클릭 → 메모 편집기", w.document.getElementById("memo-modal").classList.contains("open")
        && /수정/.test(w.document.getElementById("memo-modal-title").textContent), "");
      w.closeMemoModal();
      w.toggleEditMode();

      // 삭제
      w.deleteItem(memo.id);
      ok("메모 삭제", ev("state.days[0].items.length") === 2
        && !ev("state.days[0].items.some(i => i.kind === 'memo')"), ev("state.days[0].items.map(i=>i.kind||i.id).join(',')"));
    }

    // 48) ☔ 플랜 B ↔ ✏️ 일정 편집 — 자리와 크기 교환 (편집 버튼이 넓은 왼쪽)
    {
      const rowStart = html.indexOf('<div class="tl-planb-row"');
      const rowEnd = html.indexOf("</div>", html.indexOf('id="planb-toggle"', rowStart));
      const rowHtml = html.slice(rowStart, rowEnd);
      ok("플랜 B·일정 편집 위치 교환", rowStart > 0 && rowHtml.indexOf('id="edit-mode-btn"') >= 0
        && rowHtml.indexOf('id="edit-mode-btn"') < rowHtml.indexOf('id="planb-bar-title"'),
        rowStart > 0 ? rowHtml.slice(0, 90) : "row 없음");
      ok("일정 편집 = 넓은 왼쪽(flex:1)", /id="edit-mode-btn"[^>]*flex:1 1 auto/.test(html), "");
      ok("플랜 B = 오른쪽 컴팩트(flex:0 0 auto)", /class="planb-bar planb-bar-compact"[^>]*flex:0 0 auto/.test(html)
        && /\.planb-bar\.planb-bar-compact/.test(html), "");
      const toggle = w.document.getElementById("planb-toggle");
      ok("플랜 B 토글·제목 그대로 동작", !!toggle && !!w.document.getElementById("planb-bar-title")
        && !!w.document.getElementById("planb-bar-sub")
        && typeof w.updatePlanBBar === "function", "");
      w.updatePlanBBar();
      ok("플랜 B 제목 갱신", /플랜 B/.test(w.document.getElementById("planb-bar-title").textContent), "");
    }

    /* ================= 2026-11-22 📋 일정 복사 · 🔢 1·2·3·4 순서 ================= */
    // 49) ✏️ 편집 모드 📋 복사 — 새 id·필드 복사, 원본 바로 아래, 저장까지
    {
      const seed = [
        { id: "cp-a", time: "10:00", place: "롯데호텔 체크인", memo: "짐 맡기기", stay: "체류 40분", moveMode: "택시", moveMin: 12, moveCost: 8000, costTotal: 12000, lat: 35.1538, lng: 129.1187, badges: ["직접 추가"], mapUrl: "https://map.example/lotte", menus: [{ name: "조식", price: 15000, qty: 2 }] },
        { id: "cp-b", time: "18:00", place: "광안리 해변", memo: "", stay: "체류 60분", moveMode: "도보", moveMin: 15, moveCost: 0, costTotal: 0, lat: 35.1532, lng: 129.1187, badges: [] }
      ];
      ev(`currentDay = 1;
        state.meta = { title:'복사 테스트', destination:'부산', startDate:'2027-03-06', endDate:'2027-03-07', travelers:2 };
        state.days = [{ day:1, label:'1일차', date:'2027-03-06', items: ${JSON.stringify(seed)} }, { day:2, label:'2일차', date:'2027-03-07', items: [] }];
        state.bookings = []; state.expenses = []; state.bookingAlerts = []; state.weather = []; state.checklist = [];
        editMode = true; saveState();`);

      const rowA = w.document.querySelector('#timeline-list .tl-edit-row[data-item-id="cp-a"]');
      ok("편집 행에 📋 복사 버튼(+모달 안 염)", !!rowA && !!rowA.querySelector(".tl-edit-copy")
        && /duplicateTimelineItem\('cp-a'\)/.test(rowA.querySelector(".tl-edit-copy").getAttribute("onclick"))
        && /stopPropagation/.test(rowA.querySelector(".tl-edit-copy").getAttribute("onclick")), "");
      const kids = rowA ? [...rowA.children].map(el => el.className.split(" ")[0]) : [];
      ok("편집 행 순서 [−][카드][📋][≡]", kids.join(",") === "tl-edit-del,tl-edit-card,tl-edit-copy,tl-edit-handle", kids.join(","));

      const copy = w.duplicateTimelineItem("cp-a");
      const items = ev("state.days[0].items");
      const allIds = ev("state.days.flatMap(d=>d.items.map(i=>String(i.id)))");
      ok("복사: 새 고유 id + 원본 바로 아래", items.length === 3 && items[1].id !== "cp-a" && items[1].id !== "cp-b"
        && String(items[1].id) === String(copy.id) && new Set(allIds).size === allIds.length,
        items.map(i => i.id).join(","));
      ok("복사: 필드·좌표·배지·기간 복사", items[1].place === "롯데호텔 체크인" && items[1].lat === 35.1538 && items[1].lng === 129.1187
        && items[1].stay === "체류 40분" && items[1].costTotal === 12000 && items[1].moveCost === 8000 && items[1].moveMin === 12
        && items[1].memo === "짐 맡기기" && items[1].mapUrl === "https://map.example/lotte" && items[1].time === "10:00"
        && (items[1].badges || []).join("|") === (items[0].badges || []).join("|"),
        JSON.stringify({ place: items[1].place, cost: items[1].costTotal, lat: items[1].lat }));
      ok("복사: 메뉴는 깊은 복사(원본과 별개)", Array.isArray(items[1].menus) && items[1].menus !== items[0].menus
        && items[1].menus[0].name === "조식" && items[1].menus[0].qty === 2, "");
      ev("state.days[0].items[1].menus[0].qty = 5");
      ok("복사본 수정이 원본에 영향 없음", ev("state.days[0].items[0].menus[0].qty") === 2, String(ev("state.days[0].items[0].menus[0].qty")));

      const savedCopy = JSON.parse(w.localStorage.getItem(w.getLocalKey()));
      ok("복사: localStorage에 저장", savedCopy.days[0].items.length === 3 && String(savedCopy.days[0].items[1].id) === String(copy.id), "");
      ok("복사 후 편집 모드 유지 + 토스트 안내", ev("editMode") === true
        && !!w.document.getElementById("app-toast")
        && /바로 아래에 복사했어요/.test(w.document.getElementById("app-toast").textContent)
        && /롯데호텔 체크인/.test(w.document.getElementById("app-toast").textContent), "");
      await new Promise(r => setTimeout(r, 160));   // 강조는 잠시 뒤에 켜진다
      ok("복사 직후 새 행 강조", !!w.document.querySelector("#timeline-list .tl-just-copied"), "");

      // 버튼 클릭 경로 — 모달을 열지 않고 한 번 더 복사
      const beforeClick = ev("state.days[0].items.length");
      const btn = w.document.querySelector('#timeline-list .tl-edit-row[data-item-id="cp-b"] .tl-edit-copy');
      btn.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
      ok("📋 클릭: 모달 없이 복사", ev("state.days[0].items.length") === beforeClick + 1
        && !w.document.getElementById("place-modal").classList.contains("open"), "");

      // 📝 메모·🚆 교통편도 복사된다
      ev("state.days[0].items.push(Object.assign(makeMemoItem('체크인 준비','우산 챙기기'), { id:'cp-memo' })); saveState();");
      const memoCopy = w.duplicateTimelineItem("cp-memo");
      const memoItems = ev("state.days[0].items");
      const memoIdx = memoItems.findIndex(x => String(x.id) === "cp-memo");
      ok("메모 복사: kind·내용 유지 + 바로 아래", memoItems[memoIdx + 1] && memoItems[memoIdx + 1].kind === "memo"
        && memoItems[memoIdx + 1].memoTitle === "체크인 준비" && /우산 챙기기/.test(memoItems[memoIdx + 1].memo)
        && String(memoItems[memoIdx + 1].id) === String(memoCopy.id), "");
      ev(`state.days[0].items.push({ id:'cp-tr', time:'07:30', place:'서울역 → 부산역 (KTX 101)', fromPlace:'서울역', toPlace:'부산역', transitType:'KTX', moveMode:'KTX KTX 101', stay:'07:30→09:40', costTotal:59800, moveCost:59800, badges:['KTX'], lat:35.1152, lng:129.0414 });
        saveState();`);
      const trCopy = w.duplicateTimelineItem("cp-tr");
      const trItems = ev("state.days[0].items");
      const trIdx = trItems.findIndex(x => String(x.id) === "cp-tr");
      ok("교통편 복사: 출발·도착·수단 유지", trItems[trIdx + 1] && trItems[trIdx + 1].fromPlace === "서울역"
        && trItems[trIdx + 1].toPlace === "부산역" && trItems[trIdx + 1].transitType === "KTX"
        && trItems[trIdx + 1].lat === 35.1152 && String(trItems[trIdx + 1].id) === String(trCopy.id), "");

      // 📱 375px 아이폰 폭에서도 네 칸이 넘치지 않는다
      ok("편집 행 375px 레이아웃 CSS", /\.tl-edit-copy \{[^}]*width: 30px[^}]*flex: 0 0 30px/.test(html)
        && /@media \(max-width: 390px\)[\s\S]{0,500}\.tl-edit-del, \.tl-edit-copy \{ width: 28px; height: 28px; flex-basis: 28px; \}/.test(html)
        && /@media \(max-width: 390px\)[\s\S]{0,500}\.tl-edit-handle, \.tl-drag-handle \{ width: 30px; flex-basis: 30px/.test(html)
        && /\.tl-edit-card \{ flex: 1; min-width: 0;/.test(html)
        && /\.tl-edit-place \{[^}]*line-height: 1\.35/.test(html), "");
      const rowFixed = 28 + 28 + 30 + 6 * 3;   // − · 📋 · ≡ + 간격 3곳
      const cardWidth = 375 - 32 - rowFixed;   // 좌우 main padding 16px씩
      ok("375px에서 장소 카드 폭 200px 이상", cardWidth >= 200, `카드 ${cardWidth}px (고정 ${rowFixed}px)`);
    }

    // 50) 🔢 방문 시간 대신 1·2·3·4 — 배열 순서 그대로 + 메모는 번호 없이 📝
    {
      ev(`currentDay = 1; editMode = false;
        state.meta = { title:'순서 테스트', destination:'부산', startDate:'2027-03-06', endDate:'2027-03-07', travelers:2 };
        state.days = [{ day:1, label:'1일차', date:'2027-03-06', items: [
          { id:'sq-late', time:'18:00', place:'광안리 해변', lat:35.1532, lng:129.1187, badges:[], costTotal:0 },
          { id:'sq-early', time:'09:00', place:'부산역', lat:35.1157, lng:129.0403, badges:[], costTotal:0 },
          { id:'sq-memo', kind:'memo', time:'', place:'메모', memoTitle:'체크인 준비', memo:'우산 챙기기', badges:['📝 메모'] },
          { id:'sq-mid', time:'12:00', place:'본전돼지국밥', lat:35.1165, lng:129.0411, badges:[], costTotal:0 }
        ] }, { day:2, label:'2일차', date:'2027-03-07', items: [] }];
        state.bookings = []; saveState();`);
      w.renderTimeline();

      const cards = [...w.document.querySelectorAll("#timeline-list [data-card-id]")];
      const placeOf = (c) => (c.querySelector(".tl-place") || {}).textContent || "";
      ok("보기 모드도 배열 순서(시간 정렬 안 함)", cards.length === 4
        && placeOf(cards[0]) === "광안리 해변" && placeOf(cards[1]) === "부산역" && placeOf(cards[3]) === "본전돼지국밥",
        cards.map(placeOf).join(" > "));
      const seqNums = cards.filter(c => c.querySelector(".tl-stop-num")).map(c => c.querySelector(".tl-stop-num").textContent.trim());
      ok("카드에 1·2·3 순번 배지", seqNums.join(",") === "1,2,3", seqNums.join(","));
      ok("방문 시간은 카드에 안 적힌다", !cards.some(c => /\b\d{1,2}:\d{2}\b/.test((c.querySelector(".tl-time") || {}).textContent || ""))
        && !/18:00|09:00|12:00/.test(w.document.getElementById("timeline-list").textContent.replace(/\s+/g, " ").split("메모")[0]),
        "");
      const memoTl = w.document.querySelector("#timeline-list .tl-memo-card");
      ok("메모는 번호 대신 📝 메모", !!memoTl && !memoTl.querySelector(".tl-stop-num") && /📝 메모/.test(memoTl.textContent), "");
      ok("번호는 메모를 건너뛰고 1·2·3", ev("JSON.stringify([...dayItemNumbers(state.days[0]).entries()])") === '[["sq-late",1],["sq-early",2],["sq-mid",3]]',
        ev("JSON.stringify([...dayItemNumbers(state.days[0]).entries()])"));
      ok("홈 지도·요약 번호도 일정 탭과 같다", ev("JSON.stringify(homeGeoPts().map(p=>[p.it.place,p.num]))") === '[["광안리 해변",1],["부산역",2],["본전돼지국밥",3]]'
        && /data-num="1"/.test(w.document.getElementById("home-sheet-body").innerHTML.replace(/\s+/g, " ")),
        ev("JSON.stringify(homeGeoPts().map(p=>[p.it.place,p.num]))"));

      // 순서를 바꾸면 번호도 즉시 1·2·3으로 다시 매겨진다
      w.toggleEditMode();
      const rows = [...w.document.querySelectorAll("#timeline-list .tl-edit-row[data-item-id]")];
      w.document.getElementById("timeline-list").insertBefore(rows[rows.length - 1], rows[0]);
      w.commitTimelineEditOrder();
      w.toggleEditMode();
      const afterCards = [...w.document.querySelectorAll("#timeline-list [data-card-id]")];
      ok("순서 바꾸면 번호도 다시 1·2·3", placeOf(afterCards[0]) === "본전돼지국밥"
        && afterCards.filter(c => c.querySelector(".tl-stop-num"))[0].querySelector(".tl-stop-num").textContent.trim() === "1"
        && ev("dayItemNumbers(state.days[0]).get('sq-mid')") === 1, ev("JSON.stringify([...dayItemNumbers(state.days[0]).entries()])"));

      // 지도 핀 번호 = 카드 번호 (핀 데이터에 같은 번호가 실린다)
      const pinNums = ev("[...((state.days[0].items||[]).filter(i=>i.kind!=='memo'))].map(i=>dayItemNumbers(state.days[0]).get(String(i.id)))");
      ok("지도 핀·카드 번호 일치", pinNums.join(",") === "1,2,3" && ev("activeDayGeoPts().map(p=>p.num).join(',')") === "1,2,3", `${pinNums.join(",")} / ${ev("activeDayGeoPts().map(p=>p.num).join(',')")}`);
    }

    // 51) 🕒 시간은 선택 — 비워 두고 순서로만 저장해도 카드에 번호가 나온다
    {
      ev(`currentDay = 1; editMode = false;
        state.days = [{ day:1, label:'1일차', date:'2027-03-06', items: [] }, { day:2, label:'2일차', date:'2027-03-07', items: [] }];
        state.bookings = []; saveState();`);
      w.openPlaceModal(null);
      w.document.getElementById("pm-place").value = "서면 카페";
      w.document.getElementById("pm-time").value = "";
      ev("pickedLat = 35.1578; pickedLng = 129.0594;");
      w.savePlaceEdit();
      const added = ev("state.days[0].items[0]");
      ok("시간 없이 추가해도 저장·좌표 유지", !!added && added.time === "" && added.place === "서면 카페" && added.lat === 35.1578, JSON.stringify(added && { time: added.time, place: added.place }));
      const card = w.document.querySelector("#timeline-list [data-card-id]");
      ok("시간 없는 일정도 1번으로", !!card && card.querySelector(".tl-stop-num").textContent.trim() === "1"
        && !/\d{1,2}:\d{2}/.test(card.querySelector(".tl-head").textContent), card && card.querySelector(".tl-head").textContent.trim());
      ok("장소 모달에 방문시간·체류 칸이 없다", /<div style="display:none;" aria-hidden="true">[\s\S]{0,220}id="pm-time"[\s\S]{0,220}id="pm-stay"/.test(html)
        && !/placeholder="시간/.test(html.slice(html.indexOf('id="place-modal"'), html.indexOf('id="place-modal"') + 6000))
        && !/placeholder="체류"/.test(html.slice(html.indexOf('id="place-modal"'), html.indexOf('id="place-modal"') + 6000)), "");
      ok("카드에 체류·방문시간이 안 보인다", !/체류/.test(card ? card.textContent : "") && !!added && added.stay === "",
        card ? card.textContent.replace(/\s+/g, " ").slice(0, 60) : "");

      // 이미 적혀 있던 시간·체류 값은 모달에서 안 물어봐도 그대로 보존된다
      ev("state.days[0].items[0].time = '14:30'; state.days[0].items[0].stay = '체류 40분'; state.days[0].items[0].memo = '창가 자리'; saveState();");
      const keepId = ev("state.days[0].items[0].id");
      w.openPlaceModal(keepId);
      w.document.getElementById("pm-memo").value = "창가 자리 요청";
      w.savePlaceEdit();
      const kept = ev("state.days[0].items[0]");
      ok("기존 시간·체류는 숨겨 둔 채 보존", kept.time === "14:30" && kept.stay === "체류 40분" && kept.memo === "창가 자리 요청",
        JSON.stringify({ time: kept.time, stay: kept.stay }));
      w.renderTimeline();
      const keptCard = w.document.querySelector(`#timeline-list [data-card-id="${keepId}"]`);
      ok("카드에는 체류·시간 없이 번호만", !!keptCard && keptCard.querySelector(".tl-stop-num").textContent.trim() === "1"
        && !/체류|14:30/.test(keptCard.textContent), keptCard ? keptCard.textContent.replace(/\s+/g, " ").slice(0, 70) : "");
    }

    // 52) 🏠 홈 탭 '일차 일정 요약' 시트에도 시간 없이 1·2·3 번호만
    {
      ev(`currentDay = 1; editMode = false;
        state.meta = { title:'홈 시트 테스트', destination:'부산', startDate:'2027-03-06', endDate:'2027-03-07', travelers:2 };
        state.days = [{ day:1, label:'1일차', date:'2027-03-06', items: [
          { id:'hs-a', time:'09:00', place:'부산역', lat:35.1157, lng:129.0403, badges:[], costTotal:0 },
          { id:'hs-b', time:'12:30', place:'본전돼지국밥', lat:35.1165, lng:129.0411, badges:[], costTotal:0 },
          { id:'hs-memo', kind:'memo', time:'', place:'메모', memoTitle:'체크인 준비', memo:'우산 챙기기', badges:['📝 메모'] },
          { id:'hs-c', time:'18:00', place:'광안리 해변', lat:35.1532, lng:129.1187, badges:[], costTotal:0 }
        ] }, { day:2, label:'2일차', date:'2027-03-07', items: [] }];
        state.bookings = []; saveState();`);
      w.renderHome();
      const sheetEl = w.document.getElementById("home-sheet-body");
      const homeRows = [...sheetEl.querySelectorAll(".home-row")];
      const rowText = (r) => r.textContent.replace(/\s+/g, " ").trim();
      ok("홈 요약 시트: 방문 시간이 안 적힌다", homeRows.length === 4 && !/\b\d{1,2}:\d{2}\b/.test(rowText(sheetEl)),
        rowText(sheetEl).slice(0, 120));
      ok("홈 요약 시트: 1·2·3 순번은 그대로", homeRows.filter(r => r.dataset.num !== "memo")
        .map(r => r.querySelector(".hr-num").textContent.trim()).join(",") === "1,2,3",
        homeRows.map(r => r.querySelector(".hr-num").textContent.trim()).join(","));
      ok("홈 요약 시트: 일정 순서 = 배열 순서", homeRows.map(r => (r.querySelector(".hr-place") || {}).textContent)
        .filter(Boolean).join(" > ") === "부산역 > 본전돼지국밥 > 체크인 준비 > 광안리 해변",
        homeRows.map(r => (r.querySelector(".hr-place") || {}).textContent).join(" > "));
      ok("홈 요약 시트: 메모는 📝 그대로", homeRows.some(r => r.dataset.num === "memo" && /📝/.test(rowText(r)) && /우산 챙기기/.test(rowText(r))), "");
      ok("홈 요약 시트: 시간 칸(.hr-time) 제거", sheetEl.querySelectorAll(".hr-time").length === 0 && !/\.hr-time/.test(html), "");
    }

    // 53) 🗺️ 지도 핀 말풍선·큰 지도 스텝에서 '체류 N분' 제거
    {
      ev(`currentDay = 1; editMode = false;
        state.meta = { title:'핀 말풍선 테스트', destination:'부산', startDate:'2027-03-06', endDate:'2027-03-07', travelers:2 };
        state.days = [{ day:1, label:'1일차', date:'2027-03-06', items: [
          { id:'mp-a', time:'09:00', place:'부산역', stay:'체류 45분', stayMin:45, moveMode:'KTX 일반실', moveMin:149, lat:35.1157, lng:129.0403, badges:[], costTotal:94400 },
          { id:'mp-b', time:'13:00', place:'본전돼지국밥', stay:'체류 45분', stayMin:45, moveMode:'', moveMin:0, lat:35.1165, lng:129.0411, badges:[], costTotal:22000 },
          { id:'mp-c', time:'18:00', place:'광안리 해변', stay:'체류 60분', stayMin:60, moveMode:'도보 5분', moveMin:5, lat:35.1532, lng:129.1187, badges:[], costTotal:0 }
        ] }, { day:2, label:'2일차', date:'2027-03-07', items: [] }];
        state.bookings = []; saveState();`);

      // 말풍선 문자열 — 번호·장소·이동수단만, 체류 문구도 빈 둘째 줄도 없다
      const oneLine = ev("pinPopupHtml(2, '부산역', pinPopupSub(state.days[0].items[0]))");
      const noSub = ev("pinPopupHtml(3, '본전돼지국밥', pinPopupSub(state.days[0].items[1]))");
      ok("핀 말풍선: 번호·장소·이동수단만", !/체류/.test(oneLine) && /2\. 부산역/.test(oneLine)
        && /KTX 일반실/.test(oneLine) && !/<br>/.test(noSub) && !/체류/.test(noSub), oneLine + " / " + noSub);

      // 가짜 지도 표면을 세워 세 지도에 실제로 실린 말풍선 문자열을 모은다
      const homePopups = ev(`(() => {
        const got = [];
        const surface = { alive:true, hostEl:()=>null, containerPoint:()=>null, fromContainerPoint:()=>null,
          clearMarkers(){}, clearShapes(){}, polyline(){},
          addMarker(m){ got.push(String(m.popup || "")); return { openPopup(){} }; } };
        const savedMap = homeMap, savedPts = homePts;
        homeMap = surface; homePts = homeGeoPts();
        try { drawHomePins(); } finally { homeMap = savedMap; homePts = savedPts; }
        return got.join(" | ");
      })()`);
      ok("홈 지도 핀 말풍선에 체류 없음", /1\. 부산역/.test(homePopups) && /3\. 광안리 해변/.test(homePopups)
        && /KTX 일반실/.test(homePopups) && !/체류/.test(homePopups), homePopups);

      const dayPopups = ev(`(() => {
        const got = [];
        const surface = { alive:true, hostEl:()=>null, containerPoint:()=>null, fromContainerPoint:()=>null,
          clearMarkers(){}, clearShapes(){}, polyline(){},
          addMarker(m){
            got.push(String(m.popup || ""));
            return { openPopup(){} };
          } };
        const savedMap = leafletMap;
        leafletMap = surface;
        try { drawDayPins(activeDayGeoPts()); } finally { leafletMap = savedMap; }
        return got.join(" | ");
      })()`);
      ok("일정 지도 핀 말풍선에 체류 없음", /1\. 부산역/.test(dayPopups) && /도보 5분/.test(dayPopups)
        && !/체류/.test(dayPopups), dayPopups);

      const bigPopups = ev(`(() => {
        const got = [];
        const surface = { alive:true, hostEl:()=>null, containerPoint:()=>null, fromContainerPoint:()=>null,
          clearMarkers(){}, clearShapes(){}, polyline(){},
          addMarker(m){ got.push(String(m.popup || "")); return { openPopup(){} }; } };
        const savedMap = bigMap, savedPts = bigMapPts, savedMk = bigMapMarkers;
        bigMap = surface; bigMapPts = activeDayGeoPts();
        try { drawBigPins(); } finally { bigMap = savedMap; bigMapPts = savedPts; bigMapMarkers = savedMk; }
        return got.join(" | ");
      })()`);
      ok("큰 지도 핀 말풍선에 체류 없음", /1\. 부산역/.test(bigPopups) && /3\. 광안리 해변/.test(bigPopups)
        && !/체류/.test(bigPopups), bigPopups);

      const stepHtml = ev(`(() => { const pts = activeDayGeoPts(); return pts.map((p, i) => bigMapDetailHtml(p, i, pts.length)).join(" | "); })()`);
      ok("큰 지도 스텝에 체류 없음·번호·경비는 그대로", !/체류/.test(stepHtml) && /1 \/ 3/.test(stepHtml)
        && /94,400/.test(stepHtml), stepHtml.replace(/\s+/g, " ").slice(0, 160));

      // 홈 요약 시트 메모 줄도 체류 대신 배지·이동수단
      ok("홈 요약 메모 줄에 체류 없음", !/체류/.test(ev("homeMemoLine(state.days[0].items[0])"))
        && ev("homeMemoLine(state.days[0].items[1])") === "", ev("homeMemoLine(state.days[0].items[0])"));

      // 🔒 체류 값 자체는 지우지 않는다 (숙소 복귀 시각 계산 등 내부에서 쓴다)
      ok("체류 값은 내부 데이터로 보존", ev("state.days[0].items[0].stay") === "체류 45분"
        && ev("state.days[0].items[0].stayMin") === 45 && ev("stayMinutes(state.days[0].items[0].stay)") === 45, "");

      // 🎉 축제 일정 추가 안내에도 체류 문구가 없다
      ev("varFindings = [{ key:'mp-fest', kind:'festival', place:'광안리 불꽃축제', suggestTime:'19:00', stay:'체류 60분', cost:0, packing:[] }]; window.__alerts = [];");
      ev("addVariableToItinerary('mp-fest')");
      const festAlert = (w.__alerts || []).join(" | ");
      const festItem = ev("JSON.stringify((state.days[0].items || []).filter(i => String(i.place||'').includes('광안리 불꽃축제'))[0] || null)");
      ok("축제 추가 안내에 체류 없음", !/체류/.test(festAlert) && /광안리 불꽃축제/.test(festAlert), festAlert.replace(/\s+/g, " "));
      ok("축제 일정의 체류 값도 내부 보존", /"stay":"체류 60분"/.test(festItem), festItem);
    }

    // 54) 🗺️ 일정 탭: 1일차 칸 바로 아래 오늘의 동선 지도 → 그 아래 편집·플랜 B
    {
      // 앞 테스트가 PC 화면을 켜 두었을 수 있으니 모바일 배치부터 확인한다
      ev('document.body.classList.remove("view-pc"); buildPcTimeline();');
      const panel = w.document.getElementById("tab-timeline");
      const kids = [...panel.children];
      const pos = (sel) => kids.findIndex(el => el.matches(sel));
      const need = [".day-tabs", ".tl-map-card", ".map-action-row", ".map-help-row", "#map-hours-stamp", ".tl-planb-row", "#planb-content", "#add-btns-row", ".tl-places-row", "#timeline-list"];
      const order = need.map(pos);
      ok("일정 탭 순서: 날짜 탭 → 지도 → 편집·플랜B → 일정", order.every(i => i >= 0)
        && order.every((v, i) => i === 0 || order[i - 1] < v), order.join(","));
      ok("동선 지도는 1일차 칸 바로 밑", pos(".tl-map-card") === pos(".day-tabs") + 1
        && pos(".tl-map-card") < pos(".map-action-row"), order.join(","));
      ok("편집·플랜B는 지도 블록 바로 밑", pos(".tl-planb-row") === pos("#map-hours-stamp") + 1
        && pos("#planb-content") === pos(".tl-planb-row") + 1 && pos("#planb-content") < pos("#add-btns-row"), order.join(","));

      // PC 버전도 좌 칸 맨 위가 날짜 탭, 바로 아래 지도 (스티키 좌 칸 유지)
      ev('document.body.classList.add("view-pc"); buildPcTimeline();');
      const left = w.document.querySelector("#tab-timeline .tl-pc-left");
      const right = w.document.querySelector("#tab-timeline .tl-pc-right");
      const li = (sel) => (left ? [...left.children].indexOf(left.querySelector(sel)) : -99);
      ok("PC: 좌 칸 날짜 탭 → 지도 → 편집·플랜B", !!left && li(".day-tabs") === 0 && li(".tl-map-card") === 1
        && li(".tl-planb-row") > li("#map-hours-stamp") && li(".tl-planb-row") >= 0, left ? [...left.children].map(el => el.id || el.className).join(" | ") : "no-left");
      ok("PC: 우 칸은 일정 목록부터", !!right && !!right.querySelector("#timeline-list")
        && !right.querySelector(".day-tabs") && !right.querySelector(".tl-map-card"), "");
      ok("PC 지도·날짜 탭 여백 CSS", /body\.view-pc \.tl-pc-left > \.day-tabs \{ margin-bottom: 12px; \}/.test(html)
        && !/body\.view-pc \.tl-pc-right > \.day-tabs/.test(html), "");
      ev('document.body.classList.remove("view-pc"); buildPcTimeline();');
      ok("모바일로 돌아와도 순서 그대로", [...panel.children][1].classList.contains("tl-map-card")
        && !panel.querySelector(".tl-pc-left"), "");
    }

    // 55) 🏨 새 일정 추가 — 예약한 호텔 이름을 눌러도 '룸타입·인원'은 장소명·지도 검색어에 안 들어간다
    {
      // (1) 꼬리표 떼기 규칙
      const clean = (s) => ev(`cleanPlaceName(${JSON.stringify(s)})`);
      ok("' · 디럭스 더블 · 2명' 꼬리표 제거", clean("롯데호텔 부산 · 디럭스 더블 · 2명") === "롯데호텔 부산", clean("롯데호텔 부산 · 디럭스 더블 · 2명"));
      ok("괄호 안 객실·인원 제거", clean("파라다이스 호텔 부산 (스탠다드 트윈 / 2인)") === "파라다이스 호텔 부산", clean("파라다이스 호텔 부산 (스탠다드 트윈 / 2인)"));
      ok("구분자 없이 붙은 인원 제거", clean("시그니엘 부산 2명") === "시그니엘 부산", clean("시그니엘 부산 2명"));
      ok("지점·주소 괄호는 그대로", clean("호텔 더 메 (부산역점)") === "호텔 더 메 (부산역점)" && clean("인천 미추홀구 학익동") === "인천 미추홀구 학익동", clean("호텔 더 메 (부산역점)"));

      // (2) 예약 → 거점 자동 연동: 주소에 객실·인원이 섞이지 않는다
      ev(`currentDay = 1; editMode = false;
        state.meta = { title:'호텔 칩 테스트', destination:'부산', startDate:'2027-03-06', endDate:'2027-03-07', travelers:2, tripType:'domestic' };
        state.days = [{ day:1, label:'1일차', date:'2027-03-06', items: [] }, { day:2, label:'2일차', date:'2027-03-07', items: [] }];
        state.savedPlaces = [];
        state.bookings = [{ id:'bk-h1', type:'hotel', name:'롯데호텔 부산', room:'디럭스 더블 · 2명',
          inDate:'2027-03-06', outDate:'2027-03-07', inTime:'15:00', outTime:'11:00',
          price:0, payStatus:'planned', schedule:{ on:false }, lat:35.1532, lng:129.0564 }];
        ensureSavedPlaces();`);
      const hotelRec = ev("JSON.stringify(state.savedPlaces.find(p => p.kind === 'hotel') || null)");
      const hr = JSON.parse(hotelRec);
      ok("예약 호텔 거점은 이름만 저장", !!hr && hr.label === "롯데호텔 부산" && hr.address === "롯데호텔 부산"
        && hr.room === "디럭스 더블 · 2명" && hr.lat === 35.1532, hotelRec);

      // 예전에 객실·인원이 섞여 저장된 거점도 동기화 때 고쳐진다
      ev(`state.savedPlaces = [{ id:'pl-auto-old', auto:true, key:'hotel|롯데호텔 부산', kind:'hotel', label:'롯데호텔 부산', address:'롯데호텔 부산 (디럭스 더블 · 2명)' }];
        ensureSavedPlaces();`);
      ok("예전에 섞인 거점 주소도 자동 복구", ev("state.savedPlaces.find(p => p.kind === 'hotel').address") === "롯데호텔 부산",
        ev("state.savedPlaces.find(p => p.kind === 'hotel').address"));

      // (3) 장소 모달에서 호텔 칩 클릭 → 장소명·검색칸·좌표가 깨끗하게
      w.openPlaceModal(null);
      const chipBox = w.document.getElementById("pm-saved-single");
      const hotelChip = [...chipBox.querySelectorAll(".sp-chip")].find(b => /롯데호텔 부산/.test(b.textContent));
      ok("호텔 칩이 깨끗한 이름으로 보인다", !!hotelChip && !/2명|디럭스/.test(hotelChip.textContent),
        chipBox.textContent.replace(/\s+/g, " ").slice(0, 80));
      ok("객실·인원은 칩 툴팁에만 남는다", !!hotelChip && /디럭스 더블/.test(hotelChip.getAttribute("title") || ""), hotelChip && hotelChip.getAttribute("title"));
      hotelChip.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
      const placeVal = w.document.getElementById("pm-place").value;
      const searchVal = w.document.getElementById("pm-search-q").value;
      ok("호텔 클릭 → 장소명에 호텔 이름만", placeVal === "롯데호텔 부산", placeVal);
      ok("호텔 클릭 → 지도 검색칸은 비어 있다(검색 화면 아님)", searchVal === "", searchVal);
      ok("호텔 클릭 → 예약 좌표 그대로 사용", ev("pickedLat") === 35.1532 && ev("pickedLng") === 129.0564,
        `${ev("pickedLat")},${ev("pickedLng")}`);

      // (4) 저장한 일정·지도 링크에도 객실·인원이 남지 않는다
      w.savePlaceEdit();
      const savedItem = JSON.parse(ev("JSON.stringify(state.days[0].items[0] || null)"));
      ok("일정 저장도 깨끗한 장소명", !!savedItem && savedItem.place === "롯데호텔 부산", savedItem && savedItem.place);
      const mapUrl = savedItem ? String(savedItem.mapUrl || "") : "";
      ok("지도 링크에 룸타입·인원 없음", !!mapUrl && !/2%EB%AA%85|2%EC%9D%B8/.test(mapUrl) && !/디럭스|%EB%94%94%EB%9F%AD%EC%8A%A4/.test(mapUrl), mapUrl);
      ok("지도 링크는 예약 좌표를 사용", /35\.1532/.test(mapUrl) && /129\.0564/.test(mapUrl), mapUrl);

      // (5) 예약 카드 · 숙소 복귀 카드 이름에도 객실·인원이 붙지 않는다
      ev("state.days[0].items = []; ensureSavedPlaces();");
      const hotelChip2 = [...w.document.getElementById("pm-saved-single").querySelectorAll(".sp-chip")].find(b => /롯데호텔 부산/.test(b.textContent));
      ok("칩 다시 그려도 이름 깨끗", !!hotelChip2 && hotelChip2.textContent.trim() === "🏨 롯데호텔 부산", hotelChip2 && hotelChip2.textContent.trim());
      ev("state.bookings = []; state.savedPlaces = []; state.days[0].items = []; saveState();");
    }

    // 56) ⚡ 새 일정 추가 — 저장해 둔 집·호텔 칩을 누르면 위치까지 바로 채워지고, 다시 검색할 필요가 없다
    {
      ev(`currentDay = 1; editMode = false;
        state.meta = { title:'거점 즉시 입력', destination:'부산', startDate:'2027-03-06', endDate:'2027-03-07', travelers:2, tripType:'domestic' };
        state.days = [{ day:1, label:'1일차', date:'2027-03-06', items: [] }, { day:2, label:'2일차', date:'2027-03-07', items: [] }];
        state.bookings = [];
        state.savedPlaces = [
          { id:'pl-home-1', kind:'home', label:'집', address:'인천 미추홀구 인하로 100', roadAddress:'인천 미추홀구 인하로 100', lat:37.4586, lng:126.6425 },
          { id:'pl-hotel-1', kind:'hotel', label:'호텔 아쿠아 펠리스', address:'호텔 아쿠아 펠리스', roadAddress:'부산 수영구 광안해변로 225', lat:35.1532, lng:129.1180 }
        ];
        saveState();`);
      // 지도 검색이 실제로 돌았는지 감시
      const realSearch = w.smartPlaceSearch;
      let searchCalls = 0;
      w.smartPlaceSearch = (...a) => { searchCalls++; return realSearch(...a); };

      w.openPlaceModal(null);
      const chip = [...w.document.getElementById("pm-saved-single").querySelectorAll(".sp-chip")].find(b => /호텔 아쿠아 펠리스/.test(b.textContent));
      ok("저장 거점 칩이 새 일정 모달에 보인다", !!chip, w.document.getElementById("pm-saved-single").textContent.replace(/\s+/g, " ").slice(0, 60));
      chip.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
      const hint = w.document.getElementById("pm-pick-hint");
      ok("칩 클릭 → 위치가 바로 확정됐다고 알려 준다", hint.style.display !== "none" && /등록된 위치 바로 사용됨/.test(hint.textContent), hint.textContent);
      ok("칩 클릭 → 도로명 주소까지 보인다", /부산 수영구 광안해변로 225/.test(hint.textContent), hint.textContent);
      ok("칩 클릭 → 좌표 즉시 세팅", ev("pickedLat") === 35.1532 && ev("pickedLng") === 129.1180, `${ev("pickedLat")},${ev("pickedLng")}`);
      ok("칩 클릭 → 좌표 숫자는 화면에 안 보인다", !/-?\d{2,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}/.test(w.document.getElementById("place-modal").textContent), "");
      ok("칩 클릭 → 검색은 돌지 않는다", searchCalls === 0, String(searchCalls));
      ok("칩 클릭 → 검색 결과 칸은 비어 있다", w.document.getElementById("pm-search-results").innerHTML.trim() === "", "");

      // 메모·금액만 적고 바로 저장 → 검색 없이 좌표·주소까지 저장된다
      w.document.getElementById("pm-memo").value = "오션뷰 요청";
      w.document.getElementById("pm-cost").value = "211411";
      await w.savePlaceEdit();
      const saved = JSON.parse(ev("JSON.stringify(state.days[0].items[0] || null)"));
      ok("검색 없이 바로 저장 — 장소명·좌표·주소", !!saved && saved.place === "호텔 아쿠아 펠리스" && saved.lat === 35.1532 && saved.lng === 129.1180 && saved.addr === "부산 수영구 광안해변로 225",
        JSON.stringify(saved && { place: saved.place, lat: saved.lat, lng: saved.lng, addr: saved.addr }));
      ok("검색 없이 바로 저장 — 모달 닫힘·검색 0회", !w.document.getElementById("place-modal").classList.contains("open") && searchCalls === 0, String(searchCalls));

      // 집 칩도 같은 방식으로 바로 채워진다
      w.openPlaceModal(null);
      const homeChip = [...w.document.getElementById("pm-saved-single").querySelectorAll(".sp-chip")].find(b => /🏠 집/.test(b.textContent));
      homeChip.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
      const homeHint = w.document.getElementById("pm-pick-hint").textContent;
      ok("집 칩도 바로 좌표·주소", ev("pickedLat") === 37.4586 && /인천 미추홀구 인하로 100/.test(homeHint), `${ev("pickedLat")} / ${homeHint}`);

      // 좌표가 없는 거점(새로 넣은 예약 등) → 뒤에서 조용히 찾아 채우고, 예전 좌표가 남지 않는다
      ev(`state.savedPlaces.push({ id:'pl-new-hotel', kind:'hotel', label:'신라스테이 해운대', address:'신라스테이 해운대' }); saveState();`);
      const realGeo = w.geocodeByName;
      const geoAsked = [];
      w.geocodeByName = async (q) => { geoAsked.push(q); return { lat: 35.1595, lng: 129.1626, address: "부산 해운대구 해운대로 570" }; };
      w.openPlaceModal(null);
      const newChip = [...w.document.getElementById("pm-saved-single").querySelectorAll(".sp-chip")].find(b => /신라스테이 해운대/.test(b.textContent));
      newChip.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
      ok("좌표 없는 거점 → 찾는 중 안내", /찾는 중/.test(w.document.getElementById("pm-pick-hint").textContent), w.document.getElementById("pm-pick-hint").textContent);
      ok("좌표 없는 거점 → 예전 좌표가 남지 않는다", ev("pickedLat") === null, String(ev("pickedLat")));
      await ev("pickedCoordPromise");
      const autoHint = w.document.getElementById("pm-pick-hint").textContent;
      ok("좌표 없는 거점 → 자동으로 위치·주소 채움", ev("pickedLat") === 35.1595 && ev("pickedLng") === 129.1626 && /위치 확인됨/.test(autoHint) && /부산 해운대구 해운대로 570/.test(autoHint), `${ev("pickedLat")} / ${autoHint}`);
      ok("자동 찾기도 검색 버튼 없이 조용히", geoAsked.length >= 1 && searchCalls === 0, `${geoAsked.join("|")} / 검색 ${searchCalls}`);
      await w.savePlaceEdit();
      const autoSaved = JSON.parse(ev("JSON.stringify(state.days[0].items.find(i => i.place === '신라스테이 해운대') || null)"));
      ok("자동 찾은 위치로 바로 저장", !!autoSaved && autoSaved.lat === 35.1595 && autoSaved.lng === 129.1626, JSON.stringify(autoSaved && { lat: autoSaved.lat, lng: autoSaved.lng }));

      // 칩을 안 누르고 이름만 직접 쳐도, 저장해 둔 집·호텔이면 위치를 같이 저장한다
      w.openPlaceModal(null);
      w.document.getElementById("pm-place").value = "호텔 아쿠아 펠리스 체크인";
      await w.savePlaceEdit();
      const typed = JSON.parse(ev("JSON.stringify(state.days[0].items[state.days[0].items.length - 1] || null)"));
      ok("이름만 쳐도 저장 거점 위치 사용", !!typed && typed.place === "호텔 아쿠아 펠리스 체크인" && typed.lat === 35.1532 && typed.addr === "부산 수영구 광안해변로 225",
        JSON.stringify(typed && { place: typed.place, lat: typed.lat, addr: typed.addr }));

      // 저장한 적 없는 새 이름에는 위치를 지어내지 않는다
      w.openPlaceModal(null);
      w.document.getElementById("pm-place").value = "처음 가는 식당";
      await w.savePlaceEdit();
      const fresh = JSON.parse(ev("JSON.stringify(state.days[0].items[state.days[0].items.length - 1] || null)"));
      ok("모르는 이름은 위치를 지어내지 않는다", !!fresh && fresh.place === "처음 가는 식당" && fresh.lat === undefined, JSON.stringify(fresh && { place: fresh.place, lat: fresh.lat }));

      w.geocodeByName = realGeo;
      w.smartPlaceSearch = realSearch;
      ev("state.bookings = []; state.savedPlaces = []; state.days[0].items = []; saveState();");
    }
    {
      const rawCoordRe = /-?\d{2,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}/;
      ok("도로명 주소 우선 표기", ev("placeAddressText({lat:37.5,lng:127, roadAddress:'서울 마포구 마포대로 109', sub:'다른주소'})") === "서울 마포구 마포대로 109",
        ev("placeAddressText({lat:37.5,lng:127, roadAddress:'서울 마포구 마포대로 109', sub:'다른주소'})"));
      ok("좌표 문자열은 주소에서 걸러진다", ev("looksLikeCoordText('37.5428, 126.9497')") === true
        && ev("placeLocationText('37.5428, 126.9497')") === "📍 위치 확인됨", ev("placeLocationText('37.5428, 126.9497')"));
      ok("주소 없으면 '위치 확인됨'", ev("placeLocationText('')") === "📍 위치 확인됨", ev("placeLocationText('')"));

      // 카카오 결과의 도로명 주소가 표시용 주소로 잡힌다
      ok("카카오 결과 roadAddress", ev("kakaoDocToPlace({place_name:'신라스테이 마포', y:'37.5428', x:'126.9497', road_address_name:'서울 마포구 마포대로 109', address_name:'서울 마포구 도화동 1', category_group_code:'AD5'}).roadAddress") === "서울 마포구 마포대로 109",
        ev("JSON.stringify(kakaoDocToPlace({place_name:'신라스테이 마포', y:'37.5428', x:'126.9497', road_address_name:'서울 마포구 마포대로 109', address_name:'서울 마포구 도화동 1', category_group_code:'AD5'}))"));

      // 거점 목록: 이름 + 도로명 주소, 좌표 숫자·'좌표' 문구 없음
      ev(`state.savedPlaces = [
        { id:'pl-t1', kind:'hotel', label:'신라스테이 마포', address:'신라스테이 마포', roadAddress:'서울 마포구 마포대로 109', lat:37.5428, lng:126.9497 },
        { id:'pl-t2', kind:'home', label:'집', address:'인천 미추홀구 인하로 100', lat:37.4586, lng:126.6425 }
      ]; state.bookings = []; saveState();`);
      w.openPlacesModal();
      const placesTxt = w.document.getElementById("places-modal").textContent;
      ok("거점 목록에 도로명 주소", /서울 마포구 마포대로 109/.test(placesTxt) && /인천 미추홀구 인하로 100/.test(placesTxt), placesTxt.replace(/\s+/g, " ").slice(0, 160));
      ok("거점 목록에 좌표 숫자 없음", !rawCoordRe.test(placesTxt), placesTxt.replace(/\s+/g, " ").slice(0, 160));
      ok("거점 모달에 '좌표' 문구 없음", !/좌표/.test(placesTxt), (placesTxt.match(/.{0,12}좌표.{0,12}/) || [""])[0]);
      ok("검색 버튼은 '위치 찾기'", /위치 찾기/.test(placesTxt) && !/좌표 찾기/.test(placesTxt), placesTxt.includes("위치 찾기"));

      // 검색 결과를 고르면 입력칸·안내문이 도로명 주소로
      w.eval(`window._savedPlaceResults = [{ name:'신라스테이 마포', sub:'서울 마포구 마포대로 109', roadAddress:'서울 마포구 마포대로 109', lat:37.5428, lng:126.9497, kind:'attraction' }]; pickSavedPlaceCoords(0);`);
      ok("고른 곳 주소가 칸에 들어간다", w.document.getElementById("place-address").value === "서울 마포구 마포대로 109", w.document.getElementById("place-address").value);
      const noteTxt = w.document.getElementById("place-coord-note").textContent;
      ok("안내문도 주소로", /서울 마포구 마포대로 109/.test(noteTxt) && !rawCoordRe.test(noteTxt) && !/좌표/.test(noteTxt), noteTxt);
      w.closePlacesModal();

      // 일정 장소 모달에 좌표 숫자·'좌표' 문구 없음
      w.eval("state.days[0].items = []; delete state.savedPlaces; ensureSavedPlaces();");
      w.openPlaceModal(null);
      const placeModalTxt = w.document.getElementById("place-modal").textContent;
      ok("장소 모달에 좌표 숫자 없음", !rawCoordRe.test(placeModalTxt), placeModalTxt.replace(/\s+/g, " ").slice(0, 120));
      ok("장소 모달에 '좌표' 문구 없음", !/좌표/.test(placeModalTxt), (placeModalTxt.match(/.{0,12}좌표.{0,12}/) || [""])[0]);
      w.closePlaceModal();

      // 숙소 예약 모달: 주소가 있으면 주소, 없으면 '위치 확인됨' — 숫자 없음
      ev(`state.bookings = [{ id:'bk-t1', type:'hotel', name:'신라스테이 마포', room:'스탠다드 · 2명', inDate:'2027-01-31', outDate:'2027-02-02', inTime:'15:00', outTime:'11:00', price:0, payStatus:'planned', addr:'서울 마포구 마포대로 109', lat:37.5428, lng:126.9497, schedule:{ on:true, lat:37.5428, lng:126.9497, plan:{nights:2,mornings:2} } }]; ensureSavedPlaces();`);
      w.openBookingModal("bk-t1");
      const bkNote = w.document.getElementById("bk-sched-coord").textContent;
      ok("숙소 위치 줄에 도로명 주소", /서울 마포구 마포대로 109/.test(bkNote), bkNote);
      const bkModalTxt = w.document.getElementById("booking-modal").textContent;
      ok("예약 모달에 좌표 숫자 없음", !rawCoordRe.test(bkModalTxt), (bkModalTxt.match(rawCoordRe) || [""])[0]);
      ok("예약 모달 버튼은 '위치 검색'·'위치 찾기'", /위치 검색/.test(bkModalTxt) && !/좌표 검색|좌표 찾기/.test(bkModalTxt), "");
      w.closeBookingModal();

      // 주소를 모르는 예약은 숫자 대신 '위치 확인됨'
      ev("state.bookings[0].addr = ''; saveState();");
      w.openBookingModal("bk-t1");
      const bkNote2 = w.document.getElementById("bk-sched-coord").textContent;
      ok("주소 없으면 '위치 확인됨'", /위치 확인됨/.test(bkNote2) && !rawCoordRe.test(bkNote2), bkNote2);
      w.closeBookingModal();

      ev("state.bookings = []; delete state.savedPlaces; ensureSavedPlaces(); state.days[0].items = []; saveState();");
    }

    // 57) 🚌 '이동' 모드 — 카카오맵 기준 대중교통 3개 루트 추천
    {
      // 카카오 대중교통 응답(실제 구조 그대로) — 0번이 가장 빠르고, 2·3번은 2번이 더 빠른데도 뒤에 온다
      const TRANSIT_STUB = {
        status: "OK",
        properties: { total: 4 },
        routes: [
          { properties: { type: "SUBWAY", totalTime: 1108, totalDistance: 5885, transfers: 0, fare: { value: 1550 } },
            steps: [{ properties: { type: "SUBWAY", guidance: "2호선 (홍대입구 > 을지로입구)", time: 720, vehicles: [{ name: "2호선", type: "일반" }] } }] },
          { properties: { type: "BUS", totalTime: 2301, totalDistance: 7484, transfers: 0, fare: { min: 0, max: 2500 } },
            steps: [{ properties: { type: "BUS", guidance: "간선 271외 3대 (홍대입구역(중) > 종로1가.종각역)", time: 1524, vehicles: [{ name: "271", type: "간선" }] } }] },
          { properties: { type: "BUS_AND_SUBWAY", totalTime: 2298, totalDistance: 6864, transfers: 1, fare: { value: 1500 } },
            steps: [
              { properties: { type: "BUS", guidance: "간선 271외 8대 (홍대입구역(중) > 충정로역(중))", time: 972, vehicles: [{ name: "271" }] } },
              { properties: { type: "WALKING", guidance: "충정로역까지 도보로 이동", time: 300 } },
              { properties: { type: "BUS", guidance: "간선 721외 4대 (충정로역(중) > 종로1가.종각역)", time: 552, vehicles: [{ name: "721" }] } }
            ] },
          // 같은 노선·같은 환승이 반복되는 경로 — 카드로 또 띄우지 않는다
          { properties: { type: "BUS_AND_SUBWAY", totalTime: 2298, totalDistance: 6864, transfers: 1, fare: { value: 1500 } },
            steps: [
              { properties: { type: "BUS", guidance: "간선 271외 14대 (홍대입구역(중) > 충정로역(중))", time: 972, vehicles: [{ name: "271" }] } },
              { properties: { type: "WALKING", guidance: "충정로역까지 도보로 이동", time: 300 } },
              { properties: { type: "BUS", guidance: "간선 721외 1대 (충정로역(중) > 종로1가.종각역)", time: 552, vehicles: [{ name: "721" }] } }
            ] }
        ]
      };
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const cards = () => [...w.document.querySelectorAll("#pm-transit-box .pm-tr-card")];

      ev(`currentDay = 1; editMode = false;
        state.meta = { title:'서울 이동', destination:'서울', startDate:'2027-03-06', endDate:'2027-03-07', travelers:2, tripType:'domestic', country:'대한민국' };
        state.days = [{ day:1, label:'1일차', date:'2027-03-06', items: [] }];
        state.bookings = []; state.days[0].items = [];
        state.savedPlaces = [
          { id:'pl-tr-home', kind:'home', label:'집', address:'인천 미추홀구 인하로 100', roadAddress:'인천 미추홀구 인하로 100', lat:37.4586, lng:126.6425 },
          { id:'pl-tr-station', kind:'station', label:'서울역', address:'서울역', roadAddress:'서울 용산구 한강대로 405', lat:37.5547, lng:126.9707 },
          { id:'pl-tr-hotel', kind:'hotel', label:'롯데호텔 서울', address:'롯데호텔 서울', roadAddress:'서울 중구 을지로 30', lat:37.5651, lng:126.9816 }
        ];
        PM_TRANSIT_CACHE.clear(); saveState();`);

      const realFetch = w.fetch;
      const realSearch = w.smartPlaceSearch;
      let transitCalls = [];
      const stubFetch = (payload) => (url, opt) => {
        if (String(url).includes("kakao-transit")) {
          transitCalls.push(JSON.parse((opt && opt.body) || "{}"));
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(payload))) });
        }
        return Promise.reject(new Error("offline-test"));
      };
      w.fetch = stubFetch(TRANSIT_STUB);
      w.smartPlaceSearch = async (q) => [{ name: String(q), sub: "서울 마포구", lat: 37.5572, lng: 126.9236, kind: "station" }];

      // (1) 출발·도착이 비어 있으면 아무것도 부르지 않는다
      w.openPlaceModal(null);
      w.setPlaceMode("route");
      const box = w.document.getElementById("pm-transit-box");
      ok("이동 모드: 출발·도착 전엔 추천 칸 숨김", box.style.display === "none" && transitCalls.length === 0, box.style.display);

      // (2) 출발을 검색해서 고르면 좌표가 확보된다 (도착이 없어 아직 조회는 안 함)
      w.document.getElementById("pm-from").value = "홍대입구역";
      await w.searchPlaceOnMap("from");
      w.selectSearchPlace(0);
      await wait(320);
      ok("출발 검색 선택 → 출발 좌표 확보", ev("pmFromCoord && pmCoordOf(pmFromCoord).lat") === 37.5572, JSON.stringify(ev("pmFromCoord")));
      ok("도착 전엔 조회하지 않는다", transitCalls.length === 0, String(transitCalls.length));

      // (3) 도착을 저장 거점(예약 호텔) 칩으로 바로 넣으면 자동으로 루트를 찾는다
      const hotelChip = [...w.document.getElementById("pm-saved-to").querySelectorAll(".sp-chip")].find(b => /롯데호텔 서울/.test(b.textContent));
      ok("이동 모드에도 저장 거점 칩이 보인다", !!hotelChip, w.document.getElementById("pm-saved-to").textContent.replace(/\s+/g, " ").slice(0, 60));
      hotelChip.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
      await wait(420);
      ok("거점 칩으로 도착 입력 → 카카오 대중교통 1회 조회", transitCalls.length === 1, String(transitCalls.length));
      const sent = transitCalls[0] || {};
      ok("프록시 요청 형식(경도=x·위도=y·출발/도착 이름)", sent.start_x === 126.9236 && sent.start_y === 37.5572 && sent.end_x === 126.9816 && sent.end_y === 37.5651 && sent.s_name === "홍대입구역" && sent.e_name === "롯데호텔 서울", JSON.stringify(sent));
      ok("추천 카드 3개", cards().length === 3, String(cards().length));
      const badges = cards().map(c => (c.querySelector(".pm-tr-badge") || {}).textContent);
      ok("배지 순서: 빠른 도착 · 추천 2 · 추천 3", badges.join("|") === "빠른 도착|추천 2|추천 3", badges.join("|"));
      const txt0 = cards()[0].textContent;
      ok("1순위는 가장 빨리 도착하는 경로", /2호선 \(홍대입구 > 을지로입구\)/.test(txt0), txt0.replace(/\s+/g, " "));
      ok("카드에 소요시간·직통·요금", /약 18분/.test(txt0) && /직통/.test(txt0) && /1,550원/.test(txt0), txt0.replace(/\s+/g, " "));
      const txt1 = cards()[1].textContent;
      ok("2순위는 카카오가 그 뒤로 보여 준 첫 경로", /간선 271 \(홍대입구역 > 종로1가\.종각역\)/.test(txt1) && /약 38분/.test(txt1), txt1.replace(/\s+/g, " "));
      ok("요금이 범위면 '최대 …원'", /최대 2,500원/.test(txt1), txt1.replace(/\s+/g, " "));
      ok("'외 3대'·'(중)' 같은 잡음은 걷어낸다", !/외 \d+대|\(중\)/.test(w.document.getElementById("pm-transit-box").textContent), "");
      const txt2 = cards()[2].textContent;
      ok("3순위는 환승 경로(구간 2개)", /환승 1회/.test(txt2) && /간선 271 \(홍대입구역 > 충정로역\) → 간선 721 \(충정로역 > 종로1가\.종각역\)/.test(txt2), txt2.replace(/\s+/g, " "));
      ok("같은 노선·같은 환승 경로는 한 번만", cards().filter(c => /721/.test(c.textContent)).length === 1, String(cards().length));

      // (4) 카드를 누르면 이동수단 칸에 들어가고, 그 카드가 강조된다
      cards()[1].dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
      const moveVal = w.document.getElementById("pm-move").value;
      ok("카드 클릭 → 이동수단 칸 자동 입력", moveVal === "간선 271 (홍대입구역 > 종로1가.종각역) · 약 38분", moveVal);
      ok("카드 클릭 → 선택 카드 강조", cards()[1].classList.contains("sel") && !cards()[0].classList.contains("sel") && /선택됨/.test(cards()[1].textContent), cards().map(c => c.className).join(" / "));
      // 같은 구간을 다시 띄워도(거점 칩을 또 눌러도) 고른 카드는 그대로 강조된다
      const callsBeforeRepeat = transitCalls.length;
      w.setRouteEndpointCoord("to", { lat: 37.5651, lng: 126.9816, name: "롯데호텔 서울" });
      await wait(320);
      ok("같은 구간 다시 띄워도 선택 유지·재호출 없음", cards()[1].classList.contains("sel") && transitCalls.length === callsBeforeRepeat, `${cards().map(c => c.className).join(" / ")} / ${transitCalls.length - callsBeforeRepeat}회`);

      // (5) 자동 입력 뒤 직접 고쳐도 그대로 저장된다
      w.document.getElementById("pm-move").value = "간선 271 (홍대입구역 > 종로1가.종각역) · 약 40분 (막차 주의)";
      w.document.getElementById("pm-memo").value = "2번 출구";
      await w.savePlaceEdit();
      const routeItem = JSON.parse(ev("JSON.stringify(state.days[0].items[0] || null)"));
      ok("이동 일정 저장 — 출발/도착·직접 고친 이동수단", !!routeItem && routeItem.fromPlace === "홍대입구역" && routeItem.toPlace === "롯데호텔 서울"
        && routeItem.moveMode === "간선 271 (홍대입구역 > 종로1가.종각역) · 약 40분 (막차 주의)",
        JSON.stringify(routeItem && { from: routeItem.fromPlace, to: routeItem.toPlace, move: routeItem.moveMode }));
      ok("이동 일정 저장 뒤 모달 닫힘", !w.document.getElementById("place-modal").classList.contains("open"), "");

      // (6) 같은 구간을 다시 물어도 캐시로 다시 부르지 않는다
      const before = transitCalls.length;
      w.openPlaceModal(null);
      w.setPlaceMode("route");
      w.setRouteEndpointCoord("from", { lat: 37.5572, lng: 126.9236, name: "홍대입구역" });
      w.setRouteEndpointCoord("to", { lat: 37.5651, lng: 126.9816, name: "롯데호텔 서울" });
      await wait(400);
      ok("같은 출발·도착은 캐시로 재호출 없음", transitCalls.length === before && cards().length === 3, `${transitCalls.length - before}회 / 카드 ${cards().length}`);

      // (6-2) 칩을 안 누르고 이름만 쳐도, 저장 거점이면 위치를 찾아 조회한다
      const beforeTyped = transitCalls.length;
      w.document.getElementById("pm-from").value = "집";
      w.document.getElementById("pm-from").dispatchEvent(new w.Event("input", { bubbles: true }));
      w.document.getElementById("pm-to").value = "서울역";
      w.document.getElementById("pm-to").dispatchEvent(new w.Event("input", { bubbles: true }));
      await wait(420);
      ok("이름만 쳐도 저장 거점이면 자동 조회", transitCalls.length === beforeTyped + 1 && cards().length === 3 && ev("pmCoordOf(pmFromCoord).lat") === 37.4586, `${transitCalls.length - beforeTyped}회 / 카드 ${cards().length}`);

      // (7) 찾는 중 안내
      let release = null;
      w.fetch = (url, opt) => {
        if (String(url).includes("kakao-transit")) {
          transitCalls.push(JSON.parse((opt && opt.body) || "{}"));
          return new Promise(r => { release = () => r({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(TRANSIT_STUB))) }); });
        }
        return Promise.reject(new Error("offline-test"));
      };
      w.document.getElementById("pm-from").value = "신촌역";
      w.document.getElementById("pm-to").value = "시청역";
      w.setRouteEndpointCoord("from", { lat: 37.5551, lng: 126.9368, name: "신촌역" });
      w.setRouteEndpointCoord("to", { lat: 37.5658, lng: 126.9774, name: "시청역" });
      ev("if (pmTransitTimer) { clearTimeout(pmTransitTimer); pmTransitTimer = null; }");   // 디바운스를 건너뛰고 바로 부른다
      const pending = w.loadRouteRecommendations();
      ok("조회 중엔 '대중교통 루트 찾는 중' 안내", /대중교통 루트 찾는 중/.test(w.document.getElementById("pm-transit-box").textContent), w.document.getElementById("pm-transit-box").textContent);
      release && release();
      await pending;
      ok("응답이 오면 추천 카드로 바뀐다", cards().length === 3, String(cards().length));

      // (8) 경로 없음 / 통신 오류 안내
      w.fetch = stubFetch({ status: "NO_RESULT", routes: [] });
      ev("PM_TRANSIT_CACHE.clear()");
      await w.loadRouteRecommendations({ force: true });
      const noneTxt = w.document.getElementById("pm-transit-box").textContent;
      ok("경로 없음 안내", /찾지 못했어요/.test(noneTxt) && cards().length === 0, noneTxt.replace(/\s+/g, " "));
      w.fetch = () => Promise.reject(new Error("offline-test"));
      await w.loadRouteRecommendations({ force: true });
      const errTxt = w.document.getElementById("pm-transit-box").textContent;
      ok("통신 오류 안내", /불러오지 못했어요/.test(errTxt), errTxt.replace(/\s+/g, " "));
      ok("경로 없음·오류엔 '다시 찾기' 버튼", !!w.document.querySelector("#pm-transit-box .pm-tr-retry"), "");
      w.fetch = stubFetch(TRANSIT_STUB);
      w.document.querySelector("#pm-transit-box .pm-tr-retry").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
      await wait(200);
      ok("'다시 찾기' → 추천 카드 복귀", cards().length === 3, String(cards().length));

      // (9) 출발·도착을 지우면 추천도 함께 사라진다
      w.fetch = stubFetch(TRANSIT_STUB);
      ev("PM_TRANSIT_CACHE.clear()");
      w.setRouteEndpointCoord("from", { lat: 37.5551, lng: 126.9368, name: "신촌역" });
      w.setRouteEndpointCoord("to", { lat: 37.5658, lng: 126.9774, name: "시청역" });
      await wait(400);
      ok("두 지점이 있으면 다시 카드", cards().length === 3, String(cards().length));
      w.document.getElementById("pm-to").value = "";
      w.document.getElementById("pm-to").dispatchEvent(new w.Event("input", { bubbles: true }));
      await wait(60);
      ok("도착을 지우면 추천 칸 접힘", w.document.getElementById("pm-transit-box").style.display === "none" && cards().length === 0, w.document.getElementById("pm-transit-box").style.display);

      // (10) 저장해 둔 이동 일정을 다시 열면 도착 좌표·거점 이름으로 추천이 다시 뜬다
      ev(`state.days[0].items = [{ id:'rt-open', time:'', place:'집 → 롯데호텔 서울', fromPlace:'집', toPlace:'롯데호텔 서울', moveMode:'2호선 · 약 19분', lat:37.5651, lng:126.9816, badges:['직접 추가'] }];`);
      const beforeOpen = transitCalls.length;
      w.openPlaceModal("rt-open");
      ok("저장된 이동 일정 → 이동 모드로 열린다", ev("placeEditMode") === "route", ev("placeEditMode"));
      await wait(420);
      ok("다시 열어도 출발(집) 좌표를 찾아 조회", transitCalls.length === beforeOpen + 1 && cards().length === 3, `${transitCalls.length - beforeOpen}회 / 카드 ${cards().length}`);
      ok("다시 연 카드도 1순위가 빠른 도착", /빠른 도착/.test((cards()[0] || { textContent: "" }).textContent), (cards()[0] || { textContent: "" }).textContent.replace(/\s+/g, " ").slice(0, 40));

      // (11) 해외 여행 — 카카오 대중교통을 부르지 않고 추천 칸도 뜨지 않는다
      ev("state.meta.tripType = 'overseas'; state.meta.country = 'JP'; state.meta.destination = '도쿄'; saveState();");
      const beforeOverseas = transitCalls.length;
      w.openPlaceModal(null);
      w.setPlaceMode("route");
      w.setRouteEndpointCoord("from", { lat: 35.6812, lng: 139.7671, name: "도쿄역" });
      w.setRouteEndpointCoord("to", { lat: 35.6595, lng: 139.7005, name: "시부야" });
      await wait(320);
      ok("해외에선 프록시 미호출", transitCalls.length === beforeOverseas, String(transitCalls.length - beforeOverseas));
      ok("해외에선 추천 칸 숨김", w.document.getElementById("pm-transit-box").style.display === "none" && cards().length === 0, w.document.getElementById("pm-transit-box").style.display);
      w.closePlaceModal();

      w.fetch = realFetch;
      w.smartPlaceSearch = realSearch;
      ev(`state.meta = { title:'', destination:'', startDate:'', endDate:'', travelers:2, tripType:'domestic', country:'대한민국' };
        state.bookings = []; state.savedPlaces = []; state.days[0].items = []; PM_TRANSIT_CACHE.clear(); saveState();`);
    }

    // 58) 🏠 거점 칩('집')을 누르면 '집'을 검색하는 화면·자동완성이 뜨지 않는다 (사용자 제보 버그 회귀)
    {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      ev(`currentDay = 1; editMode = false;
        state.meta = { title:'칩 클릭 버그', destination:'부산', startDate:'2027-03-06', endDate:'2027-03-07', travelers:2, tripType:'domestic', country:'대한민국' };
        state.days = [{ day:1, label:'1일차', date:'2027-03-06', items: [] }];
        state.bookings = [];
        state.savedPlaces = [
          { id:'home1', kind:'home', label:'집', address:'인천광역시 미추홀구 인하로 100', roadAddress:'인천광역시 미추홀구 인하로 100', lat:37.45, lng:126.65 },
          { id:'hotel1', kind:'hotel', label:'롯데호텔 부산', address:'부산 부산진구 부전로 45', roadAddress:'부산 부산진구 부전로 45', lat:35.1567, lng:129.0564 }
        ];
        PM_TRANSIT_CACHE.clear(); saveState();`);
      const realSearch = w.smartPlaceSearch, realGeo = w.geocodeByName, realFetch = w.fetch;
      const searched = [], geoAsked = [], transitCalls = [];
      w.smartPlaceSearch = (q, ...a) => { searched.push(String(q)); return realSearch(q, ...a); };
      w.geocodeByName = async (q) => { geoAsked.push(String(q)); return null; };
      w.fetch = (url, opt) => {
        if (String(url).includes("kakao-transit")) {
          transitCalls.push(JSON.parse((opt && opt.body) || "{}"));
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ status: "NO_RESULT", routes: [] }) });
        }
        return Promise.reject(new Error("offline-test"));
      };
      const openAc = () => [...w.document.querySelectorAll(".ac-list.open")];
      const clickChip = (boxId, re) => {
        const box = w.document.getElementById(boxId);
        const b = box ? [...box.querySelectorAll(".sp-chip")].find(x => re.test(x.textContent)) : null;
        if (b) b.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
        return b;
      };

      // (1) 단일 장소 모드 — 🏠 집
      w.openPlaceModal(null);
      searched.length = 0; geoAsked.length = 0;
      ok("집 칩이 보인다", !!clickChip("pm-saved-single", /집/), w.document.getElementById("pm-saved-single").textContent.replace(/\s+/g, " ").slice(0, 60));
      ok("집 칩 클릭 직후 — 자동완성 드롭다운 없음", openAc().length === 0, openAc().map(e => e.id).join(","));
      await wait(430);   // 자동완성 디바운스(250ms)가 지나도 목록이 뜨지 않아야 한다
      ok("집 칩 → 검색칸에 '집'이 채워지지 않음", w.document.getElementById("pm-search-q").value === "", JSON.stringify(w.document.getElementById("pm-search-q").value));
      ok("집 칩 → 자동완성 드롭다운이 열리지 않음", openAc().length === 0, openAc().map(e => e.id).join(","));
      ok("집 칩 → '집'으로 검색·지오코딩하지 않음", searched.length === 0 && geoAsked.length === 0, `검색 ${JSON.stringify(searched)} / 지오코딩 ${JSON.stringify(geoAsked)}`);
      ok("집 칩 → 장소명 '집' + 좌표 바로 확정", w.document.getElementById("pm-place").value === "집" && ev("pickedLat") === 37.45 && ev("pickedLng") === 126.65,
        `${w.document.getElementById("pm-place").value} / ${ev("pickedLat")},${ev("pickedLng")}`);
      // 칸을 다시 눌러도 '집' 연관검색어가 붙지 않는다
      w.document.getElementById("pm-place").dispatchEvent(new w.Event("focus"));
      await wait(340);
      ok("집 칸에 포커스해도 자동완성 안 열림", openAc().length === 0, openAc().map(e => e.id).join(","));
      await w.savePlaceEdit();
      const homeItem = JSON.parse(ev("JSON.stringify(state.days[0].items[state.days[0].items.length - 1] || null)"));
      ok("집 칩 → 검색 없이 바로 저장(좌표 포함)", !!homeItem && homeItem.place === "집" && homeItem.lat === 37.45 && homeItem.lng === 126.65,
        JSON.stringify(homeItem && { place: homeItem.place, lat: homeItem.lat, lng: homeItem.lng }));

      // (2) 이동 모드 — 출발 🏠 집
      w.openPlaceModal(null);
      w.setPlaceMode("route");
      searched.length = 0; transitCalls.length = 0;
      clickChip("pm-saved-from", /집/);
      await wait(430);
      ok("이동 모드 집 칩 → 출발칸 '집'", w.document.getElementById("pm-from").value === "집", w.document.getElementById("pm-from").value);
      ok("이동 모드 집 칩 → 자동완성 드롭다운 안 열림", openAc().length === 0, openAc().map(e => e.id).join(","));
      ok("이동 모드 집 칩 → 출발 좌표 바로 확정", ev("pmCoordOf(pmFromCoord).lat") === 37.45 && ev("pmCoordOf(pmFromCoord).lng") === 126.65, ev("JSON.stringify(pmFromCoord)"));
      ok("이동 모드 집 칩 → '집' 검색 없음", searched.length === 0, JSON.stringify(searched));
      // 도착도 거점 칩으로 넣으면 검색 없이 바로 대중교통 루트를 조회한다
      clickChip("pm-saved-to", /롯데호텔 부산/);
      await wait(430);
      ok("도착 거점 칩 → 자동완성 없이 루트 조회", openAc().length === 0 && transitCalls.length === 1, `ac=${openAc().length} / 조회 ${transitCalls.length}`);
      ok("보낸 좌표가 거점 좌표", (transitCalls[0] || {}).start_x === 126.65 && (transitCalls[0] || {}).start_y === 37.45
        && (transitCalls[0] || {}).end_x === 129.0564 && (transitCalls[0] || {}).end_y === 35.1567, JSON.stringify(transitCalls[0] || {}));

      // (3) 좌표도 주소도 없는 '집' — 이름만으로 지오코딩하지 않는다
      w.closePlaceModal();
      ev("state.days[0].items = []; state.savedPlaces.push({ id:'home2', kind:'home', label:'집', address:'집' }); saveState();");
      w.openPlaceModal(null);
      geoAsked.length = 0; searched.length = 0;
      const homes = [...w.document.getElementById("pm-saved-single").querySelectorAll(".sp-chip")].filter(b => /집/.test(b.textContent));
      ok("좌표 없는 '집' 칩도 보인다", homes.length >= 2, String(homes.length));
      homes[homes.length - 1].dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
      await wait(430);
      ok("좌표 없는 '집' → geocodeByName('집') 호출 없음", geoAsked.length === 0 && searched.length === 0, `지오코딩 ${JSON.stringify(geoAsked)} / 검색 ${JSON.stringify(searched)}`);
      ok("좌표 없는 '집' → 못 찾았다고만 안내", /찾지 못했어요/.test(w.document.getElementById("pm-pick-hint").textContent) && ev("pickedLat") === null,
        `${w.document.getElementById("pm-pick-hint").textContent} / pickedLat=${ev("pickedLat")}`);

      w.smartPlaceSearch = realSearch; w.geocodeByName = realGeo; w.fetch = realFetch;
      w.closePlaceModal();
      ev("state.bookings = []; state.savedPlaces = []; state.days[0].items = []; PM_TRANSIT_CACHE.clear(); saveState();");
    }

    // 59) 💳 대중교통 추천 루트를 고르면 교통비(요금)가 금액 칸에 자동 반영된다
    {
      const TRANSIT_STUB = {
        status: "OK",
        properties: { total: 3 },
        routes: [
          { properties: { type: "SUBWAY", totalTime: 1108, totalDistance: 5885, transfers: 0, fare: { value: 1550 } },
            steps: [{ properties: { type: "SUBWAY", guidance: "2호선 (홍대입구 > 을지로입구)", time: 720 } }] },
          { properties: { type: "BUS", totalTime: 2301, totalDistance: 7484, transfers: 0, fare: { min: 0, max: 2500 } },
            steps: [{ properties: { type: "BUS", guidance: "간선 271외 3대 (홍대입구역(중) > 종로1가.종각역)", time: 1524 } }] },
          { properties: { type: "BUS_AND_SUBWAY", totalTime: 2298, totalDistance: 6864, transfers: 1, fare: { value: 1500 } },
            steps: [
              { properties: { type: "BUS", guidance: "간선 271외 8대 (홍대입구역(중) > 충정로역(중))", time: 972 } },
              { properties: { type: "WALKING", guidance: "충정로역까지 도보로 이동", time: 300 } },
              { properties: { type: "BUS", guidance: "간선 721외 4대 (충정로역(중) > 종로1가.종각역)", time: 552 } }
            ] }
        ]
      };
      const NO_FARE_STUB = {
        status: "OK",
        properties: { total: 1 },
        routes: [
          { properties: { type: "SUBWAY", totalTime: 1200, totalDistance: 5000, transfers: 0 },
            steps: [{ properties: { type: "SUBWAY", guidance: "2호선 (홍대입구 > 시청)", time: 900 } }] }
        ]
      };
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const cards = () => [...w.document.querySelectorAll("#pm-transit-box .pm-tr-card")];
      const clickCard = (i) => cards()[i].dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
      const costEl = () => w.document.getElementById("pm-cost");
      const hintEl = () => w.document.getElementById("pm-cost-hint");

      ev(`currentDay = 1; editMode = false;
        state.meta = { title:'교통비 반영', destination:'서울', startDate:'2027-03-06', endDate:'2027-03-07', travelers:2, tripType:'domestic', country:'대한민국' };
        state.days = [{ day:1, label:'1일차', date:'2027-03-06', items: [] }];
        state.bookings = []; state.expenses = []; state.expenseStatusMap = {}; state.savedPlaces = []; PM_TRANSIT_CACHE.clear(); saveState();`);

      const realFetch = w.fetch;
      let stubPayload = TRANSIT_STUB;
      let transitCalls = 0;
      w.fetch = (url, opt) => {
        if (String(url).includes("kakao-transit")) {
          transitCalls++;
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(stubPayload))) });
        }
        return Promise.reject(new Error("offline-test"));
      };

      // (1) 새 일정 · 이동 모드에서 추천을 띄운다 — 금액 칸은 비어 있다
      w.openPlaceModal(null);
      w.setPlaceMode("route");
      w.document.getElementById("pm-from").value = "홍대입구역";
      w.document.getElementById("pm-to").value = "롯데호텔 서울";
      w.setRouteEndpointCoord("from", { lat: 37.5572, lng: 126.9236, name: "홍대입구역" });
      w.setRouteEndpointCoord("to", { lat: 37.5651, lng: 126.9816, name: "롯데호텔 서울" });
      await wait(420);
      ok("교통비: 추천 카드 3개", cards().length === 3, String(cards().length));
      ok("교통비: 누르기 전엔 금액 칸이 비어 있다", costEl().value === "" && hintEl().style.display === "none", `${costEl().value} / ${hintEl().textContent}`);
      ok("교통비: 카드에 1인 기준 요금 표시", /1인 1,550원/.test(cards()[0].textContent), cards()[0].textContent.replace(/\s+/g, " "));

      // (2) 카드를 누르면 1인 요금 × 인원수(2명)가 금액 칸에 들어간다
      clickCard(0);
      ok("교통비: 카드 클릭 → 금액 칸 자동 입력 (1,550 × 2 = 3,100)", costEl().value === "3100", costEl().value);
      ok("교통비: 1인 요금·인원·총액 안내", hintEl().style.display !== "none" && /1인 1,550원 × 2명 = 3,100원/.test(hintEl().textContent), hintEl().textContent);

      // (3) 다른 카드를 누르면 새 루트 요금으로 갱신된다 (범위 요금은 max)
      clickCard(1);
      ok("교통비: 다른 루트 → 새 요금으로 갱신 (최대 2,500 × 2 = 5,000)", costEl().value === "5000", costEl().value);
      ok("교통비: 범위 요금도 대표 금액으로 안내", /최대 2,500원 × 2명 = 5,000원/.test(hintEl().textContent), hintEl().textContent);
      clickCard(2);
      ok("교통비: 세 번째 루트 요금 (1,500 × 2 = 3,000)", costEl().value === "3000", costEl().value);
      clickCard(0);
      ok("교통비: 다시 첫 루트 → 3,100으로 되돌아온다", costEl().value === "3100", costEl().value);

      // (4) 직접 고쳐 적은 금액은 루트를 눌러도 덮어쓰지 않는다
      costEl().value = "4000";
      clickCard(1);
      ok("교통비: 직접 적은 금액은 그대로", costEl().value === "4000" && /직접 적은 금액/.test(hintEl().textContent), `${costEl().value} / ${hintEl().textContent}`);
      // 금액 없이(0원) 저장돼 있던 카드도 루트 요금으로 채운다
      costEl().value = "0";
      clickCard(2);
      ok("교통비: 0원이던 값도 루트 요금으로 채운다", costEl().value === "3000", costEl().value);
      // 비우고 다시 누르면 그 루트 요금으로 바뀐다
      costEl().value = "";
      clickCard(1);
      ok("교통비: 비우고 다시 누르면 루트 요금", costEl().value === "5000", costEl().value);

      // (5) 저장 → 일정 카드·경비에 한 번만, 빠짐없이 반영된다
      w.document.getElementById("pm-memo").value = "2번 출구";
      await w.savePlaceEdit();
      const savedRoute = JSON.parse(ev("JSON.stringify(state.days[0].items[0] || null)"));
      ok("교통비: 저장된 이동 일정 금액", !!savedRoute && savedRoute.costTotal === 5000 && savedRoute.moveCost === 5000,
        JSON.stringify(savedRoute && { place: savedRoute.place, costTotal: savedRoute.costTotal, moveCost: savedRoute.moveCost }));
      w.renderTimeline();
      const tlTxt = w.document.getElementById("timeline-list").textContent;
      ok("교통비: 일정 카드에 금액이 보인다", /₩5,000/.test(tlTxt), tlTxt.replace(/\s+/g, " ").slice(0, 120));
      const savedExp = JSON.parse(ev("JSON.stringify(getSyncedExpenses())"));
      const fareEntries = savedExp.filter(e => Number(e.amount) === 5000);
      ok("교통비: 경비에 한 번만 (중복 없음)", fareEntries.length === 1 && fareEntries[0].category === "교통" && fareEntries[0].transit === true && fareEntries[0].included === false,
        JSON.stringify(savedExp.map(e => ({ id: e.id, cat: e.category, amt: e.amount, inc: e.included }))));
      ok("교통비: 대중교통 합계로 또 더하지 않는다", !savedExp.some(e => e.id === "tl_transit_local"),
        JSON.stringify(savedExp.map(e => e.id)));
      ok("교통비: 대중교통이라 기본은 총액에서 빠진다 (경비 목록에는 보인다)", fareEntries.length === 1 && fareEntries[0].amount === 5000
        && ev("getSyncedExpenses().filter(e => e.included).reduce((s,e)=>s+(Number(e.amount)||0),0)") === 0,
        String(ev("getSyncedExpenses().filter(e => e.included).reduce((s,e)=>s+(Number(e.amount)||0),0)")));

      // (6) 1명 여행이면 1인 요금 그대로
      ev("state.meta.travelers = 1; saveState();");
      w.openPlaceModal(null);
      w.setPlaceMode("route");
      await wait(60);
      w.document.getElementById("pm-from").value = "홍대입구역";
      w.document.getElementById("pm-to").value = "롯데호텔 서울";
      w.setRouteEndpointCoord("from", { lat: 37.5572, lng: 126.9236, name: "홍대입구역" });
      w.setRouteEndpointCoord("to", { lat: 37.5651, lng: 126.9816, name: "롯데호텔 서울" });
      await wait(420);
      clickCard(0);
      ok("교통비: 1명이면 1,550원 그대로", costEl().value === "1550", costEl().value);
      ok("교통비: 1명일 땐 인원 표기 없음", !/×/.test(hintEl().textContent) && /1,550원/.test(hintEl().textContent), hintEl().textContent);

      // (7) 출발·도착이 바뀌면 앞서 넣은 루트 요금은 지운다
      ev("state.meta.travelers = 2; saveState();");
      const beforeSeg = transitCalls;
      w.document.getElementById("pm-to").value = "서울역";
      w.setRouteEndpointCoord("to", { lat: 37.5547, lng: 126.9707, name: "서울역" });
      await wait(420);
      ok("교통비: 구간이 바뀌면 금액·안내를 지운다", transitCalls > beforeSeg && costEl().value === "" && hintEl().style.display === "none",
        `${costEl().value} / ${hintEl().textContent} / 조회 ${transitCalls - beforeSeg}`);

      // (8) 요금이 없는 루트 — 금액은 비워 두고 직접 적도록 안내
      stubPayload = NO_FARE_STUB;
      ev("PM_TRANSIT_CACHE.clear()");
      w.document.getElementById("pm-from").value = "신촌역";
      w.setRouteEndpointCoord("from", { lat: 37.5551, lng: 126.9368, name: "신촌역" });
      await wait(420);
      ok("교통비: 요금 없는 루트도 카드로 뜬다", cards().length === 1, String(cards().length));
      clickCard(0);
      ok("교통비: 요금 없으면 비워 두고 안내", costEl().value === "" && /요금 정보가 없어요/.test(hintEl().textContent), `${costEl().value} / ${hintEl().textContent}`);
      ok("교통비: 이동수단은 그대로 입력", /2호선 \(홍대입구 > 시청\)/.test(w.document.getElementById("pm-move").value), w.document.getElementById("pm-move").value);
      w.closePlaceModal();

      // (9) 저장된 이동 일정을 열면 금액이 보이고, 비우고 저장하면 교통비도 지워진다
      const rid = ev("state.days[0].items[0].id");
      stubPayload = TRANSIT_STUB;
      w.openPlaceModal(rid);
      ok("교통비: 다시 열면 저장된 금액", costEl().value === "5000", costEl().value);
      costEl().value = "";
      await w.savePlaceEdit();
      const cleared = JSON.parse(ev("JSON.stringify(state.days[0].items[0] || null)"));
      ok("교통비: 금액을 비우고 저장하면 0원", !!cleared && cleared.costTotal === 0 && cleared.moveCost === 0,
        JSON.stringify(cleared && { costTotal: cleared.costTotal, moveCost: cleared.moveCost }));
      ok("교통비: 지운 금액은 경비에서도 빠진다", ev("getSyncedExpenses().reduce((s,e)=>s+(Number(e.amount)||0),0)") === 0,
        String(ev("getSyncedExpenses().reduce((s,e)=>s+(Number(e.amount)||0),0)")));

      w.fetch = realFetch;
      w.closePlaceModal();
      ev(`editMode = false; state.meta = { title:'', destination:'', startDate:'', endDate:'', travelers:2, tripType:'domestic', country:'대한민국' };
        state.bookings = []; state.savedPlaces = []; state.days[0].items = []; state.expenses = []; PM_TRANSIT_CACHE.clear(); saveState();`);
    }

    // 60) 🌅 일정 탭에서 일출·일몰 줄을 없앤다 (날씨 탭에는 그대로)
    {
      ev(`currentDay = 1; editMode = false;
        state.meta = { title:'일출일몰', destination:'부산', startDate:'2027-03-06', endDate:'2027-03-07', travelers:2, tripType:'domestic', country:'대한민국' };
        state.days = [{ day:1, label:'1일차', date:'2027-03-06', items: [
          { id:'sun-1', time:'09:00', place:'해운대 해수욕장', stay:'체류 60분', moveMode:'호텔 도보 5분', moveMin:5, moveCost:0, costTotal:0, badges:['일출 07:12'], lat:35.1586, lng:129.1604 },
          { id:'sun-2', time:'18:30', place:'광안리 해변', stay:'체류 50분', moveMode:'41번 버스', moveMin:20, moveCost:3100, costTotal:3100, badges:['일몰 18:04'], lat:35.1533, lng:129.1186 }
        ]}];
        state.bookings = []; state.expenses = [];
        state.weather = [{ dayNum:1, day:'1일차', cityLabel:'부산', area:'해운대', condition:'맑음', minTemp:2, maxTemp:9, sunrise:'07:12', sunset:'18:04' }];
        saveState();`);
      w.renderTimeline();
      const tl = w.document.getElementById("timeline-list");
      ok("일출일몰: 일정 탭에 구분 줄이 없다", tl.querySelectorAll(".tl-sun-row").length === 0, String(tl.querySelectorAll(".tl-sun-row").length));
      ok("일출일몰: 일정 탭 텍스트에 일출·일몰이 없다", !/일출|일몰/.test(tl.textContent), tl.textContent.replace(/\s+/g, " ").slice(0, 160));
      ok("일출일몰: 일정 카드는 그대로 그려진다", tl.querySelectorAll(".card").length === 2, String(tl.querySelectorAll(".card").length));
      ok("일출일몰: 카드 배지 데이터는 남아 있다", JSON.stringify(JSON.parse(ev("JSON.stringify(state.days[0].items.map(i => i.badges))"))) === JSON.stringify([["일출 07:12"], ["일몰 18:04"]]),
        ev("JSON.stringify(state.days[0].items.map(i => i.badges))"));
      ok("일출일몰: 렌더 함수 자체가 사라졌다", typeof w.daySunTimeRows === "undefined", typeof w.daySunTimeRows);
      ev("editMode = true");
      w.renderTimeline();
      ok("일출일몰: 편집 모드에도 없다", !/일출|일몰/.test(tl.textContent), tl.textContent.replace(/\s+/g, " ").slice(0, 160));
      ev("editMode = false");
      w.renderWeather();
      const wx = w.document.getElementById("weather-list").textContent;
      ok("일출일몰: 날씨 탭에는 그대로", /🌅 일출 07:12/.test(wx) && /🌇 일몰 18:04/.test(wx), wx.replace(/\s+/g, " ").slice(0, 160));
      ev("state.weather = []; state.days[0].items = []; saveState();");
    }

    // 61) 🎫 대중교통 경비는 기본 제외 — 경비 탭에서 포함/제외를 직접 고른다
    {
      ev(`currentDay = 1; editMode = false;
        state.meta = { title:'경비 포함 토글', destination:'부산', startDate:'2027-03-06', endDate:'2027-03-07', travelers:2, tripType:'domestic', country:'대한민국' };
        state.days = [{ day:1, label:'1일차', date:'2027-03-06', items: [
          { id:'t-bus', time:'09:00', place:'숙소 → 해운대', fromPlace:'숙소', toPlace:'해운대', moveMode:'41번 버스', moveMin:44, moveCost:3100, costTotal:3100 },
          { id:'t-ktx', time:'10:00', place:'부산역 → 광명역 (KTX)', fromPlace:'부산역', toPlace:'광명역', moveMode:'KTX 일반실', moveMin:149, moveCost:104400, costTotal:104400, badges:['예매 필수'] },
          { id:'t-taxi', time:'12:00', place:'광안리 → 부산역', fromPlace:'광안리', toPlace:'부산역', moveMode:'택시 25분', moveMin:25, moveCost:18000, costTotal:18000 },
          { id:'t-hotel', time:'15:00', place:'호텔 아쿠아 펠리스 체크인', moveMode:'도보 3분', moveMin:3, moveCost:0, costTotal:211411 },
          { id:'t-bus2', time:'18:00', place:'광안리 → 남포동', fromPlace:'광안리', toPlace:'남포동', moveMode:'2호선', moveMin:30, moveCost:1550, costTotal:20000 }
        ]}];
        state.bookings = [{ id:'bk1', type:'train', name:'KTX 25 부산행', price:104400, payStatus:'paid', inDate:'2027-03-06' }];
        state.expenses = [{ id:'e-manual-1', category:'기타', name:'간식', amount:5000, status:'현장', manual:true }];
        state.savedPlaces = []; state.weather = []; state.expenseIncludeMap = {};
        saveState();`);

      const list = () => JSON.parse(ev("JSON.stringify(getSyncedExpenses())"));
      const byId = (id) => list().find(e => e.id === id) || {};
      const total = () => w.document.getElementById("sum-total").textContent;
      const per = () => w.document.getElementById("sum-per").textContent;
      const legend = () => w.document.getElementById("donut-legend").textContent.replace(/\s+/g, " ");
      const listEl = () => w.document.getElementById("expense-list");
      const clickToggle = (id) => {
        const b = listEl().querySelector(`[data-exp-id="${id}"]`);
        if (b) b.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
        return b;
      };

      // (1) 기본값 — 버스·지하철 요금만 빠지고, KTX·택시·숙소·예약·직접 추가는 그대로 포함
      ok("경비: 버스·지하철 요금은 기본 제외", byId("tl_t-bus").transit === true && byId("tl_t-bus").included === false,
        JSON.stringify(byId("tl_t-bus")));
      ok("경비: KTX·택시·숙소·예약·직접 추가는 그대로 포함", byId("bk_bk1").included === true && byId("tl_t-taxi").included === true
        && byId("tl_t-hotel").included === true && byId("e-manual-1").included === true,
        JSON.stringify({ ktx: byId("bk_bk1").included, taxi: byId("tl_t-taxi").included, hotel: byId("tl_t-hotel").included, manual: byId("e-manual-1").included }));
      ok("경비: 대중교통 합계 줄도 기본 제외", byId("tl_transit_local").amount === 1550 && byId("tl_transit_local").included === false,
        JSON.stringify(byId("tl_transit_local")));
      ok("경비: 숙소·식비가 섞인 이동 카드는 교통 요금으로 빼지 않는다", byId("tl_t-bus2").transit === false && byId("tl_t-bus2").included === true,
        JSON.stringify(byId("tl_t-bus2")));
      ok("경비: 총 예상 경비에 대중교통 요금은 빠진다", total() === "₩358,811", total());
      ok("경비: 1인당도 포함된 금액 기준", per() === "₩179,406", per());
      ok("경비: 카테고리 합계도 제외 금액 뺀 값", /₩142,400/.test(legend()), legend());
      ok("경비: 결제 진행률은 실제 결제 항목만", w.document.getElementById("sum-done").textContent === "1/5건",
        w.document.getElementById("sum-done").textContent);

      // (2) 경비 탭에서 토글 — 포함하면 바로 합계에 들어간다
      const busBtn = listEl().querySelector('[data-exp-id="tl_t-bus"]');
      ok("경비 탭: 대중교통 항목에 '경비에 포함' 버튼", !!busBtn && busBtn.textContent.trim() === "경비에 포함", busBtn && busBtn.textContent);
      ok("경비 탭: 제외된 항목 표시", /🎫 경비 제외/.test(listEl().textContent), "");
      ok("경비 탭: KTX·예약 항목에는 토글이 없다", !listEl().querySelector('[data-exp-id="bk_bk1"]'), "");
      const note = w.document.getElementById("exp-transit-note");
      ok("경비 탭: 기본 제외 안내", note.style.display !== "none" && /기본으로 경비에서 빼 두었어요/.test(note.textContent) && /₩4,650/.test(note.textContent),
        note.textContent.replace(/\s+/g, " "));

      busBtn.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
      ok("경비: 포함을 켜면 상태에 저장", ev("state.expenseIncludeMap['tl_t-bus']") === true, ev("JSON.stringify(state.expenseIncludeMap)"));
      ok("경비: 포함을 켜면 총액에 바로 더해진다", total() === "₩361,911", total());
      ok("경비: 1인당·카테고리 합계도 같이 오른다", per() === "₩180,956" && /₩145,500/.test(legend()), `${per()} / ${legend()}`);
      ok("경비: 포함된 항목의 버튼은 '제외 (교통카드)'", (listEl().querySelector('[data-exp-id="tl_t-bus"]') || {}).textContent === "제외 (교통카드)",
        (listEl().querySelector('[data-exp-id="tl_t-bus"]') || {}).textContent);

      // (3) 다시 끄면 합계에서 빠진다 + 저장도 남는다
      clickToggle("tl_t-bus");
      ok("경비: 다시 끄면 총액에서 빠진다", total() === "₩358,811", total());
      ok("경비: 끈 상태가 저장된다", ev("state.expenseIncludeMap['tl_t-bus']") === false, ev("JSON.stringify(state.expenseIncludeMap)"));
      ok("경비: 포함 여부가 로컬 저장에도 남는다", ev("JSON.parse(localStorage.getItem(getLocalKey())).expenseIncludeMap['tl_t-bus']") === false,
        ev("JSON.stringify(JSON.parse(localStorage.getItem(getLocalKey())).expenseIncludeMap || null)"));

      // (4) '일정 내 대중교통 합계' 줄도 같은 방식으로 켤 수 있다
      ok("경비 탭: 대중교통 합계 줄에도 토글", !!listEl().querySelector('[data-exp-id="tl_transit_local"]'), "");
      clickToggle("tl_transit_local");
      ok("경비: 합계 줄을 켜면 1,550원이 더해진다", total() === "₩360,361", total());
      clickToggle("tl_transit_local");
      ok("경비: 다시 끄면 원래대로", total() === "₩358,811", total());

      ev("state.bookings = []; state.expenses = []; state.days[0].items = []; state.expenseIncludeMap = {}; saveState();");
    }

    // 57) 📍 지도 위 같은 장소·호텔은 핀 하나로 — 세 지도 모두, 동선 순서는 그대로
    {
      ev(`currentDay = 1; editMode = false;
        state.meta = { title:'핀 중복 테스트', destination:'부산', startDate:'2027-05-01', endDate:'2027-05-03', travelers:2 };
        state.days = [
          { day:1, label:'1일차', date:'2027-05-01', items: [
            { id:'dp-a', time:'09:00', place:'부산역', lat:35.1157, lng:129.0403, moveMode:'KTX 일반실', moveMin:150 },
            { id:'dp-h', time:'15:00', place:'호텔 아쿠아 펠리스 체크인', lat:35.1532, lng:129.1180 },
            { id:'dp-b', time:'17:00', place:'광안리 해변', lat:35.1532, lng:129.1187 },
            { id:'dp-b2', time:'19:00', place:'광안리 해변', lat:35.1532, lng:129.1187 },
            { id:'dp-c', time:'20:00', place:'민락회센터', lat:35.1532, lng:129.1189 }
          ]},
          { day:2, label:'2일차', date:'2027-05-02', items: [
            { id:'dp-d', time:'10:00', place:'감천문화마을', lat:35.0975, lng:129.0106 }
          ]},
          { day:3, label:'3일차', date:'2027-05-03', items: [] }
        ];
        state.bookings = [{ id:'bk-dp', type:'hotel', name:'호텔 아쿠아 펠리스', room:'디럭스 오션뷰 더블', inDate:'2027-05-01', outDate:'2027-05-03', inTime:'15:00', outTime:'11:00', price:211411, payStatus:'reserved', lat:35.1532, lng:129.1180 }];
        state.expenses = []; state.savedPlaces = []; currentDay = 1; saveState();`);

      // 같은 이름·같은 숙소는 하나로, 이름이 다른 가까운 장소는 그대로 (병합 규칙 직접 확인)
      ok("핀 병합: 같은 숙소 출발·복귀·체크인은 1개", ev(`mergeMapPoints([
        { it:{ place:'🏨 호텔 아쿠아 펠리스 출발' }, ll:[35.1532,129.1180], num:'🏨', kind:'hotelStart' },
        { it:{ place:'호텔 아쿠아 펠리스 체크인' }, ll:[35.1532,129.1180], num:2 },
        { it:{ place:'🏨 호텔 아쿠아 펠리스 복귀' }, ll:[35.1532,129.1180], num:'🏨', kind:'hotelEnd' }
      ]).length`) === 1, ev("JSON.stringify(mergeMapPoints([{ it:{place:'호텔 A'}, ll:[35,129], num:1 },{ it:{place:'호텔 A 체크인'}, ll:[35,129], num:2 }]).length)"));
      ok("핀 병합: 같은 이름 반복은 1개", ev("mergeMapPoints([{ it:{place:'광안리 해변'}, ll:[35.1532,129.1187], num:1 },{ it:{place:'광안리  해변'}, ll:[35.1532,129.1187], num:2 }]).length") === 1, "");
      ok("핀 병합: 20m 안이라도 이름이 다르면 구분", ev("mergeMapPoints([{ it:{place:'광안리 해변'}, ll:[35.1532,129.1187], num:1 },{ it:{place:'민락회센터'}, ll:[35.1532,129.1189], num:2 },{ it:{place:'호텔 A'}, ll:[35.1600,129.1200], num:3 },{ it:{place:'호텔 B'}, ll:[35.1602,129.1200], num:4 }]).length") === 4, "");

      // 홈 지도 (1일차) — 5개 일정 중 같은 곳 1쌍 → 핀 4개, 동선은 5개 순서 그대로
      const homeProbe = ev(`(() => {
        const calls = { markers: [], lines: [] };
        const surface = { alive:true, hostEl:()=>null, containerPoint:()=>null, fromContainerPoint:()=>null,
          clearMarkers(){ calls.markers.length = 0; }, clearShapes(){},
          polyline(lls){ calls.lines.push(lls); },
          addMarker(m){ calls.markers.push({ num:m.num, popup:String(m.popup||""), ll:m.ll }); return { openPopup(){} }; } };
        const savedMap = homeMap, savedPts = homePts, savedMk = homeMarkers;
        homeMap = surface; homePts = homeGeoPts(); homeMarkers = {};
        let alias = false;
        try { drawHomePins(); alias = homeMarkers[3] && homeMarkers[4] && homeMarkers[3] === homeMarkers[4]; }
        finally { const out = { calls, alias, pts: homePts.map(p => p.ll) }; homeMap = savedMap; homePts = savedPts; homeMarkers = savedMk; return JSON.parse(JSON.stringify(out)); }
      })()`);
      ok("홈 지도: 같은 장소 핀 1개", homeProbe.calls.markers.length === 4,
        homeProbe.calls.markers.map(m => `${m.num}:${m.popup.replace(/<[^>]+>/g, " ")}`).join(" | "));
      ok("홈 지도: 합쳐진 핀 말풍선에 방문 횟수", homeProbe.calls.markers.some(m => /광안리 해변/.test(m.popup) && /3·4번 방문/.test(m.popup)),
        homeProbe.calls.markers.map(m => m.popup).join(" | "));
      ok("홈 지도: 가까운 다른 장소는 따로", homeProbe.calls.markers.some(m => /민락회센터/.test(m.popup)), "");
      ok("홈 지도: 동선은 5개 좌표 순서 그대로", homeProbe.calls.lines.length === 1 && homeProbe.calls.lines[0].length === 5
        && JSON.stringify(homeProbe.calls.lines[0]) === JSON.stringify(homeProbe.pts), JSON.stringify(homeProbe.calls.lines[0]));
      ok("홈 지도: 합쳐진 번호도 같은 핀을 가리킨다", homeProbe.alias, "");

      // 일정 지도 (1일차) — 숙소 복귀 핀 + 숙소 체크인 일정 + 광안리 2번 → 핀 4개, 동선 6개
      const dayProbe = ev(`(() => {
        const calls = { markers: [], lines: [] };
        const surface = { alive:true, hostEl:()=>null, containerPoint:()=>null, fromContainerPoint:()=>null,
          clearMarkers(){ calls.markers.length = 0; }, clearShapes(){},
          polyline(lls){ calls.lines.push(lls); },
          addMarker(m){ calls.markers.push({ num:m.num, popup:String(m.popup||"") }); return { openPopup(){} }; } };
        const savedMap = leafletMap;
        const pts = dayMapGeoPts(state.days[0]);
        leafletMap = surface;
        try { drawDayPins(pts); } finally { leafletMap = savedMap; }
        return JSON.parse(JSON.stringify({ calls, pts: pts.map(p => p.ll) }));
      })()`);
      ok("일정 지도: 숙소 자동 핀과 숙소 일정 카드가 1개", dayProbe.calls.markers.length === 4,
        dayProbe.calls.markers.map(m => `${m.num}:${m.popup.replace(/<[^>]+>/g, " ")}`).join(" | "));
      ok("일정 지도: 합쳐진 숙소 핀 말풍선", dayProbe.calls.markers.some(m => /호텔 아쿠아 펠리스/.test(m.popup) && /숙소 복귀/.test(m.popup)),
        dayProbe.calls.markers.map(m => m.popup).join(" | "));
      ok("일정 지도: 동선은 6개 좌표 순서 그대로", dayProbe.calls.lines.length === 1 && dayProbe.calls.lines[0].length === 6
        && JSON.stringify(dayProbe.calls.lines[0]) === JSON.stringify(dayProbe.pts), JSON.stringify(dayProbe.calls.lines[0]));

      // 일정 지도 (2일차) — 숙소 출발 + 숙소 복귀 + 감천마을 → 핀 2개
      const day2Probe = ev(`(() => {
        const calls = { markers: [], lines: [] };
        const surface = { alive:true, hostEl:()=>null, containerPoint:()=>null, fromContainerPoint:()=>null,
          clearMarkers(){ calls.markers.length = 0; }, clearShapes(){},
          polyline(lls){ calls.lines.push(lls); },
          addMarker(m){ calls.markers.push({ num:m.num, popup:String(m.popup||"") }); return { openPopup(){} }; } };
        const savedMap = leafletMap;
        const pts = dayMapGeoPts(state.days[1]);
        leafletMap = surface;
        try { drawDayPins(pts); } finally { leafletMap = savedMap; }
        return JSON.parse(JSON.stringify({ calls, pts: pts.map(p => p.ll) }));
      })()`);
      ok("일정 지도: 숙소 출발·복귀 핀 1개로", day2Probe.calls.markers.length === 2
        && day2Probe.calls.markers.some(m => /숙소 출발·복귀/.test(m.popup)),
        day2Probe.calls.markers.map(m => m.popup).join(" | "));
      ok("일정 지도: 2일차 동선 3개 좌표 유지", day2Probe.calls.lines.length === 1 && day2Probe.calls.lines[0].length === 3
        && JSON.stringify(day2Probe.calls.lines[0]) === JSON.stringify(day2Probe.pts), JSON.stringify(day2Probe.calls.lines[0]));

      // 큰 지도 (1일차) — 핀 4개, 스텝은 5개 그대로
      const bigProbe = ev(`(() => {
        const calls = { markers: [], lines: [] };
        const surface = { alive:true, hostEl:()=>null, containerPoint:()=>null, fromContainerPoint:()=>null,
          clearMarkers(){ calls.markers.length = 0; }, clearShapes(){},
          polyline(lls){ calls.lines.push(lls); },
          addMarker(m){ calls.markers.push({ num:m.num, popup:String(m.popup||"") }); return { openPopup(){} }; } };
        const savedMap = bigMap, savedPts = bigMapPts, savedMk = bigMapMarkers;
        bigMap = surface; bigMapPts = activeDayGeoPts();
        let marks = 0;
        try { drawBigPins(); marks = bigMapMarkers.length; } finally {
          const out = { calls, marks, steps: bigMapPts.length };
          bigMap = savedMap; bigMapPts = savedPts; bigMapMarkers = savedMk;
          return JSON.parse(JSON.stringify(out));
        }
      })()`);
      ok("큰 지도: 같은 장소 핀 1개", bigProbe.calls.markers.length === 4,
        bigProbe.calls.markers.map(m => `${m.num}:${m.popup.replace(/<[^>]+>/g, " ")}`).join(" | "));
      ok("큰 지도: 스텝(◀▶)·동선 순서는 5개 그대로", bigProbe.marks === 5 && bigProbe.steps === 5
        && bigProbe.calls.lines.length === 1 && bigProbe.calls.lines[0].length === 5, JSON.stringify({ marks: bigProbe.marks, steps: bigProbe.steps }));

      // 고객이 보는 실제 화면(renderTimeline 등)에서 숙소 연동 카드도 정상으로 그려진다
      w.renderTimeline();
      ok("지도 병합 후에도 일정 목록 정상", w.document.querySelectorAll("#timeline-list .card").length >= 5, "");
    }

    // 58) 🏨 예약 내역은 경비 탭 — 일정 카드는 일반 일정처럼 간단히
    {
      ev(`state.meta = { title:'예약 내역 탭 테스트', destination:'부산', startDate:'2027-05-01', endDate:'2027-05-02', travelers:2 };
        state.days = [{ day:1, label:'1일차', date:'2027-05-01', items:[{ id:'bx-1', time:'12:00', place:'부산역', lat:35.1157, lng:129.0403 }] }];
        state.bookings = [
          { id:'bx-h', type:'hotel', name:'호텔 아쿠아 펠리스', room:'디럭스 오션뷰 더블', inDate:'2027-05-01', outDate:'2027-05-02', inTime:'15:00', outTime:'11:00', price:211411, payStatus:'reserved', dueAmount:211411, dueDate:'2027-04-20', lat:35.1532, lng:129.1180 },
          { id:'bx-t', type:'transit', mode:'KTX', name:'KTX 101', from:'서울역', to:'부산역', depDate:'2027-05-01', depTime:'09:00', arrTime:'11:30', seat:'4호 12A', price:59800, payStatus:'paid' }
        ];
        state.expenses = []; currentDay = 1; saveState();`);
      w.renderTimeline();
      w.renderExpenses();

      const tlPanel = w.document.getElementById("tab-timeline");
      const expPanel = w.document.getElementById("tab-expenses");
      ok("예약 내역 섹션: 경비 탭에 있다", !!expPanel.querySelector("#bookings-section #bookings-card")
        && !tlPanel.querySelector("#bookings-section"), "");
      ok("경비 탭 예약 내역: 금액·결제 예정 그대로", /호텔 아쿠아 펠리스/.test(expPanel.textContent)
        && /211,411/.test(expPanel.textContent) && /결제 예정/.test(expPanel.textContent)
        && /KTX 101/.test(expPanel.textContent) && /59,800/.test(expPanel.textContent), "");
      ok("경비 탭 예약 내역: 숙소·교통편 추가 버튼", !!expPanel.querySelector("#bookings-section") 
        && /숙소 추가/.test(expPanel.querySelector("#bookings-section").textContent)
        && /교통편 추가/.test(expPanel.querySelector("#bookings-section").textContent), "");

      const vCards2 = [...w.document.querySelectorAll("#timeline-list .card.tl-virtual")];
      const vText = vCards2.map(c => c.textContent).join(" | ");
      ok("일정 탭 예약 연동 카드 생성", vCards2.length >= 2, `${vCards2.length}장`);
      ok("일정 카드에는 금액·결제 문구가 없다", vCards2.length > 0 && !/₩|결제 예정|결제 완료|211,411|59,800/.test(vText), vText.slice(0, 160));
      ok("일정 카드에는 객실·예약 상세가 없다", !/디럭스|오션뷰|211,411/.test(vText), vText.slice(0, 160));
      ok("일정 카드 구성은 일반 카드와 같다", vCards2.every(c => !!c.querySelector(".tl-place") && !!c.querySelector(".tl-memo")
        && c.querySelectorAll(".ph-slot").length === 1), "");
      ok("일정 카드: 지도 버튼은 그대로", vCards2.every(c => !c.querySelector(".tl-extra") || !!c.querySelector(".tl-extra .map-btn")), "");

      // 일정 연동은 그대로 — 숙소 자동 카드가 그날 맨 마지막에, 교통편이 출발일에
      ok("일정 연동 유지: 숙소 복귀·교통편 카드", vCards2.some(c => /숙소 복귀/.test(c.textContent))
        && vCards2.some(c => /서울역/.test(c.textContent) && /부산역/.test(c.textContent)), vText.slice(0, 200));
      ok("일정 연동 유지: 거점 자동 반영", (() => { w.ensureSavedPlaces(); return ev("JSON.stringify(state.savedPlaces.filter(p => p.auto).map(p => p.label))").includes("호텔 아쿠아 펠리스"); })(),
        ev("JSON.stringify((state.savedPlaces||[]).map(p => p.label))"));
      ok("일정 연동 유지: 숙소 좌표로 지도 핀", ev("JSON.stringify(dayMapGeoPts(state.days[0]).filter(p => p.kind && p.kind.indexOf('hotel') === 0))").includes("hotel")
        || ev("dayMapGeoPts(state.days[0]).some(p => p.num === '🏨')"), "");

      // 경비 탭에서 예약 금액이 총액에 잡히는지 (연동 그대로)
      ok("경비: 예약 금액이 총액에 들어간다", ev("getSyncedExpenses().filter(e => e.fromBooking).length") === 2,
        ev("JSON.stringify(getSyncedExpenses().filter(e => e.fromBooking).map(e => [e.name, e.amount]))"));
    }

    // 59) ⏱️ '이동' 카드는 접힌 상태(더보기 전)에서도 이동 시간이 보인다
    {
      ev(`state.meta = { title:'이동 시간 테스트', destination:'부산', startDate:'2027-06-01', endDate:'2027-06-02', travelers:2 };
        state.days = [{ day:1, date:'2027-06-01', label:'1일차', items: [
          { id:'mv-1', time:'09:00', place:'부산역', lat:35.1157, lng:129.0403, moveMode:'', moveMin:0, costTotal:0 },
          { id:'mv-2', time:'10:00', place:'부산역 → 광안리', fromPlace:'부산역', toPlace:'광안리', moveMode:'수영로 · 약 46분', moveMin:10, moveCost:1550, costTotal:1550 },
          { id:'mv-3', time:'11:00', place:'광안리 → 해운대', fromPlace:'광안리', toPlace:'해운대', moveMode:'해운대 2호선', moveMin:25, moveCost:1550, costTotal:1550 },
          { id:'mv-4', time:'12:00', place:'감천문화마을', lat:35.0975, lng:129.0106, moveMode:'도보 5분', moveMin:5, costTotal:0 }
        ] }];
        state.bookings = []; state.expenses = []; currentDay = 1; saveState();`);
      w.renderTimeline();
      const tlCards = [...w.document.querySelectorAll("#timeline-list .card")];
      const cardOf = (id) => tlCards.find(c => c.getAttribute("data-card-id") === id) || null;
      const cMv2 = cardOf("mv-2"), cMv3 = cardOf("mv-3"), cMv4 = cardOf("mv-4");
      const etaOf = (c) => (c && c.querySelector(".tl-eta") ? c.querySelector(".tl-eta").textContent.trim() : "");

      ok("이동 카드: 접힌 상태에서도 이동 시간 표시", !!cMv2 && !cMv2.classList.contains("tl-open")
        && /약 46분/.test(etaOf(cMv2)) && !cMv2.classList.contains("tl-open"), `opened=${cMv2 && cMv2.classList.contains("tl-open")} / ${etaOf(cMv2)}`);
      ok("이동 카드: 추천 루트 시간과 moveMin이 겹쳐도 한 번만", /약 46분/.test(etaOf(cMv2))
        && (etaOf(cMv2).match(/46\s*분/g) || []).length === 1 && !/10\s*분/.test(etaOf(cMv2)), etaOf(cMv2));
      ok("이동 카드: moveMin만 있어도 시간·수단 표시", /약 25분/.test(etaOf(cMv3)) && /해운대 2호선/.test(etaOf(cMv3)), etaOf(cMv3));
      ok("이동 카드: '⏱️ 이동시간 약 N분' — 이모티콘 옆에 이동시간이라고 밝힌다",
        /^⏱️ 이동시간 약 46분$/.test(etaOf(cMv2)) && /^⏱️ 이동시간 약 25분 · 해운대 2호선$/.test(etaOf(cMv3)),
        `${etaOf(cMv2)} | ${etaOf(cMv3)}`);
      ok("이동 카드: 체류 시간이 아니라 이동 시간임이 글자로 드러난다", /이동시간/.test(etaOf(cMv2)) && !/체류/.test(etaOf(cMv2)), etaOf(cMv2));
      ok("이동 카드 데이터는 그대로(펼친 상세 줄에 원래 이동수단)", (() => {
        const move = cMv2.querySelector(".tl-extra .tl-move");
        return !!move && /수영로 · 약 46분/.test(move.textContent) && ev("state.days[0].items[1].moveMode") === "수영로 · 약 46분";
      })(), cMv2.querySelector(".tl-extra .tl-move") && cMv2.querySelector(".tl-extra .tl-move").textContent);
      ok("일반 장소 카드에는 이동 시간 칩 없음·체류 문구도 없음", !!cMv4 && !cMv4.querySelector(".tl-eta")
        && !/체류/.test(cMv4.textContent) && !/약 5분/.test(cMv4.textContent), cMv4 && cMv4.textContent.replace(/\s+/g, " ").slice(0, 80));
      ok("이동 카드: 펼치면 상세 줄에 있으니 칩은 숨김(CSS)", /\.card\.tl-open \.tl-eta \{ display: none; \}/.test(html)
        && /\.tl-eta \{/.test(html), "");
      ok("이동 카드 판정: 출발·도착 또는 화살표 카드", ev("isMoveCardItem({ fromPlace:'A', toPlace:'B' })") === true
        && ev("isMoveCardItem({ place:'A → B' })") === true && ev("isMoveCardItem({ place:'감천문화마을' })") === false, "");
      ok("moveEtaText: 시간 없으면 빈 문자열", ev("moveEtaText({ fromPlace:'A', toPlace:'B', place:'A → B' })") === "",
        ev("moveEtaText({ fromPlace:'A', toPlace:'B', place:'A → B' })"));

      // 예약 연동 교통편 카드(경비 탭 예약 내역 기반)도 이동 카드라서 같은 자리에 시간이 보인다
      ev(`state.bookings = [{ id:'mv-bk', type:'transit', mode:'KTX', name:'KTX 25', from:'광명역', to:'부산역', depDate:'2027-06-01', depTime:'10:17', arrTime:'12:46', seat:'4호 12A', price:104400, payStatus:'paid' }]; saveState();`);
      w.renderTimeline();
      const vMove = [...w.document.querySelectorAll("#timeline-list .card.tl-virtual")].find(c => /광명역/.test(c.textContent));
      ok("예약 교통편 카드도 접힌 채로 이동 시간", !!vMove && !vMove.classList.contains("tl-open")
        && /⏱️ 이동시간 약 149분/.test(((vMove.querySelector(".tl-eta") || {}).textContent || "")), vMove && ((vMove.querySelector(".tl-eta") || {}).textContent || ""));

      ev("state.bookings = []; saveState();");
    }

    // 64) 🧭 일정과 일정 사이 구간 길찾기 커넥터 — 편집에서 고르고, 보기에서 작게
    {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const TRANSIT_STUB = {
        status: "OK",
        routes: [
          { properties: { type: "SUBWAY", totalTime: 1108, transfers: 0, fare: { value: 1550 } },
            steps: [{ properties: { type: "SUBWAY", guidance: "2호선 (홍대입구 > 을지로입구)" } }] },
          { properties: { type: "BUS", totalTime: 2301, transfers: 0, fare: { min: 0, max: 2500 } },
            steps: [{ properties: { type: "BUS", guidance: "간선 271외 3대 (홍대입구역(중) > 종로1가.종각역)" } }] },
          { properties: { type: "BUS_AND_SUBWAY", totalTime: 2298, transfers: 1, fare: { value: 1500 } },
            steps: [
              { properties: { type: "BUS", guidance: "간선 271외 8대 (홍대입구역(중) > 충정로역(중))" } },
              { properties: { type: "BUS", guidance: "간선 721외 4대 (충정로역(중) > 종로1가.종각역)" } }] }
        ]
      };
      const DAY = `[
        { id:'br-home', place:'집', lat:37.4586, lng:126.6425, badges:['직접 추가'] },
        { id:'br-move', place:'집 → 홍대입구역', fromPlace:'집', toPlace:'홍대입구역', fromLat:37.4586, fromLng:126.6425, toLat:37.5572, toLng:126.9236, lat:37.5572, lng:126.9236, moveMode:'지하철 · 약 40분', badges:['직접 추가'] },
        { id:'br-hong', place:'홍대입구 카페', lat:37.5572, lng:126.9236, badges:['직접 추가'] },
        { id:'br-city', place:'시청역', lat:37.5658, lng:126.9774, badges:['직접 추가'] },
        { id:'br-gwang', place:'광화문', lat:37.5759, lng:126.9769, badges:['직접 추가'] }
      ]`;
      const realFetch = w.fetch;
      const transitCalls = [];
      w.fetch = (url, opt) => {
        if (String(url).includes("kakao-transit")) {
          transitCalls.push(JSON.parse((opt && opt.body) || "{}"));
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(JSON.stringify(TRANSIT_STUB))) });
        }
        return Promise.reject(new Error("offline-test"));
      };
      ev(`currentDay = 1; editMode = false;
        state.meta = { title:'구간', destination:'서울', startDate:'2027-03-06', endDate:'2027-03-07', travelers:2, tripType:'domestic', country:'대한민국' };
        state.days = [{ day:1, label:'1일차', date:'2027-03-06', items: ${DAY} }];
        state.bookings = []; state.expenses = []; PM_TRANSIT_CACHE.clear(); editMode = true; saveState();`);
      const list = () => w.document.getElementById("timeline-list");
      const brBtns = () => [...list().querySelectorAll(".tl-br-edit .tl-br-btn")];

      // (1) 편집 모드에서만 구간 버튼이 생긴다 — 위치가 다른 두 일정 사이
      ok("구간 길찾기: 편집 모드에 두 일정 사이 버튼", brBtns().length === 3 && brBtns().every(b => /─── 🧭 길찾기 ───/.test(b.textContent)), brBtns().map(b => b.getAttribute("title")).join(" | "));
      ok("구간 길찾기: 같은 곳끼리는 버튼 없음", !brBtns().some(b => /홍대입구역 → 홍대입구역/.test(b.getAttribute("title") || "")) && !brBtns().some(b => /집 → 집/.test(b.getAttribute("title") || "")), brBtns().map(b => b.getAttribute("title")).join(" | "));
      ev("editMode = false; renderTimeline();");
      ok("구간 길찾기: 보기 모드에서는 버튼이 절대 안 보인다", list().querySelectorAll(".tl-br-edit").length === 0 && list().querySelectorAll(".tl-br").length === 0, String(list().querySelectorAll(".tl-br").length));
      ev("editMode = true; renderTimeline();");

      // (2) 앞이 '이동(A→B)' 이면 B 가 출발지, 뒤가 '이동' 이면 그 출발지가 도착지
      const ep1 = JSON.parse(ev(`JSON.stringify({ from: betweenEndpointOf(state.days[0].items[1], 'to'), to: betweenEndpointOf(state.days[0].items[3], 'from') })`));
      ok("구간 출발지: 앞 '이동'의 목적지(B)", ep1.from.name === "홍대입구역" && ep1.from.lat === 37.5572 && ep1.from.lng === 126.9236, JSON.stringify(ep1.from));
      ok("구간 도착지: 뒤 일정 장소(C)", ep1.to.name === "시청역" && ep1.to.lat === 37.5658, JSON.stringify(ep1.to));
      const ep2 = JSON.parse(ev("JSON.stringify(betweenEndpointOf(state.days[0].items[1], 'from'))"));
      ok("구간 도착지: 뒤가 '이동'이면 그 출발지", ep2.name === "집" && ep2.lat === 37.4586, JSON.stringify(ep2));

      // (3) 버튼을 누르면 그 구간 그대로 3개 루트
      const targetBtn = brBtns().find(b => /^홍대입구 카페 → 시청역/.test(b.getAttribute("title") || ""));
      targetBtn.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
      await wait(260);
      const modal = () => w.document.getElementById("between-route-modal");
      ok("구간 길찾기: 전용 모달이 열린다", modal().classList.contains("open"), modal().className);
      ok("구간 길찾기: 출발→도착이 자동으로 잡힌다", /홍대입구 카페[\s\S]*→[\s\S]*시청역/.test(w.document.getElementById("br-endpoints").textContent), w.document.getElementById("br-endpoints").textContent.replace(/\s+/g, " "));
      const cards = () => [...w.document.querySelectorAll("#br-box .pm-tr-card")];
      ok("구간 길찾기: 카카오 프록시 루트 3개", cards().length === 3, String(cards().length));
      ok("구간 길찾기: 요청 좌표가 두 일정 끝점", transitCalls.length === 1 && transitCalls[0].start_x === 126.9236 && transitCalls[0].start_y === 37.5572 && transitCalls[0].end_x === 126.9774 && transitCalls[0].end_y === 37.5658, JSON.stringify(transitCalls[0] || {}));
      ok("구간 길찾기: 1순위 = 빠른 도착", /빠른 도착/.test(cards()[0].textContent) && /약 18분/.test(cards()[0].textContent), cards()[0].textContent.replace(/\s+/g, " "));

      // (4) 루트 하나를 딱 고르면 저장하고 닫힌다
      cards()[0].dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
      await wait(60);
      const stored = JSON.parse(ev("JSON.stringify((state.days[0].betweenRoutes||{})['br-hong__br-city']||null)"));
      ok("구간 저장: 앞__뒤 키로 저장", !!stored && stored.minutes === 18 && stored.farePer === 1550 && stored.legs === "2호선 (홍대입구 > 을지로입구)", JSON.stringify(stored));
      ok("구간 저장: 고르고 나면 모달이 닫힌다", !modal().classList.contains("open"), modal().className);
      ok("구간 저장: localStorage 상태에도 남는다", /betweenRoutes/.test(String(w.localStorage.getItem(ev("getLocalKey()")) || "")) && /br-hong__br-city/.test(String(w.localStorage.getItem(ev("getLocalKey()")) || "")), "");
      const setRows = [...list().querySelectorAll(".tl-br-set")];
      ok("편집 모드: 고른 구간은 '약 18분 · 변경' + 지우기", setRows.length === 1 && /약 18분 · 변경/.test(setRows[0].textContent) && !!setRows[0].querySelector(".tl-br-clear"), setRows.map(r => r.textContent.trim().replace(/\s+/g, " ")).join(" | "));

      // (5) 보기 모드 — 작은 화살표만, 누르면 요금·이동수단 펼침
      ev("editMode = false; renderTimeline();");
      const views = [...list().querySelectorAll(".tl-br-view")];
      ok("보기 모드: 구간이 작은 화살표 하나로", views.length === 1 && /↓ 약 18분/.test(views[0].querySelector(".tl-br-arrow").textContent), views.map(v => v.textContent.trim().replace(/\s+/g, " ")).join(" | "));
      ok("보기 모드: 화살표 줄에는 가격이 안 보인다(접힘)", views[0].querySelector(".tl-br-detail").style.display === "none" && views[0].querySelector(".tl-br-arrow").getAttribute("aria-expanded") === "false", views[0].querySelector(".tl-br-arrow").getAttribute("aria-expanded"));
      const cssRule = (sel) => {
        const pat = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}";
        const m = html.match(new RegExp(pat));
        return m ? m[1] : "";
      };
      const brViewCss = cssRule(".tl-br-view");
      ok("보기 모드: 화살표·이동시간 줄은 가운데 정렬(CSS)", /flex-direction:\s*column/.test(brViewCss) && /align-items:\s*center/.test(brViewCss)
        && /justify-content:\s*center/.test(brViewCss) && /text-align:\s*center/.test(brViewCss) && !/margin:[^;]*14px/.test(brViewCss), brViewCss);
      const brDetailCss = cssRule(".tl-br-detail");
      ok("보기 모드: 펼친 상세 박스도 가운데·카드 폭 안", /max-width:[^;]*100%/.test(brDetailCss) && /text-align:\s*center/.test(brDetailCss)
        && /margin:[^;]*auto/.test(brDetailCss), brDetailCss);
      const brEditCss = cssRule(".tl-br-edit");
      const brBaseCss = cssRule(".tl-br");
      ok("편집 모드 '─── 길찾기 ───' 버튼도 가운데 정렬", /display:\s*flex/.test(brBaseCss) && /align-items:\s*center/.test(brBaseCss)
        && /justify-content:\s*center/.test(brBaseCss) && !/align-items|justify-content/.test(brEditCss), `${brBaseCss} / ${brEditCss}`);
      views[0].querySelector(".tl-br-arrow").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
      const dtxt = views[0].querySelector(".tl-br-detail").textContent.replace(/\s+/g, " ");
      ok("보기 모드: 화살표 클릭 → 요금(1인·인원수)·자세한 이동수단", views[0].querySelector(".tl-br-detail").style.display === "block"
        && /1인 1,550원 · 2명 3,100원/.test(dtxt) && /2호선 \(홍대입구 > 을지로입구\) · 직통/.test(dtxt), dtxt);
      views[0].querySelector(".tl-br-arrow").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
      ok("보기 모드: 다시 누르면 접힌다", views[0].querySelector(".tl-br-detail").style.display === "none", views[0].querySelector(".tl-br-arrow").getAttribute("aria-expanded"));

      // (6) 경비 탭 — 구간 요금이 1인×인원수로 들어가고 기본은 제외(토글 가능)
      const brExp = () => JSON.parse(ev("JSON.stringify(getSyncedExpenses().filter(e => String(e.id).indexOf('tl_br_') === 0))"));
      const e0 = brExp()[0];
      ok("경비: 구간 요금이 교통 항목으로 잡힌다", brExp().length === 1 && e0.amount === 3100 && e0.category === "교통" && /홍대입구 카페 → 시청역/.test(e0.name), JSON.stringify(e0));
      ok("경비: 대중교통 요금이라 기본 제외", e0.transit === true && e0.included === false, JSON.stringify({ transit: e0.transit, included: e0.included }));
      w.toggleExpenseInclude(e0.id);
      ok("경비: '경비에 포함'으로 바로 토글", brExp()[0].included === true, String(brExp()[0].included));
      w.toggleExpenseInclude(e0.id);

      // (7) 메모를 사이에 둬도 이어지고, 커넥터는 다음 일정 바로 위에 붙는다
      ev(`state.days[0].items = [
        { id:'br-memo-a', place:'집', lat:37.4586, lng:126.6425 },
        { id:'br-memo-m', kind:'memo', place:'메모', memo:'중간 메모' },
        { id:'br-memo-b', place:'시청역', lat:37.5658, lng:126.9774 }
      ]; editMode = true; saveState();`);
      const memoRowIdx = [...list().children].findIndex(r => r.classList.contains("tl-edit-memo"));
      const brRowIdx = [...list().children].findIndex(r => r.classList.contains("tl-br"));
      ok("구간: 메모는 건너뛰고 두 일정을 잇는다", brBtns().length === 1 && brRowIdx === memoRowIdx + 1, `memo=${memoRowIdx} / br=${brRowIdx}`);

      // (8) 순서가 바뀌어 인접하지 않게 되면 표시·경비에서 사라진다
      ev(`state.days[0].items = ${DAY};
        state.days[0].betweenRoutes = { 'br-hong__br-city': { minutes:18, farePer:1550, legs:'2호선 (홍대입구 > 을지로입구)', transfers:0, type:'SUBWAY', mode:'2호선 · 약 18분', from:{name:'홍대입구 카페'}, to:{name:'시청역'} } };
        state.days[0].items = [state.days[0].items[0], state.days[0].items[1], state.days[0].items[3], state.days[0].items[2], state.days[0].items[4]];
        editMode = false; saveState();`);
      ok("구간: 순서가 바뀌면 보기 모드에서 사라진다", list().querySelectorAll(".tl-br-view").length === 0, String(list().querySelectorAll(".tl-br-view").length));
      ok("구간: 인접하지 않은 구간 요금은 경비에도 없다", brExp().length === 0, JSON.stringify(brExp()));
      ev("editMode = true; renderTimeline();");
      ok("구간: 순서가 바뀌면 편집 모드에서도 '변경' 표시가 없다", list().querySelectorAll(".tl-br-set").length === 0, String(list().querySelectorAll(".tl-br-set").length));

      // (9) 편집 모드 ✕ 로 지우기
      ev(`state.days[0].items = ${DAY};
        state.days[0].betweenRoutes = { 'br-hong__br-city': { minutes:18, farePer:1550, legs:'2호선 (홍대입구 > 을지로입구)', transfers:0, type:'SUBWAY', mode:'2호선 · 약 18분', from:{name:'홍대입구 카페'}, to:{name:'시청역'} } }; editMode = true; saveState();`);
      const clearBtn = list().querySelector(".tl-br-set .tl-br-clear");
      ok("구간: 편집 모드에 지우기(✕) 버튼", !!clearBtn, "");
      clearBtn.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
      await wait(40);
      ok("구간: 지우면 기록도 사라진다", list().querySelectorAll(".tl-br-set").length === 0 && !ev("state.days[0].betweenRoutes"), String(ev("JSON.stringify(state.days[0].betweenRoutes||null)")));

      // (10) '이동(A→B) → 일정(C)' 흐름을 그대로 — 저장하면 B→C 로 조회·저장
      ev(`state.days[0].items = [state.days[0].items[1], state.days[0].items[3]]; editMode = true; saveState();`);
      const callsBefore = transitCalls.length;
      ev("PM_TRANSIT_CACHE.clear()");
      w.openBetweenRouteModal("br-move", "br-city");
      await wait(280);
      const lastCall = transitCalls[transitCalls.length - 1] || {};
      ok("'이동→일정': 모달이 이동의 목적지(B)에서 출발", transitCalls.length > callsBefore && lastCall.s_name === "홍대입구역" && lastCall.e_name === "시청역" && lastCall.start_x === 126.9236, JSON.stringify(lastCall));
      cards()[1].dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
      await wait(40);
      ok("'이동→일정': 그 구간으로 저장", !!JSON.parse(ev("JSON.stringify((state.days[0].betweenRoutes||{})['br-move__br-city']||null)")), ev("JSON.stringify(Object.keys(state.days[0].betweenRoutes||{}))"));
      ev("editMode = false; renderTimeline();");
      const mvView = list().querySelector(".tl-br-view");
      ok("'이동→일정': 보기 모드에 '↓ 약 38분'", !!mvView && /↓ 약 38분/.test(mvView.textContent), mvView && mvView.textContent.replace(/\s+/g, " "));
      mvView.querySelector(".tl-br-arrow").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
      ok("'이동→일정': 펼치면 1인 2,500원(최대)·버스 노선", /1인 2,500원/.test(mvView.querySelector(".tl-br-detail").textContent) && /간선 271 \(홍대입구역 > 종로1가\.종각역\) · 직통/.test(mvView.querySelector(".tl-br-detail").textContent), mvView.querySelector(".tl-br-detail").textContent.replace(/\s+/g, " "));

      // (11) '이동' 카드를 저장할 때 출발·도착 좌표도 함께 남긴다 (다음 구간 길찾기에 쓰임)
      ev(`currentDay = 1; editMode = false;
        state.days[0].items = [{ id:'br-newmove', place:'', time:'', fromPlace:'', toPlace:'', moveMode:'', moveCost:0, costTotal:0, badges:['직접 추가'] }]; saveState();`);
      w.openPlaceModal("br-newmove");
      w.setPlaceMode("route");
      w.document.getElementById("pm-from").value = "집";
      w.document.getElementById("pm-to").value = "시청역";
      w.setRouteEndpointCoord("from", { lat: 37.4586, lng: 126.6425, name: "집" });
      w.setRouteEndpointCoord("to", { lat: 37.5658, lng: 126.9774, name: "시청역" });
      await wait(320);
      await w.savePlaceEdit();
      const savedMove = JSON.parse(ev("JSON.stringify(state.days[0].items[0])"));
      ok("'이동' 저장: 출발·도착 좌표도 함께 저장", savedMove.fromLat === 37.4586 && savedMove.fromLng === 126.6425 && savedMove.toLat === 37.5658 && savedMove.toLng === 126.9774, JSON.stringify({ from: [savedMove.fromLat, savedMove.fromLng], to: [savedMove.toLat, savedMove.toLng] }));

      // (12) 해외 일정은 카카오 대중교통을 부르지 않는다
      ev(`state.meta.tripType = 'overseas'; state.meta.country='JP'; state.meta.destination='도쿄';
        state.days[0].items = [
          { id:'br-os-a', place:'도쿄역', lat:35.6812, lng:139.7671 },
          { id:'br-os-b', place:'시부야', lat:35.6595, lng:139.7005 }
        ]; editMode = true; saveState();`);
      const beforeOverseas = transitCalls.length;
      w.openBetweenRouteModal("br-os-a", "br-os-b");
      await wait(200);
      ok("구간: 해외 일정은 카카오 미호출 + 안내", transitCalls.length === beforeOverseas && /해외 일정은/.test(w.document.getElementById("br-box").textContent) && !w.document.querySelector("#br-box .pm-tr-card"), w.document.getElementById("br-box").textContent.replace(/\s+/g, " "));
      w.closeBetweenRouteModal();

      // (13) 좌표가 없어도 저장 거점·일정 장소에서 찾고, 없으면 지오코딩한다
      ev(`state.meta = { title:'', destination:'서울', startDate:'2027-03-06', endDate:'2027-03-07', travelers:2, tripType:'domestic', country:'대한민국' };
        state.days[0].items = [
          { id:'br-nocoord-a', place:'집' },
          { id:'br-nocoord-b', place:'시청역' }
        ];
        state.savedPlaces = [{ id:'sp-home', kind:'home', label:'집', address:'인천 미추홀구', lat:37.4586, lng:126.6425 }];
        state.bookings = []; PM_TRANSIT_CACHE.clear(); saveState();`);
      const ep3 = JSON.parse(ev(`JSON.stringify({ a: betweenEndpointOf(state.days[0].items[0], 'to'), b: betweenEndpointOf(state.days[0].items[1], 'from') })`));
      ok("구간: 좌표가 없어도 저장 거점 이름으로 찾는다", ep3.a.name === "집" && ep3.a.lat === 37.4586 && ep3.a.lng === 126.6425, JSON.stringify(ep3.a));
      ok("구간: 모르는 이름은 좌표 없음(지오코딩으로 넘긴다)", ep3.b.name === "시청역" && ep3.b.lat == null, JSON.stringify(ep3.b));
      const realGeo = w.geocodeByName;
      const geoAsked = [];
      w.geocodeByName = async (q) => { geoAsked.push(String(q)); return String(q).includes("시청") ? { lat: 37.5658, lng: 126.9774 } : null; };
      const callsBeforeGeo = transitCalls.length;
      w.openBetweenRouteModal("br-nocoord-a", "br-nocoord-b");
      await wait(260);
      const geoCall = transitCalls[transitCalls.length - 1] || {};
      ok("구간: 위치를 모르면 지오코딩해 루트를 찾는다", transitCalls.length === callsBeforeGeo + 1 && geoAsked.includes("시청역") && geoCall.end_x === 126.9774 && geoCall.end_y === 37.5658, `${JSON.stringify(geoAsked)} / ${JSON.stringify(geoCall)}`);
      w.closeBetweenRouteModal();
      w.geocodeByName = realGeo;

      w.fetch = realFetch;
      ev(`state.meta = { title:'', destination:'', startDate:'', endDate:'', travelers:2, tripType:'domestic', country:'대한민국' };
        state.days = [{ day:1, label:'1일차', date:'2027-03-06', items: [] }];
        state.bookings = []; state.savedPlaces = []; state.expenses = []; editMode = false; PM_TRANSIT_CACHE.clear(); saveState();`);
    }

    // 65) 🍽️ 메뉴판 불러오기 모달 — '네이버 지도' 안내 문구가 남아 있지 않다
    {
      const menuModal = w.document.getElementById("menu-modal");
      const bulk = w.document.getElementById("menu-bulk-text");
      const modalCopy = [menuModal.textContent]
        .concat([...menuModal.querySelectorAll("[placeholder],[title],[aria-label]")].map(el =>
          [el.getAttribute("placeholder"), el.getAttribute("title"), el.getAttribute("aria-label")].filter(Boolean).join(" ")))
        .join(" ");
      ok("메뉴 모달: '네이버 지도' 안내 문구 없음", !/네이버/.test(modalCopy), (modalCopy.match(/.{0,15}네이버.{0,15}/) || [""])[0]);
      ok("메뉴 모달: 안내가 특정 지도 앱을 말하지 않는다", /메뉴판 텍스트 붙여넣기/.test(bulk.placeholder) && !/지도/.test(bulk.placeholder), bulk.placeholder);

      // 문구만 바꾸고 붙여넣기 기능은 그대로 동작한다
      ev(`state.meta = { title:'메뉴', destination:'부산', startDate:'2027-03-06', endDate:'2027-03-07', travelers:2, tripType:'domestic', country:'대한민국' };
        state.days = [{ day:1, label:'1일차', date:'2027-03-06', items: [{ id:'mm-1', place:'카페', badges:['직접 추가'], menus: [] }] }];
        currentDay = 1; editMode = false; renderTimeline(); openMenuModal('mm-1');`);
      ok("메뉴 모달: 메뉴 있는 식당·카페에서 열린다", menuModal.classList.contains("open"), menuModal.className);
      bulk.value = "아메리카노 5,500원\n카페라떼 6,000원";
      ev("applyBulkMenuText()");
      const draft = JSON.parse(ev("JSON.stringify(draftMenus)"));
      ok("메뉴 모달: 붙여넣은 텍스트로 일괄 추가가 그대로 동작", draft.length === 2 && draft[0].name === "아메리카노" && draft[0].price === 5500 && draft[1].name === "카페라떼" && draft[1].price === 6000, JSON.stringify(draft));
      ok("메뉴 모달: 추가 후 입력창이 비워진다", bulk.value === "", bulk.value);
      ok("메뉴 모달: 화면에 추가된 메뉴가 보인다", /아메리카노/.test(w.document.getElementById("menu-modal-list").textContent), w.document.getElementById("menu-modal-list").textContent.replace(/\s+/g, " "));
      w.closeMenuModal();
      ev(`state.days = [{ day:1, label:'1일차', date:'2027-03-06', items: [] }]; state.bookings = []; state.expenses = []; saveState();`);
    }

    // 66) 🌏 해외 여행 지도·길찾기 = 구글 지도 / 국내 여행 = 카카오맵 그대로 + 홈 탭 '직접추가' 꼬리표 제거
    {
      const setMapTrip = (overseas) => ev(`state.meta = { title:'지도 링크', destination:'${overseas ? "시드니" : "부산"}', startDate:'2027-03-06', endDate:'2027-03-07', travelers:2, tripType:'${overseas ? "overseas" : "domestic"}', country:'${overseas ? "호주" : "대한민국"}' };
        state.days = [{ day:1, label:'1일차', date:'2027-03-06', items: [
          { id:'gl-a', place:'시드니 오페라하우스', stay:'체류 60분', moveMode:'도보', badges:['예매 필수'], lat:-33.8568, lng:151.2153, mapUrl:'https://map.naver.com/p/search/Sydney%20Opera%20House' },
          { id:'gl-b', place:'서클러키 → 맨리', fromPlace:'서클러키 선창장', toPlace:'맨리 선창장', fromLat:-33.8577, fromLng:151.2108, toLat:-33.7969, toLng:151.2840, lat:-33.8577, lng:151.2108, moveMode:'페리 F1', routeUrl:'https://map.naver.com/p/directions/151.210800,-33.857700/Sydney%20Ferries/-/transit', mapUrl:'https://map.naver.com/p/search/Manly%20Wharf' }
        ] }];
        state.bookings = []; state.savedPlaces = []; currentDay = 1; editMode = false; saveState();`);
      const itemA = "state.days[0].items[0]", itemB = "state.days[0].items[1]";

      // (1) 해외 — 지도 열기·검색
      setMapTrip(true);
      ok("해외: 지도 버튼 라벨이 '구글 지도'", ev("mapSearchLabel()") === "🗺️ 구글 지도", ev("mapSearchLabel()"));
      const osSearch = String(ev("mapSearchUrl('시드니 오페라하우스', -33.8568, 151.2153)"));
      ok("해외: 좌표가 있으면 구글 지도 좌표 핀", osSearch === "https://www.google.com/maps/search/?api=1&query=-33.8568,151.2153", osSearch);
      const osSearchName = String(ev("mapSearchUrl('시드니 오페라하우스')"));
      ok("해외: 좌표가 없으면 장소명으로 구글 검색", osSearchName === "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent("시드니 오페라하우스"), osSearchName);
      const osItemMap = String(ev(`itemMapUrl(${itemA})`));
      ok("해외: 저장된 네이버 지도 링크는 구글 지도로 바뀐다", osItemMap === "https://www.google.com/maps/search/?api=1&query=-33.8568,151.2153" && !/naver/.test(osItemMap), osItemMap);
      const osMoveMap = String(ev(`itemMapUrl(${itemB})`));
      ok("해외: '이동' 카드 지도는 도착지(toLat·Lng) 좌표", /query=-33\.7969,151\.284/.test(osMoveMap) && !/naver/.test(osMoveMap), osMoveMap);
      ok("해외: 공식 예약 사이트 링크는 그대로 둔다", ev(`itemMapUrl({ place:'블루라인파크', mapUrl:'https://www.bluelinepark.com/' })`) === "https://www.bluelinepark.com/", ev(`itemMapUrl({ place:'블루라인파크', mapUrl:'https://www.bluelinepark.com/' })`));

      // (2) 해외 — 길찾기
      const osRoute = String(ev(`itemRouteUrl(${itemB})`));
      ok("해외: 저장된 네이버 길찾기 링크는 구글 길찾기로", /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&/.test(osRoute)
        && /origin=-33\.8577,151\.2108/.test(osRoute) && /destination=-33\.7969,151\.284/.test(osRoute) && /travelmode=transit/.test(osRoute), osRoute);
      const osWalk = String(ev("mapRouteUrl({name:'호텔', lat:-33.8614, lng:151.2108}, {name:'오페라하우스', lat:-33.8568, lng:151.2153}, '도보')"));
      const osTaxi = String(ev("mapRouteUrl({name:'호텔', lat:-33.8614, lng:151.2108}, {name:'오페라하우스', lat:-33.8568, lng:151.2153}, '택시')"));
      ok("해외: 이동수단이 구글 travelmode로 (도보=walking·택시=driving)", /travelmode=walking/.test(osWalk) && /travelmode=driving/.test(osTaxi), `${osWalk} / ${osTaxi}`);
      const osNameRoute = String(ev("mapRouteUrl({name:'센트럴역'}, {name:'오페라하우스'}, '대중교통')"));
      ok("해외: 좌표 없는 지점은 장소명으로 길찾기", osNameRoute.indexOf("origin=" + encodeURIComponent("센트럴역")) > 0
        && osNameRoute.indexOf("destination=" + encodeURIComponent("오페라하우스")) > 0, osNameRoute);

      w.openTransitModal();
      w.document.getElementById("tr-from").value = "센트럴역";
      w.document.getElementById("tr-to").value = "오페라하우스";
      ev("trFromCoord = { lat:-33.8830, lng:151.2070, name:'센트럴역' }; trToCoord = { lat:-33.8568, lng:151.2153, name:'오페라하우스' }; updateTransitDirLink();");
      const trBtnOs = w.document.getElementById("tr-naver-dir");
      ok("해외: 교통편 모달 길찾기 버튼이 '구글'", /구글 길찾기/.test(trBtnOs.textContent) && /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&/.test(trBtnOs.href)
        && /destination=-33\.8568,151\.2153/.test(trBtnOs.href), `${trBtnOs.textContent} ${trBtnOs.href}`);
      w.closeTransitModal();

      // (3) 홈 탭 — 일정마다 붙던 '직접추가' 꼬리표가 없다 (예전 저장 데이터도 포함)
      ev(`${itemA}.memo = ''; ${itemA}.badges = ['직접 추가', '예매 필수']; renderHome();`);
      const osHomeTxt = w.document.getElementById("home-sheet-body").textContent;
      ok("홈 탭: '직접추가' 꼬리표 없음", !/직접\s*추가/.test(osHomeTxt) && /예매 필수/.test(osHomeTxt), osHomeTxt.replace(/\s+/g, " ").slice(0, 90));

      // (4) 새 일정·교통편에도 '직접 추가' 배지를 붙이지 않는다
      w.openPlaceModal(null);
      w.document.getElementById("pm-place").value = "오페라하우스";
      w.document.getElementById("pm-time").value = "10:00";
      await w.savePlaceEdit();
      const newItem = JSON.parse(ev("JSON.stringify(state.days[0].items[state.days[0].items.length - 1] || null)"));
      ok("새 일정 추가: '직접 추가' 배지 없음", !!newItem && newItem.place === "오페라하우스" && !(newItem.badges || []).some(b => /직접\s*추가/.test(String(b))),
        JSON.stringify(newItem && newItem.badges));
      ok("새 일정·교통편 생성 코드에 '직접 추가' 없음", !/badges:\s*\["직접 추가"\]/.test(html) && !/\[type, "직접 추가"\]/.test(html), "");

      // (5) 국내 회귀 — 카카오맵 링크·라벨 그대로, 구글 지도는 쓰지 않는다
      setMapTrip(false);
      ok("국내: 지도 버튼 라벨이 '카카오맵'", ev("mapSearchLabel()") === "🗺️ 카카오맵", ev("mapSearchLabel()"));
      const krSearch = String(ev("mapSearchUrl('광안리 해변', 35.1533, 129.1186)"));
      ok("국내: 좌표가 있으면 카카오맵 장소 링크", /^https:\/\/map\.kakao\.com\/link\/map\//.test(krSearch) && !/google/.test(krSearch), krSearch);
      const krItemMap = String(ev(`itemMapUrl(${itemA})`));
      const krItemRoute = String(ev(`itemRouteUrl(${itemB})`));
      ok("국내: 일정 지도·길찾기는 카카오맵", /^https:\/\/map\.kakao\.com\//.test(krItemMap) && /^https:\/\/map\.kakao\.com\//.test(krItemRoute) && !/google/.test(krItemMap + krItemRoute), `${krItemMap} / ${krItemRoute}`);
      w.openTransitModal();
      w.document.getElementById("tr-from").value = "부산역";
      w.document.getElementById("tr-to").value = "광안역";
      ev("trFromCoord = { lat:35.1152, lng:129.0422, name:'부산역' }; trToCoord = { lat:35.1520, lng:129.1180, name:'광안역' }; updateTransitDirLink();");
      const trBtnKr = w.document.getElementById("tr-naver-dir");
      ok("국내: 교통편 모달 길찾기 버튼은 카카오맵", /카카오맵 길찾기/.test(trBtnKr.textContent) && /^https:\/\/map\.kakao\.com\//.test(trBtnKr.href), `${trBtnKr.textContent} ${trBtnKr.href}`);
      w.closeTransitModal();
      ev(`state.meta = { title:'', destination:'', startDate:'', endDate:'', travelers:2, tripType:'domestic', country:'대한민국' };
        state.days = [{ day:1, label:'1일차', date:'2027-03-06', items: [] }];
        state.bookings = []; state.savedPlaces = []; editMode = false; saveState();`);
    }

    // 67) 🍽️ 메뉴 모달 — 받은 입력·OCR 상태가 다음 가게로 넘어가지 않고, 메뉴판 사진은 여러 장을 순서대로 읽는다
    {
      ev(`state.meta = { title:'메뉴', destination:'부산', startDate:'2027-03-06', endDate:'2027-03-07', travelers:2, tripType:'domestic', country:'대한민국' };
        state.days = [{ day:1, label:'1일차', date:'2027-03-06', items: [
          { id:'mn-food', place:'칼국수집', badges:[], menus:[{ name:'칼국수', price:9000, qty:0 }] },
          { id:'mn-cafe', place:'카페', badges:[], menus:[{ name:'아메리카노', price:5500, qty:0 }] }
        ] }];
        currentDay = 1; editMode = false; saveState();`);
      const bulk = w.document.getElementById("menu-bulk-text");
      const status = w.document.getElementById("menu-ocr-status");
      const nameIn = w.document.getElementById("menu-custom-name");
      const priceIn = w.document.getElementById("menu-custom-price");
      w.openMenuModal("mn-food");
      bulk.value = "칼국수 9,000원\n만두 6,000원";
      status.textContent = "✓ 2개 메뉴를 추가했습니다!";
      nameIn.value = "공기밥";
      priceIn.value = "1000";
      w.closeMenuModal();
      w.openMenuModal("mn-cafe");
      ok("메뉴 모달: 다른 가게로 열면 이전 텍스트·상태가 비워진다", bulk.value === "" && status.textContent === "" && nameIn.value === "" && priceIn.value === "",
        `text="${bulk.value}" status="${status.textContent}" name="${nameIn.value}" price="${priceIn.value}"`);
      ok("메뉴 모달: 메뉴 목록은 그 가게 메뉴로 새로 시작", ev("draftMenus.map(m=>m.name).join(',')") === "아메리카노", ev("draftMenus.map(m=>m.name).join(',')"));
      const fileIn = w.document.getElementById("menu-ocr-file");
      const fileTag = html.slice(html.indexOf('id="menu-ocr-file"'), html.indexOf('id="menu-ocr-file"') + 200);
      ok("메뉴판 사진: 여러 장 선택 가능(multiple)", fileIn.multiple === true && /multiple/.test(fileTag), fileTag);
      const realTesseract = w.Tesseract;
      const seen = [];
      w.Tesseract = { recognize: (file) => { seen.push(file.name); return Promise.resolve({ data: { text: file.text } }); } };
      await w.handleMenuImageFiles([
        { name: "menu-1.png", text: "아메리카노 5,500원\n카페라떼 6,000원" },
        { name: "menu-2.png", text: "치즈케이크 7,500원" }
      ]);
      ok("메뉴판 사진: 여러 장을 순서대로 읽는다", seen.join(",") === "menu-1.png,menu-2.png", seen.join(","));
      ok("메뉴판 사진: 모든 장의 텍스트를 합친다", /아메리카노/.test(bulk.value) && /치즈케이크/.test(bulk.value) && bulk.value.split("\n").length >= 3, JSON.stringify(bulk.value));
      ok("메뉴판 사진: 모든 장에서 메뉴를 더한다", ev("draftMenus.map(m=>m.name).join(',')") === "아메리카노,카페라떼,치즈케이크", ev("draftMenus.map(m=>m.name).join(',')"));
      ok("메뉴판 사진: 진행 상태에 장수를 보여 준다", /2장/.test(status.textContent), status.textContent);
      w.Tesseract = realTesseract;
      w.closeMenuModal();
      ev(`state.days = [{ day:1, label:'1일차', date:'2027-03-06', items: [] }]; state.bookings = []; state.expenses = []; saveState();`);
    }

    // 68) 📸 메뉴판 OCR — 전처리(헤더·사진 칸 크롭·업스케일) · 대표 메뉴명 추출 · '가격 변동'은 '-'
    {
      // 실제 첨부 스크린샷(보통공원 망원)과 같은 OCR 결과
      const OCR_SAMPLE = [
        "9:09",
        "보통공원 망원",
        "홈", "소식", "메뉴", "예약", "리뷰", "사진", "주변",
        "팥말차롤",
        "제주 말차와 고급진맛의 팥 생크림이 함께",
        "있는 롤케이크",
        "6,500원",
        "행운초코컵",
        "발로나 초코의 꾸덕한 머핀과 가나슈 초콜",
        "릿위에 행운가득 클로버가 얹혀진 초코 ...",
        "6.500원",                 // OCR이 마침표로 읽은 가격
        "라떼(ICE)",
        "5,300 원",
        "황매실 에이드",
        "청매실보다 더 깊은 풍미와 단맛의 황매실",
        "청으로 만든 에이드",
        "6,200원",
        "오늘의 산도",
        "가격 변동",
        "후르츠 산도",
        "폭신하고 쫀득한 식빵 그리고 동물성 생크림과",
        "계절과일이 담긴 디저트",
        "가격변동",
        "쌀음료",
        "쌀튀밥과 함께 고소 달달하게 즐길수 있는",
        "쌀음료",
        "6,700원",
        "아메리카노(ICE)",
        "4,800원"
      ].join("\n");
      const parsed = JSON.parse(ev(`JSON.stringify(parseBulkMenus(${JSON.stringify(OCR_SAMPLE)}))`));
      const names = parsed.map(m => m.name);
      const priceOf = (n) => (parsed.find(m => m.name === n) || {}).price;

      ok("메뉴판 파싱: 대표 메뉴명을 설명 문장 대신 뽑는다",
        ["팥말차롤", "행운초코컵", "라떼(ICE)", "황매실 에이드", "오늘의 산도", "후르츠 산도", "쌀음료", "아메리카노(ICE)"].every(n => names.includes(n)),
        names.join(" / "));
      ok("메뉴판 파싱: 메뉴 수가 정확하다(8개)", parsed.length === 8, `${parsed.length}개 — ${names.join(",")}`);
      ok("메뉴판 파싱: 설명 문장이 메뉴명으로 새지 않는다",
        !names.some(n => /(롤케이크|머핀|에이드|디저트|식빵|존재)/.test(n) && n.length > 12), names.join(" / "));
      ok("메뉴판 파싱: 상단 탭·상태바·매장명 노이즈 제거",
        !names.some(n => /^(홈|소식|메뉴|예약|리뷰|사진|주변|9:09|보통공원 망원)$/.test(n)), names.join(" / "));
      ok("메뉴판 파싱: 6,500원 / 6.500원 / 5,300 원 모두 숫자로", priceOf("팥말차롤") === 6500 && priceOf("행운초코컵") === 6500 && priceOf("라떼(ICE)") === 5300,
        `${priceOf("팥말차롤")} / ${priceOf("행운초코컵")} / ${priceOf("라떼(ICE)")}`);
      const varNames = parsed.filter(m => m.variablePrice === true && m.price === null).map(m => m.name);
      ok("메뉴판 파싱: '가격 변동'·'가격변동'은 변동 메뉴로", varNames.length === 2 && varNames.includes("오늘의 산도") && varNames.includes("후르츠 산도"), varNames.join(","));

      // 실제 Tesseract가 빈 줄을 넣어 내놓는 모양 — 메뉴명은 한 줄짜리 묶음으로 따로 선다
      const OCR_TESSERACT = [
        "팔말차롤", "", "제주 말차와 고급진맛의 팔 생크림이 함께", "있는 롤케이크", "", "6,500원", "",
        "행운초코컵", "", "발로나 초코의 꾸덕한 머핀과 가나슈 초콜", "릿위에 행운가득 클로버가 없혀진 초코 ……", "6,500원", "",
        "라떼((06)", "", "5,300원", "",
        "황매실 에이드", "", "청매실보다 더 깊은 풍미와 단맛의 황매실", "doz 만든 에이드", "", "6,200원", "",
        "황매실차", "", "청매실보다 더 깊은 풍미와 단맛의 황매실", "HE 사용한 매실음료", "", "5,700원"
      ].join("\n");
      const tess = JSON.parse(ev(`JSON.stringify(parseBulkMenus(${JSON.stringify(OCR_TESSERACT)}))`));
      const tessNames = tess.map(m => m.name);
      ok("메뉴판 파싱: OCR이 빈 줄로 나눈 출력에서도 메뉴명을 잡는다",
        tessNames.length === 5 && tessNames[0] === "팔말차롤" && tessNames.includes("행운초코컵") && tessNames.includes("황매실 에이드") && tessNames.includes("황매실차"),
        tessNames.join(" / "));
      ok("메뉴판 파싱: 설명 꼬리줄이 메뉴명으로 잡히지 않는다",
        !tessNames.some(n => /^(있는 롤케이크|doz 만든 에이드|HE 사용한 매실음료)/.test(n)) && tess.map(m => m.price).join(",") === "6500,6500,5300,6200,5700",
        tess.map(m => `${m.name}:${m.price}`).join(", "));

      // 한 줄에 이름·가격이 붙은 입력, '가격 변동'/' - ' 표기
      const inline = JSON.parse(ev(`JSON.stringify(parseBulkMenus('오늘의 산도 가격 변동\\n아메리카노 5,500원\\n치즈케이크 -\\n라떼 6.500원'))`));
      ok("메뉴판 파싱: '오늘의 산도 가격 변동' 한 줄 입력도 변동 메뉴",
        inline.length === 4 && inline[0].name === "오늘의 산도" && inline[0].variablePrice === true && inline[1].name === "아메리카노" && inline[1].price === 5500
        && inline[2].variablePrice === true && inline[3].price === 6500, JSON.stringify(inline));

      // OCR이 글자를 벌려 읽은 경우도 같은 뜻으로
      const spaced = JSON.parse(ev(`JSON.stringify(parseBulkMenus('오늘의 산도 가 격 변 동\\n쌀음료 변 동\\n아메리카노(ICE) 4,800 원'))`));
      ok("메뉴판 파싱: '가 격 변 동'처럼 벌어진 글자도 변동 메뉴",
        spaced.length === 3 && spaced[0].name === "오늘의 산도" && spaced[0].variablePrice === true
        && spaced[1].name === "쌀음료" && spaced[1].variablePrice === true && spaced[2].price === 4800, JSON.stringify(spaced));

      // '-' 표시
      ok("가격 표시: 변동 메뉴는 0원이 아니라 '-'", ev("menuPriceLabel({name:'오늘의 산도', price:null, variablePrice:true})") === "-"
        && ev("menuPriceLabel({name:'라떼', price:5300})") === "₩5,300", ev("menuPriceLabel({name:'오늘의 산도', price:null, variablePrice:true})"));

      // 모달 목록·합계 — 변동 메뉴가 섞여도 오류 없이 0으로 더한다
      ev(`state.meta = { title:'메뉴', destination:'부산', startDate:'2027-03-06', endDate:'2027-03-07', travelers:2, tripType:'domestic', country:'대한민국' };
        state.days = [{ day:1, label:'1일차', date:'2027-03-06', items: [{ id:'vr-1', place:'보통공원 망원', badges:[], menus:[
          { name:'오늘의 산도', price:null, variablePrice:true, qty:1 },
          { name:'라떼(ICE)', price:5300, qty:2 }
        ] }] }];
        currentDay = 1; editMode = false; renderTimeline(); openMenuModal('vr-1');`);
      const menuListTxt = w.document.getElementById("menu-modal-list").textContent.replace(/\s+/g, " ");
      const menuTotalTxt = w.document.getElementById("menu-modal-total").textContent;
      ok("메뉴 모달: 변동 메뉴는 '-'로 보인다", /오늘의 산도/.test(menuListTxt) && menuListTxt.includes(" -") && !/₩0(?!\d)/.test(menuListTxt), menuListTxt);
      ok("메뉴 모달: 변동 메뉴는 합계에서 0원으로 계산", menuTotalTxt === "₩10,600", menuTotalTxt);

      // 직접 추가 — '-' / '가격 변동'
      const nameIn2 = w.document.getElementById("menu-custom-name");
      const priceIn2 = w.document.getElementById("menu-custom-price");
      nameIn2.value = "황매실차";
      priceIn2.value = "가격 변동";
      ev("addCustomMenuItem()");
      const last1 = JSON.parse(ev("JSON.stringify(draftMenus[draftMenus.length-1])"));
      nameIn2.value = "쌀음료";
      priceIn2.value = "-";
      ev("addCustomMenuItem()");
      const last2 = JSON.parse(ev("JSON.stringify(draftMenus[draftMenus.length-1])"));
      nameIn2.value = "아메리카노(ICE)";
      priceIn2.value = "4,800원";
      ev("addCustomMenuItem()");
      const last3 = JSON.parse(ev("JSON.stringify(draftMenus[draftMenus.length-1])"));
      ok("메뉴 직접 추가: '가격 변동'·'-'은 변동 메뉴로", last1.name === "황매실차" && last1.variablePrice === true && last1.price === null
        && last2.name === "쌀음료" && last2.variablePrice === true, `${JSON.stringify(last1)} / ${JSON.stringify(last2)}`);
      ok("메뉴 직접 추가: '4,800원' 같은 표기도 4800으로", last3.price === 4800, JSON.stringify(last3));

      ev("saveMenuSelection()");
      const savedItem = JSON.parse(ev("JSON.stringify(state.days[0].items[0])"));
      ok("메뉴 저장: 변동 메뉴가 섞여도 합계가 깨지지 않는다", savedItem.costTotal === 15400 && savedItem.menus.length === 5,
        `${savedItem.costTotal} / ${savedItem.menus.map(m => m.name + ":" + m.price).join(", ")}`);
      // 변동 메뉴만 고른 카드 — 0원이 아니라 '가격 변동'으로 보여 준다
      ev(`state.days[0].items[0].menus = [{ name:'오늘의 산도', price:null, variablePrice:true, qty:2 }];
        state.days[0].items[0].costTotal = 0; renderTimeline();`);
      const tlTxt = w.document.getElementById("timeline-list").textContent.replace(/\s+/g, " ");
      ok("메뉴 저장: 일정 카드의 변동 메뉴는 '가격 변동'으로", /🍴 오늘의 산도×2 \(가격 변동\)/.test(tlTxt) && !/오늘의 산도×2 \(₩0\)/.test(tlTxt), tlTxt.slice(0, 120));

      // OCR 전처리 — 세로형 스크린샷만 헤더·사진 칸을 자른다
      const portrait = JSON.parse(ev("JSON.stringify(menuOcrCropPlan(945, 2048, { rightPhotoLike: true, headerBottom: 0.1817 }))"));
      const portraitNoPhoto = JSON.parse(ev("JSON.stringify(menuOcrCropPlan(945, 2048, { rightPhotoLike: false, headerBottom: 0.1817 }))"));
      const landscape = JSON.parse(ev("JSON.stringify(menuOcrCropPlan(2048, 945, { rightPhotoLike: true, headerBottom: 0.2 }))"));
      ok("OCR 전처리: 세로 스크린샷은 상단 헤더를 자른다", portrait.y > 300 && portrait.y < 400 && portrait.h === 2048 - portrait.y, JSON.stringify(portrait));
      ok("OCR 전처리: 사진 칸이 있으면 오른쪽 33%도 자른다", portrait.w === Math.round(945 * 0.66) && portraitNoPhoto.w === 945, `${portrait.w} / ${portraitNoPhoto.w}`);
      ok("OCR 전처리: 가로 메뉴판 사진은 자르지 않는다", landscape.x === 0 && landscape.y === 0 && landscape.w === 2048 && landscape.h === 945, JSON.stringify(landscape));
      const big = JSON.parse(ev("JSON.stringify(menuOcrTargetSize(624, 1676))"));
      ok("OCR 전처리: 작은 캡처는 최소 폭 1200px로 키운다", big.width >= 1200 && big.width <= 1700 && big.height > big.width, JSON.stringify(big));

      // 헤더 끝(탭바 아래 구분선) 찾기 — 흰 줄·본문 줄은 구분선으로 오인하지 않는다
      const mkPixels = (pw, ph, dividerY, darkRight) => {
        const arr = new Array(pw * ph * 4).fill(255);
        for (let x = 0; x < pw; x++) { const i = (dividerY * pw + x) * 4; arr[i] = arr[i + 1] = arr[i + 2] = 230; }
        for (let y = dividerY + 4; y < ph; y += 8) for (let x = 2; x < Math.floor(pw * 0.55); x += 5) { const i = (y * pw + x) * 4; arr[i] = arr[i + 1] = arr[i + 2] = 20; }
        if (darkRight) for (let y = dividerY + 30; y < ph; y++) for (let x = Math.floor(pw * 0.7); x < pw; x++) { const i = (y * pw + x) * 4; arr[i] = 90; arr[i + 1] = 60; arr[i + 2] = 40; }
        return arr;
      };
      const W1 = 100, H1 = 200, DIV = 36;
      w.__px = mkPixels(W1, H1, DIV, true);
      const headerRatio = w.eval("menuOcrHeaderBottom(__px, 100, 200)");
      ok("OCR 전처리: 탭바 아래 구분선 y를 찾는다", Math.abs(headerRatio - (DIV + 1) / H1) < 0.02, String(headerRatio));
      const rightPhoto = w.eval("menuOcrRightBandPhotoLike(__px, 100, 200)");
      w.__px2 = mkPixels(W1, H1, DIV, false);
      const rightText = w.eval("menuOcrRightBandPhotoLike(__px2, 100, 200)");
      ok("OCR 전처리: 오른쪽 사진 칸 판정", rightPhoto === true && rightText === false, `${rightPhoto} / ${rightText}`);
      delete w.__px;
      delete w.__px2;

      // 캔버스가 없는 환경(jsdom)에서는 원본을 그대로 — OCR 흐름이 멈추지 않는다
      w.__fakeFile = { name: "raw.png" };
      const passthrough = await ev("preprocessMenuImageForOcr(__fakeFile)");
      ok("OCR 전처리: 캔버스 없으면 원본 그대로 넘긴다", passthrough === w.__fakeFile, String(passthrough && passthrough.name));
      delete w.__fakeFile;

      // OCR → 파싱 → 목록까지 한 번에
      ev(`state.days = [{ day:1, label:'1일차', date:'2027-03-06', items: [{ id:'ocr-1', place:'보통공원 망원', badges:[], menus: [] }] }];
        currentDay = 1; editMode = false; openMenuModal('ocr-1');`);
      const realTess = w.Tesseract;
      w.Tesseract = { recognize: () => Promise.resolve({ data: { text: OCR_SAMPLE } }) };
      await w.handleMenuImageFiles([{ name: "menu-shot.png" }]);
      const ocrDraft = JSON.parse(ev("JSON.stringify(draftMenus)"));
      const ocrTxt = w.document.getElementById("menu-modal-list").textContent.replace(/\s+/g, " ");
      ok("메뉴판 사진: OCR 결과가 대표 메뉴명으로 목록에 들어간다",
        ocrDraft.length === 8 && ocrDraft.some(m => m.name === "팥말차롤" && m.price === 6500) && ocrDraft.some(m => m.name === "오늘의 산도" && m.variablePrice === true),
        ocrDraft.map(m => `${m.name}:${m.price}`).join(", "));
      ok("메뉴판 사진: 목록에서 '가격 변동'이 '-'로 보인다", /오늘의 산도/.test(ocrTxt) && ocrTxt.includes(" -") && !/₩0(?!\d)/.test(ocrTxt), ocrTxt.slice(0, 160));
      w.Tesseract = realTess;
      w.closeMenuModal();
      ev(`state.days = [{ day:1, label:'1일차', date:'2027-03-06', items: [] }]; state.bookings = []; state.expenses = []; saveState();`);
    }

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
