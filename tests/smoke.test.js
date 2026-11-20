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
    ok("접힘 CSS: 사진·체류·세부 숨김", /\.card\.tl-collapsible:not\(\.tl-open\) \.tl-stay/.test(html) && /\.card\.tl-collapsible:not\(\.tl-open\) \.ph-slot/.test(html) && /\.tl-extra \{ display: none; \}/.test(html), "");
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
