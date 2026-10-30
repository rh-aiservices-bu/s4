import * as React from 'react';
import { useTranslation } from 'react-i18next';
import apiClient from '@app/utils/apiClient';
import {
  Button,
  Card,
  Content,
  ContentVariants,
  EmptyState,
  EmptyStateBody,
  EmptyStateFooter,
  Flex,
  FlexItem,
  Form,
  FormGroup,
  FormHelperText,
  FormSelect,
  FormSelectOption,
  HelperText,
  HelperTextItem,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  PageSection,
  Popover,
  Skeleton,
  TextInput,
  ToolbarContent,
  ToolbarGroup,
  ToolbarItem,
  Tooltip,
} from '@patternfly/react-core';
import { Table, Tbody, Td, Th, ThProps, Thead, Tr } from '@patternfly/react-table';
import {
  AngleLeftIcon,
  AngleRightIcon,
  BellIcon,
  CloudIcon,
  CubesIcon,
  DatabaseIcon,
  FolderIcon,
  QuestionCircleIcon,
  SearchIcon,
  SyncIcon,
  TrashIcon,
} from '@patternfly/react-icons';
import { useNavigate } from 'react-router-dom';
import { notifyApiError, notifySuccess, notifyWarning } from '@app/utils/notifications';
import { getBucketNameRules, validateS3BucketName } from '@app/utils/validation';
import { useModal, useStorageLocations } from '@app/hooks';
import { MobileCardItem, MobileCardView, ResponsiveTableWrapper } from '@app/components/ResponsiveTable';
import BucketNotificationsModal from './BucketNotificationsModal';

class Bucket {
  Name: string;
  CreationDate: string;

  constructor(name: string, creationDate: string) {
    this.Name = name;
    this.CreationDate = creationDate;
  }
}

class Owner {
  DisplayName: string;
  ID: string;

  constructor(displayName: string, id: string) {
    this.DisplayName = displayName;
    this.ID = id;
  }
}

class BucketsList {
  buckets: Bucket[];
  owner: Owner;

  constructor(buckets: Bucket[], owner: Owner) {
    this.buckets = buckets;
    this.owner = owner;
  }
}

