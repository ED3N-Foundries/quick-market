import { LATE_BUY_IN_ERROR } from "../../shared/buyIn"
import type { Lang } from "../../shared/lang"

export type Copy = {
  language: string
  signIn: string
  pleaseWait: string
  openInPhantom: string
  opens: string
  settles: string
  buyIn: string
  switching: string
  priceDelayed: string
  now: string
  walletMenu: string
  disconnect: string
  grantReady: string
  grantQm: string
  depositUsdc: string
  grant: string
  deposit: string
  switchNetwork: string
  withdraw: string
  up: string
  down: string
  push: string
  amount: string
  gets: string
  order: string
  orders: string
  buyUp: string
  buyDown: string
  pageChain: (page: string, server: string) => string
  lockedPrice: string
  locked: string
  priceLocked: string
  priceLocking: string
  fromLast: string
  pushMark: string
  circleTitle: string
  qmTitle: string
  close: string
  network: string
  fromTo: string
  wallet: string
  treasury: string
  fundAmount: string
  customAmount: string
  confirmPhantom: string
  waitingConfirmations: string
  ledgerWait: (brief: string) => string
  depositSent: string
  grantMissed: string
  treasuryWait: (token: string) => string
  grantAria: string
  granting: string
  next: string
  withdrawQm: string
  withdrawUsdc: string
  toWallet: string
  spendable: string
  withdrawAmount: string
  max: string
  withdrawing: string
  paysQm: string
  secondUnit: string
  previousMarkets: string
  lastTen: string
  all: string
  myTrades: string
  noRounds: string
  time: string
  result: string
  open: string
  closePrice: string
  feed: string
  bought: string
  back: string
  replay: string
  replayMiss: string
  emptyPool: string
  void: string
  youWin: string
  lost: string
  elapsed: (timer: string) => string
  periods: (windowSeconds: number, marketSeconds: number) => string
  ruleFinish: string
  ruleVoid: string
  ruleDrop: string
  feeLine: (fee: string, source: string) => string
  connection: string
  live: string
  slow: string
  reconnecting: string
  lagUp: string
  lagDown: string
  roundTrip: string
  connectionName: (state: string, ms: number | null) => string
  lateBuyIn: string
  paceHour: string
  paceHours: (hours: number) => string
  paceMinute: string
  paceMinutes: (minutes: number) => string
  paceSeconds: (seconds: number) => string
  grantButton: (amount: string) => string
  grantReadyAmount: (amount: string) => string
  nextGrant: (wait: string) => string
  grantSentence: (amount: string, pace: string) => string
  ready: string
  waitHours: (hours: number) => string
  waitHoursMinutes: (hours: number, minutes: number) => string
  waitMinutes: (minutes: number) => string
  waitSeconds: (seconds: number) => string
  quoteBack: string
  quoteGets: (money: string) => string
  chainTestnetMenu: string
  chainTestnetBadge: string
  chainTestnetNetwork: string
  chainMainnet: string
  waitingPhantom: string
  approveSignIn: string
  signedBalance: string
  confirmingSignIn: string
  stepPhantom: string
  stepApprove: string
  stepBalance: string
  stepConfirm: string
  mintingGrant: string
  confirmationsIn: string
  waitingOne: string
  waitingMany: (left: number) => string
}

