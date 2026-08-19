import { EventEmitter } from "events";
import { BinanceMarketFeed } from "./binance-feed.js";
import { PaperExecutor } from "./paper-executor.js";
import type {
  PaperEngineConfig,
  MarketData,
  Candle,
  PaperOrder,
  PaperPosition,
  AccountSnapshot,
  PaperFill,
  OrderSide,
  OrderType,
  OrderStatus,
} from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

export class BinanceCoinDcxPaperEngine extends EventEmitter {
  private readonly config: PaperEngineConfig;
  private readonly feed: BinanceMarketFeed;
  private readonly executor: PaperExecutor;
  private running = false;
  private basisLogEnabled: boolean;

  constructor(config: Partial<PaperEngineConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.basisLogEnabled = this.config.logBasis;

    this.feed = new BinanceMarketFeed({
      binanceWsUrl: this.config.binanceWsUrl,
      binanceRestUrl: this.config.binanceRestUrl,
      symbols: this.config.symbols,
    });

    this.executor = new PaperExecutor(this.config);

    this.setupFeedHandlers();
    this.setupExecutorHandlers();
  }

  private setupFeedHandlers(): void {
    this.feed.on("marketData", (md: MarketData) => {
      this.executor.onMarketData(md);
      this.emit("marketData", md);
    });

    this.feed.on("candle", (candle: Candle) => {
      this.emit("candle", candle);
    });

    this.feed.on("markPrice", (data: { symbol: string; markPrice: number; timestamp: number }) => {
      if (this.basisLogEnabled) {
        this.logBasis(data.symbol, data.markPrice, "mark");
      }
    });
  }

  private setupExecutorHandlers(): void {
    this.executor.on("fill", (fill: PaperFill) => {
      this.emit("fill", fill);
      if (this.basisLogEnabled) {
        this.logBasis(fill.symbol, fill.price, fill.side === "buy" ? "entry" : "exit");
      }
    });

    this.executor.on("orderUpdate", (order: PaperOrder) => {
      this.emit("orderUpdate", order);
    });

    this.executor.on("positionClosed", (data: { symbol: string; reason: string; exitPrice: number }) => {
      this.emit("positionClosed", data);
    });
  }

  private async logBasis(symbol: string, binancePrice: number, eventType: "entry" | "exit" | "mark"): Promise<void> {
    try {
      const coindcxPrice = await this.fetchCoinDcxPrice(symbol);
      if (coindcxPrice === null) return;
      
      const basisBps = ((coindcxPrice - binancePrice) / binancePrice) * 10_000;
      const record = {
        ts: new Date().toISOString(),
        symbol,
        eventType,
        binancePrice,
        coindcxPrice,
        basisBps,
      };
      
      const logDir = dirname(this.config.basisLogPath);
      if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
      appendFileSync(this.config.basisLogPath, `${JSON.stringify(record)}\n`);
    } catch {
      // best-effort
    }
  }

  private async fetchCoinDcxPrice(symbol: string): Promise<number | null> {
    try {
      const res = await fetch("https://api.coindcx.com/exchange/ticker");
      if (!res.ok) return null;
      const tickers = await res.json() as Array<{ market: string; last_price: string }>;
      const coindcxPair = `B-${symbol.replace("USDT", "_USDT")}`;
      const hit = tickers.find(t => t.market === coindcxPair);
      return hit ? Number(hit.last_price) : null;
    } catch {
      return null;
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.feed.connect();
    this.running = true;
    this.emit("started");
    console.log("[PaperEngine] Started with Binance market data + simulated CoinDCX execution");
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    await this.feed.disconnect();
    this.running = false;
    this.emit("stopped");
    console.log("[PaperEngine] Stopped");
  }

  isRunning(): boolean {
    return this.running;
  }

  getConfig(): PaperEngineConfig {
    return { ...this.config };
  }

  getAccount(): AccountSnapshot {
    return this.executor.getAccount();
  }

  getPositions(): PaperPosition[] {
    return this.executor.getPositions();
  }

  getPosition(symbol: string): PaperPosition | undefined {
    return this.executor.getPosition(symbol);
  }

  getOrders(filters?: { symbol?: string; status?: OrderStatus[] }): PaperOrder[] {
    return this.executor.getOrders(filters);
  }

  setMarkPrice(symbol: string, price: number): void {
    this.executor.setMarkPrice(symbol, price);
  }

  async placeOrder(input: {
    symbol: string;
    side: OrderSide;
    type: OrderType;
    quantity: number;
    price?: number;
    stopPrice?: number;
    leverage: number;
    takeProfit?: number;
    stopLoss?: number;
    reduceOnly?: boolean;
    clientOrderId?: string;
  }): Promise<PaperOrder> {
    return this.executor.placeOrder(input);
  }

  async cancelOrder(orderId: string): Promise<PaperOrder | undefined> {
    return this.executor.cancelOrder(orderId);
  }

  async closePosition(symbol: string, quantity?: number): Promise<PaperPosition | undefined> {
    return this.executor.closePosition(symbol, quantity);
  }

  async closeAllPositions(): Promise<PaperPosition[]> {
    return this.executor.closeAllPositions();
  }

  async fetchCandles(symbol: string, interval: string, limit?: number): Promise<Candle[]> {
    return this.feed.fetchCandles(symbol, interval, limit);
  }

  async fetchMarkPrice(symbol: string): Promise<number> {
    return this.feed.fetchMarkPrice(symbol);
  }

  async fetchFundingRate(symbol: string): Promise<number> {
    return this.feed.fetchFundingRate(symbol);
  }

  async fetchOpenInterest(symbol: string): Promise<number> {
    return this.feed.fetchOpenInterest(symbol);
  }

  reset(): void {
    this.executor.reset();
    this.emit("reset");
  }

  subscribeOrderbook(symbol: string): AsyncIterable<{ symbol: string; bids: [number, number][]; asks: [number, number][]; timestamp: number }> {
    return (async function* () {
      // Simplified - in production use feed.subscribeOrderbook
      yield { symbol, bids: [], asks: [], timestamp: Date.now() };
    })();
  }
}

export function createPaperEngine(config?: Partial<PaperEngineConfig>): BinanceCoinDcxPaperEngine {
  return new BinanceCoinDcxPaperEngine(config);
}