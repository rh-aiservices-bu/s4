import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DestinationPicker } from '@app/components/Transfer/DestinationPicker';
import { FileEntry, StorageLocation, storageService } from '@app/services/storageService';

// Mock the storage service
jest.mock('@app/services/storageService', () => ({
  storageService: {
    getLocations: jest.fn(),
    listFiles: jest.fn(),
    createDirectory: jest.fn(),
  },
}));

// Mock the emitter
jest.mock('@app/utils/emitter', () => ({
  __esModule: true,
  default: {
    emit: jest.fn(),
  },
}));

describe('DestinationPicker', () => {
  const mockLocations: StorageLocation[] = [
    { id: 'bucket1', name: 'Bucket 1', type: 's3', available: true, region: 'us-east-1' },
    { id: 'local-0', name: 'Data Storage', type: 'local', available: true, path: '/mnt/data' },
    { id: 'local-1', name: 'Model Storage', type: 'local', available: false, path: '/mnt/models' },
  ];

  const mockDirectories: FileEntry[] = [
    { name: 'folder1', path: 'folder1', type: 'directory' },
    { name: 'folder2', path: 'folder2', type: 'directory' },
  ];

  const mockOnSelect = jest.fn();
  const mockOnCancel = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    // Return the correct structure: { locations, s3Status, localStatus }
    (storageService.getLocations as jest.Mock).mockResolvedValue({
      locations: mockLocations,
      s3Status: { success: true },
      localStatus: { success: true },
    });
    (storageService.listFiles as jest.Mock).mockResolvedValue({ files: mockDirectories });
  });

  afterEach(() => {
    // Clean up global.prompt if it was mocked
    if ('prompt' in global) {
      delete (global as { prompt?: typeof window.prompt }).prompt;
    }
  });

  it('should load locations when modal opens', async () => {
    render(<DestinationPicker isOpen={true} onSelect={mockOnSelect} onCancel={mockOnCancel} />);

    await waitFor(() => {
      expect(storageService.getLocations).toHaveBeenCalledTimes(1);
    });
  });

  it('should display all locations in dropdown', async () => {
    render(<DestinationPicker isOpen={true} onSelect={mockOnSelect} onCancel={mockOnCancel} />);

    await waitFor(() => {
      expect(screen.getByText(/Bucket 1 \(S3\)/)).toBeInTheDocument();
    });

    const select = screen.getByRole('combobox');
    // Locations load asynchronously; React 19 no longer flushes the update
    // before the interaction, so wait for the options to exist.
    await waitFor(() => {
      expect(screen.getAllByRole('option').length).toBeGreaterThan(1);
    });
    expect(select).toBeInTheDocument();
  });

  it('should disable unavailable locations', async () => {
    render(<DestinationPicker isOpen={true} onSelect={mockOnSelect} onCancel={mockOnCancel} />);

    await waitFor(() => {
      expect(screen.getByText(/Model Storage.*unavailable/)).toBeInTheDocument();
    });
  });

  it('should list directories when location is selected', async () => {
    const user = userEvent.setup();
    render(<DestinationPicker isOpen={true} onSelect={mockOnSelect} onCancel={mockOnCancel} />);

    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    // Select a location
    const select = screen.getByRole('combobox');
    // Locations load asynchronously; React 19 no longer flushes the update
    // before the interaction, so wait for the options to exist.
    await waitFor(() => {
      expect(screen.getAllByRole('option').length).toBeGreaterThan(1);
    });
    await user.selectOptions(select, 'bucket1');

    await waitFor(() => {
      expect(storageService.listFiles).toHaveBeenCalledWith('bucket1', '');
    });

    await waitFor(() => {
      expect(screen.getByText('folder1')).toBeInTheDocument();
      expect(screen.getByText('folder2')).toBeInTheDocument();
    });
  });

  it('should navigate into folder when clicked', async () => {
    const user = userEvent.setup();
    render(<DestinationPicker isOpen={true} onSelect={mockOnSelect} onCancel={mockOnCancel} />);

    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    const select = screen.getByRole('combobox');
    // Locations load asynchronously; React 19 no longer flushes the update
    // before the interaction, so wait for the options to exist.
    await waitFor(() => {
      expect(screen.getAllByRole('option').length).toBeGreaterThan(1);
    });
    await user.selectOptions(select, 'bucket1');

    await waitFor(() => {
      expect(screen.getByText('folder1')).toBeInTheDocument();
    });

    // Click on folder1
    const folder1 = screen.getByText('folder1');
    await user.click(folder1);

    await waitFor(() => {
      expect(storageService.listFiles).toHaveBeenCalledWith('bucket1', 'folder1');
    });
  });

  it('should navigate via breadcrumb', async () => {
    const user = userEvent.setup();

    // Set up mock to return different results for different paths
    (storageService.listFiles as jest.Mock).mockImplementation((locationId, path) => {
      if (path === '') {
        return Promise.resolve({ files: mockDirectories });
      } else if (path === 'folder1') {
        return Promise.resolve({
          files: [{ name: 'subfolder', path: 'folder1/subfolder', type: 'directory' }],
        });
      }
      return Promise.resolve({ files: [] });
    });

    render(<DestinationPicker isOpen={true} onSelect={mockOnSelect} onCancel={mockOnCancel} />);

    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    const select = screen.getByRole('combobox');
    // Locations load asynchronously; React 19 no longer flushes the update
    // before the interaction, so wait for the options to exist.
    await waitFor(() => {
      expect(screen.getAllByRole('option').length).toBeGreaterThan(1);
    });
    await user.selectOptions(select, 'bucket1');

    await waitFor(() => {
      expect(screen.getByText('folder1')).toBeInTheDocument();
    });

    // Navigate into folder1
    await user.click(screen.getByText('folder1'));

    await waitFor(() => {
      expect(screen.getByText('subfolder')).toBeInTheDocument();
    });

    // Click Root in breadcrumb
    const rootBreadcrumb = screen.getByText('Root');
    await user.click(rootBreadcrumb);

    await waitFor(() => {
      expect(screen.getByText('folder1')).toBeInTheDocument();
    });
  });

  it('should create new folder', async () => {
    const user = userEvent.setup();

    render(<DestinationPicker isOpen={true} onSelect={mockOnSelect} onCancel={mockOnCancel} />);

    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    const select = screen.getByRole('combobox');
    // Locations load asynchronously; React 19 no longer flushes the update
    // before the interaction, so wait for the options to exist.
    await waitFor(() => {
      expect(screen.getAllByRole('option').length).toBeGreaterThan(1);
    });
    await user.selectOptions(select, 'bucket1');

    await waitFor(() => {
      expect(screen.getByText('Create Folder')).toBeInTheDocument();
    });

    // Click Create Folder button to open modal
    const createButton = screen.getByText('Create Folder');
    await user.click(createButton);

    // Wait for folder creation modal to appear
    await waitFor(() => {
      expect(screen.getByText('Create a new folder')).toBeInTheDocument();
    });

    // Type folder name in the input (use hidden: true since the first modal is aria-hidden)
    const folderNameInput = screen.getByRole('textbox', { hidden: true });
    await user.type(folderNameInput, 'new-folder');

    // Click the Create button in the modal (use hidden: true since modals are nested)
    // Get all Create buttons (there might be Create Folder button too) and select the right one
    const createButtons = screen.getAllByRole('button', { name: /^Create$/i, hidden: true });
    // The "Create" button should be in the folder creation modal - get the last one
    const createModalButton = createButtons[createButtons.length - 1];
    await user.click(createModalButton);

    await waitFor(() => {
      expect(storageService.createDirectory).toHaveBeenCalledWith('bucket1', 'new-folder');
    });
  });

  it('should call onSelect with location and path', async () => {
    const user = userEvent.setup();
    render(<DestinationPicker isOpen={true} onSelect={mockOnSelect} onCancel={mockOnCancel} />);

    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    const select = screen.getByRole('combobox');
    // Locations load asynchronously; React 19 no longer flushes the update
    // before the interaction, so wait for the options to exist.
    await waitFor(() => {
      expect(screen.getAllByRole('option').length).toBeGreaterThan(1);
    });
    await user.selectOptions(select, 'bucket1');

    // Wait for button to be enabled
    await waitFor(() => {
      const selectButton = screen.getByRole('button', { name: /select destination/i });
      expect(selectButton).not.toBeDisabled();
    });

    const selectButton = screen.getByRole('button', { name: /select destination/i });
    await user.click(selectButton);

    expect(mockOnSelect).toHaveBeenCalledWith('bucket1', '');
  });

  it('should call onCancel when cancel is clicked', async () => {
    const user = userEvent.setup();
    render(<DestinationPicker isOpen={true} onSelect={mockOnSelect} onCancel={mockOnCancel} />);

    await waitFor(() => {
      expect(screen.getByText('Cancel')).toBeInTheDocument();
    });

    const cancelButton = screen.getByText('Cancel');
    await user.click(cancelButton);

    expect(mockOnCancel).toHaveBeenCalledTimes(1);
  });

  it('should disable select button when no location selected', async () => {
    render(<DestinationPicker isOpen={true} onSelect={mockOnSelect} onCancel={mockOnCancel} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /select destination/i })).toBeInTheDocument();
    });

    const selectButton = screen.getByRole('button', { name: /select destination/i });
    expect(selectButton).toBeDisabled();
  });

  it('should not render when modal is closed', () => {
    render(<DestinationPicker isOpen={false} onSelect={mockOnSelect} onCancel={mockOnCancel} />);

    expect(screen.queryByText('Select Destination')).not.toBeInTheDocument();
  });
});
