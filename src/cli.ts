#!/usr/bin/env node
import { createPaperEngine } from "./engine.js";
import type { PaperEngineConfig } from "./types.js";

const ENGINE_CONFIG: Partial<PaperEngineConfig> = {
  initialBalance: 10000,
  marginCurrency: "USDT",
  usdtInrRate: 85,
  makerFeeBps: 2,
  takerFeeBps: 5,
  slippageBps: 5,
  maxLeverage: 20,
  maxPositionPct: 0.5,
  symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"],
  logBasis: true,
  basisLogPath: "./logs/basis.jsonl",
};

async function runTradeDemo(): Promise<void> {
  console.log("=".repeat(60));
  console.log("BINANCE MARKET DATA + COINDCX PAPER EXECUTION");
  console.log("=".repeat(60));

  const engine = createPaperEngine(ENGINE_CONFIG);

  engine.on("started", () => console.log("[Engine] Running\n"));
  engine.on("marketData", (md) => {
    process.stdout.write(`\r[${md.symbol}] Mark: ${md.markPrice.toFixed(2)} | Bid: ${md.bidPrice.toFixed(2)} | Ask: ${md.askPrice.toFixed(2)}`);
  });
  engine.on("fill", (fill) => {
    console.log(`\n[FILL] ${fill.symbol} ${fill.side.toUpperCase()} ${fill.quantity} @ ${fill.price.toFixed(2)} | Fee: ${fill.fee.toFixed(4)} | Slippage: ${fill.slippage.toFixed(4)}`);
  });
  engine.on("orderUpdate", (order) => {
    if (order.status === "filled" || order.status === "rejected") {
      console.log(`[ORDER] ${order.symbol} ${order.side.toUpperCase()} ${order.type} ${order.status.toUpperCase()} | ID: ${order.id.slice(0, 8)}`);
    }
  });
  engine.on("positionClosed", (data) => {
    console.log(`\n[CLOSE] ${data.symbol} ${data.reason.toUpperCase()} @ ${data.exitPrice.toFixed(2)}`);
  });

  await engine.start();

  const symbols = ENGINE_CONFIG.symbols ?? ["BTCUSDT"];
  const symbol = symbols[0]!;
  
  console.log(`\nFetching initial mark price for ${symbol}...`);
  const markPrice = await engine.fetchMarkPrice(symbol);
  console.log(`Current ${symbol} mark price: ${markPrice}`);

  const capital = 1000;
  const leverage = 10;
  const qty = Math.max(1, Math.floor((capital * leverage) / markPrice));
  
  console.log(`\nPlacing LONG market order:`);
  console.log(`  Capital: ${capital} USDT`);
  console.log(`  Leverage: ${leverage}x`);
  console.log(`  Qty: ${qty} contracts`);
  console.log(`  Stop Loss: ${(markPrice * 0.99).toFixed(2)} (-1%)`);
  console.log(`  Take Profit: ${(markPrice * 1.02).toFixed(2)} (+2%)`);

  await engine.placeOrder({
    symbol: symbol as string,
    side: "buy",
    type: "market",
    quantity: qty,
    leverage,
    takeProfit: markPrice * 1.02,
    stopLoss: markPrice * 0.99,
  });

  console.log("\nMonitoring position... (Ctrl+C to stop)\n");

  const interval = setInterval(() => {
    const account = engine.getAccount();
    const pos = engine.getPosition(symbol);
    if (pos) {
      const pnlPct = ((pos.markPrice - pos.entryPrice) / pos.entryPrice) * 100 * (pos.side === "LONG" ? 1 : -1);
      console.log(`\n[POSITION] ${pos.symbol} ${pos.side} | Entry: ${pos.entryPrice.toFixed(2)} | Mark: ${pos.markPrice.toFixed(2)} | PnL: ${pos.unrealizedPnl.toFixed(2)} (${pnlPct.toFixed(2)}%) | Margin: ${pos.marginUsed.toFixed(2)}`);
      console.log(`[ACCOUNT] Equity: ${account.equity.toFixed(2)} | Available: ${account.available.toFixed(2)} | Used: ${account.usedMargin.toFixed(2)} | Realized: ${account.realizedPnl.toFixed(2)}`);
    }
  }, 5000);

  process.on("SIGINT", async () => {
    clearInterval(interval);
    console.log("\n\nShutting down...");
    await engine.closeAllPositions();
    await engine.stop();
    console.log("Final account:", engine.getAccount());
    process.exit(0);
  });
}

async function runMonitor(): Promise<void> {
  const engine = createPaperEngine(ENGINE_CONFIG);

  engine.on("started", () => console.log("[Monitor] Running - watching market data\n"));
  engine.on("marketData", (md) => {
    console.log(`[${md.symbol}] Mark: ${md.markPrice} | Spread: ${(md.askPrice - md.bidPrice).toFixed(4)} | BidQty: ${md.bidQty} | AskQty: ${md.askQty}`);
  });

  await engine.start();

  process.on("SIGINT", async () => {
    await engine.stop();
    process.exit(0);
  });
}

async function runBacktest(): Promise<void> {
  console.log("Backtest mode - fetch historical candles and simulate");
  const engine = createPaperEngine(ENGINE_CONFIG);
  
  const candles = await engine.fetchCandles("BTCUSDT", "1h", 100);
  console.log(`Fetched ${candles.length} candles for BTCUSDT`);
  
  let balance = ENGINE_CONFIG.initialBalance!;
  let position: { side: "long" | "short"; entry: number; qty: number } | null = null;
  
  for (const c of candles) {
    engine.setMarkPrice("BTCUSDT", c.close);
    
    if (!position && c.close > c.open * 1.01) {
      const qty = Math.floor((balance * 0.1 * 10) / c.close);
      position = { side: "long", entry: c.close, qty };
      balance -= c.close * qty / 10;
      console.log(`[BUY] ${c.close} x${qty}`);
    } else if (position && position.side === "long") {
      if (c.low <= position.entry * 0.99) {
        balance += position.entry * 0.99 * position.qty / 10;
        console.log(`[STOP] Exit @ ${position.entry * 0.99}`);
        position = null;
      } else if (c.high >= position.entry * 1.02) {
        balance += position.entry * 1.02 * position.qty / 10;
        console.log(`[TARGET] Exit @ ${position.entry * 1.02}`);
        position = null;
      }
    }
  }
  
  console.log(`Final balance: ${balance.toFixed(2)} (PnL: ${(balance - ENGINE_CONFIG.initialBalance!).toFixed(2)})`);
}

const command = process.argv[2] ?? "trade";

switch (command) {
  case "trade":
    await runTradeDemo();
    break;
  case "monitor":
    await runMonitor();
    break;
  case "backtest":
    await runBacktest();
    break;
  default:
    console.log("Usage: npm run paper:trade | npm run paper:monitor | npm run paper:backtest");
    process.exit(1);
}