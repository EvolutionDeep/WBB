/**
 * Front-end localisation for the dashboard.
 *
 * English is the source language: every string that ships in the page exists here as
 * an { en, zh } pair, so the two versions of a sentence cannot drift apart the way
 * parallel copies in different files always do. The test imports this module and
 * refuses any key without both languages, which is what makes "translated everywhere"
 * a checkable claim rather than a promise.
 *
 * Rules that matter for the rest of the site:
 *   - English is the default, and it is also the fallback: a key missing a Chinese
 *     value would show English, never a blank and never the raw key;
 *   - the choice lives in localStorage and in ?lang=, so an embedded badge or a
 *     screenshot can be pinned to one language without touching stored state;
 *   - this module touches no network, no wallet and no contract. It only ever
 *     receives a key and returns text, so it stays inside the global read-only guard;
 *   - text built from several pieces (a badge, a sentence with numbers in it) is
 *     assembled with parameters here rather than glued in a module, because Chinese
 *     puts the qualifier before the noun and a half-sentence translated on its own
 *     comes out wrong.
 *
 * Comment policy: English only (project rule). The Chinese in this file is UI copy,
 * not commentary.
 */

export const LANGS = ["en", "zh"];
export const DEFAULT_LANG = "en";
const LS_KEY = "wbb_lang";

