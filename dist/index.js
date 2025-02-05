// src/actions/priceCheck.ts
import {
  composeContext,
  elizaLogger as elizaLogger2,
  generateObjectDeprecated,
  ModelClass
} from "@elizaos/core";

// src/services/base.ts
import { Spot } from "@binance/connector";
import { elizaLogger } from "@elizaos/core";

// src/constants/api.ts
var API_DEFAULTS = {
  BASE_URL: "https://api.binance.com",
  TIMEOUT: 3e4,
  // 30 seconds
  RATE_LIMIT: {
    MAX_REQUESTS_PER_MINUTE: 1200,
    WEIGHT_PER_REQUEST: 1
  }
};
var ORDER_TYPES = {
  MARKET: "MARKET",
  LIMIT: "LIMIT"
};
var TIME_IN_FORCE = {
  GTC: "GTC",
  // Good Till Cancel
  IOC: "IOC",
  // Immediate or Cancel
  FOK: "FOK"
  // Fill or Kill
};

// src/constants/errors.ts
var ERROR_CODES = {
  INVALID_CREDENTIALS: 401,
  INVALID_PARAMETERS: 400,
  INSUFFICIENT_BALANCE: -1012,
  MIN_NOTIONAL_NOT_MET: -1013,
  UNKNOWN_ORDER_COMPOSITION: -1111,
  PRICE_QTY_EXCEED_HARD_LIMITS: -1021
};
var ERROR_MESSAGES = {
  INVALID_CREDENTIALS: "Invalid API credentials. Please check your API key and secret.",
  INVALID_SYMBOL: "Invalid trading pair symbol",
  SYMBOL_NOT_FOUND: (symbol) => `Trading pair ${symbol} is not available`,
  MIN_NOTIONAL_NOT_MET: (minNotional) => `Order value is too small. Please increase the quantity to meet the minimum order value requirement.${minNotional ? ` Minimum order value is ${minNotional} USDC.` : ""}`,
  LIMIT_ORDER_PRICE_REQUIRED: "Price is required for LIMIT orders",
  BALANCE_FETCH_ERROR: (asset) => asset ? `Failed to fetch balance for ${asset}` : "Failed to fetch account balances",
  PRICE_FETCH_ERROR: (symbol) => `Failed to fetch price for ${symbol}`
};

// src/types/internal/error.ts
var BinanceError = class _BinanceError extends Error {
  code;
  originalError;
  constructor(message, code = ERROR_CODES.INVALID_PARAMETERS, originalError) {
    super(message);
    this.name = "BinanceError";
    this.code = code;
    this.originalError = originalError;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, _BinanceError);
    }
  }
};
var AuthenticationError = class extends BinanceError {
  constructor(message = "Invalid API credentials") {
    super(message, ERROR_CODES.INVALID_CREDENTIALS);
    this.name = "AuthenticationError";
  }
};
var OrderValidationError = class extends BinanceError {
  constructor(message, code = ERROR_CODES.INVALID_PARAMETERS) {
    super(message, code);
    this.name = "OrderValidationError";
  }
};
var MinNotionalError = class extends OrderValidationError {
  constructor(minNotional) {
    super(
      `Order value is too small. ${minNotional ? `Minimum order value is ${minNotional} USDC.` : ""}`,
      ERROR_CODES.MIN_NOTIONAL_NOT_MET
    );
    this.name = "MinNotionalError";
  }
};
var InvalidSymbolError = class extends BinanceError {
  constructor(symbol) {
    super(
      `Trading pair ${symbol} is not available`,
      ERROR_CODES.INVALID_PARAMETERS
    );
    this.name = "InvalidSymbolError";
  }
};
var ApiError = class extends BinanceError {
  constructor(message, code, response) {
    super(message, code);
    this.response = response;
    this.name = "ApiError";
  }
};