const en: Copy = {
  language: "Language",
  signIn: "Sign in",
  pleaseWait: "Please wait",
  openInPhantom: "Open in Phantom",
  opens: "Opens",
  settles: "Settles",
  buyIn: "Buy-in",
  switching: "Switching price source",
  priceDelayed: "Price delayed",
  now: "Now",
  walletMenu: "Wallet menu",
  disconnect: "Disconnect",
  grantReady: "Grant ready",
  grantQm: "Grant QM USDC",
  depositUsdc: "Deposit USDC",
  grant: "Grant",
  deposit: "Deposit",
  switchNetwork: "Switch network",
  withdraw: "Withdraw",
  up: "Up",
  down: "Down",
  push: "Push",
  amount: "Amount",
  gets: "Gets",
  order: "order",
  orders: "orders",
  buyUp: "Buy up",
  buyDown: "Buy down",
  pageChain: (page, server) => `This page is on ${page} and the server is on ${server}.`,
  lockedPrice: "Locked price",
  locked: "Locked",
  priceLocked: "Price locked",
  priceLocking: "Price locking",
  fromLast: "from last",
  pushMark: "= Push",
  circleTitle: "Circle USDC on Base",
  qmTitle: "Quick Market USDC on Base Sepolia. Play money, not Circle USDC.",
  close: "Close",
  network: "Network",
  fromTo: "From → To",
  wallet: "Wallet",
  treasury: "Treasury",
  fundAmount: "Fund amount",
  customAmount: "Custom amount",
  confirmPhantom: "Confirm in Phantom…",
  waitingConfirmations: "Waiting for 3 confirmations…",
  ledgerWait: (brief) => `Transfer sent. Waiting for the ledger.${brief ? ` ${brief}` : ""}`,
  depositSent: "Deposit sent. It will show after confirmation.",
  grantMissed: "The grant did not land. Try again.",
  treasuryWait: (token) => `Transfer sent. The ${token} is in the treasury and will be credited when the server is back.`,
  grantAria: "Grant QM USDC",
  granting: "Granting…",
  next: "Next",
  withdrawQm: "Withdraw QM USDC",
  withdrawUsdc: "Withdraw USDC",
  toWallet: "To wallet",
  spendable: "Spendable",
  withdrawAmount: "Withdraw amount",
  max: "Max",
  withdrawing: "Withdrawing…",
  paysQm: "Pays QM USDC to your wallet on Base Sepolia.",
  secondUnit: "s",
  previousMarkets: "Previous markets",
  lastTen: "(last 10)",
  all: "All",
  myTrades: "My trades",
  noRounds: "No settled rounds yet.",
  time: "Time",
  result: "Result",
  open: "Open",
  closePrice: "Close",
  feed: "Feed",
  bought: "Bought",
  back: "Back",
  replay: "Market replay",
  replayMiss: "Couldn't load this market.",
  emptyPool: "No one in this pool.",
  void: "Void",
  youWin: "You win",
  lost: "Lost",
  elapsed: (timer) => `Elapsed time ${timer}`,
  periods: (windowSeconds, marketSeconds) => `Buy-in ${windowSeconds}s · Market ${marketSeconds}s`,
  ruleFinish: "Up finishes above the open. Down finishes below. Push is a tie, and stakes return.",
  ruleVoid: "If a market never gets a price, it is void and stakes return.",
  ruleDrop: "If the price feed drops during a market, that market is void and stakes return. The next feed is shown before buy-in opens.",
  feeLine: (fee, source) => `${fee}% fee on a paid pool. Price from ${source}.`,
  connection: "Connection",
  live: "Live",
  slow: "Slow",
  reconnecting: "Reconnecting",
  lagUp: "Up",
  lagDown: "Down",
  roundTrip: "Round trip",
  connectionName: (state, ms) => (ms == null ? `Connection, ${state}` : `Connection, ${state}, ${ms} milliseconds`),
  lateBuyIn: LATE_BUY_IN_ERROR,
  paceHour: "once an hour",
  paceHours: (hours) => `once every ${hours} hours`,
  paceMinute: "once a minute",
  paceMinutes: (minutes) => `once every ${minutes} minutes`,
  paceSeconds: (seconds) => `once every ${seconds}s`,
  grantButton: (amount) => `Grant ${amount}`,
  grantReadyAmount: (amount) => `Grant ready · ${amount}`,
  nextGrant: (wait) => `Next grant in ${wait}`,
  grantSentence: (amount, pace) =>
    `Quick Market adds ${amount} QM USDC to this balance ${pace}. The wallet is not charged, and Phantom is not involved.`,
  ready: "Ready",
  waitHours: (hours) => `${hours}h`,
  waitHoursMinutes: (hours, minutes) => `${hours}h ${minutes}m`,
  waitMinutes: (minutes) => `${minutes}m`,
  waitSeconds: (seconds) => `${seconds}s`,
  quoteBack: "$1 back",
  quoteGets: (money) => `$1 gets ${money}`,
  chainTestnetMenu: "Base Sepolia · Testnet",
  chainTestnetBadge: "Base Sepolia Testnet",
  chainTestnetNetwork: "Base Sepolia (Testnet)",
  chainMainnet: "Base Mainnet",
  waitingPhantom: "Waiting for Phantom",
  approveSignIn: "Approve the sign-in in Phantom",
  signedBalance: "Signed. Adding your balance on Base Sepolia. This can take a bit.",
  confirmingSignIn: "Confirming sign-in",
  stepPhantom: "Phantom",
  stepApprove: "Approve",
  stepBalance: "Balance",
  stepConfirm: "Confirm",
  mintingGrant: "Minting the grant on Base Sepolia. This can take a bit.",
  confirmationsIn: "Confirmations in. Crediting the balance.",
  waitingOne: "Waiting on 1 confirmation",
  waitingMany: (left) => `Waiting on ${left} confirmations`,
}

