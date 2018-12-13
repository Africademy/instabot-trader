const async = require('async');
const Gdax = require('gdax');
const log = require('../common/logger');
const util = require('../common/util');
const ApiInterface = require('./api');

const logger = log.logger;


class Coinbase extends ApiInterface {
    /**
     * Set up the API
     * @param key
     * @param secret
     * @param passphrase
     * @param endpoint
     */
    constructor(key, secret, passphrase, endpoint) {
        super();

        // Create the 2 ways of calling the API
        this.publicClient = new Gdax.PublicClient(endpoint);
        this.authClient = new Gdax.AuthenticatedClient(key, secret, passphrase, endpoint);

        // rate limiting - when can we next make a call, and how often (in ms)
        this.nextCallAt = Date.now();
        this.minTimeBetweenCalls = 250;
    }

    formatPrice(price) {
        return String(price);
    }

    formatAmount(amount) {
        return String(amount);
    }

    /**
     * Make the call later...
     * @returns {Promise<any>}
     */
    rateLimit() {
        return new Promise((resolve, reject) => {
            // Figure out if we need to rate limit ourselves a bit
            const currentTime = Date.now();
            const waitBeforeCall = this.nextCallAt > currentTime ? (this.nextCallAt - currentTime) + 1 : 1;
            this.nextCallAt = currentTime + waitBeforeCall + this.minTimeBetweenCalls;
            if (waitBeforeCall > 1) logger.debug(`Rate limiting myself by waiting ${waitBeforeCall}ms`);

            setTimeout(() => resolve(), waitBeforeCall);
        });
    }

    /**
     * Find out the precision used for the symbol
     * @param symbol
     * @returns {Promise<void>}
     */
    async init(symbol) {
        const products = await this.publicClient.getProducts();
        const match = products.filter(s => s.id.toLowerCase() === symbol.toLowerCase()).shift();
        if (!match) {
            logger.error(`Symbol ${symbol} not accessible on Coinbase.`);
        }

        return match;
    }

    /**
     * Get the ticker for a symbol
     * @param symbol
     * @returns {*}
     */
    ticker(symbol) {
        return this.rateLimit().then(() => this.publicClient.getProductTicker(symbol)
            .then(ticker => ({
                // standard data we need for this response
                bid: ticker.bid,
                ask: ticker.ask,
                last_price: ticker.price,
            })),
        );
    }

    /**
     * Get the balances
     * @returns {*}
     */
    walletBalances() {
        return this.rateLimit().then(() => this.authClient.getAccounts()
            .then(accounts => accounts.map(item => ({
                type: 'exchange',
                currency: item.currency.toLowerCase(),
                amount: item.balance,
                available: item.available,
            }))),
        );
    }


    /**
     * place a limit order
     * @param symbol
     * @param amount
     * @param price
     * @param side
     * @returns {*}
     */
    limitOrder(symbol, amount, price, side) {
        const params = {
            type: 'limit',
            side,
            product_id: symbol,
            price: this.formatPrice(price),
            size: this.formatAmount(amount),
            post_only: true,
        };

        return this.rateLimit().then(() => this.authClient.placeOrder(params));
    }

    /**
     * Place a market order
     * @param symbol
     * @param amount
     * @param side - buy or sell
     */
    marketOrder(symbol, amount, side) {
        const params = {
            type: 'market',
            side,
            product_id: symbol,
            size: this.formatAmount(amount),
        };

        return this.rateLimit().then(() => this.authClient.placeOrder(params));
    }

    /**
     * Place a stop market order
     * @param symbol
     * @param amount
     * @param price
     * @param side - buy or sell
     * @param trigger
     */
    stopOrder(symbol, amount, price, side, trigger) {
        const params = {
            type: 'market',
            side,
            product_id: symbol,
            size: this.formatAmount(amount),
            stop: side === 'sell' ? 'loss' : 'entry',
            stop_price: this.formatPrice(price),
        };

        return this.rateLimit().then(() => this.authClient.placeOrder(params));
    }

    /**
     * Get active orders
     * @param symbol
     * @param side - buy, sell or all
     * @returns {PromiseLike<T> | Promise<T>}
     */
    activeOrders(symbol, side) {
        return this.rateLimit().then(async () => {
            // get all teh orders
            const orders = await this.authClient.getOrders({ product_id: symbol });
            if (side === 'all') {
                return orders;
            }

            // filter down to just the ones on the side given
            return orders.filter(item => item.side === side);
        });
    }

    /**
     * Cancel orders
     * @param orders - and array of orders to cancel
     * @returns {*}
     */
    cancelOrders(orders) {
        return new Promise((resolve, reject) => {
            async.eachSeries(orders, (order, next) => {
                this.rateLimit()
                    .then(() => this.authClient.cancelOrder(order.id))
                    .then(() => next())
                    .catch(err => next());
            }, (err) => {
                if (err) { return reject(err); }
                return resolve();
            });
        });
    }

    /**
     * Get order info
     * @param orderInfo
     * @returns {PromiseLike<{id: *, side: *, amount: number, remaining: number, executed: number, is_filled: boolean}> | Promise<{id: *, side: *, amount: number, remaining: number, executed: number, is_filled: boolean}>}
     */
    order(orderInfo) {
        return this.rateLimit()
            .then(() => this.authClient.getOrder(orderInfo.id))
            .then(order => ({
                id: order.id,
                side: order.side,
                amount: parseFloat(order.size),
                remaining: parseFloat(order.size) - parseFloat(order.filled_size),
                executed: parseFloat(order.filled_size),
                is_filled: parseFloat(order.size) === parseFloat(order.filled_size),
                is_open: order.status !== 'open',
            }));
    }
}

module.exports = Coinbase;

