/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Bridge between Deriv's new OAuth 2.0 accounts (ids like DOT92307170 / ROT91139228)
 * and the legacy account model this app was written for (VRTC... / CR... ids, one
 * token per account, `authorize` response with an account_list).
 *
 * New accounts get a legacy-looking alias so the rest of the app (which tests ids
 * with /^VR/, /^CR/ and friends) keeps working unchanged:
 *   demo  DOT92307170 -> VRTC92307170
 *   real  ROT91139228 -> CR91139228
 * The alias is only used inside this browser; requests to Deriv use the real id.
 *
 * The per-account "token" the app stores is `oauth:<account_id>`. The real bearer
 * token never leaves localStorage (OAUTH_STORAGE_KEY) and is only used by the
 * socket adapter to request a one-time WebSocket URL.
 */

export const OAUTH_STORAGE_KEY = 'deriv_oauth_session';
export const OAUTH_ACCOUNTS_KEY = 'deriv_oauth_accounts_raw';
export const OAUTH_TOKEN_PREFIX = 'oauth:';

export type TOAuthAccount = {
    account_id: string;
    loginid: string;
    balance: number;
    currency: string;
    is_virtual: 0 | 1;
    status: string;
};

const safeParse = (value: string | null) => {
    try {
        return value ? JSON.parse(value) : null;
    } catch (e) {
        return null;
    }
};

export const toLegacyLoginid = (account_id: string, account_type: string) => {
    const digits = account_id.replace(/^[A-Za-z]+/, '');
    return `${account_type === 'demo' ? 'VRTC' : 'CR'}${digits}`;
};

/** Reads the accounts list the sign-in saved (the raw /options/accounts response). */
export const readOAuthAccounts = (): TOAuthAccount[] => {
    const raw = safeParse(localStorage.getItem(OAUTH_ACCOUNTS_KEY));
    const list = raw && Array.isArray(raw.data) ? raw.data : [];
    return list
        .filter((item: any) => item && item.account_id)
        .map((item: any) => ({
            account_id: String(item.account_id),
            loginid: toLegacyLoginid(String(item.account_id), item.account_type),
            balance: Number(item.balance) || 0,
            currency: item.currency || 'USD',
            is_virtual: item.account_type === 'demo' ? 1 : 0,
            status: item.status || 'active',
        }));
};

export const readOAuthSession = (): { access_token: string; expires_at: number } | null => {
    const session = safeParse(localStorage.getItem(OAUTH_STORAGE_KEY));
    if (!session || !session.access_token) return null;
    if (session.expires_at && Date.now() >= session.expires_at) return null;
    return session;
};

export const tokenFor = (account: TOAuthAccount) => `${OAUTH_TOKEN_PREFIX}${account.account_id}`;

export const findAccountByToken = (token: unknown, accounts = readOAuthAccounts()) => {
    if (typeof token !== 'string' || !token.startsWith(OAUTH_TOKEN_PREFIX)) return undefined;
    const account_id = token.slice(OAUTH_TOKEN_PREFIX.length);
    return accounts.find(account => account.account_id === account_id);
};

/**
 * The address the app is sent to after sign-in. It uses the app's existing
 * "login coming back" format (acct1/token1/cur1 ...), which the client store
 * turns into its stored accounts after calling `authorize`.
 * The demo account is listed first and selected, so a fresh sign-in never
 * starts on the real account by accident.
 */
export const buildLoginQuery = (accounts: TOAuthAccount[]) => {
    const ordered = [...accounts].sort((a, b) => b.is_virtual - a.is_virtual);
    const params = new URLSearchParams();
    ordered.forEach((account, index) => {
        params.set(`acct${index + 1}`, account.loginid);
        params.set(`token${index + 1}`, tokenFor(account));
        params.set(`cur${index + 1}`, account.currency);
    });
    if (ordered.length) params.set('selected_acct', ordered[0].loginid);
    return params.toString();
};

/** Legacy `authorize` response for one account. */
export const buildLegacyAuthorize = (account: TOAuthAccount, accounts: TOAuthAccount[]) => ({
    account_list: accounts.map(item => ({
        account_category: 'trading',
        account_type: 'binary',
        created_at: 0,
        currency: item.currency,
        is_disabled: item.status === 'active' ? 0 : 1,
        is_virtual: item.is_virtual,
        landing_company_name: item.is_virtual ? 'virtual' : 'svg',
        linked_to: [],
        loginid: item.loginid,
    })),
    balance: account.balance,
    country: '',
    currency: account.currency,
    email: '',
    fullname: '',
    is_virtual: account.is_virtual,
    landing_company_fullname: account.is_virtual ? 'Deriv Limited' : 'Deriv (SVG) LLC',
    landing_company_name: account.is_virtual ? 'virtual' : 'svg',
    linked_to: [],
    local_currencies: {},
    loginid: account.loginid,
    preferred_language: 'EN',
    scopes: ['read', 'trade'],
    upgradeable_landing_companies: [],
    user_id: Number(account.account_id.replace(/\D/g, '')) || 0,
});

/** Replaces every legacy alias in an outgoing message with the real Deriv account id. */
export const aliasToReal = (text: string, accounts = readOAuthAccounts()) =>
    accounts.reduce((out, account) => out.split(account.loginid).join(account.account_id), text);

/** Replaces every real Deriv account id in an incoming message with its legacy alias. */
export const realToAlias = (text: string, accounts = readOAuthAccounts()) =>
    accounts.reduce((out, account) => out.split(account.account_id).join(account.loginid), text);

/** Legacy `balance` response for `account: 'all'`, built from the saved accounts list. */
export const buildLegacyBalanceAll = (accounts = readOAuthAccounts(), active_loginid?: string) => {
    const active = accounts.find(account => account.loginid === active_loginid) || accounts[0];
    return {
        accounts: Object.fromEntries(
            accounts.map(account => [
                account.loginid,
                {
                    balance: account.balance,
                    converted_amount: account.balance,
                    currency: account.currency,
                    demo_account: account.is_virtual,
                    status: account.status === 'active' ? 1 : 0,
                    type: 'deriv',
                },
            ])
        ),
        balance: active ? active.balance : 0,
        currency: active ? active.currency : 'USD',
        loginid: active ? active.loginid : '',
        total: {
            deriv: { amount: active ? active.balance : 0, currency: active ? active.currency : 'USD' },
            deriv_demo: { amount: 0, currency: 'USD' },
            mt5: { amount: 0, currency: 'USD' },
            mt5_demo: { amount: 0, currency: 'USD' },
        },
    };
};

export const clearOAuthSession = () => {
    try {
        localStorage.removeItem(OAUTH_STORAGE_KEY);
        localStorage.removeItem(OAUTH_ACCOUNTS_KEY);
    } catch (e) {
        // storage can be unavailable; nothing else to do
    }
};
