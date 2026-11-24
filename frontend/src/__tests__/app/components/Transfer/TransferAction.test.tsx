import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TransferAction } from '@app/components/Transfer/TransferAction';
import { StorageLocation, storageService } from '@app/services/storageService';

// Mock the storage service
jest.mock('@app/services/storageService', () => ({
  storageService: {
    getLocations: jest.fn(),
    listFiles: jest.fn(),
    checkConflicts: jest.fn(),
    initiateTransfer: jest.fn(),
  },
}));

// Mock the emitter
jest.mock('@app/utils/emitter', () => ({
  __esModule: true,
  default: {
    emit: jest.fn(),
  },
}));

// Mock EventSource for TransferProgress
global.EventSource = jest.fn(() => ({
  onmessage: null,
  onerror: null,
  close: jest.fn(),
})) as never;

// Mock the SSE tickets module
jest.mock('@app/utils/sseTickets', () => ({
  createAuthenticatedEventSource: jest.fn(() => {
    return Promise.resolve({
      onmessage: null,
      onerror: null,
      close: jest.fn(),
      readyState: 1,
      CONNECTING: 0,
      OPEN: 1,
      CLOSED: 2,
    });
  }),
}));

describe('TransferAction', () => {
  const mockLocations: StorageLocation[] = [
    { id: 'bucket1', name: 'Bucket 1', type: 's3', available: true, region: 'us-east-1' },
    { id: 'local-0', name: 'Data Storage', type: 'local', available: true, path: '/mnt/data' },
  ];

  const mockOnClose = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    // Return the correct structure: { locations, s3Status, localStatus }
    (storageService.getLocations as jest.Mock).mockResolvedValue({
      locations: mockLocations,
      s3Status: { success: true },
      localStatus: { success: true },
    });
    (storageService.listFiles as jest.Mock).mockResolvedValue({ files: [] });
    (storageService.checkConflicts as jest.Mock).mockResolvedValue({
      conflicts: [],
      nonConflicting: [],
    });
    (storageService.initiateTransfer as jest.Mock).mockResolvedValue({
      jobId: 'job-123',
      sseUrl: 'http://test.com/progress/job-123',
    });
  });

  it('should show DestinationPicker initially', async () => {
    render(
      <TransferAction
        sourceLocationId="bucket1"
        sourceType="s3"
        sourcePath=""
        selectedFiles={['file1.txt']}
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    // Wait for the modal title - more specific query
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /select destination/i })).toBeInTheDocument();
    });
  });

  it('should check for conflicts after destination selection', async () => {
    const user = userEvent.setup();

    render(
      <TransferAction
        sourceLocationId="bucket1"
        sourceType="s3"
        sourcePath=""
        selectedFiles={['file1.txt', 'file2.txt']}
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    // Select destination
    const select = screen.getByRole('combobox');
    // Locations load asynchronously; React 19 no longer flushes the update
    // before the interaction, so wait for the options to exist.
    await waitFor(() => {
      expect(screen.getAllByRole('option').length).toBeGreaterThan(1);
    });
    await user.selectOptions(select, 'local-0');

    // Wait for button to be enabled
    await waitFor(() => {
      const selectButton = screen.getByRole('button', { name: /select destination/i });
      expect(selectButton).not.toBeDisabled();
    });

    const selectButton = screen.getByRole('button', { name: /select destination/i });
    await user.click(selectButton);

    await waitFor(() => {
      expect(storageService.checkConflicts).toHaveBeenCalledWith('bucket1', '', expect.any(Array), 'local-0', '');
    });
  });

  it('should show ConflictResolutionModal when conflicts exist', async () => {
    const user = userEvent.setup();
    (storageService.checkConflicts as jest.Mock).mockResolvedValue({
      conflicts: ['file1.txt'],
      nonConflicting: ['file2.txt'],
    });

    render(
      <TransferAction
        sourceLocationId="bucket1"
        sourceType="s3"
        sourcePath=""
        selectedFiles={['file1.txt', 'file2.txt']}
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    const select = screen.getByRole('combobox');
    // Locations load asynchronously; React 19 no longer flushes the update
    // before the interaction, so wait for the options to exist.
    await waitFor(() => {
      expect(screen.getAllByRole('option').length).toBeGreaterThan(1);
    });
    await user.selectOptions(select, 'local-0');

    // Wait for button to be enabled
    await waitFor(() => {
      const selectButton = screen.getByRole('button', { name: /select destination/i });
      expect(selectButton).not.toBeDisabled();
    });

    const selectButton = screen.getByRole('button', { name: /select destination/i });
    await user.click(selectButton);

    // Wait for conflict modal - matches "1 file already exists" or "N files already exist"
    await waitFor(() => {
      expect(screen.getByText(/already exist/i)).toBeInTheDocument();
    });
  });

  it('should skip to transfer when no conflicts exist', async () => {
    const user = userEvent.setup();

    render(
      <TransferAction
        sourceLocationId="bucket1"
        sourceType="s3"
        sourcePath=""
        selectedFiles={['file1.txt']}
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    const select = screen.getByRole('combobox');
    // Locations load asynchronously; React 19 no longer flushes the update
    // before the interaction, so wait for the options to exist.
    await waitFor(() => {
      expect(screen.getAllByRole('option').length).toBeGreaterThan(1);
    });
    await user.selectOptions(select, 'local-0');

    // Wait for button to be enabled
    await waitFor(() => {
      const selectButton = screen.getByRole('button', { name: /select destination/i });
      expect(selectButton).not.toBeDisabled();
    });

    const selectButton = screen.getByRole('button', { name: /select destination/i });
    await user.click(selectButton);

    await waitFor(() => {
      expect(storageService.initiateTransfer).toHaveBeenCalled();
    });
  });

  it('should initiate transfer with correct source parameters', async () => {
    const user = userEvent.setup();

    render(
      <TransferAction
        sourceLocationId="bucket1"
        sourceType="s3"
        sourcePath="folder1"
        selectedFiles={['file1.txt', 'file2.txt']}
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    const select = screen.getByRole('combobox');
    // Locations load asynchronously; React 19 no longer flushes the update
    // before the interaction, so wait for the options to exist.
    await waitFor(() => {
      expect(screen.getAllByRole('option').length).toBeGreaterThan(1);
    });
    await user.selectOptions(select, 'local-0');

    // Wait for the location to be selected and button to be enabled
    await waitFor(() => {
      const selectButton = screen.getByRole('button', { name: /select destination/i });
      expect(selectButton).not.toBeDisabled();
    });

    const selectButton = screen.getByRole('button', { name: /select destination/i });
    await user.click(selectButton);

    // Wait for transfer to be initiated
    await waitFor(() => {
      expect(storageService.initiateTransfer).toHaveBeenCalled();
    });

    // Verify the source and file parameters are correct
    const callArgs = (storageService.initiateTransfer as jest.Mock).mock.calls[0][0];
    expect(callArgs.source).toEqual({
      type: 's3',
      locationId: 'bucket1',
      path: 'folder1',
    });
    expect(callArgs.items).toEqual([
      { path: 'file1.txt', type: 'file' },
      { path: 'file2.txt', type: 'file' },
    ]);
    expect(callArgs.conflictResolution).toBe('rename');
  });

  it('should show TransferProgress after initiating transfer', async () => {
    const user = userEvent.setup();

    render(
      <TransferAction
        sourceLocationId="bucket1"
        sourceType="s3"
        sourcePath=""
        selectedFiles={['file1.txt']}
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    const select = screen.getByRole('combobox');
    // Locations load asynchronously; React 19 no longer flushes the update
    // before the interaction, so wait for the options to exist.
    await waitFor(() => {
      expect(screen.getAllByRole('option').length).toBeGreaterThan(1);
    });
    await user.selectOptions(select, 'local-0');

    // Wait for button to be enabled
    await waitFor(() => {
      const selectButton = screen.getByRole('button', { name: /select destination/i });
      expect(selectButton).not.toBeDisabled();
    });

    const selectButton = screen.getByRole('button', { name: /select destination/i });
    await user.click(selectButton);

    await waitFor(() => {
      expect(screen.getByText('File Transfer Progress')).toBeInTheDocument();
    });
  });

  it('should reset state when modal closes and reopens', async () => {
    const { rerender } = render(
      <TransferAction
        sourceLocationId="bucket1"
        sourceType="s3"
        sourcePath=""
        selectedFiles={['file1.txt']}
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /select destination/i })).toBeInTheDocument();
    });

    // Close modal
    rerender(
      <TransferAction
        sourceLocationId="bucket1"
        sourceType="s3"
        sourcePath=""
        selectedFiles={['file1.txt']}
        isOpen={false}
        onClose={mockOnClose}
      />,
    );

    // Reopen modal
    rerender(
      <TransferAction
        sourceLocationId="bucket1"
        sourceType="s3"
        sourcePath=""
        selectedFiles={['file1.txt']}
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    // Should be back at destination picker
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /select destination/i })).toBeInTheDocument();
    });
  });

  it('should handle conflict resolution and proceed to transfer', async () => {
    const user = userEvent.setup();
    (storageService.checkConflicts as jest.Mock).mockResolvedValue({
      conflicts: ['file1.txt'],
      nonConflicting: [],
    });

    render(
      <TransferAction
        sourceLocationId="bucket1"
        sourceType="s3"
        sourcePath=""
        selectedFiles={['file1.txt']}
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    // Select destination
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    const select = screen.getByRole('combobox');
    // Locations load asynchronously; React 19 no longer flushes the update
    // before the interaction, so wait for the options to exist.
    await waitFor(() => {
      expect(screen.getAllByRole('option').length).toBeGreaterThan(1);
    });
    await user.selectOptions(select, 'local-0');

    // Wait for button to be enabled
    await waitFor(() => {
      const selectButton = screen.getByRole('button', { name: /select destination/i });
      expect(selectButton).not.toBeDisabled();
    });

    const selectButton = screen.getByRole('button', { name: /select destination/i });
    await user.click(selectButton);

    // Wait for conflict modal - matches "1 file already exists" or "N files already exist"
    await waitFor(() => {
      expect(screen.getByText(/already exist/i)).toBeInTheDocument();
    });

    // The conflict modal has "Apply" button, not "Proceed with Transfer"
    const applyButton = screen.getByRole('button', { name: /apply/i });
    await user.click(applyButton);

    await waitFor(() => {
      expect(storageService.initiateTransfer).toHaveBeenCalled();
    });
  });

  it('should call onClose when cancel is clicked', async () => {
    const user = userEvent.setup();

    render(
      <TransferAction
        sourceLocationId="bucket1"
        sourceType="s3"
        sourcePath=""
        selectedFiles={['file1.txt']}
        isOpen={true}
        onClose={mockOnClose}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Cancel')).toBeInTheDocument();
    });

    const cancelButton = screen.getByText('Cancel');
    await user.click(cancelButton);

    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });
});
