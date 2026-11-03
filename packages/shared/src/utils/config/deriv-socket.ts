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
 * Logged-out, the socket talks to the public endpoint (market data only).
 * After the OAuth2 sign-in (see utils/login/oauth2.ts) the app sends the legacy
 * `authorize` request with the per-account token `oauth:<account_id>`. The adapter
 * then asks Deriv for a one-time WebSocket URL for that account
 * (POST /trading/v1/options/accounts/{id}/otp, using the saved bearer token),
 * connects to it, and sends all further traffic there. Per Deriv's docs no auth
 * message is sent on that socket. Account ids are aliased to the legacy format
 * (see oauth-accounts.ts) in both directions.
 */

import {
    aliasToReal,
    buildLegacyAuthorize,
    buildLegacyBalanceAll,
    clearOAuthSession,
    findAccountByToken,
    readOAuthAccounts,
    readOAuthSession,
    realToAlias,
} from '../login/oauth-accounts';

export const DERIV_PUBLIC_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';
const OTP_URL = (account_id: string) =>
    `https://api.derivws.com/trading/v1/options/accounts/${encodeURIComponent(account_id)}/otp`;
const AUTHORIZED_OPEN_TIMEOUT_MS = 15000;

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
    allow_forward_starting: 0,
    delay_amount: 0,
    exchange_name: '',
    intraday_interval_minutes: 0,
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
    return null;
};

/**
 * Legacy calls the new API has no equivalent for. They get an empty but correctly
 * shaped answer so the parts of the app waiting on them can continue.
 */
const FORWARDED_CALLS = [
    'contracts_for',
    'active_symbols',
    'proposal',
    'proposal_open_contract',
    'buy',
    'sell',
    'cancel',
    'contract_update',
    'contract_update_history',
    'ticks',
    'ticks_history',
    'portfolio',
    'profit_table',
    'statement',
    'transaction',
    'trading_times',
    'trading_durations',
];

const LEGACY_STUBS: Record<string, (request?: any) => Record<string, unknown>> = {
    get_settings: () => ({ email: '', country_code: '', preferred_language: 'EN' }),
    set_settings: () => 1 as unknown as Record<string, unknown>,
    get_account_status: () => ({
        currency_config: {},
        status: [],
        risk_classification: 'low',
        prompt_client_to_authenticate: 0,
        p2p_status: 'none',
        authentication: {
            needs_verification: [],
            document: { status: 'none' },
            identity: { status: 'none', services: {} },
            income: { status: 'none' },
            ownership: { status: 'none' },
        },
    }),
    payout_currencies: () => readOAuthAccounts().map(account => account.currency) as unknown as Record<string, unknown>,
    landing_company: () => ({}),
    residence_list: () => [] as unknown as Record<string, unknown>,
    states_list: () => [] as unknown as Record<string, unknown>,
    mt5_login_list: () => [] as unknown as Record<string, unknown>,
    trading_servers: () => [] as unknown as Record<string, unknown>,
    trading_platform_available_accounts: () => [] as unknown as Record<string, unknown>,
    trading_platform_accounts: () => [] as unknown as Record<string, unknown>,
    get_self_exclusion: () => ({}),
    get_limits: () => ({}),
    get_financial_assessment: () => ({}),
    login_history: () => [] as unknown as Record<string, unknown>,
    crypto_config: () => ({ currencies_config: {} }),
    // Only same-currency rates are known locally; the trader needs this to price stakes in the account currency.
    exchange_rates: (request: any = {}) => {
        const base = request.base_currency || 'USD';
        const target = request.target_currency || base;
        return {
            base_currency: base,
            date: Math.floor(Date.now() / 1000),
            rates: base === target ? { [target]: 1 } : {},
        };
    },
};

// ---------------------------------------------------------------------------
// Differences between the legacy API and the new one, from Deriv's migration
// notes (developers.deriv.com/comparison/...). Requests are translated to the
// new format and responses back to what this app was written to read.
// ---------------------------------------------------------------------------

const REMOVED_REQUEST_KEYS = ['loginid', 'account', 'product_type', 'date_start', 'barrier_range', 'trade_risk_profile'];
const REMOVED_PARAMETER_KEYS = [
    'barrier_range',
    'date_start',
    'product_type',
    'trade_risk_profile',
    'trading_period_start',
];

/** The new API has HIGHER/LOWER for barrier contracts where the legacy API reused CALL/PUT. */
const withBarrierContractType = (contract_type: unknown, barrier: unknown) => {
    const has_barrier = barrier !== undefined && barrier !== null && barrier !== '';
    if (has_barrier && contract_type === 'CALL') return 'HIGHER';
    if (has_barrier && contract_type === 'PUT') return 'LOWER';
    return contract_type;
};