const Buckets: React.FunctionComponent = () => {
  const { t } = useTranslation(['buckets', 'translation']);
  const navigate = useNavigate();

  // New bucket handling
  const [newBucketName, setNewBucketName] = React.useState('');
  const [newBucketNameRulesVisibility, setNewBucketNameRulesVisibility] = React.useState(false);

  // Create bucket modal handling
  const createBucketModal = useModal();

  const handleNewBucketCreate = () => {
    if (!validateBucketName(newBucketName)) {
      notifyWarning(t('validation.invalidName'), t('validation.invalidNameMessage', { bucketName: newBucketName }));
      return;
    } else {
      apiClient
        .post(`/buckets`, {
          bucketName: newBucketName,
        })
        .then((_response) => {
          notifySuccess(t('createModal.success'), t('createModal.successMessage', { bucketName: newBucketName }));
          // Refresh both locations and bucket details (force refresh to update cache)
          Promise.all([refreshLocations(), loadBucketDetails()])
            .then(() => {
              setNewBucketName('');
              createBucketModal.close();
            })
            .catch((error) => {
              notifyApiError(t('translation:common.actions.refresh'), error);
            });
        })
        .catch((error) => {
          notifyApiError(t('actions.createBucket'), error);
          createBucketModal.close();
        });
    }
  };

  const handleNewBucketCancel = () => {
    setNewBucketName('');
    createBucketModal.close();
  };

  // Notifications modal handling
  const notificationsModal = useModal();
  const [notificationsBucket, setNotificationsBucket] = React.useState('');

  const handleNotificationsClick = (name: string) => (_event: React.MouseEvent<HTMLButtonElement>) => {
    setNotificationsBucket(name);
    notificationsModal.open();
  };

  // Delete bucket handling
  const deleteBucketModal = useModal();
  const [selectedBucket, setSelectedBucket] = React.useState('');
  const [bucketToDelete, setBucketToDelete] = React.useState('');

  const handleDeleteBucketClick = (name: string) => (_event: React.MouseEvent<HTMLButtonElement>) => {
    setSelectedBucket(name);
    deleteBucketModal.open();
  };

  const validateBucketToDelete = (): boolean => {
    if (bucketToDelete !== selectedBucket) {
      return false;
    } else {
      return true;
    }
  };

  const handleDeleteBucketConfirm = () => {
    if (!validateBucketToDelete()) {
      return;
    } else {
      apiClient
        .delete(`/buckets/${selectedBucket}`)
        .then((_response) => {
          notifySuccess(t('deleteModal.success'), t('deleteModal.successMessage', { bucketName: selectedBucket }));
          // Refresh both locations and bucket details (force refresh to update cache)
          Promise.all([refreshLocations(), loadBucketDetails()])
            .then(() => {
              setBucketToDelete('');
              deleteBucketModal.close();
            })
            .catch((error) => {
              notifyApiError(t('translation:common.actions.refresh'), error);
            });
        })
        .catch((error) => {
          notifyApiError(t('actions.deleteBucket'), error);
        });
    }
  };

  const handleDeleteBucketCancel = () => {
    setBucketToDelete('');
    deleteBucketModal.close();
  };

  // Storage locations handling (S3 + PVC)
  const [searchBucketText, setSearchBucketText] = React.useState('');
  // Suppress notifications - Buckets page is where users go to CREATE buckets,
  // so they don't need a notification saying there are no buckets
  const {
    locations,
    loading: _locationsLoading,
    refreshLocations,
  } = useStorageLocations({
    suppressNotifications: true,
  });
  const [bucketsList, setBucketsList] = React.useState<BucketsList | null>(null);
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [isLoadingBuckets, setIsLoadingBuckets] = React.useState(true);

  // Pagination state
  const [bucketsPerPage, setBucketsPerPage] = React.useState(25);
  const [currentPage, setCurrentPage] = React.useState(1);

  // Validate bucket name using centralized validation utility
  const validateBucketName = React.useCallback(
    (name: string): boolean => {
      const existingBucketNames = bucketsList?.buckets.map((bucket) => bucket.Name) || [];
      return validateS3BucketName(name, existingBucketNames);
    },
    [bucketsList],
  );

  React.useEffect(() => {
    // Only show validation error after 3+ characters
    const hasValidationError = newBucketName.length >= 3 && !validateBucketName(newBucketName);
    setNewBucketNameRulesVisibility(hasValidationError);
  }, [newBucketName, validateBucketName]);

  // Manual refresh handler
  const handleRefreshLocations = async () => {
    setIsRefreshing(true);
    try {
      // Refresh both storage locations and bucket details
      await Promise.all([refreshLocations(), loadBucketDetails()]);

      notifySuccess(t('refresh.success'), t('refresh.successMessage'));
    } catch (error: unknown) {
      notifyApiError(t('translation:common.actions.refresh'), error);
    } finally {
      setIsRefreshing(false);
    }
  };

  // Load S3 bucket details for creation date and owner
  const loadBucketDetails = async () => {
    try {
      const response = await apiClient.get(`/buckets`);
      const { owner, buckets } = response.data;
      const newBucketsState = new BucketsList(
        buckets.map((bucket: { Name: string; CreationDate: string }) => new Bucket(bucket.Name, bucket.CreationDate)),
        new Owner(owner.DisplayName, owner.ID),
      );
      setBucketsList(newBucketsState);
    } catch (error) {
      console.error('Failed to load bucket details:', error);
      // Don't show notification here as it's not critical and locations already handle errors
    }
  };

  const columnNames = {
    name: t('table.columns.name'),
    type: t('table.columns.type'),
    status: t('table.columns.status'),
    creation_date: t('table.columns.creationDate'),
    owner: t('table.columns.owner'),
  };

  // Map locations to rows for display
  interface LocationRow {
    id: string;
    name: string;
    type: 's3' | 'local';
    available: boolean;
    creation_date?: string;
    owner?: string;
  }

  const rows: LocationRow[] = locations.map((location) => ({
    id: location.id,
    name: location.name,
    type: location.type,
    available: location.available,
    creation_date:
      location.type === 's3' ? bucketsList?.buckets.find((b) => b.Name === location.id)?.CreationDate : undefined,
    owner: location.type === 's3' ? bucketsList?.owner.DisplayName : undefined,
  }));

  const filteredRows = rows.filter(
    (row) =>
      Object.entries(row)
        .map(([_, value]) => value)
        .some((val) => val.toString().toLowerCase().includes(searchBucketText.toLowerCase())), // Search all fields with the search text
  );

  // Index of the currently sorted column
  const [activeSortIndex, setActiveSortIndex] = React.useState<number | null>(null);

  // Sort direction of the currently sorted column
  const [activeSortDirection, setActiveSortDirection] = React.useState<'asc' | 'desc' | null>(null);

  // Since OnSort specifies sorted columns by index, we need sortable values for our object by column index.
  const getSortableRowValues = (row: LocationRow): (string | number | boolean)[] => {
    const { name, type, available, creation_date, owner } = row;
    return [name, type, available ? 1 : 0, creation_date || '', owner || ''];
  };

  let sortedRows = filteredRows;
  if (activeSortIndex !== null) {
    sortedRows = rows.sort((a, b) => {
      const aValue = getSortableRowValues(a)[activeSortIndex as number];
      const bValue = getSortableRowValues(b)[activeSortIndex as number];
      if (typeof aValue === 'number') {
        // Numeric sort
        if (activeSortDirection === 'asc') {
          return (aValue as number) - (bValue as number);
        }
        return (bValue as number) - (aValue as number);
      } else {
        // String sort
        if (activeSortDirection === 'asc') {
          return (aValue as string).localeCompare(bValue as string);
        }
        return (bValue as string).localeCompare(aValue as string);
      }
    });
  }

  // Pagination logic
  const totalItems = sortedRows.length;
  const totalPages = Math.ceil(totalItems / bucketsPerPage);
  const startIndex = (currentPage - 1) * bucketsPerPage;
  const endIndex = Math.min(startIndex + bucketsPerPage, totalItems);
  const paginatedRows = sortedRows.slice(startIndex, endIndex);

  // Map rows to mobile card items
  const mobileCardItems: MobileCardItem[] = paginatedRows.map((row) => ({
    id: row.id,
    title: row.name,
    icon: row.type === 's3' ? <DatabaseIcon /> : <FolderIcon />,
    label: {
      text: row.type === 's3' ? t('types.s3') : t('types.pvc'),
      color: row.type === 's3' ? 'blue' : 'green',
      icon: row.type === 's3' ? <CloudIcon /> : <FolderIcon />,
    },
    fields: [
      {
        label: t('table.columns.status'),
        value: row.available ? (
          t('translation:common.status.available')
        ) : (
          <Label color="red">{t('translation:common.status.unavailable')}</Label>
        ),
      },
      {
        label: t('table.columns.creationDate'),
        value: row.creation_date || '-',
      },
      {
        label: t('table.columns.owner'),
        value: row.owner || '-',
      },
    ],
    actions: row.type === 's3' && (
      <>
        <Tooltip content={<div>{t('tooltips.notifications')}</div>}>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleNotificationsClick(row.name)}
            isDisabled={!row.available}
            aria-label={t('notifications.actions.notifications') + ': ' + row.name}
          >
            <BellIcon />
          </Button>
        </Tooltip>{' '}
        <Tooltip content={<div>{t('tooltips.deleteBucket')}</div>}>
          <Button
            variant="danger"
            size="sm"
            onClick={handleDeleteBucketClick(row.name)}
            isDisabled={!row.available}
            aria-label={t('deleteModal.confirm') + ': ' + row.name}
          >
            <TrashIcon />
          </Button>
        </Tooltip>
      </>
    ),
    onClick: row.available ? () => navigate(`/browse/${row.id}`) : undefined,
    isDisabled: !row.available,
  }));

  // Reset to page 1 when search changes or page size changes
  React.useEffect(() => {
    setCurrentPage(1);
  }, [searchBucketText, bucketsPerPage]);

  // Ensure current page is valid when total pages changes
  React.useEffect(() => {
    if (currentPage > totalPages && totalPages > 0) {
      setCurrentPage(totalPages);
    }
  }, [totalPages, currentPage]);

  const getSortParams = (columnIndex: number): ThProps['sort'] => ({
    sortBy: {
      index: activeSortIndex as number,
      direction: activeSortDirection as 'asc' | 'desc',
      defaultDirection: 'asc', // starting sort direction when first sorting a column. Defaults to 'asc'
    },
    onSort: (_event, index, direction) => {
      setActiveSortIndex(index);
      setActiveSortDirection(direction);
    },
    columnIndex,
  });

  // Load S3 bucket details at startup
  React.useEffect(() => {
    const initLoad = async () => {
      setIsLoadingBuckets(true);
      try {
        await loadBucketDetails();
      } finally {
        setIsLoadingBuckets(false);
      }
    };
    void initLoad();
  }, []);

  return (
    <div className="buckets-list">
      <PageSection hasBodyWrapper={false}>
        <Content>
          <Content component={ContentVariants.h1}>{t('title')}</Content>
        </Content>
      </PageSection>
      <PageSection hasBodyWrapper={false}>
        <Flex>
          <FlexItem>
            <TextInput
              value={searchBucketText}
              type="search"
              onChange={(_event, searchText) => setSearchBucketText(searchText)}
              aria-label={t('search.placeholder')}
              placeholder={t('search.placeholder')}
              customIcon={<SearchIcon />}
              className="buckets-list-filter-search"
            />
          </FlexItem>
          <FlexItem>
            <FormSelect
              value={bucketsPerPage.toString()}
              aria-label={t('translation:accessibility.itemsPerPage')}
              onChange={(_e, value) => {
                setBucketsPerPage(parseInt(value, 10));
              }}
              ouiaId="PageSizeSelect"
              className="page-size-select"
            >
              {[10, 25, 50, 100].map((size) => (
                <FormSelectOption key={size} value={size.toString()} label={t('pagination.perPage', { count: size })} />
              ))}
            </FormSelect>
          </FlexItem>
          <FlexItem>
            <Flex alignItems={{ default: 'alignItemsCenter' }} spaceItems={{ default: 'spaceItemsSm' }}>
              <FlexItem>
                <Button
                  variant="plain"
                  aria-label={t('translation:accessibility.previousPage')}
                  isDisabled={currentPage <= 1}
                  onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
                >
                  <AngleLeftIcon />
                </Button>
              </FlexItem>
              <FlexItem>
                <Content component={ContentVariants.small}>
                  {totalItems > 0
                    ? t('translation:common.pagination.showing', {
                        start: startIndex + 1,
                        end: endIndex,
                        total: totalItems,
                      })
                    : t('translation:common.pagination.noItems')}
                </Content>
              </FlexItem>
              <FlexItem>
                <Button
                  variant="plain"
                  aria-label={t('translation:accessibility.nextPage')}
                  isDisabled={currentPage >= totalPages}
                  onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))}
                >
                  <AngleRightIcon />
                </Button>
              </FlexItem>
            </Flex>
          </FlexItem>
          <FlexItem flex={{ default: 'flex_1' }}></FlexItem>
          <FlexItem>
            <Button
              variant="secondary"
              onClick={handleRefreshLocations}
              isLoading={isRefreshing}
              isDisabled={isLoadingBuckets || isRefreshing}
              icon={<SyncIcon />}
              aria-label={t('actions.refresh')}
            >
              {t('actions.refresh')}
            </Button>
          </FlexItem>
          <FlexItem>
            <Button variant="primary" onClick={createBucketModal.open} ouiaId="ShowCreateProjectModal">
              {t('actions.createBucket')}
            </Button>
          </FlexItem>
        </Flex>
      </PageSection>
      <PageSection hasBodyWrapper={false}>
        <Card component="div">
          {isLoadingBuckets ? (
            <>
              {/* Table view for loading (desktop) */}
              <div className="s4-table-view">
                <ResponsiveTableWrapper ariaLabel="Loading storage locations table">
                  <Table aria-label="Loading storage locations" isStickyHeader>
                    <Thead>
                      <Tr>
                        <Th width={15}>{columnNames.name}</Th>
                        <Th width={10}>{columnNames.type}</Th>
                        <Th width={10} className="s4-hide-below-sm">
                          {columnNames.status}
                        </Th>
                        <Th width={10} className="s4-hide-below-md">
                          {columnNames.creation_date}
                        </Th>
                        <Th width={10} className="s4-hide-below-md">
                          {columnNames.owner}
                        </Th>
                        <Th width={10} screenReaderText={t('translation:common.labels.actions')} />
                      </Tr>
                    </Thead>
                    <Tbody>
                      {[1, 2, 3].map((i) => (
                        <Tr key={i} className="bucket-row">
                          <Td className="bucket-column">
                            <Skeleton width="60%" screenreaderText={t('translation:common.actions.loading')} />
                          </Td>
                          <Td className="bucket-column">
                            <Skeleton width="50px" screenreaderText={t('translation:common.actions.loading')} />
                          </Td>
                          <Td className="bucket-column s4-hide-below-sm">
                            <Skeleton width="80px" screenreaderText={t('translation:common.actions.loading')} />
                          </Td>
                          <Td className="bucket-column s4-hide-below-md">
                            <Skeleton width="100px" screenreaderText={t('translation:common.actions.loading')} />
                          </Td>
                          <Td className="bucket-column s4-hide-below-md">
                            <Skeleton width="80px" screenreaderText={t('translation:common.actions.loading')} />
                          </Td>
                          <Td className="bucket-column align-right">
                            <Skeleton width="40px" screenreaderText={t('translation:common.actions.loading')} />
                          </Td>
                        </Tr>
                      ))}
                    </Tbody>
                  </Table>
                </ResponsiveTableWrapper>
              </div>
              {/* Card view for loading (mobile) */}
              <div className="s4-card-view">
                <MobileCardView items={[]} isLoading={true} skeletonCount={3} ariaLabel="Loading storage locations" />
              </div>
            </>
          ) : sortedRows.length === 0 ? (
            <EmptyState headingLevel="h4" icon={CubesIcon} titleText={t('table.emptyState.title')}>
              <EmptyStateBody>{t('table.emptyState.description')}</EmptyStateBody>
              <EmptyStateFooter>
                <Button variant="primary" onClick={createBucketModal.open}>
                  {t('table.emptyState.createButton')}
                </Button>
              </EmptyStateFooter>
            </EmptyState>
          ) : (
            <>
              {/* Table view (desktop) */}
              <div className="s4-table-view">
                <ResponsiveTableWrapper ariaLabel="Storage locations list table">
                  <Table aria-label="Storage locations list" isStickyHeader>
                    <Thead>
                      <Tr>
                        <Th sort={getSortParams(0)} width={15}>
                          {columnNames.name}
                        </Th>
                        <Th width={10}>{columnNames.type}</Th>
                        <Th width={10} className="s4-hide-below-sm">
                          {columnNames.status}
                        </Th>
                        <Th width={10} className="s4-hide-below-md">
                          {columnNames.creation_date}
                        </Th>
                        <Th width={10} className="s4-hide-below-md">
                          {columnNames.owner}
                        </Th>
                        <Th width={10} screenReaderText={t('translation:common.labels.actions')} />
                      </Tr>
                    </Thead>
                    <Tbody>
                      {paginatedRows.map((row, rowIndex) => (
                        <Tr key={rowIndex} className="bucket-row">
                          <Td className="bucket-column">
                            <Button
                              variant="link"
                              onClick={() => {
                                navigate(`/browse/${row.id}`);
                              }}
                              isDisabled={!row.available}
                            >
                              {row.type === 's3' ? <DatabaseIcon /> : <FolderIcon />}
                              &nbsp;{row.name}
                            </Button>
                          </Td>
                          <Td className="bucket-column">
                            {row.type === 's3' ? (
                              <Label color="blue" icon={<CloudIcon />}>
                                {t('types.s3')}
                              </Label>
                            ) : (
                              <Label color="green" icon={<FolderIcon />}>
                                {t('types.pvc')}
                              </Label>
                            )}
                          </Td>
                          <Td className="bucket-column s4-hide-below-sm">
                            {!row.available && (
                              <Tooltip content={t('translation:common.status.unavailable')}>
                                <Label color="red">{t('translation:common.status.unavailable')}</Label>
                              </Tooltip>
                            )}
                          </Td>
                          <Td className="bucket-column s4-hide-below-md">{row.creation_date || '-'}</Td>
                          <Td className="bucket-column s4-hide-below-md">{row.owner || '-'}</Td>
                          <Td className="bucket-column align-right">
                            {row.type === 's3' && (
                              <ToolbarContent>
                                <ToolbarGroup
                                  variant="action-group-plain"
                                  align={{ default: 'alignEnd' }}
                                  gap={{ default: 'gapMd', md: 'gapMd' }}
                                >
                                  <ToolbarItem>
                                    <Tooltip content={<div>{t('tooltips.notifications')}</div>}>
                                      <Button
                                        variant="secondary"
                                        onClick={handleNotificationsClick(row.name)}
                                        isDisabled={!row.available}
                                        aria-label={t('notifications.actions.notifications') + ': ' + row.name}
                                      >
                                        <BellIcon />
                                      </Button>
                                    </Tooltip>
                                  </ToolbarItem>
                                  <ToolbarItem variant="separator" />
                                  <ToolbarItem>
                                    <Tooltip content={<div>{t('tooltips.deleteBucket')}</div>}>
                                      <Button
                                        variant="danger"
                                        onClick={handleDeleteBucketClick(row.name)}
                                        isDisabled={!row.available}
                                        aria-label={t('deleteModal.confirm') + ': ' + row.name}
                                      >
                                        <TrashIcon />
                                      </Button>
                                    </Tooltip>
                                  </ToolbarItem>
                                </ToolbarGroup>
                              </ToolbarContent>
                            )}
                          </Td>
                        </Tr>
                      ))}
                    </Tbody>
                  </Table>
                </ResponsiveTableWrapper>
              </div>
              {/* Card view (mobile) */}
              <div className="s4-card-view">
                <MobileCardView items={mobileCardItems} ariaLabel="Storage locations list" />
              </div>
            </>
          )}
        </Card>
      </PageSection>
      <Modal
        className="standard-modal"
        isOpen={createBucketModal.isOpen}
        onClose={createBucketModal.close}
        ouiaId="CreateBucketModal"
        aria-labelledby="create-bucket-modal-title"
      >
        <ModalHeader labelId="create-bucket-modal-title" title={t('createModal.title')} />
        <ModalBody>
          <Form
            onSubmit={(event) => {
              event.preventDefault();
              if (newBucketName.length > 2 && validateBucketName(newBucketName)) {
                handleNewBucketCreate();
              }
            }}
          >
            <FormGroup label={t('createModal.nameLabel')} isRequired fieldId="bucket-name">
              <TextInput
                isRequired
                type="text"
                id="bucket-name"
                name="bucket-name"
                aria-describedby="bucket-name-helper"
                placeholder={t('createModal.namePlaceholder')}
                value={newBucketName}
                onChange={(_event, newBucketName) => setNewBucketName(newBucketName)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    if (newBucketName.length > 2 && validateBucketName(newBucketName)) {
                      handleNewBucketCreate();
                    }
                  }
                }}
                validated={newBucketName.length >= 3 && !validateBucketName(newBucketName) ? 'error' : 'default'}
              />
              <FormHelperText>
                <HelperText id="bucket-name-helper">
                  {newBucketNameRulesVisibility ? (
                    <HelperTextItem variant="error">
                      {t('validation.invalidName')}{' '}
                      <Popover
                        headerContent={t('createModal.rules.title')}
                        bodyContent={
                          <ul>
                            {getBucketNameRules().map((rule, index) => (
                              <li key={index}>{t(rule)}</li>
                            ))}
                          </ul>
                        }
                      >
                        <Button variant="plain" aria-label="Naming rules" style={{ padding: 0 }}>
                          <QuestionCircleIcon />
                        </Button>
                      </Popover>
                    </HelperTextItem>
                  ) : null}
                </HelperText>
              </FormHelperText>
            </FormGroup>
          </Form>
        </ModalBody>
        <ModalFooter>
          <Button
            key="create"
            variant="primary"
            onClick={handleNewBucketCreate}
            isDisabled={newBucketName.length < 3 || newBucketNameRulesVisibility}
          >
            {t('createModal.create')}
          </Button>
          <Button key="cancel" variant="link" onClick={handleNewBucketCancel}>
            {t('translation:common.actions.cancel')}
          </Button>
        </ModalFooter>
      </Modal>
      <Modal
        className="standard-modal"
        isOpen={deleteBucketModal.isOpen}
        onClose={deleteBucketModal.close}
        aria-labelledby="delete-bucket-modal-title"
      >
        <ModalHeader labelId="delete-bucket-modal-title" title={t('deleteModal.title')} titleIconVariant="warning" />
        <ModalBody>
          <Content>
            <Content component={ContentVariants.p}>{t('deleteModal.message')}</Content>
            <Content component={ContentVariants.p} id="delete-confirmation-instructions">
              {t('deleteModal.confirmMessage', { bucketName: selectedBucket })}
            </Content>
          </Content>
          <TextInput
            id="delete-modal-input"
            aria-label={t('deleteModal.confirm')}
            aria-describedby="delete-confirmation-instructions"
            value={bucketToDelete}
            onChange={(_event, bucketToDelete) => setBucketToDelete(bucketToDelete)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                if (validateBucketToDelete()) {
                  handleDeleteBucketConfirm();
                }
              }
            }}
            validated={bucketToDelete.length > 0 && !validateBucketToDelete() ? 'error' : 'default'}
          />
        </ModalBody>
        <ModalFooter>
          <Button
            key="confirm"
            variant="danger"
            onClick={handleDeleteBucketConfirm}
            isDisabled={!validateBucketToDelete()}
          >
            {t('deleteModal.confirm')}
          </Button>
          <Button key="cancel" variant="secondary" onClick={handleDeleteBucketCancel}>
            {t('translation:common.actions.cancel')}
          </Button>
        </ModalFooter>
      </Modal>
      <BucketNotificationsModal
        bucketName={notificationsBucket}
        isOpen={notificationsModal.isOpen}
        onClose={notificationsModal.close}
      />
    </div>
  );
};

export default Buckets;
