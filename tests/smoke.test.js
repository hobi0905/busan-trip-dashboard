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
    ok("편집 행 구성: 삭제·핸들", w.document.querySelectorAll("#timeline-list .tl-edit-del").length === d0items
      && w.document.querySelectorAll("#timeline-list .tl-edit-handle").length === d0items, "");
    ok("편집 모드에 사진·메뉴 버튼 숨김", w.document.querySelectorAll("#timeline-list .ph-slot").length === 0
      && !/메뉴 선택/.test(w.document.getElementById("timeline-list").textContent), "");
    const beforeOrder = ev("state.days[0].items.map(i=>i.place)");
    const listEl = w.document.getElementById("timeline-list");
    const rowsArr = [...listEl.querySelectorAll(".tl-edit-row[data-item-id]")];
    listEl.insertBefore(rowsArr[rowsArr.length - 1], rowsArr[0]);
    w.commitTimelineEditOrder();
    const afterOrder = ev("state.days[0].items.map(i=>i.place)");
    ok("드래그 순서 반영", afterOrder[0] === beforeOrder[beforeOrder.length - 1] && afterOrder.length === beforeOrder.length,
      `${beforeOrder.join(">")} → ${afterOrder.join(">")}`);
    ok("순서 변경 후 시간 재배정", ev("state.days[0].items.map(i=>i.time).join(',')") === ev("state.days[0].items.map(i=>i.time).slice().sort().join(',')"), ev("state.days[0].items.map(i=>i.time).join(',')"));
    w.toggleEditMode();

    // 27) 📅 일반 일정 카드: 메모만 기본, 메뉴·가격은 펼치면
    const plainCard = w.document.querySelector("#timeline-list .card.tl-collapsible");
    ok("카드 기본 접힘", plainCard && !plainCard.classList.contains("tl-open") && !!plainCard.querySelector(".tl-extra") && /더 보기/.test(plainCard.textContent), "");
    ok("접힘 CSS: 체류·세부 숨김", /\.card\.tl-collapsible:not\(\.tl-open\) \.tl-stay/.test(html) && /\.tl-extra \{ display: none; \}/.test(html), "");
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
    ok("놓은 뒤 시간표 재배정", ev("state.days[0].items.map(i=>i.time).join(',')") === "09:00,10:00,11:00,12:00", ev("state.days[0].items.map(i=>i.time).join(',')"));
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
    ok("호텔 카드: 접힐 때 한 줄 요약 CSS", /\.card\.tl-virtual\.tl-collapsible:not\(\.tl-open\) \.tl-memo \{[^}]*-webkit-line-clamp: 1;/.test(html), "");
    ok("호텔 카드: 상세는 .tl-extra 안", vCards.every(c => !!c.querySelector(".tl-extra .tl-meta")),
      vCards.map(c => c.querySelectorAll(".tl-extra .tl-meta").length).join(","));
    const vCard = vCards[0];
    const vId = vCard.getAttribute("data-card-id");
    vCard.querySelector(".tl-place").click();
    ok("호텔 카드 탭 → 펼침", vCard.classList.contains("tl-open") && /접기/.test(vCard.querySelector(".tl-fold-cue").textContent)
      && ev(`expandedTimelineCards.has(${JSON.stringify(vId)})`), vCard.className);
    vCard.querySelector(".tl-place").click();
    ok("다시 탭 → 접힘", !vCard.classList.contains("tl-open") && /더 보기/.test(vCard.querySelector(".tl-fold-cue").textContent), "");
    ok("호텔 카드: 펼치면 루트·금액·버튼", (() => {
      w.renderTimeline();
      const c = w.document.querySelector(`#timeline-list .card[data-card-id="${vId}"]`);
      c.querySelector(".tl-place").click();
      const extra = c.querySelector(".tl-extra");
      return /🛣️|좌표가 없어|이동 시간/.test(extra.textContent) && !!extra.querySelector(".tl-meta .tl-cost");
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
    ok("여유 루트: 결과 안내 문구", /점심\(12시대\)/.test(w.document.getElementById("route-results").textContent)
      && /16~17시에 마무리/.test(w.document.getElementById("route-results").textContent), "");

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