// src/services/base.ts
var BaseService = class {
  client;
  config;
  constructor(config) {
    this.config = {
      baseURL: API_DEFAULTS.BASE_URL,
      timeout: API_DEFAULTS.TIMEOUT,
      ...config
    };
    this.client = new Spot(this.config.apiKey, this.config.secretKey, {
      baseURL: this.config.baseURL,
      timeout: this.config.timeout
    });
  }
  /**
   * Handles common error scenarios and transforms them into appropriate error types
   */
  handleError(error, context) {
    if (error instanceof BinanceError) {
      throw error;
    }
    const apiError = error;
    const errorResponse = apiError.response?.data;
    const errorCode = errorResponse?.code || apiError.code;
    const errorMessage = errorResponse?.msg || apiError.message;
    if (apiError.response?.status === 401) {
      throw new AuthenticationError(ERROR_MESSAGES.INVALID_CREDENTIALS);
    }
    if (errorCode === -1013 && errorMessage?.includes("NOTIONAL")) {
      throw new MinNotionalError();
    }
    if (errorMessage?.includes("Invalid symbol")) {
      throw new InvalidSymbolError(context || "Unknown");
    }
    elizaLogger.error("Unexpected API error:", {
      context,
      code: errorCode,
      message: errorMessage,
      response: errorResponse
    });
    throw new ApiError(
      errorMessage || "An unexpected error occurred",
      errorCode || 500,
      errorResponse
    );
  }
  /**
   * Validates required API credentials
   */
  validateCredentials() {
    if (!this.config.apiKey || !this.config.secretKey) {
      throw new AuthenticationError("API credentials are required");
    }
  }
  /**
   * Merges default options with provided options
   */
  mergeOptions(options) {
    return {
      timeout: this.config.timeout,
      ...options
    };
  }
};

// src/services/account.ts
var AccountService = class extends BaseService {
  /**
   * Get account balance for all assets or a specific asset
   */
  async getBalance(request) {
    try {
      this.validateCredentials();
      const response = await this.client.account();
      const accountInfo = response.data;
      let balances = this.filterNonZeroBalances(accountInfo.balances);
      if (request.asset) {
        balances = this.filterByAsset(balances, request.asset);
      }
      return {
        balances,
        timestamp: Date.now()
      };
    } catch (error) {
      throw this.handleError(
        error,
        request.asset ? `Asset: ${request.asset}` : "All assets"
      );
    }
  }
  /**
   * Filter out zero balances
   */
  filterNonZeroBalances(balances) {
    return balances.filter(
      (balance) => Number.parseFloat(balance.free) > 0 || Number.parseFloat(balance.locked) > 0
    );
  }
  /**
   * Filter balances by asset
   */
  filterByAsset(balances, asset) {
    return balances.filter(
      (b) => b.asset.toUpperCase() === asset.toUpperCase()
    );
  }
  /**
   * Get account trading status
   */
  async getTradingStatus() {
    try {
      this.validateCredentials();
      const response = await this.client.account();
      const accountInfo = response.data;
      return accountInfo.canTrade;
    } catch (error) {
      throw this.handleError(error, "Trading status check");
    }
  }
  /**
   * Check if account has sufficient balance for a trade
   */
  async checkBalance(asset, required) {
    try {
      const { balances } = await this.getBalance({ asset });
      const balance = balances[0];
      if (!balance) {
        return false;
      }
      const available = Number.parseFloat(balance.free);
      return available >= required;
    } catch (error) {
      throw this.handleError(error, `Balance check for ${asset}`);
    }
  }
};

// src/constants/defaults.ts
var VALIDATION = {
  SYMBOL: {
    MIN_LENGTH: 2,
    MAX_LENGTH: 10
  }
};

// src/services/price.ts
var PriceService = class extends BaseService {
  /**
   * Get current price for a symbol
   */
  async getPrice(request) {
    try {
      this.validateSymbol(request.symbol);
      const symbol = `${request.symbol}${request.quoteCurrency}`;
      const response = await this.client.tickerPrice(symbol);
      const data = response.data;
      return {
        symbol,
        price: data.price,
        timestamp: Date.now()
      };
    } catch (error) {
      throw this.handleError(error, request.symbol);
    }
  }
  /**
   * Validates symbol format
   */
  validateSymbol(symbol) {
    const trimmedSymbol = symbol.trim();
    if (trimmedSymbol.length < VALIDATION.SYMBOL.MIN_LENGTH || trimmedSymbol.length > VALIDATION.SYMBOL.MAX_LENGTH) {
      throw new BinanceError(ERROR_MESSAGES.INVALID_SYMBOL);
    }
  }
  /**
   * Format price for display
   */
  static formatPrice(price) {
    const numPrice = typeof price === "string" ? Number.parseFloat(price) : price;
    return new Intl.NumberFormat("en-US", {
      style: "decimal",
      minimumFractionDigits: 2,
      maximumFractionDigits: 8
    }).format(numPrice);
  }
};