/** Legacy request -> new API request. */
const toNewRequest = (request: any) => {
    const result = { ...request };
    if ('symbol' in result) {
        result.underlying_symbol = result.symbol;
        delete result.symbol;
    }
    if (result.parameters && typeof result.parameters === 'object') {
        const parameters = { ...result.parameters };
        if ('symbol' in parameters) {
            parameters.underlying_symbol = parameters.symbol;
            delete parameters.symbol;
        }
        REMOVED_PARAMETER_KEYS.forEach(key => delete parameters[key]);
        if (parameters.contract_type) {
            parameters.contract_type = withBarrierContractType(parameters.contract_type, parameters.barrier);
        }
        result.parameters = parameters;
    }
    REMOVED_REQUEST_KEYS.forEach(key => delete result[key]);
    if (result.proposal !== undefined) {
        delete result.trading_period_start;
        result.contract_type = withBarrierContractType(result.contract_type, result.barrier);
    }
    if (result.active_symbols !== undefined) {
        ['landing_company', 'landing_company_short', 'barrier_category'].forEach(key => delete result[key]);
    }
    if (result.contracts_for !== undefined) {
        ['currency', 'landing_company', 'landing_company_short'].forEach(key => delete result[key]);
    }
    return result;
};

const CONTRACT_DISPLAY: Record<string, string> = {
    CALL: 'Higher',
    PUT: 'Lower',
    CALLE: 'Higher or equal',
    PUTE: 'Lower or equal',
    DIGITMATCH: 'Matches',
    DIGITDIFF: 'Differs',
    DIGITEVEN: 'Even',
    DIGITODD: 'Odd',
    DIGITOVER: 'Over',
    DIGITUNDER: 'Under',
    ONETOUCH: 'Touches',
    NOTOUCH: 'Does Not Touch',
    EXPIRYRANGE: 'Ends Between',
    EXPIRYMISS: 'Ends Outside',
    EXPIRYRANGEE: 'Ends Between',
    EXPIRYMISSE: 'Ends Outside',
    RANGE: 'Stays Between',
    UPORDOWN: 'Goes Outside',
    ASIANU: 'Asian Up',
    ASIAND: 'Asian Down',
    TICKHIGH: 'High Tick',
    TICKLOW: 'Low Tick',
    RUNHIGH: 'Only Ups',
    RUNLOW: 'Only Downs',
    MULTUP: 'Multiply Up',
    MULTDOWN: 'Multiply Down',
    ACCU: 'Accumulator Up',
    VANILLALONGCALL: 'Call',
    VANILLALONGPUT: 'Put',
    TURBOSLONG: 'Turbo Long',
    TURBOSSHORT: 'Turbo Short',
    RESETCALL: 'Reset Call',
    RESETPUT: 'Reset Put',
};

const CATEGORY_DISPLAY: Record<string, string> = {
    callput: 'Up/Down',
    callputequal: 'Rise/Fall Equal',
    digits: 'Digits',
    touchnotouch: 'Touch/No Touch',
    endsinout: 'Ends In/Out',
    staysinout: 'Stays In/Out',
    asian: 'Asians',
    highlowticks: 'High/Low Ticks',
    runs: 'Only Ups/Only Downs',
    multiplier: 'Multipliers',
    accumulator: 'Accumulators',
    vanilla: 'Vanilla Options',
    turbos: 'Turbos',
    reset: 'Reset Call/Reset Put',
};

const barrierCategoryFor = (contract: any) => {
    switch (contract.contract_category) {
        case 'callput':
        case 'callputequal':
            return Number(contract.barriers) > 0 ? 'euro_non_atm' : 'euro_atm';
        case 'touchnotouch':
        case 'staysinout':
            return 'american';
        case 'endsinout':
            return 'euro_non_atm';
        case 'asian':
            return 'asian';
        case 'reset':
            return 'reset';
        default:
            return 'non_financial';
    }
};

const toLegacyContractType = (value: unknown) => (value === 'HIGHER' ? 'CALL' : value === 'LOWER' ? 'PUT' : value);

/** contracts_for items lost their display fields and start_type; the trader reads all of them. */
const toLegacyContractsFor = (response: any) => {
    const contracts_for = response.contracts_for;
    if (!contracts_for || !Array.isArray(contracts_for.available)) return response;
    return {
        ...response,
        contracts_for: {
            ...contracts_for,
            available: contracts_for.available.map((contract: any) => {
                const contract_type = toLegacyContractType(contract.contract_type) as string;
                return {
                    exchange_name: '',
                    start_type: 'spot',
                    ...contract,
                    contract_type,
                    barrier_category: contract.barrier_category || barrierCategoryFor(contract),
                    contract_category_display:
                        contract.contract_category_display ||
                        CATEGORY_DISPLAY[contract.contract_category] ||
                        humanize(contract.contract_category),
                    contract_display:
                        contract.contract_display || CONTRACT_DISPLAY[contract_type] || humanize(contract_type),
                };
            }),
        },
    };
};