/** Every user-visible string on the site, both languages, side by side. */
export const MESSAGES = {
  // ---- header ----
  "head.h1": { en: "Worm<b>Readout</b> · read-only lens", zh: "Worm<b>Readout</b> · 只读透镜" },
  "head.tagline": {
    en: "a permissionless on-chain C. elegans on BSC mainnet · this page <b>reads</b> the deployed WormReadout & SenseAdapter and never advances the animal by itself · the only two ways anything is ever spent here are the opt-in poke and the opt-in engraving, each pinned to one contract and signed by your own wallet",
    zh: "一条无需许可、跑在 BSC 主网上的链上秀丽隐杆线虫 · 本页面只<b>读取</b>已部署的 WormReadout 与 SenseAdapter，绝不自行推进这只动物 · 这里唯一可能花掉东西的两条路径，是你主动开启的「投喂」与主动开启的「刻字」，各自只钉住一个合约，并由你自己的钱包签名",
  },
  "head.lang_btn": { en: "切换中文", zh: "Switch to English" },
  "head.lang_title": { en: "switch the language of this page", zh: "切换本页面的语言" },

  // ---- 00 · 3D demo ----
  "c00.title": { en: "3D worm — the connectome, animated as a demo", zh: "3D 线虫 —— 作为演示动画播放的神经连接组" },
  "c00.note": {
    en: "a pure visualisation, and it plays by itself: the page pulls in three.js the moment it opens, alongside the first chain reads, plus the anatomy from data/graph.json and data/layout.json — 302 neurons at their real positions and the 5,144 directed synapses — and then runs forever, crawling, reversing and turning. There is nothing to press. It sends no request to the chain: the wave, the firing and the pulses along the fibres are invented for the eye. The animal's actual state is on card 01. It stops drawing while the tab is in the background and resumes on its own when you come back.",
    zh: "纯粹的可视化，而且它自己就会播：页面一打开就去取 three.js，与最早那几次链上读取并行，再从 data/graph.json 与 data/layout.json 读取解剖数据 —— 302 个神经元按真实位置摆放，5,144 条有方向的突触 —— 然后一直跑下去：爬行、倒退、转向。没有任何需要按的按钮。它不向链上发任何请求：波动、放电、沿神经纤维奔跑的脉冲都是为眼睛编造出来的。这只动物的真实状态在 01 号卡片上。标签页切到后台时它停止绘制，你回来时它自己续上。",
  },
  // the button text is still shared: the wall and the time-lapse cards load their own
  // modules behind a click and reuse this one word
  "c00.btn_loading": { en: "LOADING…", zh: "加载中…" },
  "c00.loading": {
    en: "the 3D demo is loading — three.js is coming down right now. Drag to orbit, scroll to zoom, hover a node for its name and its class.",
    zh: "3D 演示正在加载 —— three.js 此刻正在下载。拖动可旋转视角，滚轮可缩放，鼠标停在节点上可看到它的名字与类别。",
  },
  "c00.load_fail": {
    en: "the 3D demo could not load ({m}). Nothing else on this page depends on it.",
    zh: "3D 演示加载失败（{m}）。页面上没有别的东西依赖它。",
  },
  "c00.lg_exc": { en: "excitatory synapse (pre → post)", zh: "兴奋性突触（前 → 后）" },
  "c00.lg_inh": { en: "inhibitory synapse (pre → post)", zh: "抑制性突触（前 → 后）" },
  "c00.lg_ring": { en: "nerve ring", zh: "神经环" },
  "c00.lg_head": { en: "head sensory", zh: "头部感觉" },
  "c00.lg_motor": { en: "motor", zh: "运动神经元" },
  "c00.lg_cord": { en: "cord interneuron", zh: "腹索中间神经元" },
  "c00.lg_post": { en: "postdeirid", zh: "尾感器神经元" },
  "c00.lg_tail": { en: "tail", zh: "尾部" },
  "c00.hud_demo": { en: "<b>DEMO</b> — nothing here is read from the chain; the animation runs on its own", zh: "<b>演示</b> —— 这里没有任何内容读自链上；动画完全自行运转" },
  "c00.hud_episode": { en: "<b>episode</b> {name} · <b>wave</b> {wave} · {dir} · <b>bend</b> {bend}", zh: "<b>片段</b> {name} · <b>波</b> {wave} · {dir} · <b>弯曲</b> {bend}" },
  "c00.dir_forward": { en: "forward", zh: "前进" },
  "c00.dir_reverse": { en: "reverse", zh: "后退" },
  "c00.dir_none": { en: "no translation", zh: "无位移" },
  // the episode and neuron-class captions: the English side deliberately spells the data
  // token, the Chinese side is what the caption has always meant
  "c00.ep_forward_crawl": { en: "forward crawl", zh: "前进爬行" },
  "c00.ep_pause": { en: "pause", zh: "停顿" },
  "c00.ep_reversal": { en: "reversal", zh: "后退反转" },
  "c00.ep_turn": { en: "turn", zh: "转向" },
  "c00.ep_slow_crawl": { en: "slow crawl", zh: "缓慢爬行" },
  "c00.cls_sensor_head": { en: "sensor_head", zh: "头部感觉" },
  "c00.cls_ring": { en: "ring", zh: "神经环" },
  "c00.cls_cord_misc": { en: "cord_misc", zh: "腹索中间" },
  "c00.cls_cord_motor": { en: "cord_motor", zh: "腹索运动" },
  "c00.cls_midbody": { en: "midbody", zh: "中段" },
  "c00.cls_postdeirid": { en: "postdeirid", zh: "尾感器" },
  "c00.cls_tail": { en: "tail", zh: "尾部" },
  "c00.hud_anatomy": { en: "<b>anatomy</b> {n} neurons · {e} directed synapses · real positions", zh: "<b>解剖</b> {n} 个神经元 · {e} 条有向突触 · 真实位置" },
  "c00.hud_signals": { en: "<b>signals</b> {p} pulses running pre → post · {f} cells lit right now", zh: "<b>信号</b> {p} 道脉冲沿 前 → 后 传导 · 此刻 {f} 个细胞在亮" },
  "c00.hud_synthetic": { en: "drive, brightness and timing are synthetic — the animal's live state is on card 01", zh: "驱动力、亮度与节奏都是合成的 —— 这只动物的实时状态在 01 号卡片" },
  "c00.tip": { en: "{name} · {cls} · t {t} · demo drive {pct}%", zh: "{name} · {cls} · t {t} · 演示驱动 {pct}%" },
  "c00.tip_unplaced": { en: "unplaced", zh: "未定位" },

  // ---- 01 · identity ----
  "c01.title": { en: "Identity", zh: "身份" },
  "c01.k_status": { en: "STATUS", zh: "状态" },
  "c01.k_brain": { en: "BRAIN", zh: "大脑合约" },
  "c01.k_conn": { en: "CONN ROOT", zh: "连接组根" },
  "c01.k_tick": { en: "TICK", zh: "心跳计数" },
  "c01.k_hash": { en: "STATE HASH", zh: "状态哈希" },
  "c01.k_advblock": { en: "LAST ADVANCE BLOCK", zh: "最近推进区块" },
  "c01.k_curblock": { en: "CURRENT BLOCK", zh: "当前区块" },
  "c01.k_since": { en: "BLOCKS SINCE ADVANCE", zh: "距推进的区块数" },
  "c01.k_age": { en: "ADVANCE AGE", zh: "推进年龄" },
  "c01.k_window": { en: "STALE WINDOW", zh: "失活窗口" },
  "c01.note_default": {
    en: "Liveness is judged on elapsed time against the heartbeat this page has measured, not on a block count: BSC now seals a block in well under a second, so a stale window written in blocks no longer means what it did.",
    zh: "判活看的是时间流逝，也就是本页面自己测到的那颗心跳，而不是区块数：BSC 现在出块远快于一秒，所以用区块写成的失活窗口早已不是它原本的意义。",
  },
  "c01.connecting": { en: "CONNECTING…", zh: "连接中…" },
  "c01.badge_checking": { en: "CHECKING — advance not observable yet", zh: "观察中 —— 还观测不到推进" },
  "c01.badge_halted": { en: "HALTED — no advance for {age}", zh: "已停摆 —— {age} 内没有任何推进" },
  "c01.badge_live": { en: "LIVE — advanced {age} ago", zh: "活着 —— {age} 之前推进过" },
  "c01.verdict_halted": { en: "HALTED", zh: "停摆" },
  "c01.verdict_live": { en: "LIVE", zh: "活着" },
  "c01.tick_raw": { en: " (raw {n})", zh: "（脑上原始值 {n}）" },
  "c01.adv_unreadable": { en: "not readable here ({e}/{s} log spans rejected)", zh: "此处读不到（{e}/{s} 段日志被拒）" },
  "c01.adv_none": { en: "none in the last 6000 blocks", zh: "最近 6000 个区块内没有" },
  "c01.age_line": { en: "{age} ago (event {event}{scan} / observed {observed})", zh: "{age} 之前（日志事件 {event}{scan} / 本地观测 {observed}）" },
  "c01.age_scan": { en: ", scanned {x} ago", zh: "，扫描于 {x} 之前" },
  "c01.age_na": { en: "n/a", zh: "暂无" },
  "c01.age_none": { en: "no witness yet", zh: "还没有可用的证人" },
  // the age formatter: a bare "3min" is not a Chinese word, so the unit is a message too
  "c01.age_s": { en: "{n}s", zh: "{n} 秒" },
  "c01.age_min": { en: "{n}min", zh: "{n} 分钟" },
  "c01.age_h": { en: "{n}h", zh: "{n} 小时" },
  "c01.window_beat": { en: "{sec}s = {mult} x learned ~{beat}s beat", zh: "{sec} 秒 = {mult} × 学到的约 {beat} 秒节拍" },
  "c01.window_floor": { en: "{sec}s = floor, no beat learned yet", zh: "{sec} 秒 = 下限，尚未学到节拍" },
  "c01.note_neutral": {
    en: "Neither the advance log nor a changed tick is readable from this endpoint yet, so the page refuses to call the animal dead on a missing reading. It will re-judge on the next poll.",
    zh: "推进日志与变化的心跳此刻都还没从这个端点读到，所以本页面拒绝凭一次读不到就判定这只动物死了。下一轮读取会重新判定。",
  },
  "c01.note_halted": {
    en: "Honest stall: nothing has advanced the brain for {age}, past the {window}s window. Only advance() moves the clock and it costs gas - the keeper may have stopped, while injecting through the adapter below still works for anyone.",
    zh: "这是一次如实的停顿：已经 {age} 没有任何东西推进过大脑，超出了 {window} 秒的窗口。只有 advance() 会拨动这只动物的时钟，而它要花 gas —— 维护节点可能停了；任何人通过下面的适配器注入电流依然有效。",
  },
  "c01.note_live": {
    en: "Liveness is judged on elapsed time: stalled after {window}s of silence, which is {mult}x the ~{beat}s beat this page measured from real tick changes.",
    zh: "判活看的是时间流逝：安静超过 {window} 秒即判停摆，这是本页面从真实心跳计数变化里测到的约 {beat} 秒节拍的 {mult} 倍。",
  },
  "c01.note_blockmath": {
    en: " Block math, shown for reference only: {since} blocks since the last advance, and the contract's STALE_WINDOW of {sw} blocks is worth about {sec}s at the ~{spb}s per block measured here - far shorter than this worm's heartbeat, which is why a block count cannot decide the verdict.",
    zh: " 区块换算只作参考：距上次推进 {since} 个区块，而合约里那个 {sw} 个区块的 STALE_WINDOW，按此处测到的每块约 {spb} 秒只值大约 {sec} 秒 —— 远短于这只线虫的心跳，所以区块数不能用来下判词。",
  },
  "c01.note_cadence": {
    en: " The tick and the body are read every {fast}s, the advance log re-scanned every {slow}s, so the fresher witness is the one on screen and the log one is at most that late.",
    zh: " 心跳计数与躯体每 {fast} 秒读一次，推进日志每 {slow} 秒重扫一次，因此屏幕上显示的是更新的那位证人，而日志证人最多只滞后到那个间隔。",
  },
  "c01.status_reading": { en: "reading · head {head} · {verdict}", zh: "读取中 · 最新区块 {head} · {verdict}" },
  "c01.status_failed": { en: "RPC read failed — retrying", zh: "RPC 读取失败 —— 正在重试" },
  "c01.rpc_label": { en: "{host} (worker -> BSC)", zh: "{host}（worker 代理 → BSC）" },

  // ---- 02 · body ----
  "c02.title": { en: "Body (only read() → approach / turn / speed)", zh: "躯体（只来自 read() → 趋近 / 转向 / 速度）" },
  "c02.approach": { en: "APPROACH", zh: "趋近" },
  "c02.turn": { en: "TURN", zh: "转向" },
  "c02.speed": { en: "SPEED", zh: "速度" },
  "c02.note": {
    en: "x = turn (−10000 left ↔ 10000 right), y = approach (−10000 down ↔ 10000 up), size = |speed|. A point is drawn only for a NEW on-chain tick — the page never fabricates a trajectory between beats.",
    zh: "x = 转向（−10000 左 ↔ 10000 右），y = 趋近（−10000 下 ↔ 10000 上），大小 = |速度|。只有链上出现了新的心跳计数才画一个点 —— 本页面从不在两拍之间编造轨迹。",
  },
  "c02.axis_turn": { en: "turn →", zh: "转向 →" },
  "c02.axis_approach": { en: "approach ↑", zh: "趋近 ↑" },
  "c02.tick_label": { en: "tick {n}", zh: "心跳 {n}" },

  // ---- 03 · stimuli ----
  "c03.title": { en: "Stimuli (inject / stimulate / sample)", zh: "刺激（inject / stimulate / sample）" },
  "c03.k_asel": { en: "stim(ASEL) live", zh: "stim(ASEL) 实时" },
  "c03.k_aser": { en: "stim(ASER) live", zh: "stim(ASER) 实时" },
  "c03.k_ratio": { en: "POOL RATIO (now, Q20)", zh: "池子比值（当前，Q20）" },
  "c03.k_last": { en: "LAST SAMPLED RATIO", zh: "上次采到的比值" },
  "c03.k_delta": { en: "Δ vs PREVIOUS BEAT", zh: "与上一拍的差值" },
  "c03.note": { en: "Stimulation accumulates within a block; a later same-block current is ADDED, it never overwrites.", zh: "刺激在同一区块内累加；同一区块里后来的电流是被加上的，永远不会覆盖前面的。" },
  "c03.feed_empty": { en: "no inject / stimulate events in the last ~1500 blocks", zh: "最近约 1500 个区块内没有 inject / stimulate 事件" },
  "c03.amp": { en: "amp", zh: "强度" },
  "c03.blk": { en: "blk", zh: "区块" },
  "c03.from": { en: "from", zh: "来自" },
  "c03.accum": { en: "accum", zh: "累计" },
  "c03.na": { en: "n/a", zh: "暂无" },
  "c03.not_primed": { en: "  (adapter not primed yet)", zh: "（适配器尚未 primed）" },
  "c03.pair_failed": { en: "— (pair read failed)", zh: "—（交易对读取失败）" },
  "c03.tick_word": { en: "tick", zh: "心跳" },

  // ---- 04 · poke (opt-in write path) ----
  "c04.title": { en: "Poke the worm (opt-in · your wallet · your gas)", zh: "投喂线虫（需主动开启 · 你的钱包 · 你的 gas）" },
  "c04.btn_enable": { en: "ENABLE POKE UI", zh: "开启投喂界面" },
  "c04.btn_on": { en: "POKE UI ON", zh: "投喂界面已开启" },
  "c04.btn_food": { en: "POKE +2.0 → ASEL (food-like)", zh: "投喂 +2.0 → ASEL（类似食物）" },
  "c04.btn_avert": { en: "POKE −2.0 → ASER (repellent)", zh: "投喂 −2.0 → ASER（类似回避）" },
  "c04.status_off": { en: "disabled — this page stays read-only until you enable the poke UI", zh: "已禁用 —— 在你开启投喂界面之前，本页面保持只读" },
  "c04.k_result": { en: "RESULT", zh: "结果" },
  "c04.note": {
    en: "The only write path on this site: it encodes exactly one call, SenseAdapter.inject(int256), signed and paid by YOUR own wallet (a few ten-thousandths of BNB). The brain is passive — your current queues into the chemoreceptor and bites on the NEXT advance by a keeper node. Nothing on this page can move, pause or own the animal.",
    zh: "本站唯一的写入路径：它只编码一个调用 SenseAdapter.inject(int256)，由你自己的钱包签名并付费（几万分之一 BNB 量级）。大脑是被动的 —— 你注入的电流排进化学感受器，要在维护节点的下一次推进时才起作用。本页面没有任何东西能移动、暂停或拥有这只动物。",
  },
  "c04.load_fail": { en: "poke module failed to load: {m}", zh: "投喂模块加载失败：{m}" },
  "c04.feed_empty": { en: "no pokes on record in the recent window — be the first, or let the keeper lead.", zh: "最近的区块窗口内没有投喂记录 —— 做第一个，或者让维护节点带头。" },
  "c04.feed_fail": { en: "poke feed unavailable: {m}", zh: "投喂动态不可用：{m}" },
  "c04.idx": { en: "idx {n}", zh: "编号 {n}" },
  "c04.ago_min": { en: "{m}m ago", zh: "{m} 分钟前" },
  "c04.no_wallet": { en: "no wallet detected — install an EIP-1193 browser wallet first", zh: "未检测到钱包 —— 请先安装一个 EIP-1193 浏览器钱包" },
  "c04.no_account": { en: "your wallet shared no account — approve the connect prompt, then poke again", zh: "钱包没有共享任何账户 —— 先在钱包里批准连接，再投喂一次" },
  "c04.waiting": { en: "waiting for your wallet…", zh: "等待你的钱包…" },
  "c04.account_changed": { en: "account changed, try again", zh: "账户发生变化，请重试" },
  "c04.wrong_chain": { en: "connect to BNB Chain mainnet (chainId 56)", zh: "请连接到 BNB Chain 主网（chainId 56）" },
  "c04.tx_sent": { en: "tx sent: {h}… waiting for receipt", zh: "交易已发出：{h}… 等待回执" },
  "c04.poked": { en: "poked {where} · you paid {gas} BNB gas · takes effect on the next advance", zh: "已投喂 {where} · 你支付了 {gas} BNB 的 gas · 下一次推进时生效" },
  "c04.where_asel": { en: "ASEL (food-like)", zh: "ASEL（类似食物）" },
  "c04.where_aser": { en: "ASER (repellent-like)", zh: "ASER（类似回避）" },
  "c04.reverted": { en: "poke tx reverted — nothing was written", zh: "投喂交易回滚了 —— 什么都没写进去" },
  "c04.not_sent": { en: "not sent: {m}", zh: "未发出：{m}" },

  // ---- 05 · inscription wall (read view) ----
  "c05.title": { en: "Inscription wall (read-only until you arm it)", zh: "铭文墙（在你装载之前保持只读）" },
  "c05.btn_read": { en: "READ THE WALL", zh: "读取铭文墙" },
  "c05.btn_enable": { en: "ENABLE ENGRAVING", zh: "开启刻字" },
  "c05.btn_rescan": { en: "RE-SCAN FROM GENESIS", zh: "从创世重新扫描" },
  "c05.btn_armed": { en: "ENGRAVING ARMED", zh: "刻字已装载" },
  "c05.btn_online": { en: "WALL ONLINE", zh: "墙已联网" },
  "c05.status_off": { en: "not loaded — nothing is read from this card until you press READ THE WALL", zh: "未读取 —— 在你按「读取铭文墙」之前，这张卡片不会从链上读任何东西" },
  "c05.reading": { en: "reading the wall…", zh: "正在读取铭文墙…" },
  "c05.read_at": { en: "wall read · {time}", zh: "墙已读取 · {time}" },
  "c05.unreadable": { en: "wall unreadable: {m}", zh: "铭文墙读不到：{m}" },
  "c05.load_fail": { en: "wall module failed to load: {m}", zh: "铭文墙模块加载失败：{m}" },
  "c05.k_wall": { en: "WALL", zh: "墙状态" },
  "c05.k_price": { en: "PRICE PER SLOT (MUST ARRIVE)", zh: "每槽价格（必须到账）" },
  "c05.k_floor": { en: "CONTRACT FLOOR (PRICE ÷ 0.97)", zh: "合约下限（价格 ÷ 0.97）" },
  "c05.k_span": { en: "SLOT SPAN", zh: "每槽跨度" },
  "c05.k_newest": { en: "NEWEST SLOT", zh: "最新槽位" },
  "c05.k_taken": { en: "ENGRAVED SO FAR", zh: "已刻数量" },
  "c05.k_scan": { en: "LOG SCAN COVERAGE", zh: "日志扫描覆盖" },
  "c05.price": { en: "{n} {sym} (must arrive)", zh: "{n} {sym}（需实际到账）" },
  "c05.floor": { en: "{n} {sym} — the bare contract floor, the form adds a 2% margin", zh: "{n} {sym} —— 合约硬下限，表单会再加 2% 余量" },
  "c05.span": { en: "{ticks} ticks of beating (about {ticks} minutes at the observed ~1 tick/min cadence)", zh: "{ticks} 个心跳的搏动（按实测约每分钟 1 个心跳，大约 {ticks} 分钟）" },
  "c05.cur_slot": { en: "{slot} (brain tick {tick})", zh: "{slot}（大脑当前心跳 {tick}）" },
  "c05.taken": { en: "{n} engraved", zh: "已刻 {n} 条" },
  "c05.edge_all": { en: "all history, through block {head}", zh: "全部历史，扫到区块 {head}" },
  "c05.edge_part": { en: "through block {to} of {head} — the scan is incremental", zh: "扫到 {head} 中的 {to} —— 扫描是增量的" },
  "c05.refused": { en: "; {n} span(s) refused by the endpoint, not empty", zh: "；{n} 段被端点拒绝，这不等于没有" },
  "c05.slot": { en: "slot {n}", zh: "槽 {n}" },
  "c05.tile_tip": { en: "tick {tick} · {burned}", zh: "心跳 {tick} · {burned}" },
  "c05.burned": { en: "{n} {sym} burned", zh: "销毁 {n} {sym}" },
  "c05.tile_unknown": { en: "unreadable here", zh: "此处读不到" },
  "c05.tile_open": { en: "open — {max} characters, forever", zh: "空着 —— 可写 {max} 个字符，永久" },
  "c05.log_empty": { en: "nothing engraved yet — every slot on the wall is still open.", zh: "还没有任何人刻下文字 —— 墙上的每一个槽位都还空着。" },
  "c05.log_line": { en: "{author} · ticks {from}–{to} · {burned} · block {block} ·", zh: "{author} · 心跳 {from}–{to} · {burned} · 区块 {block} ·" },
  "c05.err_getters": { en: "ledger getters unreadable on every endpoint", zh: "每个端点都读不到台账的 getter" },
  "c05.err_token": { en: "ledger is paid in {a}, not the token this page pins -- refusing to quote a price", zh: "该台账的支付代币是 {a}，与本页面钉住的代币不同 —— 拒绝报价" },
  "c05.note": {
    en: "The most recent slots of the animal's life — up to the last 24, fewer while the wall is young — each one purchasable forever. A magenta brick carries text that is already on-chain and can never be edited, overwritten or removed; the paid token is burned in the same transaction, so the ledger holds no balance and pays no one. The price is what must ARRIVE, and the token levies a 3% transfer tax, so the contract floor is price ÷ 0.97 — the engraving form deliberately prefills 2% above that, because it cannot know how the token rounds its own fee and a reverted inscription still costs gas. Everything above is an eth_call or an Inscribed event log — this card reads the deployed WormLedger at 0x16a4d26C90fE7613f22Da41150E4847e1fE47495 (100 ticks per slot, 10,000 token per inscription) and copies nothing from a server. An earlier wall at 0xb305bDcf97C26B1312E3C3b3158BAAc7cD5f6966 is superseded, not retired: its 1-token price is immutable, so it stays buyable forever and nothing on this site points at it any more.",
    zh: "这里展示这只动物生命里最近的槽位 —— 最多 24 个，墙还很年轻时会少一些 —— 每一格一旦买到就永久属于你。洋红色的砖块上已经有链上文字，永远无法编辑、覆盖或移除；支付出去的代币在同一笔交易里被销毁，所以这个台账不持有任何余额，也不付钱给任何人。价格指的是必须到账的数额，而该代币收取 3% 的转账税，所以合约硬下限是价格 ÷ 0.97 —— 刻字表单故意按下限再加 2% 预填，因为它无法预知这个代币如何对自己的手续费取整，而一笔回滚的刻字照样要花 gas。以上所有内容都是 eth_call 或 Inscribed 事件日志 —— 本卡片读取部署在 0x16a4d26C90fE7613f22Da41150E4847e1fE47495 的 WormLedger（每槽 100 个心跳，每次刻字 10,000 枚代币），不从任何服务器抄数据。更早的那面墙在 0xb305bDcf97C26B1312E3C3b3158BAAc7cD5f6966，它是被取代，不是被废除：它 1 枚代币的价格不可更改，所以永远还能买，只是本站不再指向它。",
  },

  // ---- 05b · engraving form (the second write path) ----
  "c05f.slot_label": { en: "SLOT (AN ALREADY-LIVED ONE)", zh: "槽位（必须是已经活过的那一段）" },
  "c05f.text_label": { en: "TEXT · 1–64 PRINTABLE ASCII", zh: "文字 · 1–64 个可打印 ASCII" },
  "c05f.text_ph": { en: "what should outlive the worm", zh: "写一句该比这只线虫活得更久的话" },
  "c05f.token_label": { en: "TOKEN TO SEND (INCLUDING THE 3% TAX)", zh: "要发送的代币数量（含 3% 税）" },
  "c05f.check": { en: "CHECK", zh: "校验" },
  "c05f.check_off": { en: "type above — the contract's own text rule is applied here before anything is signed", zh: "请在上面输入 —— 合约自己的文字规则会在任何东西被签名之前先在这里校验" },
  "c05f.wallet": { en: "WALLET", zh: "钱包" },
  "c05f.wallet_none": { en: "no wallet attached", zh: "尚未连接钱包" },
  "c05f.allow": { en: "ALLOWANCE", zh: "授权额度" },
  "c05f.btn_connect": { en: "ATTACH WALLET", zh: "连接钱包" },
  "c05f.btn_send": { en: "ENGRAVE (approve + inscribe)", zh: "刻字（approve + inscribe）" },
  "c05f.note": {
    en: "Arming this form loads a second module that can encode exactly two calls: ERC20.approve(ledger, amount) and WormLedger.inscribe(slot, text, nominal). It never touches the brain, never takes a key, and every signature is confirmed inside your own wallet. A slot is permanent: two transactions, your token, your gas, and no undo.",
    zh: "装载这个表单会加载第二个模块，它只能编码两个调用：ERC20.approve(ledger, amount) 与 WormLedger.inscribe(slot, text, nominal)。它从不触碰大脑，从不获取密钥，每一次签名都在你自己的钱包里确认。一个槽位是永久的：两笔交易、你的代币、你的 gas，且无法撤销。",
  },
  "c05f.empty_text": { en: "write something — an empty slot is not an inscription", zh: "写点什么吧 —— 空的槽位不算铭文" },
  "c05f.long_text": { en: "{n} characters, the ceiling is {max}", zh: "{n} 个字符，上限是 {max}" },
  "c05f.bad_char": { en: "character \"{c}\" at position {i} is not printable ASCII — the wall refuses markup, control bytes and non-ASCII, and so do I", zh: "第 {i} 位的字符“{c}”不是可打印 ASCII —— 铭文墙拒绝标记语言、控制字节和非 ASCII，我也一样拒绝" },
  "c05f.char_space": { en: "space", zh: "空格" },
  "c05f.holds": { en: "{addr} holds {n} {sym}", zh: "{addr} 持有 {n} {sym}" },
  "c05f.allow_line": { en: "{n} {sym} approved · this form sends {m} for one slot", zh: "已授权 {n} {sym} · 本表单一个槽位要发 {m}" },
  "c05f.low_balance": { en: "your balance is {n} {sym}; an inscription needs at least {m} to survive the transfer tax", zh: "你的余额是 {n} {sym}；一次刻字至少需要 {m} 才能在转账税后仍达到价格" },
  "c05f.no_wallet": { en: "no wallet detected — an EIP-1193 browser wallet is required to engrave", zh: "未检测到钱包 —— 刻字需要一个 EIP-1193 浏览器钱包" },
  "c05f.wrong_chain": { en: "your wallet is on chain {net}; the worm lives on BNB Chain mainnet (56) — switch network and try again", zh: "你的钱包在第 {net} 号链上；这只线虫住在 BNB Chain 主网（56）—— 请切换网络后重试" },
  "c05f.err_slot": { en: "slot must be a whole number", zh: "槽位必须是非负整数" },
  "c05f.err_not_lived": { en: "slot {slot} has not been lived yet — the newest one is {newest}", zh: "槽位 {slot} 还没有被活过 —— 最新的是 {newest}" },
  "c05f.err_taken": { en: "slot {slot} is already engraved (\"{text}\") — the wall has no overwrite", zh: "槽位 {slot} 已经被刻过（“{text}”）—— 这面墙不允许覆盖" },
  "c05f.err_nominal": { en: "this form asks for at least {need} (the price divided by 0.97, plus a 2% margin) — sending {got} risks delivering under the price once the tax is taken", zh: "本表单至少要求 {need}（价格除以 0.97，再加 2% 余量）—— 只发 {got} 的话，扣掉税后到账额可能低于价格" },
  "c05f.step1": { en: "step 1 of 2: approving {n} for the ledger to pull — confirm in your wallet", zh: "第 1 步（共 2 步）：授权台账提取 {n} —— 请在你的钱包里确认" },
  "c05f.step2": { en: "approval landed · step 2 of 2: engraving — confirm in your wallet", zh: "授权已落链 · 第 2 步（共 2 步）：刻字 —— 请在你的钱包里确认" },
  "c05f.allow_covers": { en: "allowance already covers this — engraving, confirm in your wallet", zh: "已有授权足够 —— 正在刻字，请在你的钱包里确认" },
  "c05f.sent": { en: "sent {h}… waiting for the block", zh: "已发出 {h}… 等待出块" },
  "c05f.reverted": { en: "the transaction reverted — nothing was engraved", zh: "这笔交易回滚了 —— 什么都没刻上" },
  "c05f.engraved": { en: "engraved into slot {slot} at block {block} · {n} sent and what arrived was burned · you paid {gas} BNB gas · this can never be edited or removed", zh: "已刻入槽位 {slot}，区块 {block} · 发出 {n}，实际到账的部分已被销毁 · 你支付了 {gas} BNB 的 gas · 这条内容永远无法编辑或移除" },
  "c05f.not_engraved": { en: "not engraved: {m}", zh: "未刻成：{m}" },
  "c05f.pin_ledger": { en: "the wall handed this module a ledger it does not pin", zh: "铭文墙交给本模块的台账并不是它自己钉住的那个" },
  "c05f.pin_token": { en: "the wall handed this module a token it does not pin", zh: "铭文墙交给本模块的代币并不是它自己钉住的那个" },
  "c05f.preview": { en: "{len}/{max} · \"{text}\"", zh: "{len}/{max} · “{text}”" },
  "c05f.attached": { en: "wallet attached — the two buttons below still need your confirmation inside the wallet", zh: "钱包已连接 —— 下面两个按钮仍然需要你在钱包里逐次确认" },
  "c05f.wallet_refused": { en: "wallet refused: {m}", zh: "钱包拒绝：{m}" },
  "c05f.armed_idle": { en: "engraving armed — nothing has been sent; the form only acts after you confirm in your own wallet", zh: "刻字已装载 —— 还没有发出任何交易；这个表单只在你于自己的钱包里确认之后才会动作" },
  "c05f.armed": { en: "engraving armed — the form below is the only thing on this page that can spend, and it spends only from your wallet", zh: "刻字已装载 —— 下面这个表单是全页面唯一能花掉东西的东西，而它只花你自己钱包里的东西" },
  "c05f.load_fail": { en: "engraving module failed to load: {m}", zh: "刻字模块加载失败：{m}" },

  // ---- 06 · time-lapse ----
  "c06.title": { en: "Time-lapse (the worm's recorded past)", zh: "延时影像（这只线虫被记录下来的过去）" },
  "c06.btn_load": { en: "LOAD RECORDING", zh: "载入录像" },
  "c06.btn_loaded": { en: "RECORDING LOADED", zh: "录像已载入" },
  "c06.status_off": { en: "not loaded — ~0.4 MB of replayed on-chain frames, fetched only on click", zh: "未载入 —— 约 0.4 MB 的链上回放帧，只在点击时才取" },
  "c06.k_replay": { en: "REPLAY", zh: "录像" },
  "c06.load_fail": { en: "recording failed to load: {m}", zh: "录像载入失败：{m}" },
  "c06.note": {
    en: "Every frame is a historical eth_call replay of the brain's real state at that heartbeat's block — 302 membrane voltages plus body pose, nothing simulated or interpolated. The undulating silhouette is a schematic of the four recorded pose scalars, not a shape fit. Regenerate incrementally with scripts/gen_replay_data.mjs.",
    zh: "每一帧都是一次历史 eth_call 回放：大脑在那一拍所在区块上的真实状态 —— 302 个膜电位加躯体姿态，没有任何模拟或插值。那条起伏的剪影只是四个被记录下来的姿态标量的示意图，不是拟合出来的形状。可用 scripts/gen_replay_data.mjs 增量重新生成。",
  },
  "c06.loading": { en: "loading the recording…", zh: "正在载入录像…" },
  "c06.err_fetch": { en: "replay.json not available ({status})", zh: "replay.json 不可用（{status}）" },
  "c06.err_empty": { en: "empty recording", zh: "录像为空" },
  "c06.btn_play": { en: "▶ PLAY", zh: "▶ 播放" },
  "c06.btn_pause": { en: "⏸ PAUSE", zh: "⏸ 暂停" },
  "c06.btn_step": { en: "STEP +1", zh: "前进 +1" },
  "c06.speed": { en: "speed", zh: "速度" },
  "c06.fps": { en: "{n}/s", zh: "{n}/秒" },
  "c06.hud_frame": { en: "tick {tick} · block {block} · {ts}", zh: "心跳 {tick} · 区块 {block} · {ts}" },
  "c06.hud_fired": { en: "{n} neurons fired this step · {m} spikes lifetime", zh: "这一步有 {n} 个神经元放电 · 累计 {m} 次脉冲" },
  "c06.hud_index": { en: "frame {i}/{n}", zh: "第 {i}/{n} 帧" },
  "c06.summary": { en: "recording: {n} heartbeats (tick {from} → {to}), every frame a replayed on-chain read — generated {date}", zh: "录像：{n} 次心跳（心跳 {from} → {to}），每一帧都是一次链上状态回放 —— 生成于 {date}" },

  // ---- 07 · evidence ----
  "c07.title": { en: "Evidence (recorded mainnet verifications)", zh: "证据（已记录的主网验证）" },
  "c07.note": { en: "These are the three on-chain records kept in the project README. They are history, not live polling.", zh: "以下是项目 README 保留的三条链上记录。它们是历史，不是实时轮询。" },
  "c07.1.lbl": { en: "1 · non-deployer inject (no advance in-tx)", zh: "1 · 非部署者注入（交易内不含推进）" },
  "c07.1.desc": { en: "A funded throwaway (not the deployer) called SenseAdapter.inject(200000); brain tick stayed 6 → 6 in that transaction.", zh: "一个充了钱的临时账户（不是部署者）调用 SenseAdapter.inject(200000)；在那笔交易里大脑心跳保持 6 → 6。" },
  "c07.1.note": { en: "funding tx 0x0f8b1da2a47ea8cb2910a1b34accd6f7348b2602f3f4affd5d8f939bea1c5aa1", zh: "注资交易 0x0f8b1da2a47ea8cb2910a1b34accd6f7348b2602f3f4affd5d8f939bea1c5aa1" },
  "c07.2.lbl": { en: "2 · same-block currents accumulate, never overwrite", zh: "2 · 同区块内的电流累加，绝不覆盖" },
  "c07.2.desc": { en: "(a) stimulate(ASEL,+300000) then stimulate(ASEL,-120000) in one block → stim 200000→380000. (b) inject(250000) then inject(150000) in one block → stim 380000→780000.", zh: "（a）在同一区块内先 stimulate(ASEL,+300000) 再 stimulate(ASEL,-120000) → stim 200000→380000。（b）同一区块内先 inject(250000) 再 inject(150000) → stim 380000→780000。" },
  "c07.2.note": { en: "blocks 125298241 / 125298253", zh: "区块 125298241 / 125298253" },
  "c07.3.lbl": { en: "3 · readout.stateHash == brain.stateHash (read-only)", zh: "3 · readout.stateHash == brain.stateHash（只读）" },
  "c07.3.desc": { en: "At block 125298262 both sides read the same stateHash — WormReadout forwards brain.stateHash() directly.", zh: "在区块 125298262 上两侧读到同一个 stateHash —— WormReadout 直接转发 brain.stateHash()。" },
  "c07.3.note": { en: "During the wait window tick stayed 6 and NO advance was observed. This is a read-only stateHash equality, NOT a verified live beat.", zh: "在等待窗口内心跳保持 6，且没有观测到任何推进。这只是一次只读的 stateHash 相等验证，不是已验证的活体心跳。" },

  // ---- footer ----
  "foot.ro": { en: "READ-ONLY BY DEFAULT · TWO OPT-IN WRITE PATHS (POKE, ENGRAVE), EACH PINNED TO ONE CONTRACT AND SIGNED BY YOUR OWN WALLET", zh: "默认只读 · 两条需主动开启的写入路径（投喂、刻字），各自钉住一个合约，并由你自己的钱包签名" },
  "foot.booting": { en: "booting", zh: "启动中" },
};