// src/services/trade.ts
var TradeService = class extends BaseService {
  /**
   * Execute a spot trade
   */
  async executeTrade(request) {
    try {
      this.validateCredentials();
      await this.validateSymbol(request.symbol);
      const orderParams = this.buildOrderParams(request);
      const response = await this.client.newOrder(
        orderParams.symbol,
        orderParams.side,
        orderParams.type,
        orderParams
      );
      const data = response.data;
      return {
        symbol: data.symbol,
        orderId: data.orderId,
        status: data.status,
        executedQty: data.executedQty,
        cummulativeQuoteQty: data.cummulativeQuoteQty,
        price: data.price,
        type: data.type,
        side: data.side
      };
    } catch (error) {
      throw this.handleError(error, request.symbol);
    }
  }
  /**
   * Validate trading pair and get symbol information
   */
  async validateSymbol(symbol) {
    const exchangeInfo = await this.client.exchangeInfo();
    const data = exchangeInfo.data;
    const symbolInfo = data.symbols.find((s) => s.symbol === symbol);
    if (!symbolInfo) {
      throw new InvalidSymbolError(symbol);
    }
    return symbolInfo;
  }
  /**
   * Build order parameters for the Binance API
   */
  buildOrderParams(request) {
    const params = {
      symbol: request.symbol.toUpperCase(),
      side: request.side,
      type: request.type,
      quantity: request.quantity.toString()
    };
    if (request.type === ORDER_TYPES.LIMIT) {
      if (!request.price) {
        throw new Error(ERROR_MESSAGES.LIMIT_ORDER_PRICE_REQUIRED);
      }
      params.timeInForce = request.timeInForce || TIME_IN_FORCE.GTC;
      params.price = request.price.toString();
    }
    return params;
  }
  /**
   * Get minimum notional value from symbol filters
   */
  getMinNotional(filters) {
    const notionalFilter = filters.find((f) => f.filterType === "NOTIONAL");
    return notionalFilter?.minNotional;
  }
  /**
   * Check if order meets minimum notional value
   */
  checkMinNotional(symbolInfo, quantity, price) {
    const minNotional = this.getMinNotional(symbolInfo.filters);
    if (!minNotional) return;
    const notionalValue = price ? quantity * price : quantity;
    if (Number.parseFloat(minNotional) > notionalValue) {
      throw new MinNotionalError(minNotional);
    }
  }
};

// src/services/index.ts
var BinanceService = class {
  priceService;
  tradeService;
  accountService;
  constructor(config) {
    this.priceService = new PriceService(config);
    this.tradeService = new TradeService(config);
    this.accountService = new AccountService(config);
  }
  /**
   * Price-related operations
   */
  async getPrice(...args) {
    return this.priceService.getPrice(...args);
  }
  static formatPrice = PriceService.formatPrice;
  /**
   * Trading operations
   */
  async executeTrade(...args) {
    return this.tradeService.executeTrade(...args);
  }
  /**
   * Account operations
   */
  async getBalance(...args) {
    return this.accountService.getBalance(...args);
  }
  async getTradingStatus() {
    return this.accountService.getTradingStatus();
  }
  async checkBalance(...args) {
    return this.accountService.checkBalance(...args);
  }
};