const zhTW: Copy = {
  language: "語言",
  signIn: "登入",
  pleaseWait: "請稍候",
  openInPhantom: "用 Phantom 開啟",
  opens: "開放",
  settles: "結算",
  buyIn: "下注",
  switching: "正在切換報價來源",
  priceDelayed: "報價延遲",
  now: "回到現在",
  walletMenu: "錢包選單",
  disconnect: "中斷連線",
  grantReady: "可以領取",
  grantQm: "領取 QM USDC",
  depositUsdc: "存入 USDC",
  grant: "領取",
  deposit: "存入",
  switchNetwork: "切換網路",
  withdraw: "提領",
  up: "上漲",
  down: "下跌",
  push: "平手",
  amount: "金額",
  gets: "可得",
  order: "筆",
  orders: "筆",
  buyUp: "買上漲",
  buyDown: "買下跌",
  pageChain: (page, server) => `此頁在 ${page}，伺服器在 ${server}。`,
  lockedPrice: "鎖定價格",
  locked: "已鎖定",
  priceLocked: "價格已鎖定",
  priceLocking: "價格鎖定中",
  fromLast: "較上一筆",
  pushMark: "＝ 平手",
  circleTitle: "Circle USDC（Base）",
  qmTitle: "Quick Market USDC（Base Sepolia）。這是遊戲代幣，不是 Circle USDC。",
  close: "關閉",
  network: "網路",
  fromTo: "從 → 到",
  wallet: "錢包",
  treasury: "資金庫",
  fundAmount: "存入金額",
  customAmount: "自訂金額",
  confirmPhantom: "請在 Phantom 確認…",
  waitingConfirmations: "等待 3 次確認…",
  ledgerWait: (brief) => `轉帳已送出。正在等待入帳。${brief ? ` ${brief}` : ""}`,
  depositSent: "存款已送出。確認後會顯示。",
  grantMissed: "撥款未完成。請再試一次。",
  treasuryWait: (token) => `轉帳已送出。${token} 已在資金庫，伺服器恢復後會入帳。`,
  grantAria: "領取 QM USDC",
  granting: "領取中…",
  next: "下次",
  withdrawQm: "提領 QM USDC",
  withdrawUsdc: "提領 USDC",
  toWallet: "到錢包",
  spendable: "可用餘額",
  withdrawAmount: "提領金額",
  max: "最大",
  withdrawing: "提領中…",
  paysQm: "將 QM USDC 匯到你在 Base Sepolia 的錢包。",
  secondUnit: "秒",
  previousMarkets: "先前的市場",
  lastTen: "（最近 10 筆）",
  all: "全部",
  myTrades: "我的交易",
  noRounds: "還沒有結算的場次。",
  time: "時間",
  result: "結果",
  open: "開盤",
  closePrice: "收盤",
  feed: "報價",
  bought: "買入",
  back: "拿回",
  replay: "市場重播",
  replayMiss: "無法載入這場。",
  emptyPool: "這個池子沒有人。",
  void: "作廢",
  youWin: "你贏了",
  lost: "輸了",
  elapsed: (timer) => `已經過 ${timer}`,
  periods: (windowSeconds, marketSeconds) => `下注 ${windowSeconds} 秒 · 市場 ${marketSeconds} 秒`,
  ruleFinish: "收盤高於開盤為上漲。收盤低於開盤為下跌。平手退回本金。",
  ruleVoid: "若一場沒有報價，該場作廢並退回本金。",
  ruleDrop: "若報價在場中中斷，該場作廢並退回本金。下一個報價來源會在下注開放前顯示。",
  feeLine: (fee, source) => `有人贏的池子收取 ${fee}% 費用。報價來自 ${source}。`,
  connection: "連線",
  live: "正常",
  slow: "偏慢",
  reconnecting: "重新連線",
  lagUp: "上行",
  lagDown: "下行",
  roundTrip: "往返",
  connectionName: (state, ms) => (ms == null ? `連線，${state}` : `連線，${state}，${ms} 毫秒`),
  lateBuyIn: "下注太晚才送到。那場已經結束。再試一次！",
  paceHour: "每小時一次",
  paceHours: (hours) => `每 ${hours} 小時一次`,
  paceMinute: "每分鐘一次",
  paceMinutes: (minutes) => `每 ${minutes} 分鐘一次`,
  paceSeconds: (seconds) => `每 ${seconds} 秒一次`,
  grantButton: (amount) => `領取 ${amount}`,
  grantReadyAmount: (amount) => `可以領取 · ${amount}`,
  nextGrant: (wait) => `下次領取還要 ${wait}`,
  grantSentence: (amount, pace) =>
    `Quick Market ${pace}，把 ${amount} QM USDC 加進這個餘額。不會向錢包扣款，也不經過 Phantom。`,
  ready: "可領取",
  waitHours: (hours) => `${hours} 小時`,
  waitHoursMinutes: (hours, minutes) => `${hours} 小時 ${minutes} 分`,
  waitMinutes: (minutes) => `${minutes} 分`,
  waitSeconds: (seconds) => `${seconds} 秒`,
  quoteBack: "$1 退回",
  quoteGets: (money) => `$1 可得 ${money}`,
  chainTestnetMenu: "Base Sepolia · 測試網",
  chainTestnetBadge: "Base Sepolia 測試網",
  chainTestnetNetwork: "Base Sepolia（測試網）",
  chainMainnet: "Base 主網",
  waitingPhantom: "正在等待 Phantom",
  approveSignIn: "請在 Phantom 核准登入",
  signedBalance: "已簽名。正在把餘額加到 Base Sepolia。可能需要一點時間。",
  confirmingSignIn: "正在確認登入",
  stepPhantom: "Phantom",
  stepApprove: "核准",
  stepBalance: "餘額",
  stepConfirm: "確認",
  mintingGrant: "正在 Base Sepolia 鑄造撥款。可能需要一點時間。",
  confirmationsIn: "確認已完成。正在入帳。",
  waitingOne: "還差 1 次確認",
  waitingMany: (left) => `還差 ${left} 次確認`,
}