// ---- the engine -------------------------------------------------------------------
// Module load must not touch the DOM: the smoke test imports this file from Node to
// prove every key carries both languages, and a top-level document access would make
// that import throw before any assertion could run.
const readStored = () => {
  try { return localStorage.getItem(LS_KEY); } catch { return null; } /* private mode */
};
const writeStored = (v) => { try { localStorage.setItem(LS_KEY, v); } catch { /* private mode */ } };

// ?lang= wins over storage, so an embedded badge or a captured screenshot can be pinned
// to one language without overwriting what the visitor chose for the rest of the site.
function detect() {
  let fromUrl = null;
  try { fromUrl = new URL(location.href).searchParams.get("lang"); } catch { /* no location, e.g. in tests */ }
  for (const candidate of [fromUrl, readStored()]) {
    if (LANGS.includes(candidate)) return candidate;
  }
  return DEFAULT_LANG;
}

let lang = detect();
const listeners = new Set();

export function getLang() { return lang; }

/** the BCP-47 tag for date and number formatting, so a Chinese page reads 14:05:07 the
 *  way a Chinese visitor expects rather than inheriting the machine's English locale */
export function localeTag() { return lang === "zh" ? "zh-CN" : "en-US"; }

/** Look a key up in the active language, then fill {param} holes.
 *  An unknown key returns the key itself: that is a visible bug in the UI instead of an
 *  exception that would take the whole polling loop down with it. */