const NUMERIC_CONTRACT_FIELDS = ['bid_price', 'buy_price', 'current_spot', 'profit', 'payout', 'sell_price'];

/** Walks a response and restores the legacy names the new API renamed (symbol, HIGHER/LOWER). */
const legacyizeDeep = (value: any): any => {
    if (Array.isArray(value)) return value.map(legacyizeDeep);
    if (!value || typeof value !== 'object') return value;
    const result: Record<string, any> = {};
    Object.keys(value).forEach(key => {
        result[key] = key === 'contract_type' ? toLegacyContractType(value[key]) : legacyizeDeep(value[key]);
    });
    if (typeof result.underlying_symbol === 'string') {
        if (result.symbol === undefined) result.symbol = result.underlying_symbol;
        if (result.underlying === undefined) result.underlying = result.underlying_symbol;
    }
    return result;
};

const toLegacyOpenContract = (contract: any) => {
    const result = { ...contract };
    NUMERIC_CONTRACT_FIELDS.forEach(key => {
        if (typeof result[key] === 'string' && result[key] !== '' && !Number.isNaN(Number(result[key]))) {
            result[key] = Number(result[key]);
        }
    });
    // sell_spot / sell_spot_time are deprecated in favour of exit_spot / exit_spot_time.
    if (result.sell_spot === undefined && result.exit_spot !== undefined) result.sell_spot = Number(result.exit_spot);
    if (result.sell_spot_time === undefined && result.exit_spot_time !== undefined) {
        result.sell_spot_time = result.exit_spot_time;
    }
    if (result.exit_tick_display_value === undefined && result.exit_tick !== undefined) {
        result.exit_tick_display_value = String(result.exit_tick);
    }
    if (result.sell_spot_display_value === undefined && result.exit_spot !== undefined) {
        result.sell_spot_display_value = String(result.exit_spot);
    }
    return result;
};

const WALKED_MESSAGES = ['contracts_for', 'proposal_open_contract', 'portfolio', 'profit_table', 'transaction', 'statement', 'buy', 'sell'];

