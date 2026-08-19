import WebSocket from "ws";
import { EventEmitter } from "events";
import type { MarketData, Candle, PaperEngineConfig } from "./types.js";

type BinanceWsMessage =
  | { e: "markPriceUpdate"; s: string; p: string; i: string; r: string; T: number }
  | { e: "bookTicker"; s: string; b: string; B: string; a: string; A: string; T: number }
  | { e: "kline"; s: string; k: { t: number; T: number; o: string; h: string; l: string; c: string; v: string; q: string; n: number; x: boolean } }
  | { e: "depthUpdate"; s: string; b: [string, string][]; a: [string, string][]; u: number };

type BinanceCombinedStreamMsg = {
  stream: string;
  data: BinanceWsMessage;
};

export class BinanceMarketFeed extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly symbols: string[];
  private readonly wsUrl: string;
  private readonly restUrl: string;
  private readonly log: Console;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private markPriceCache = new Map<string, { price: number; timestamp: number }>();
  private bookTickerCache = new Map<string, { bid: number; ask: number; bidQty: number; askQty: number; timestamp: number }>();

  constructor(config: Pick<PaperEngineConfig, "binanceWsUrl" | "binanceRestUrl" | "symbols">) {
    super();
    this.wsUrl = config.binanceWsUrl;
    this.restUrl = config.binanceRestUrl;
    this.symbols = config.symbols;
    this.log = console;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.buildStreamUrl());
      
      this.ws.on("open", () => {
        this.log.info("[BinanceFeed] Connected");
        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString()) as BinanceWsMessage;
          this.handleMessage(msg);
        } catch (e) {
          this.log.warn("[BinanceFeed] Parse error", e);
        }
      });

      this.ws.on("error", (err) => {
        this.log.error("[BinanceFeed] WS error", err);
        reject(err);
      });

      this.ws.on("close", () => {
        this.log.warn("[BinanceFeed] Disconnected, reconnecting...");
        this.scheduleReconnect();
      });
    });
  }

  private buildStreamUrl(): string {
    const streams = this.symbols.flatMap(s => [
      `${s.toLowerCase()}@markPrice@1s`,
      `${s.toLowerCase()}@bookTicker`,
    ]).join("/");
    return `${this.wsUrl}/stream?streams=${streams}`;
  }

  private handleMessage(msg: BinanceWsMessage | BinanceCombinedStreamMsg): void {
    if ("stream" in msg) {
      this.processStreamData(msg.data);
    } else {
      this.processStreamData(msg);
    }
  }

  private processStreamData(data: BinanceWsMessage): void {
    switch (data.e) {
      case "markPriceUpdate": {
        const price = parseFloat(data.p);
        this.markPriceCache.set(data.s, { price, timestamp: data.T });
        this.emit("markPrice", {
          symbol: data.s,
          markPrice: price,
          timestamp: data.T,
        });
        this.maybeEmitMarketData(data.s);
        break;
      }
      case "bookTicker": {
        const bid = parseFloat(data.b);
        const ask = parseFloat(data.a);
        const bidQty = parseFloat(data.B);
        const askQty = parseFloat(data.A);
        this.bookTickerCache.set(data.s, { bid, ask, bidQty, askQty, timestamp: data.T });
        this.maybeEmitMarketData(data.s);
        break;
      }
      case "kline": {
        if (data.k.x) {
          const candle: Candle = {
            symbol: data.s,
            interval: "1m",
            openTime: data.k.t,
            open: parseFloat(data.k.o),
            high: parseFloat(data.k.h),
            low: parseFloat(data.k.l),
            close: parseFloat(data.k.c),
            volume: parseFloat(data.k.v),
            quoteVolume: parseFloat(data.k.q),
            trades: data.k.n,
            closed: true,
          };
          this.emit("candle", candle);
        }
        break;
      }
    }
  }

  private maybeEmitMarketData(symbol: string): void {
    const mark = this.markPriceCache.get(symbol);
    const book = this.bookTickerCache.get(symbol);
    if (mark && book) {
      const md: MarketData = {
        symbol,
        markPrice: mark.price,
        bidPrice: book.bid,
        askPrice: book.ask,
        bidQty: book.bidQty,
        askQty: book.askQty,
        timestamp: Math.max(mark.timestamp, book.timestamp),
      };
      this.emit("marketData", md);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect().catch(() => {}), 5000);
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  async fetchCandles(symbol: string, interval: string, limit = 200): Promise<Candle[]> {
    const url = `${this.restUrl}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance REST error ${res.status}`);
    const raw = await res.json() as [number, string, string, string, string, string, number, string, number][];
    return raw.map(([t, o, h, l, c, v, _ct, qv, n]) => ({
      symbol,
      interval,
      openTime: t,
      open: parseFloat(o),
      high: parseFloat(h),
      low: parseFloat(l),
      close: parseFloat(c),
      volume: parseFloat(v),
      quoteVolume: parseFloat(qv),
      trades: n,
      closed: true,
    }));
  }

  async fetchMarkPrice(symbol: string): Promise<number> {
    const res = await fetch(`${this.restUrl}/fapi/v1/premiumIndex?symbol=${symbol}`);
    if (!res.ok) throw new Error(`Mark price fetch failed ${res.status}`);
    const data = await res.json() as { markPrice: string };
    return parseFloat(data.markPrice);
  }

  async fetchFundingRate(symbol: string): Promise<number> {
    const res = await fetch(`${this.restUrl}/fapi/v1/fundingRate?symbol=${symbol}&limit=1`);
    if (!res.ok) throw new Error(`Funding rate fetch failed ${res.status}`);
    const data = await res.json() as [{ fundingRate: string }];
    return parseFloat(data[0]?.fundingRate ?? "0");
  }

  async fetchOpenInterest(symbol: string): Promise<number> {
    const res = await fetch(`${this.restUrl}/fapi/v1/openInterest?symbol=${symbol}`);
    if (!res.ok) throw new Error(`OI fetch failed ${res.status}`);
    const data = await res.json() as { openInterest: string };
    return parseFloat(data.openInterest);
  }

  getLatestMarkPrice(symbol: string): number | undefined {
    return this.markPriceCache.get(symbol)?.price;
  }

  getLatestBookTicker(symbol: string): { bid: number; ask: number } | undefined {
    const b = this.bookTickerCache.get(symbol);
    return b ? { bid: b.bid, ask: b.ask } : undefined;
  }
}