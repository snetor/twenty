import { type Repository } from 'typeorm';

import { TimelineCalendarEventService } from 'src/engine/core-modules/calendar/timeline-calendar-event.service';

// 🔴 SENTINEL for trap 3 (twenty-fork-security-checks.md), Calendar side. Upstream v2.45
// removed IS_MESSAGE_CALENDAR_TARGET_READ_ENABLED, so `resolveTargetFilter` returns a filter
// that selects events by TARGET RECORD (`calendarEventTargets`), ignoring the in-scope
// persons. A scoped member must keep the person-based selection: an out-of-scope company with
// one in-scope contact would otherwise expose all its meetings.
describe('TimelineCalendarEventService — périmètre et targetFilter', () => {
  const calendarEventRepository = {
    count: jest.fn().mockResolvedValue(0),
    find: jest.fn().mockResolvedValue([]),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
  };

  const workspaceOrmManager = {
    executeInWorkspaceContext: jest
      .fn()
      .mockImplementation((callback: () => unknown) => callback()),
    getRepository: jest.fn().mockReturnValue(calendarEventRepository),
  };

  const relatedPersonIdsService = { getRelatedPersonIds: jest.fn() };
  const targetReadiness = { resolveTargetFilter: jest.fn() };
  const countryScopeService = {
    keepPersonIdsInScope: jest.fn(),
    isMemberScoped: jest.fn(),
  };

  const targetFilter = {
    fieldName: 'companyId',
    recordId: 'company-hors-perimetre',
  };

  const service = new TimelineCalendarEventService(
    workspaceOrmManager as any,
    {} as Repository<any>,
    {} as Repository<any>,
    {} as Repository<any>,
    relatedPersonIdsService as any,
    {} as any,
    targetReadiness as any,
    countryScopeService as any,
  );

  const getFromObjectRecord = () =>
    service.getCalendarEventsFromObjectRecord({
      currentWorkspaceMemberId: 'workspace-member-id',
      objectNameSingular: 'company',
      recordId: 'company-hors-perimetre',
      workspaceId: 'workspace-id',
      page: 1,
      pageSize: 10,
    });

  beforeEach(() => {
    jest.clearAllMocks();
    calendarEventRepository.count.mockResolvedValue(0);
    calendarEventRepository.find.mockResolvedValue([]);
    relatedPersonIdsService.getRelatedPersonIds.mockResolvedValue([
      'person-ci',
      'person-co',
    ]);
    targetReadiness.resolveTargetFilter.mockResolvedValue(targetFilter);
    countryScopeService.keepPersonIdsInScope.mockResolvedValue(['person-ci']);
  });

  it('a scoped member selects events by in-scope participants, never by target record', async () => {
    countryScopeService.isMemberScoped.mockResolvedValue(true);

    await getFromObjectRecord();

    const { where } = calendarEventRepository.count.mock.calls[0][0];

    expect(where).not.toHaveProperty('calendarEventTargets');
    expect(where).toHaveProperty('calendarEventParticipants.personId');
  });

  it('a scoped member with no in-scope person reads nothing', async () => {
    countryScopeService.isMemberScoped.mockResolvedValue(true);
    countryScopeService.keepPersonIdsInScope.mockResolvedValue([]);

    await expect(getFromObjectRecord()).resolves.toEqual({
      totalNumberOfCalendarEvents: 0,
      timelineCalendarEvents: [],
      relatedPersonIds: [],
    });
    expect(calendarEventRepository.count).not.toHaveBeenCalled();
  });

  it('an all-countries member keeps the upstream selection by target record', async () => {
    countryScopeService.isMemberScoped.mockResolvedValue(false);

    await getFromObjectRecord();

    const { where } = calendarEventRepository.count.mock.calls[0][0];

    expect(where).toEqual({
      calendarEventTargets: { companyId: 'company-hors-perimetre' },
    });
  });
});