// src/actions/priceCheck.ts
var priceCheckTemplate = `Look at ONLY your LAST RESPONSE message in this conversation, where you just said which cryptocurrency price you would check.
Based on ONLY that last message, provide the trading symbol.

For example:
- If your last message was "I'll check the current Ethereum price..." -> return "ETH"
- If your last message was "I'll check the current Solana price..." -> return "SOL"
- If your last message was "I'll check the current Bitcoin price..." -> return "BTC"

\`\`\`json
{
    "symbol": "<symbol from your LAST response only>",
    "quoteCurrency": "<quote currency from your LAST response, or USDT if none mentioned>"
}
\`\`\`

Last part of conversation:
{{recentMessages}}`;
var priceCheck = {
  name: "GET_PRICE",
  similes: [
    "CHECK_PRICE",
    "PRICE_CHECK",
    "GET_CRYPTO_PRICE",
    "CRYPTO_PRICE",
    "CHECK_CRYPTO_PRICE",
    "PRICE_LOOKUP",
    "CURRENT_PRICE"
  ],
  description: "Get current price information for a cryptocurrency pair",
  validate: async () => true,
  // Public endpoint
  handler: async (runtime, message, state, _options, callback) => {
    try {
      let localState = state;
      localState = !localState ? await runtime.composeState(message) : await runtime.updateRecentMessageState(localState);
      const context = composeContext({
        state: localState,
        template: priceCheckTemplate
      });
      const rawContent = await generateObjectDeprecated({
        runtime,
        context,
        modelClass: ModelClass.SMALL
      });
      if (!rawContent?.symbol) {
        throw new Error(
          "Could not determine which cryptocurrency to check"
        );
      }
      const content = {
        symbol: rawContent.symbol.toString().toUpperCase().trim(),
        quoteCurrency: (rawContent.quoteCurrency || "USDT").toString().toUpperCase().trim()
      };
      if (content.symbol.length < 2 || content.symbol.length > 10) {
        throw new Error("Invalid cryptocurrency symbol");
      }
      const binanceService = new BinanceService();
      const priceData = await binanceService.getPrice(content);
      if (callback) {
        callback({
          text: `The current ${content.symbol} price is ${BinanceService.formatPrice(priceData.price)} ${content.quoteCurrency}`,
          content: priceData
        });
      }
      return true;
    } catch (error) {
      elizaLogger2.error("Error in price check:", error);
      if (callback) {
        const errorMessage = error.message.includes("Invalid API key") ? "Unable to connect to Binance API" : error.message.includes("Invalid symbol") ? "Sorry, could not find price for the cryptocurrency symbol you provided" : `Sorry, I encountered an error: ${error.message}`;
        callback({
          text: errorMessage,
          content: { error: error.message }
        });
      }
      return false;
    }
  },
  examples: [
    [
      {
        user: "{{user1}}",
        content: {
          text: "What's the current price of Bitcoin?"
        }
      },
      {
        user: "{{agent}}",
        content: {
          text: "I'll check the current Bitcoin price for you right away.",
          action: "GET_PRICE"
        }
      },
      {
        user: "{{agent}}",
        content: {
          text: "The current BTC price is 42,150.25 USDT"
        }
      }
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "Can you check ETH price in EUR?"
        }
      },
      {
        user: "{{agent}}",
        content: {
          text: "I'll fetch the current Ethereum price in euros for you.",
          action: "GET_PRICE"
        }
      },
      {
        user: "{{agent}}",
        content: {
          text: "The current ETH price is 2,245.80 EUR"
        }
      }
    ]
  ]
};

// src/actions/spotBalance.ts
import {
  composeContext as composeContext2,
  elizaLogger as elizaLogger3,
  generateObjectDeprecated as generateObjectDeprecated2,
  ModelClass as ModelClass2
} from "@elizaos/core";

// src/environment.ts
import { z } from "zod";
var binanceEnvSchema = z.object({
  BINANCE_API_KEY: z.string().min(1, "Binance API key is required"),
  BINANCE_SECRET_KEY: z.string().min(1, "Binance secret key is required")
});
async function validateBinanceConfig(runtime) {
  try {
    const config = {
      BINANCE_API_KEY: runtime.getSetting("BINANCE_API_KEY"),
      BINANCE_SECRET_KEY: runtime.getSetting("BINANCE_SECRET_KEY")
    };
    return binanceEnvSchema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.errors.map((err) => `${err.path.join(".")}: ${err.message}`).join("\n");
      throw new Error(
        `Binance configuration validation failed:
${errorMessages}`
      );
    }
    throw error;
  }
}