/** New API response -> legacy response shape. */
const toLegacyResponse = (response: any) => {
    if (!response || typeof response !== 'object') return response;
    if (response.msg_type === 'active_symbols' && Array.isArray(response.active_symbols)) {
        return { ...response, active_symbols: response.active_symbols.map(toLegacyActiveSymbol) };
    }
    if (response.msg_type === 'proposal' && response.proposal && response.proposal.display_value === undefined) {
        return { ...response, proposal: { ...response.proposal, display_value: String(response.proposal.ask_price) } };
    }
    if (response.msg_type === 'contracts_for') {
        return toLegacyContractsFor(legacyizeDeep(response));
    }
    if (response.msg_type === 'proposal_open_contract' && response.proposal_open_contract) {
        const walked = legacyizeDeep(response);
        return { ...walked, proposal_open_contract: toLegacyOpenContract(walked.proposal_open_contract) };
    }
    if (WALKED_MESSAGES.includes(response.msg_type)) return legacyizeDeep(response);
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

    // Authenticated socket for the signed-in account, once `authorize` has succeeded.
    let authorized: WebSocket | null = null;
    let authorized_account_id = '';
    let active_loginid = '';
    let queue: Promise<void> = Promise.resolve();

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

    const handleIncoming = (raw: unknown, from_authorized: boolean) => {
        const text = from_authorized && typeof raw === 'string' ? realToAlias(raw) : raw;
        const parsed = parse(text);
        if (parsed) {
            // The new API's balance message has no loginid; the app matches it to the account by that field.
            if (from_authorized && parsed.msg_type === 'balance' && parsed.balance && !parsed.balance.loginid) {
                parsed.balance.loginid = active_loginid;
            }
            report({ dir: 'in', type: parsed.msg_type, error: parsed.error });
        }
        emit(parsed ? toLegacyResponse(parsed) : text);
    };

    nativeAdd('message', (event: Event) => handleIncoming((event as MessageEvent).data, false));

    const closeAuthorized = () => {
        const socket = authorized;
        authorized = null;
        authorized_account_id = '';
        try {
            socket?.close();
        } catch (e) {
            // already closed
        }
    };

    const openAuthorized = (url: string) =>
        new Promise<WebSocket>((resolve, reject) => {
            const socket = new WebSocket(url);
            const timer = setTimeout(() => {
                socket.close();
                reject(new Error('Timed out connecting to your account.'));
            }, AUTHORIZED_OPEN_TIMEOUT_MS);
            socket.addEventListener('open', () => {
                clearTimeout(timer);
                resolve(socket);
            });
            socket.addEventListener('error', () => {
                clearTimeout(timer);
                reject(new Error('Could not connect to your account.'));
            });
        });

    const authorizeError = (request: any, code: string, message: string) => {
        report({ dir: 'in', type: 'authorize', error: { code, message } });
        emit({
            echo_req: { ...request, authorize: '<not shown>' },
            msg_type: 'authorize',
            ...(request.req_id !== undefined ? { req_id: request.req_id } : {}),
            error: { code, message },
        });
    };

    const authorizeReply = (request: any, payload: Record<string, unknown>) => {
        report({ dir: 'in', type: 'authorize' });
        emit({
            echo_req: { ...request, authorize: '<not shown>' },
            msg_type: 'authorize',
            ...(request.req_id !== undefined ? { req_id: request.req_id } : {}),
            authorize: payload,
        });
    };

    const authorize = async (request: any) => {
        const accounts = readOAuthAccounts();
        const account = findAccountByToken(request.authorize, accounts);
        const session = readOAuthSession();
        if (!account || !session) {
            authorizeError(request, 'InvalidToken', 'Your sign-in has expired. Please log in again.');
            return;
        }
        active_loginid = account.loginid;

        // Already connected to this account: no new one-time password needed.
        if (authorized && authorized_account_id === account.account_id && authorized.readyState === WebSocket.OPEN) {
            authorizeReply(request, buildLegacyAuthorize(account, accounts));
            return;
        }

        try {
            const response = await fetch(OTP_URL(account.account_id), {
                method: 'POST',
                headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
            });
            const json = await response.json().catch(() => ({}));
            const url = json && json.data && json.data.url;
            if (!response.ok || !url) {
                const rejected = response.status === 401 || response.status === 403;
                authorizeError(
                    request,
                    rejected ? 'InvalidToken' : 'AuthorizationRequired',
                    `Could not open the account (${response.status}).`
                );
                return;
            }
            const socket = await openAuthorized(url);
            closeAuthorized();
            authorized = socket;
            authorized_account_id = account.account_id;
            socket.addEventListener('message', (event: Event) => handleIncoming((event as MessageEvent).data, true));
            socket.addEventListener('close', () => {
                if (authorized !== socket) return;
                authorized = null;
                authorized_account_id = '';
                // Closing the main socket lets the app's own reconnect logic start over.
                try {
                    ws.close();
                } catch (e) {
                    // already closed
                }
            });
            authorizeReply(request, buildLegacyAuthorize(account, accounts));
        } catch (e) {
            authorizeError(request, 'AuthorizationRequired', (e as Error).message || 'Could not open the account.');
        }
    };

    const sendToNewApi = (request: any) => {
        const text = JSON.stringify(toNewRequest(request));
        if (authorized && authorized.readyState === WebSocket.OPEN) {
            authorized.send(aliasToReal(text));
        } else {
            nativeSend(text);
        }
    };

    ws.send = (data: any) => {
        const request = parse(data);
        if (!request) {
            nativeSend(data);
            return;
        }
        report({ dir: 'out', type: Object.keys(request).find(key => key !== 'req_id') });

        const echo = {
            echo_req: request,
            ...(request.req_id !== undefined ? { req_id: request.req_id } : {}),
        };

        if (request.authorize !== undefined) {
            queue = queue.then(() => authorize(request));
            return;
        }
        if (request.logout !== undefined) {
            closeAuthorized();
            clearOAuthSession();
            setTimeout(() => emit({ ...echo, msg_type: 'logout', logout: 1 }), 0);
            return;
        }
        if (request.balance !== undefined && request.account === 'all') {
            setTimeout(
                () =>
                    emit({
                        ...echo,
                        msg_type: 'balance',
                        balance: buildLegacyBalanceAll(readOAuthAccounts(), active_loginid),
                    }),
                0
            );
            return;
        }
        if (request.forget !== undefined || request.forget_all !== undefined) {
            // The subscription may live on either socket; tell both.
            nativeSend(JSON.stringify(request));
            if (authorized && authorized.readyState === WebSocket.OPEN) authorized.send(JSON.stringify(request));
            return;
        }

        // A stub name can also appear as a plain parameter of a real call (contracts_for carries
        // `landing_company`), so stubs only apply when the request is not one of the forwarded calls.
        const is_forwarded_call = FORWARDED_CALLS.some(key => key in request);
        const stub_name = is_forwarded_call ? undefined : Object.keys(LEGACY_STUBS).find(key => key in request);
        if (stub_name) {
            const value = LEGACY_STUBS[stub_name](request);
            setTimeout(() => emit({ ...echo, msg_type: stub_name, [stub_name]: value }), 0);
            return;
        }

        const reply = localReply(request);
        if (reply) {
            setTimeout(() => emit(reply), 0);
            return;
        }
        sendToNewApi(request);
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

    // The adapter's own socket closing also takes the authenticated one down.
    nativeAdd('close', () => closeAuthorized());

    return ws;
};
