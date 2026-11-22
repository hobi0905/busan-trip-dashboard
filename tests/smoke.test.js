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
      ok("호텔 클릭 → 지도 검색어도 호텔 이름만", searchVal === "롯데호텔 부산", searchVal);
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