export function t(key, params) {
  const row = MESSAGES[key];
  let out = row ? (row[lang] || row.en || key) : key;
  if (params) {
    out = out.replace(/\{(\w+)\}/g, (hole, name) =>
      (params[name] === undefined || params[name] === null ? hole : String(params[name])));
  }
  return out;
}

/** Subscribe to language changes. Lazy modules use this to repaint what they already
 *  rendered, so switching language does not have to wait for their next poll. */
export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const HTML_KEYS = ["data-i18n-html", "data-i18n"];

/** Repaint every static element the markup tagged. Values come from this file, never
 *  from the chain, so writing them as markup cannot inject anything: an element the
 *  modules fill with chain data is deliberately left without a data-i18n attribute. */
export function applyStatic(scope) {
  const root = scope || (typeof document !== "undefined" ? document : null);
  if (!root || !root.querySelectorAll) return 0;
  let painted = 0;
  for (const attr of HTML_KEYS) {
    for (const node of root.querySelectorAll(`[${attr}]`)) {
      const value = t(node.getAttribute(attr));
      if (attr === "data-i18n-html") node.innerHTML = value; else node.textContent = value;
      painted++;
    }
  }
  // attributes, e.g. data-i18n-placeholder="c05f.text_ph"
  for (const node of root.querySelectorAll("[data-i18n-placeholder]")) {
    node.placeholder = t(node.getAttribute("data-i18n-placeholder"));
    painted++;
  }
  for (const node of root.querySelectorAll("[data-i18n-title]")) {
    node.title = t(node.getAttribute("data-i18n-title"));
    painted++;
  }
  return painted;
}