export function copy(lang: Lang): Copy {
  return lang === "zh-TW" ? zhTW : en
}

const zhFixed: Record<string, string> = {
  "Switch cancelled": "已取消切換",
  "Turn on Testnet Mode in Phantom: Settings → Developer Settings.": "請在 Phantom 開啟測試網模式：設定 → 開發者設定。",
  "This network is not available in Phantom.": "Phantom 沒有這個網路。",
  "Could not switch network": "無法切換網路",
  "Sign-in failed": "登入失敗",
  "Phantom is not ready": "Phantom 尚未就緒",
  "Phantom needs an https link to this page.": "Phantom 需要這個頁面的 https 連結。",
  "Amount is invalid": "金額無效",
  "Sign in with this wallet before depositing.": "存入前請先用這個錢包登入。",
  "Wallet is not ready": "錢包尚未就緒",
  "Treasury is not ready": "資金庫尚未就緒",
  "This page and the server are on different chains.": "此頁和伺服器不在同一條鏈。",
  "Market server is not running.": "市場伺服器沒有在跑。",
  "Deposit failed": "存入失敗",
  "Deposit cancelled": "已取消存入",
  "Chain is invalid": "鏈別無效",
  "Connect a wallet first": "請先連接錢包",
  "Can't reach the market server": "連不到市場伺服器",
  "Withdraw failed": "提領失敗",
  "Sign in to receive a grant.": "登入後才能領取撥款。",
  [en.grantMissed]: zhTW.grantMissed,
  [en.depositSent]: zhTW.depositSent,
  [LATE_BUY_IN_ERROR]: zhTW.lateBuyIn,
  "Price feed is delayed": "報價延遲",
  "Buy-in is closed": "下注已結束",
  "Side is invalid": "方向無效",
  "Stake is invalid": "金額無效",
  "Market is invalid": "市場無效",
  "Not found": "找不到",
  "Round not found": "找不到這場",
  "Server error": "伺服器錯誤",
}

/** Translate a stored English sentence. Unknown text stays as it is. */
export function localize(lang: Lang, message: string): string {
  if (lang !== "zh-TW") return message
  const fixed = zhFixed[message]
  if (fixed) return fixed
  const wait = /^Waiting on (\d+) confirmation(s)?$/.exec(message)
  if (wait) {
    const left = Number(wait[1])
    return left === 1 ? zhTW.waitingOne : zhTW.waitingMany(left)
  }
  const gas = /^This wallet needs (.+) ETH for gas\.$/.exec(message)
  if (gas) return `這個錢包需要 ${gas[1]} 的 ETH 付手續費。`
  const balance = /^This wallet does not have enough (.+) on (.+)\.$/.exec(message)
  if (balance) return `這個錢包在 ${balance[2]} 的 ${balance[1]} 不夠。`
  const ledger = /^Transfer sent\. Waiting for the ledger\. ?(.*)$/.exec(message)
  if (ledger) return zhTW.ledgerWait(ledger[1] ?? "")
  const treasury = /^Transfer sent\. The (.+) is in the treasury and will be credited when the server is back\.$/.exec(message)
  if (treasury) return zhTW.treasuryWait(treasury[1] ?? "")
  const dropped = /^(.+) dropped$/.exec(message)
  if (dropped) return `${dropped[1]} 中斷`
  return message
}
