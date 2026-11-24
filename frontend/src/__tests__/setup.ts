// Jest setup file for frontend tests
import '@testing-library/jest-dom';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

// Add polyfills for jsdom environment
import { TextDecoder, TextEncoder } from 'util';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const transferTranslations = require('../../public/locales/en/transfer.json');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const storageBrowserTranslations = require('../../public/locales/en/storage-browser.json');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bucketsTranslations = require('../../public/locales/en/buckets.json');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const settingsTranslations = require('../../public/locales/en/settings.json');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const loginTranslations = require('../../public/locales/en/login.json');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const errorsTranslations = require('../../public/locales/en/errors.json');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const translationTranslations = require('../../public/locales/en/translation.json');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
global.TextEncoder = TextEncoder as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
global.TextDecoder = TextDecoder as any;

// Initialize i18n for tests with all namespaces
i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['translation', 'storage-browser', 'buckets', 'settings', 'transfer', 'login', 'errors'],
  defaultNS: 'translation',
  interpolation: {
    escapeValue: false,
  },
  resources: {
    en: {
      translation: translationTranslations,
      'storage-browser': storageBrowserTranslations,
      buckets: bucketsTranslations,
      settings: settingsTranslations,
      transfer: transferTranslations,
      login: loginTranslations,
      errors: errorsTranslations,
    },
  },
});

// Mock window.matchMedia for responsive components
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: jest.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
});

// jsdom performs no layout, so every element reports clientWidth/clientHeight 0.
// PatternFly 6.7 derives the Page breakpoint (and therefore the mobile drawer
// layout) from the container size; without these the whole app renders in
// mobile mode and the page content is aria-hidden behind a backdrop.
Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
  configurable: true,
  get() {
    return 1200;
  },
});

Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
  configurable: true,
  get() {
    return 900;
  },
});

// Mock IntersectionObserver
global.IntersectionObserver = class IntersectionObserver {
  constructor() {}
  disconnect() {}
  observe() {}
  takeRecords() {
    return [];
  }
  unobserve() {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

// Mock ResizeObserver
global.ResizeObserver = class ResizeObserver {
  constructor() {}
  disconnect() {}
  observe() {}
  unobserve() {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

// Add any global test configuration here
// This file runs after the test framework is initialized but before tests run