// ---- labels written by script ----
// An element whose text a module overwrites must NOT carry data-i18n, or switching
// language would repaint the default label over the live state ("LOADING…" would go
// back to the word it had before). Those elements are labelled through label(), which
// remembers the key on the node, and a language switch repaints every remembered key in
// place.
export const LABEL_KEY = "labelKey";
const LABEL_PARAMS_KEY = "labelParams";
const labelAttr = (k) => `data-${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`;

/** Paint a module-owned string and remember WHICH string, so a language switch can
 *  redo the paint instead of leaving the old language on screen. Params are stored
 *  alongside the key because most of these messages carry a number or a reason. */
export function label(node, key, params) {
  if (!node) return node;
  node.dataset[LABEL_KEY] = key;
  if (params === undefined || params === null) delete node.dataset[LABEL_PARAMS_KEY];
  else node.dataset[LABEL_PARAMS_KEY] = JSON.stringify(params);
  node.textContent = t(key, params);
  return node;
}

/** Hand a node over to a module: drop every static hook so applyStatic() can never
 *  repaint the default label over the live state the module is reporting. */
export function take(node) {
  if (!node) return node;
  for (const attr of HTML_KEYS) node.removeAttribute(attr);
  node.removeAttribute("data-i18n-placeholder");
  node.removeAttribute("data-i18n-title");
  return node;
}