// src/actions/spotBalance.ts
var spotBalanceTemplate = `Look at ONLY your LAST RESPONSE message in this conversation, where you just confirmed which cryptocurrency balance to check.
Based on ONLY that last message, extract the cryptocurrency symbol.

For example:
- If your last message was "I'll fetch your Solana wallet balance..." -> return "SOL"
- If your last message was "I'll check your BTC balance..." -> return "BTC"
- If your last message was "I'll get your ETH balance..." -> return "ETH"

\`\`\`json
{
    "asset": "<symbol from your LAST response only>"
}
\`\`\`

Last part of conversation:
{{recentMessages}}`;
var spotBalance = {
  name: "GET_SPOT_BALANCE",
  similes: [
    "CHECK_BALANCE",
    "BALANCE_CHECK",
    "GET_WALLET_BALANCE",
    "WALLET_BALANCE",
    "CHECK_WALLET",
    "VIEW_BALANCE",
    "SHOW_BALANCE"
  ],
  description: "Get current spot wallet balance for one or all assets",
  validate: async (runtime) => {
    try {
      await validateBinanceConfig(runtime);
      return true;
    } catch {
      return false;
    }
  },
  handler: async (runtime, message, state, _options, callback) => {
    let currentState = state;
    if (!currentState) {
      currentState = await runtime.composeState(message);
    } else {
      currentState = await runtime.updateRecentMessageState(currentState);
    }
    const balanceContext = composeContext2({
      state: currentState,
      template: spotBalanceTemplate
    });
    const content = await generateObjectDeprecated2({
      runtime,
      context: balanceContext,
      modelClass: ModelClass2.SMALL
    });
    try {
      const binanceService = new BinanceService({
        apiKey: runtime.getSetting("BINANCE_API_KEY"),
        secretKey: runtime.getSetting("BINANCE_SECRET_KEY")
      });
      const balanceData = await binanceService.getBalance(content);
      if (content.asset) {
        const assetBalance = balanceData.balances[0];
        if (assetBalance) {
          if (callback) {
            callback({
              text: `${content.asset} Balance:
Available: ${assetBalance.free}
Locked: ${assetBalance.locked}`,
              content: assetBalance
            });
          }
        } else {
          if (callback) {
            callback({
              text: `No balance found for ${content.asset}`,
              content: { error: "Asset not found" }
            });
          }
        }
      } else {
        const balanceText = balanceData.balances.map(
          (b) => `${b.asset}: Available: ${b.free}, Locked: ${b.locked}`
        ).join("\n");
        if (callback) {
          callback({
            text: `Spot Wallet Balances:
${balanceText}`,
            content: balanceData.balances
          });
        }
      }
      return true;
    } catch (error) {
      elizaLogger3.error("Error in balance check:", {
        message: error.message,
        code: error.code
      });
      if (callback) {
        callback({
          text: error.message,
          content: { error: error.message }
        });
      }
      return false;
    }
  },
  examples: [
    [
      {
        user: "{{user1}}",
        content: {
          text: "What's my current Bitcoin balance?"
        }
      },
      {
        user: "{{agent}}",
        content: {
          text: "I'll check your BTC balance for you.",
          action: "GET_SPOT_BALANCE"
        }
      },
      {
        user: "{{agent}}",
        content: {
          text: "BTC Balance:\nAvailable: 0.5\nLocked: 0.1"
        }
      }
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "Show me all my wallet balances"
        }
      },
      {
        user: "{{agent}}",
        content: {
          text: "I'll fetch all your spot wallet balances.",
          action: "GET_SPOT_BALANCE"
        }
      },
      {
        user: "{{agent}}",
        content: {
          text: "Spot Wallet Balances:\nBTC: Available: 0.5, Locked: 0.1\nETH: Available: 2.0, Locked: 0.0\nUSDT: Available: 1000.0, Locked: 0.0"
        }
      }
    ]
  ]
};

// src/actions/spotTrade.ts
import {
  composeContext as composeContext3,
  elizaLogger as elizaLogger4,
  generateObjectDeprecated as generateObjectDeprecated3,
  ModelClass as ModelClass3
} from "@elizaos/core";

// src/types.ts
import { z as z2 } from "zod";
var PriceCheckSchema = z2.object({
  symbol: z2.string().min(1).toUpperCase(),
  quoteCurrency: z2.string().min(1).toUpperCase().default("USDT")
});
var SpotTradeSchema = z2.object({
  symbol: z2.string().min(1).toUpperCase(),
  side: z2.enum(["BUY", "SELL"]),
  type: z2.enum(["MARKET", "LIMIT"]),
  quantity: z2.number().positive(),
  price: z2.number().positive().optional(),
  timeInForce: z2.enum(["GTC", "IOC", "FOK"]).optional().default("GTC")
});

