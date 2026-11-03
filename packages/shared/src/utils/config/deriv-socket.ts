/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Adapter between this app (written for the legacy Deriv WebSocket API,
 * wss://ws.derivws.com/websockets/v3) and Deriv's new public WebSocket API.
 *
 * The legacy service rejects connections (HTTP 520), so the app never receives
 * data and stays on the loading screen. This returns a real browser WebSocket
 * pointed at the new public endpoint, patched so that:
 *  - outgoing legacy requests are translated (symbol -> underlying_symbol, ...)
 *  - incoming responses are translated back to the legacy shape the app reads
 *  - calls the public endpoint does not provide (website_status, time, ping,
 *    authorize) are answered locally.
 *
 * Only public (logged-out) market data is supported here. Login/trading needs
 * the new OAuth2 + one-time-password flow and is not handled by this adapter.
 */

export const DERIV_PUBLIC_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';

const MARKET_NAMES: Record<string, string> = {
    synthetic_index: 'Derived',
    forex: 'Forex',
    indices: 'Stock Indices',
    commodities: 'Commodities',
    cryptocurrency: 'Cryptocurrencies',
    stocks: 'Stocks',
    basket_index: 'Derived',
};

const humanize = (value?: string) =>
    (value || '')
        .split('_')
        .filter(Boolean)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');

const toLegacyActiveSymbol = (item: any, index: number) => ({
    ...item,
    symbol: item.underlying_symbol,
    display_name: item.underlying_symbol_name,
    pip: item.pip_size,
    symbol_type: item.underlying_symbol_type,
    display_order: index + 1,
    market_display_name: MARKET_NAMES[item.market] || humanize(item.market),
    submarket_display_name: humanize(item.submarket),
    subgroup_display_name: humanize(item.subgroup),
});

const parse = (data: unknown) => {
    try {
        return typeof data === 'string' ? JSON.parse(data) : null;
    } catch (e) {
        return null;
    }
};

/** Answers a request locally when the public endpoint does not offer the call. */
const localReply = (request: any): Record<string, unknown> | null => {
    const base = { echo_req: request, ...(request.req_id !== undefined ? { req_id: request.req_id } : {}) };

    if (request.ping !== undefined) return { ...base, msg_type: 'ping', ping: 'pong' };
    if (request.time !== undefined) return { ...base, msg_type: 'time', time: Math.floor(Date.now() / 1000) };
    if (request.website_status !== undefined) {
        return {
            ...base,
            msg_type: 'website_status',
            website_status: {
                site_status: 'up',
                api_call_limits: {},
                currencies_config: {},
                supported_languages: ['EN'],
                terms_conditions_version: '',
                clients_country: '',
            },
        };
    }
    if (request.authorize !== undefined) {
        return {
            ...base,
            msg_type: 'authorize',
            error: { code: 'AuthorizationRequired', message: 'Log in is not available yet.' },
        };
    }
    return null;
};

/** Legacy request -> new API request. */
const toNewRequest = (request: any) => {
    const result = { ...request };
    if ('symbol' in result) {
        result.underlying_symbol = result.symbol;
        delete result.symbol;
    }
    if (result.parameters && 'symbol' in result.parameters) {
        result.parameters = { ...result.parameters, underlying_symbol: result.parameters.symbol };
        delete result.parameters.symbol;
    }
    ['loginid', 'product_type', 'date_start', 'barrier_range', 'trade_risk_profile'].forEach(key => {
        delete result[key];
    });
    if (result.active_symbols !== undefined) delete result.landing_company;
    return result;
};

/** New API response -> legacy response shape. */
const toLegacyResponse = (response: any) => {
    if (!response || typeof response !== 'object') return response;
    if (response.msg_type === 'active_symbols' && Array.isArray(response.active_symbols)) {
        return { ...response, active_symbols: response.active_symbols.map(toLegacyActiveSymbol) };
    }
    if (response.msg_type === 'proposal' && response.proposal && response.proposal.display_value === undefined) {
        return { ...response, proposal: { ...response.proposal, display_value: String(response.proposal.ask_price) } };
    }
    return response;
};

const report = (detail: Record<string, unknown>) => {
    try {
        window.dispatchEvent(new CustomEvent('deriv-socket-log', { detail }));
    } catch (e) {
        // logging must never break the socket
    }
};

export const createDerivSocket = (): WebSocket => {
    const ws = new WebSocket(DERIV_PUBLIC_WS_URL);
    const nativeAdd = ws.addEventListener.bind(ws);
    const nativeRemove = ws.removeEventListener.bind(ws);
    const nativeSend = ws.send.bind(ws);

    const listeners: Array<(event: MessageEvent) => void> = [];
    let onmessage_handler: ((event: MessageEvent) => void) | null = null;

    const emit = (payload: unknown) => {
        const event = new MessageEvent('message', { data: JSON.stringify(payload) });
        [...listeners, ...(onmessage_handler ? [onmessage_handler] : [])].forEach(fn => {
            try {
                fn.call(ws, event);
            } catch (e) {
                // eslint-disable-next-line no-console
                console.error('[DerivSocket] message handler failed', e);
            }
        });
    };

    nativeAdd('message', (event: Event) => {
        const raw = (event as MessageEvent).data;
        const parsed = parse(raw);
        if (parsed) {
            report({ dir: 'in', type: parsed.msg_type, error: parsed.error });
        }
        emit(parsed ? toLegacyResponse(parsed) : raw);
    });

    ws.send = (data: any) => {
        const request = parse(data);
        if (!request) {
            nativeSend(data);
            return;
        }
        report({ dir: 'out', type: Object.keys(request).find(key => key !== 'req_id') });
        const reply = localReply(request);
        if (reply) {
            setTimeout(() => emit(reply), 0);
            return;
        }
        nativeSend(JSON.stringify(toNewRequest(request)));
    };

    ws.addEventListener = ((type: string, listener: any, options?: any) => {
        if (type === 'message' && typeof listener === 'function') {
            listeners.push(listener);
        } else {
            nativeAdd(type, listener, options);
        }
    }) as typeof ws.addEventListener;

    ws.removeEventListener = ((type: string, listener: any, options?: any) => {
        if (type === 'message') {
            const index = listeners.indexOf(listener);
            if (index > -1) listeners.splice(index, 1);
        } else {
            nativeRemove(type, listener, options);
        }
    }) as typeof ws.removeEventListener;

    Object.defineProperty(ws, 'onmessage', {
        configurable: true,
        get: () => onmessage_handler,
        set: handler => {
            onmessage_handler = typeof handler === 'function' ? handler : null;
        },
    });

    return ws;
};
