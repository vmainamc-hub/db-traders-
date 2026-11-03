/* eslint-disable import/no-named-as-default-member */
/* eslint-disable import/no-named-as-default */
import ReactDOM from 'react-dom';
import React from 'react';
import 'babel-polyfill';
import 'promise-polyfill';
// eslint-disable-next-line
import registerServiceWorker from 'Utils/pwa';
import initStore from 'App/initStore';
import App from 'App/app.jsx';
import { checkAndSetEndpointFromUrl, handleOAuth2Callback, initDebugPanel } from '@deriv/shared';
import AppNotificationMessages from './App/Containers/app-notification-messages.jsx';

if (
    !!window?.localStorage.getItem?.('debug_service_worker') || // To enable local service worker related development
    (!window.location.hostname.startsWith('localhost') && !/binary\.sx/.test(window.location.hostname)) ||
    window.location.hostname === 'deriv-app.binary.sx'
) {
    registerServiceWorker();
}

// if we don't clear the local storage, then exchange_rates subscription calls won't be made when user refreshes the page
// check packages/stores/src/providers/ExchangeRatesProvider.tsx

if (window.localStorage.getItem('exchange_rates')) {
    window.localStorage.removeItem('exchange_rates');
}
initDebugPanel();
const has_endpoint_url = checkAndSetEndpointFromUrl();
const is_oauth_callback = !has_endpoint_url && handleOAuth2Callback();

// if has endpoint url, APP will be redirected. On the OAuth callback page the sign-in is completed instead.
if (!has_endpoint_url && !is_oauth_callback) {
    const root_store = initStore(AppNotificationMessages);

    const wrapper = document.getElementById('deriv_app');
    if (wrapper) {
        ReactDOM.render(<App useSuspense={false} root_store={root_store} />, wrapper);
    }
}