// src/actions/spotTrade.ts
var spotTradeTemplate = `Look at your LAST RESPONSE in the conversation where you confirmed a trade/swap request.
Based on ONLY that last message, extract the trading details:

Trading pairs on Binance must include USDT or BUSD or USDC. For example:
- For "swap SOL for USDC" -> use "SOLUSDC" as symbol
- For "swap ETH for USDT" -> use "ETHUSDT" as symbol
- For "buy BTC with USDT" -> use "BTCUSDT" as symbol

\`\`\`json
{
    "symbol": "<pair with stable coin>",
    "side": "SELL",
    "type": "MARKET",
    "quantity": "<amount from your last response>"
}
\`\`\`

Recent conversation:
{{recentMessages}}`;
var spotTrade = {
  name: "EXECUTE_SPOT_TRADE",
  similes: [
    "SPOT_TRADE",
    "MARKET_ORDER",
    "LIMIT_ORDER",
    "BUY_CRYPTO",
    "SELL_CRYPTO",
    "PLACE_ORDER"
  ],
  description: "Execute a spot trade on Binance",
  validate: async (runtime) => {
    return !!(runtime.getSetting("BINANCE_API_KEY") && runtime.getSetting("BINANCE_SECRET_KEY"));
  },
  handler: async (runtime, message, state, _options, callback) => {
    let content;
    try {
      let currentState = state;
      if (!currentState) {
        currentState = await runtime.composeState(message);
      } else {
        currentState = await runtime.updateRecentMessageState(currentState);
      }
      const context = composeContext3({
        state: currentState,
        template: spotTradeTemplate
      });
      content = await generateObjectDeprecated3({
        runtime,
        context,
        modelClass: ModelClass3.SMALL
      });
      if (content && typeof content.quantity === "string") {
        content.quantity = Number.parseFloat(content.quantity);
      }
      const parseResult = SpotTradeSchema.safeParse(content);
      if (!parseResult.success) {
        throw new Error(
          `Invalid spot trade content: ${JSON.stringify(parseResult.error.errors, null, 2)}`
        );
      }
      const binanceService = new BinanceService({
        apiKey: runtime.getSetting("BINANCE_API_KEY"),
        secretKey: runtime.getSetting("BINANCE_SECRET_KEY")
      });
      const tradeResult = await binanceService.executeTrade(content);
      if (callback) {
        const orderType = content.type === "MARKET" ? "market" : content.price ? `limit at ${BinanceService.formatPrice(content.price)}` : "market";
        callback({
          text: `Successfully placed a ${orderType} order to ${content.side.toLowerCase()} ${content.quantity} ${content.symbol}
Order ID: ${tradeResult.orderId}
Status: ${tradeResult.status}`,
          content: tradeResult
        });
      }
      return true;
    } catch (error) {
      elizaLogger4.error("Error executing trade:", {
        content,
        message: error.message,
        code: error.code
      });
      if (callback) {
        callback({
          text: `Error executing trade: ${error.message}`,
          content: { error: error.message }
        });
      }
      return false;
    }
  },
  examples: [
    [
      {
        user: "{{user1}}",
        content: {
          text: "Buy 0.1 BTC at market price"
        }
      },
      {
        user: "{{agent}}",
        content: {
          text: "I'll execute a market order to buy 0.1 BTC now.",
          action: "EXECUTE_SPOT_TRADE"
        }
      },
      {
        user: "{{agent}}",
        content: {
          text: "Successfully placed a market order to buy 0.1 BTCUSDT\nOrder ID: 123456789\nStatus: FILLED"
        }
      }
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "Place a limit order to sell 100 BNB at 250 USDT"
        }
      },
      {
        user: "{{agent}}",
        content: {
          text: "I'll place a limit order to sell 100 BNB at 250 USDT.",
          action: "EXECUTE_SPOT_TRADE"
        }
      },
      {
        user: "{{agent}}",
        content: {
          text: "Successfully placed a limit order to sell 100 BNBUSDT at 250\nOrder ID: 987654321\nStatus: NEW"
        }
      }
    ]
  ]
};

// src/index.ts
var binancePlugin = {
  name: "binance",
  description: "Binance Plugin for Eliza",
  actions: [spotTrade, priceCheck, spotBalance],
  evaluators: [],
  providers: []
};
var index_default = binancePlugin;
export {
  binancePlugin,
  index_default as default
};
//# sourceMappingURL=index.js.map