function applyDynamicLabels() {
  if (typeof document === "undefined") return 0;
  const nodes = document.querySelectorAll(`[${labelAttr(LABEL_KEY)}]`);
  for (const node of nodes) {
    const key = node.dataset[LABEL_KEY];
    if (!key) continue;
    let params = null;
    // the params are ours (numbers, addresses, exception messages), and they go out
    // through textContent, so a stored value can never become markup
    try { params = node.dataset[LABEL_PARAMS_KEY] ? JSON.parse(node.dataset[LABEL_PARAMS_KEY]) : null; } catch { params = null; }
    node.textContent = t(key, params);
  }
  return nodes.length;
}

function syncToggle() {
  if (typeof document === "undefined") return;
  const b = document.getElementById("lang-toggle");
  if (!b) return;
  b.textContent = t("head.lang_btn");
  b.title = t("head.lang_title");
  // the hyphen is part of the name: setAttribute("ariaPressed") would set an
  // attribute no screen reader ever reads
  b.setAttribute("aria-pressed", String(lang !== DEFAULT_LANG));
}

// A pinned ?lang= is a choice somebody else made for a link; a click is the visitor
// choosing in the moment, and the moment wins twice: the query is rewritten to match
// the click, so reloading the page cannot undo it behind the visitor's back.
function syncUrl(next) {
  if (typeof location === "undefined" || typeof history === "undefined" || !history.replaceState) return;
  try {
    const url = new URL(location.href);
    if (!url.searchParams.has("lang")) return;
    url.searchParams.set("lang", next);
    history.replaceState(null, "", url);
  } catch { /* an unreadable location: the stored choice still stands on its own */ }
}

export function setLang(next) {
  if (!LANGS.includes(next) || next === lang) return false;
  lang = next;
  writeStored(next);
  syncUrl(next);
  if (typeof document !== "undefined" && document.documentElement) document.documentElement.lang = localeTag();
  applyStatic();
  applyDynamicLabels();
  syncToggle();
  for (const fn of [...listeners]) { try { fn(next); } catch { /* one broken module must not strand the rest */ } }
  return true;
}

export function toggleLang() { return setLang(lang === "zh" ? DEFAULT_LANG : "zh"); }

/** Called once at boot: labels, markup, document lang, and the toggle's own wiring. */
export function initI18n() {
  if (typeof document === "undefined") return;
  if (document.documentElement) document.documentElement.lang = localeTag();
  const b = document.getElementById("lang-toggle");
  if (b) b.addEventListener("click", toggleLang);
  applyStatic();
  applyDynamicLabels();
  syncToggle();
}
