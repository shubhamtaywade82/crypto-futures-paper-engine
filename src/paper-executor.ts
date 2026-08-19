import { v4 as uuidv4 } from "uuid";
import { EventEmitter } from "events";
import type {
  PaperEngineConfig,
  PaperOrder,
  PaperPosition,
  PaperFill,
  AccountSnapshot,
  MarketData,
  OrderSide,
  OrderType,
  OrderStatus,
  PositionSide,
} from "./types.js";

function toCoinDcxPair(symbol: string): string {
  return `B-${symbol.replace("USDT", "_USDT")}`;
}

function toBinanceSymbol(pair: string): string {
  return pair.replace("B-", "").replace("_USDT", "USDT");
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export class PaperExecutor extends EventEmitter {
  private readonly config: PaperEngineConfig;
  private orders = new Map<string, PaperOrder>();
  private positions = new Map<string, PaperPosition>();
  private account: AccountSnapshot;
  private markPrices = new Map<string, number>();
  private lastTradeId = 0;

  constructor(config: PaperEngineConfig) {
    super();
    this.config = config;
    this.account = {
      balance: config.initialBalance,
      available: config.initialBalance,
      usedMargin: 0,
      unrealizedPnl: 0,
      realizedPnl: 0,
      equity: config.initialBalance,
      marginCurrency: config.marginCurrency,
      updatedAt: Date.now(),
    };
  }

  setMarkPrice(symbol: string, price: number): void {
    this.markPrices.set(symbol, price);
    this.updatePositionMarkPrice(symbol, price);
    this.updateAccountEquity();
  }

  private updatePositionMarkPrice(symbol: string, price: number): void {
    const pos = this.positions.get(symbol);
    if (!pos) return;
    
    pos.markPrice = price;
    const contractValue = 1; // CoinDCX futures: 1 contract = 1 unit of base
    const notional = pos.quantity * price * contractValue;
    const marginUsed = notional / pos.leverage;
    
    if (pos.side === "LONG") {
      pos.unrealizedPnl = (price - pos.entryPrice) * pos.quantity * contractValue;
    } else {
      pos.unrealizedPnl = (pos.entryPrice - price) * pos.quantity * contractValue;
    }
    
    pos.marginUsed = marginUsed;
    pos.lastUpdateTime = Date.now();
  }

  private updateAccountEquity(): void {
    let totalUnrealized = 0;
    let totalUsedMargin = 0;
    
    for (const pos of this.positions.values()) {
      totalUnrealized += pos.unrealizedPnl;
      totalUsedMargin += pos.marginUsed;
    }
    
    this.account.unrealizedPnl = totalUnrealized;
    this.account.usedMargin = totalUsedMargin;
    this.account.available = this.account.balance - totalUsedMargin;
    this.account.equity = this.account.balance + totalUnrealized;
    this.account.updatedAt = Date.now();
  }

  getAccount(): AccountSnapshot {
    return { ...this.account };
  }

  getPositions(): PaperPosition[] {
    return Array.from(this.positions.values()).map(p => ({ ...p }));
  }

  getPosition(symbol: string): PaperPosition | undefined {
    const p = this.positions.get(symbol);
    return p ? { ...p } : undefined;
  }

  getOrders(filters?: { symbol?: string; status?: OrderStatus[] }): PaperOrder[] {
    let result = Array.from(this.orders.values());
    if (filters?.symbol) result = result.filter(o => o.symbol === filters.symbol);
    if (filters?.status) result = result.filter(o => filters.status!.includes(o.status));
    return result.map(o => ({ ...o }));
  }

  getOpenOrders(symbol?: string): PaperOrder[] {
    return this.getOrders({ symbol, status: ["open", "partially_filled"] });
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
    const symbol = input.symbol.toUpperCase();
    const markPrice = this.markPrices.get(symbol) ?? 
      (await this.fetchMarkPriceFallback(symbol));
    
    if (!markPrice || markPrice <= 0) {
      throw new Error(`No mark price for ${symbol}`);
    }

    const leverage = clamp(input.leverage, 1, this.config.maxLeverage);
    const marginRequired = this.calculateMarginRequired(markPrice, input.quantity, leverage);
    
    if (!input.reduceOnly && marginRequired > this.account.available) {
      const rejected = this.createOrder({
        ...input,
        symbol,
        leverage,
        status: "rejected",
        clientOrderId: input.clientOrderId ?? `bot_${uuidv4().slice(0, 28)}`,
      });
      this.orders.set(rejected.id, rejected);
      return rejected;
    }

    const order = this.createOrder({
      ...input,
      symbol,
      leverage,
      status: "open",
      clientOrderId: input.clientOrderId ?? `bot_${uuidv4().slice(0, 28)}`,
    });

    this.orders.set(order.id, order);
    
    if (!input.reduceOnly) {
      this.account.available -= marginRequired;
      this.account.usedMargin += marginRequired;
    }

    if (order.type === "market") {
      this.fillOrder(order, markPrice, false);
    }

    this.emit("orderUpdate", order);
    return order;
  }

  private async fetchMarkPriceFallback(symbol: string): Promise<number | null> {
    try {
      const res = await fetch(`${this.config.binanceRestUrl}/fapi/v1/premiumIndex?symbol=${symbol}`);
      if (!res.ok) return null;
      const data = await res.json() as { markPrice: string };
      return parseFloat(data.markPrice);
    } catch {
      return null;
    }
  }

  private createOrder(params: {
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
    clientOrderId: string;
    status: OrderStatus;
  }): PaperOrder {
    return {
      id: uuidv4(),
      clientOrderId: params.clientOrderId,
      symbol: params.symbol,
      coindcxPair: toCoinDcxPair(params.symbol),
      side: params.side,
      type: params.type,
      price: params.price,
      stopPrice: params.stopPrice,
      quantity: params.quantity,
      filledQuantity: 0,
      status: params.status,
      leverage: params.leverage,
      marginCurrency: this.config.marginCurrency,
      takeProfit: params.takeProfit,
      stopLoss: params.stopLoss,
      reduceOnly: params.reduceOnly ?? false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  private calculateMarginRequired(price: number, quantity: number, leverage: number): number {
    const notional = price * quantity;
    return notional / leverage;
  }

  private fillOrder(order: PaperOrder, marketPrice: number, isMaker: boolean): void {
    const slippage = this.applySlippage(marketPrice, order.side);
    const fillPrice = marketPrice + slippage;
    
    let fillQty = order.quantity - order.filledQuantity;
    if (Math.random() < this.config.partialFillProbability) {
      fillQty *= this.config.partialFillRatio;
    }
    fillQty = Math.max(0.001, fillQty);

    const feeRate = isMaker 
      ? this.config.makerFeeBps / 10000 
      : this.config.takerFeeBps / 10000;
    const fee = fillPrice * fillQty * feeRate;

    order.filledQuantity += fillQty;
    order.status = order.filledQuantity >= order.quantity ? "filled" : "partially_filled";
    order.updatedAt = Date.now();

    const fill: PaperFill = {
      orderId: order.id,
      symbol: order.symbol,
      side: order.side,
      price: fillPrice,
      quantity: fillQty,
      fee,
      slippage: Math.abs(slippage),
      timestamp: Date.now(),
      isMaker,
    };

    this.applyFillToPosition(order, fill, fillPrice, fee);
    this.emit("fill", fill);
    this.emit("orderUpdate", order);

    if (order.takeProfit || order.stopLoss) {
      this.placeBracketOrders(order);
    }

    if (order.status === "filled") {
      this.orders.delete(order.id);
    }
  }

  private applySlippage(price: number, side: OrderSide): number {
    const slippagePct = this.config.slippageBps / 10000;
    return side === "buy" ? price * slippagePct : -price * slippagePct;
  }

  private applyFillToPosition(order: PaperOrder, fill: PaperFill, fillPrice: number, fee: number): void {
    const existingPos = this.positions.get(order.symbol);
    const fillSide: PositionSide = order.side === "buy" ? "LONG" : "SHORT";

    if (!existingPos) {
      const marginUsed = this.calculateMarginRequired(fillPrice, fill.quantity, order.leverage);
      const position: PaperPosition = {
        id: uuidv4(),
        symbol: order.symbol,
        coindcxPair: order.coindcxPair,
        side: fillSide,
        entryPrice: fillPrice,
        markPrice: fillPrice,
        quantity: fill.quantity,
        leverage: order.leverage,
        marginUsed,
        unrealizedPnl: 0,
        realizedPnl: 0,
        takeProfit: order.takeProfit,
        stopLoss: order.stopLoss,
        entryFee: fee,
        entryTime: Date.now(),
        lastUpdateTime: Date.now(),
      };
      this.positions.set(order.symbol, position);
      this.account.balance -= fee;
      return;
    }

    const pos = existingPos;
    
    if (pos.side === fillSide) {
      const totalQty = pos.quantity + fill.quantity;
      pos.entryPrice = (pos.entryPrice * pos.quantity + fillPrice * fill.quantity) / totalQty;
      pos.quantity = totalQty;
      pos.leverage = order.leverage;
      pos.marginUsed = this.calculateMarginRequired(pos.markPrice, pos.quantity, pos.leverage);
      pos.entryFee += fee;
      this.account.balance -= fee;
      return;
    }

    const closingQty = Math.min(pos.quantity, fill.quantity);
    const pnl = pos.side === "LONG"
      ? (fillPrice - pos.entryPrice) * closingQty
      : (pos.entryPrice - fillPrice) * closingQty;

    pos.realizedPnl += pnl;
    this.account.balance += pnl - fee;
    this.account.realizedPnl += pnl;

    if (fill.quantity < pos.quantity) {
      pos.quantity -= fill.quantity;
      pos.marginUsed = this.calculateMarginRequired(pos.markPrice, pos.quantity, pos.leverage);
      return;
    }

    if (fill.quantity === pos.quantity) {
      this.positions.delete(order.symbol);
      return;
    }

    const remainingQty = fill.quantity - pos.quantity;
    const newMarginUsed = this.calculateMarginRequired(fillPrice, remainingQty, order.leverage);
    this.positions.set(order.symbol, {
      id: uuidv4(),
      symbol: order.symbol,
      coindcxPair: order.coindcxPair,
      side: fillSide,
      entryPrice: fillPrice,
      markPrice: fillPrice,
      quantity: remainingQty,
      leverage: order.leverage,
      marginUsed: newMarginUsed,
      unrealizedPnl: 0,
      realizedPnl: 0,
      takeProfit: order.takeProfit,
      stopLoss: order.stopLoss,
      entryFee: fee,
      entryTime: Date.now(),
      lastUpdateTime: Date.now(),
    });
  }

  private placeBracketOrders(entryOrder: PaperOrder): void {
    if (!entryOrder.takeProfit && !entryOrder.stopLoss) return;

    const side = entryOrder.side === "buy" ? "sell" : "buy";
    const pos = this.positions.get(entryOrder.symbol);
    if (!pos) return;

    if (entryOrder.stopLoss) {
      this.placeOrder({
        symbol: entryOrder.symbol,
        side,
        type: "stop_market",
        quantity: pos.quantity,
        stopPrice: entryOrder.stopLoss,
        leverage: entryOrder.leverage,
        reduceOnly: true,
        clientOrderId: `${entryOrder.clientOrderId}_sl`,
      });
    }

    if (entryOrder.takeProfit) {
      this.placeOrder({
        symbol: entryOrder.symbol,
        side,
        type: "limit",
        quantity: pos.quantity,
        price: entryOrder.takeProfit,
        leverage: entryOrder.leverage,
        reduceOnly: true,
        clientOrderId: `${entryOrder.clientOrderId}_tp`,
      });
    }
  }

  async cancelOrder(orderId: string): Promise<PaperOrder | undefined> {
    const order = this.orders.get(orderId);
    if (!order || order.status !== "open" && order.status !== "partially_filled") {
      return order;
    }

    if (!order.reduceOnly) {
      const unfilledQty = order.quantity - order.filledQuantity;
      const marginReleased = this.calculateMarginRequired(
        this.markPrices.get(order.symbol) ?? order.price ?? 0,
        unfilledQty,
        order.leverage
      );
      this.account.available += marginReleased;
      this.account.usedMargin -= marginReleased;
    }

    order.status = "cancelled";
    order.updatedAt = Date.now();
    this.orders.delete(orderId);
    this.emit("orderUpdate", order);
    return order;
  }

  async closePosition(symbol: string, quantity?: number): Promise<PaperPosition | undefined> {
    const pos = this.positions.get(symbol.toUpperCase());
    if (!pos) return undefined;

    const markPrice = this.markPrices.get(pos.symbol) ?? pos.markPrice;
    const qtyToClose = quantity ?? pos.quantity;
    const side = pos.side === "LONG" ? "sell" : "buy";

    const closingOrder = await this.placeOrder({
      symbol: pos.symbol,
      side,
      type: "market",
      quantity: qtyToClose,
      leverage: pos.leverage,
      reduceOnly: true,
      clientOrderId: `close_${pos.id.slice(0, 8)}`,
    });

    return this.getPosition(pos.symbol);
  }

  async closeAllPositions(): Promise<PaperPosition[]> {
    const closed: PaperPosition[] = [];
    for (const pos of this.positions.values()) {
      const result = await this.closePosition(pos.symbol);
      if (result) closed.push(result);
    }
    return closed;
  }

  onMarketData(md: MarketData): void {
    this.setMarkPrice(md.symbol, md.markPrice);
    this.checkStopOrders(md);
    this.checkLimitOrders(md);
    this.checkPositionExits(md);
  }

  private checkStopOrders(md: MarketData): void {
    for (const order of this.orders.values()) {
      if (order.status !== "open" && order.status !== "partially_filled") continue;
      if (order.symbol !== md.symbol) continue;
      if (order.type !== "stop_market") continue;
      if (order.reduceOnly) continue;

      const triggered = order.side === "buy" 
        ? md.markPrice >= (order.stopPrice ?? 0)
        : md.markPrice <= (order.stopPrice ?? 0);

      if (triggered) {
        this.fillOrder(order, md.markPrice, false);
      }
    }
  }

  private checkLimitOrders(md: MarketData): void {
    for (const order of this.orders.values()) {
      if (order.status !== "open" && order.status !== "partially_filled") continue;
      if (order.symbol !== md.symbol) continue;
      if (order.type !== "limit") continue;

      const canFill = order.side === "buy"
        ? md.markPrice <= (order.price ?? Infinity)
        : md.markPrice >= (order.price ?? -Infinity);

      if (canFill) {
        this.fillOrder(order, md.markPrice, true);
      }
    }
  }

  private checkPositionExits(md: MarketData): void {
    const pos = this.positions.get(md.symbol);
    if (!pos) return;

    let exitReason: "stop_loss" | "take_profit" | null = null;
    
    if (pos.stopLoss !== undefined) {
      if (pos.side === "LONG" && md.markPrice <= pos.stopLoss) exitReason = "stop_loss";
      if (pos.side === "SHORT" && md.markPrice >= pos.stopLoss) exitReason = "stop_loss";
    }
    
    if (pos.takeProfit !== undefined) {
      if (pos.side === "LONG" && md.markPrice >= pos.takeProfit) exitReason = "take_profit";
      if (pos.side === "SHORT" && md.markPrice <= pos.takeProfit) exitReason = "take_profit";
    }

    if (exitReason) {
      this.closePosition(pos.symbol).then(() => {
        this.emit("positionClosed", { symbol: pos.symbol, reason: exitReason, exitPrice: md.markPrice });
      });
    }
  }

  reset(): void {
    this.orders.clear();
    this.positions.clear();
    this.markPrices.clear();
    this.account = {
      balance: this.config.initialBalance,
      available: this.config.initialBalance,
      usedMargin: 0,
      unrealizedPnl: 0,
      realizedPnl: 0,
      equity: this.config.initialBalance,
      marginCurrency: this.config.marginCurrency,
      updatedAt: Date.now(),
    };
  }
}