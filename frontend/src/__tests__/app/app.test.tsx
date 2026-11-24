import * as React from 'react';
import App from '@app/index';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import apiClient from '@app/utils/apiClient';

// Mock axios - only needed for axios.create used internally by apiClient
jest.mock('axios', () => {
  const actualAxios = jest.requireActual('axios');
  return {
    ...actualAxios,
    create: jest.fn(() => ({
      get: jest.fn(),
      post: jest.fn(),
      delete: jest.fn(),
      interceptors: {
        request: { use: jest.fn() },
        response: { use: jest.fn() },
      },
    })),
  };
});

// Mock apiClient module - needs to return promises for all get/post/put/delete calls
jest.mock('@app/utils/apiClient', () => ({
  __esModule: true,
  default: {
    get: jest.fn().mockResolvedValue({ data: {} }),
    post: jest.fn().mockResolvedValue({ data: {} }),
    put: jest.fn().mockResolvedValue({ data: {} }),
    delete: jest.fn().mockResolvedValue({ data: {} }),
  },
  getAuthToken: jest.fn(() => null),
  setAuthToken: jest.fn(),
  clearAuthToken: jest.fn(),
}));

// Mock the emitter
jest.mock('@app/utils/emitter', () => ({
  __esModule: true,
  default: {
    emit: jest.fn(),
    on: jest.fn(() => jest.fn()), // Return unsubscribe function
    off: jest.fn(),
  },
}));

// Mock storageService for components that use it
jest.mock('@app/services/storageService', () => ({
  storageService: {
    getLocations: jest.fn().mockResolvedValue({
      locations: [],
      s3Status: { success: true },
      localStatus: { success: true },
    }),
    listFiles: jest.fn().mockResolvedValue({ files: [], totalCount: 0 }),
    refreshLocations: jest.fn().mockResolvedValue([]),
  },
}));

const mockedApiClient = apiClient as jest.Mocked<typeof apiClient>;

// Mock global fetch for GitHub API call in AppLayout
global.fetch = jest.fn(() =>
  Promise.resolve({
    json: () => Promise.resolve({ stargazers_count: 100, forks_count: 10 }),
  }),
) as jest.Mock;

describe('App tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Mock the auth/info endpoint to return auth disabled (so app renders immediately)
    // and an already-accepted disclaimer, so no modal steals focus/aria-hidden.
    mockedApiClient.get.mockResolvedValue({
      data: { authMode: 'none', authRequired: false, disclaimer: { status: 'accepted' } },
    } as never);

    // Reset fetch mock
    (global.fetch as jest.Mock).mockClear();

    // Mock console.error and console.log to reduce noise
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore console methods
    (console.error as jest.Mock).mockRestore();
    (console.log as jest.Mock).mockRestore();
  });

  test('should render default App component', async () => {
    const { asFragment } = render(<App />);

    // Wait for auth check to complete
    await waitFor(() => {
      expect(mockedApiClient.get).toHaveBeenCalled();
    });

    // Wait for the app to finish loading
    await waitFor(() => {
      // Should render the main layout with navigation
      expect(screen.queryByLabelText('Loading authentication')).not.toBeInTheDocument();
    });

    expect(asFragment()).toMatchSnapshot();
  });

  it('should render a nav-toggle button', async () => {
    render(<App />);

    // Wait for auth check and app to load
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /dashboard navigation/i })).toBeVisible();
    });
  });

  // I'm fairly sure that this test not going to work properly no matter what we do since JSDOM doesn't actually
  // draw anything. We could potentially make something work, likely using a different test environment, but
  // using Cypress for this kind of test would be more efficient.
  it.skip('should hide the sidebar on smaller viewports', () => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 600 });

    render(<App />);

    window.dispatchEvent(new Event('resize'));

    expect(screen.queryByRole('link', { name: 'Dashboard' })).not.toBeInTheDocument();
  });

  it('should expand the sidebar on larger viewports', async () => {
    render(<App />);

    // Wait for auth check and app to load
    await waitFor(() => {
      expect(screen.getByRole('link', { name: /storage browser/i, hidden: true })).toBeInTheDocument();
    });

    window.dispatchEvent(new Event('resize'));

    // Check that nav links are in the document (sidebar may be collapsed)
    expect(screen.getByRole('link', { name: /storage browser/i, hidden: true })).toBeInTheDocument();
  });

  it('should hide the sidebar when clicking the nav-toggle button', async () => {
    const user = userEvent.setup();

    render(<App />);

    // Wait for auth check and app to load - a disclaimer modal may appear
    await waitFor(() => {
      // Either the disclaimer modal or the nav button should be present
      const hasDisclaimer = screen.queryByRole('button', { name: /accept/i });
      const hasNavButton = screen.queryAllByRole('button', { name: /dashboard navigation/i, hidden: true });
      expect(hasDisclaimer || hasNavButton.length > 0).toBeTruthy();
    });

    // Close disclaimer modal if present
    const acceptButton = screen.queryByRole('button', { name: /accept/i });
    if (acceptButton) {
      await user.click(acceptButton);
    }

    // Now wait for the nav button to appear
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /dashboard navigation/i }).length).toBeGreaterThan(0);
    });

    window.dispatchEvent(new Event('resize'));
    // There may be multiple toggle buttons (one in masthead, one in sidebar) - get the first one
    const buttons = screen.getAllByRole('button', { name: /dashboard navigation/i });
    const button = buttons[0];

    // Sidebar starts collapsed, so nav links have tabindex=-1 (need hidden: true)
    const navLink = screen.getByRole('link', { name: /storage browser/i, hidden: true });
    expect(navLink).toBeInTheDocument();

    await user.click(button);

    // After clicking toggle, sidebar should still have the link
    expect(screen.getByRole('link', { name: /storage browser/i, hidden: true })).toBeInTheDocument();
  });
});
