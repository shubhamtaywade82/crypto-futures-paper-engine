export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit" | "stop_market";
export type OrderStatus = "open" | "filled" | "partially_filled" | "cancelled" | "rejected";
export type PositionSide = "LONG" | "SHORT";

export interface PaperOrder {
  id: string;
  clientOrderId: string;
  symbol: string;           // Binance format: BTCUSDT
  coindcxPair: string;      // CoinDCX format: B-BTC_USDT
  side: OrderSide;
  type: OrderType;
  price?: number;           // limit price
  stopPrice?: number;       // stop trigger
  quantity: number;
  filledQuantity: number;
  status: OrderStatus;
  leverage: number;
  marginCurrency: "USDT" | "INR";
  takeProfit?: number;
  stopLoss?: number;
  reduceOnly: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface PaperPosition {
  id: string;
  symbol: string;           // Binance format
  coindcxPair: string;      // CoinDCX format
  side: PositionSide;
  entryPrice: number;
  markPrice: number;
  quantity: number;
  leverage: number;
  marginUsed: number;       // in margin currency
  unrealizedPnl: number;    // in margin currency
  realizedPnl: number;      // in margin currency
  takeProfit?: number;
  stopLoss?: number;
  entryFee: number;
  entryTime: number;
  lastUpdateTime: number;
}

export interface PaperFill {
  orderId: string;
  symbol: string;
  side: OrderSide;
  price: number;
  quantity: number;
  fee: number;
  slippage: number;
  timestamp: number;
  isMaker: boolean;
}

export interface AccountSnapshot {
  balance: number;          // total wallet balance (margin currency)
  available: number;        // available for trading
  usedMargin: number;       // locked in positions
  unrealizedPnl: number;
  realizedPnl: number;
  equity: number;           // balance + unrealizedPnl
  marginCurrency: "USDT" | "INR";
  updatedAt: number;
}

export interface MarketData {
  symbol: string;           // Binance format
  markPrice: number;
  bidPrice: number;
  askPrice: number;
  bidQty: number;
  askQty: number;
  timestamp: number;
  fundingRate?: number;
  openInterest?: number;
}

export interface Candle {
  symbol: string;
  interval: string;
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  trades: number;
  closed: boolean;
}

export interface PaperEngineConfig {
  // Market data (Binance)
  binanceWsUrl: string;
  binanceRestUrl: string;
  
  // Paper trading settings
  initialBalance: number;
  marginCurrency: "USDT" | "INR";
  usdtInrRate: number;
  
  // Fee model (CoinDCX futures)
  makerFeeBps: number;      // 0.02% = 2
  takerFeeBps: number;      // 0.05% = 5
  fundingFeeEstBps: number; // estimated 8h funding
  
  // Slippage model
  slippageBps: number;      // 0.05% = 5
  partialFillProbability: number; // 0.1 = 10%
  partialFillRatio: number; // 0.5 = 50%
  
  // Risk
  maxLeverage: number;
  maxPositionPct: number;   // max % of equity per position
  maxTotalPositions: number;
  
  // Drift tracking
  logBasis: boolean;
  basisLogPath: string;
  
  // Symbols
  symbols: string[];        // Binance format: ["BTCUSDT", "ETHUSDT"]
}

export const DEFAULT_CONFIG: PaperEngineConfig = {
  binanceWsUrl: "wss://fstream.binance.com",
  binanceRestUrl: "https://fapi.binance.com",
  initialBalance: 10000,
  marginCurrency: "USDT",
  usdtInrRate: 85,
  makerFeeBps: 2,
  takerFeeBps: 5,
  fundingFeeEstBps: 1,
  slippageBps: 5,
  partialFillProbability: 0.1,
  partialFillRatio: 0.5,
  maxLeverage: 20,
  maxPositionPct: 0.5,
  maxTotalPositions: 10,
  logBasis: true,
  basisLogPath: "./logs/basis.jsonl",
  symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT"],
};