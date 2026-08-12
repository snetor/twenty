import { Test, type TestingModule } from '@nestjs/testing';

import { CountryScopeService } from 'src/engine/core-modules/country-scope/services/country-scope.service';
import { GetMessagesService } from 'src/engine/core-modules/messaging/services/get-messages.service';
import { TimelineMessagingService } from 'src/engine/core-modules/messaging/services/timeline-messaging.service';
import { GlobalWorkspaceOrmManager } from 'src/engine/twenty-orm/global-workspace-datasource/global-workspace-orm.manager';

// L'onglet Emails lit la messagerie en contexte système : le filtre du choke-point ORM ne
// s'y applique pas, et les trois resolvers acceptaient donc n'importe quel identifiant.
// Ces tests portent sur le seul endroit où les trois entrées se rejoignent.
describe('GetMessagesService — périmètre pays', () => {
  let service: GetMessagesService;

  const personRepository = { find: jest.fn() };

  const timelineMessagingService = {
    getAndCountMessageThreads: jest.fn().mockResolvedValue({
      messageThreads: [],
      totalNumberOfThreads: 0,
    }),
    getThreadParticipantsByThreadId: jest.fn().mockResolvedValue({}),
    getThreadVisibilityByThreadId: jest.fn().mockResolvedValue({}),
  };

  const countryScopeService = { keepPersonIdsInScope: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    timelineMessagingService.getAndCountMessageThreads.mockResolvedValue({
      messageThreads: [],
      totalNumberOfThreads: 0,
    });
    timelineMessagingService.getThreadParticipantsByThreadId.mockResolvedValue(
      {},
    );
    timelineMessagingService.getThreadVisibilityByThreadId.mockResolvedValue(
      {},
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetMessagesService,
        {
          provide: GlobalWorkspaceOrmManager,
          useValue: {
            getRepository: jest.fn().mockResolvedValue(personRepository),
            executeInWorkspaceContext: jest
              .fn()
              .mockImplementation((callback: () => unknown) => callback()),
          },
        },
        {
          provide: TimelineMessagingService,
          useValue: timelineMessagingService,
        },
        { provide: CountryScopeService, useValue: countryScopeService },
      ],
    }).compile();

    service = module.get<GetMessagesService>(GetMessagesService);
  });

  it('ne lit aucun fil quand la personne demandée est hors périmètre', async () => {
    countryScopeService.keepPersonIdsInScope.mockResolvedValue([]);

    await expect(
      service.getMessagesFromPersonIds(
        'workspace-member-id',
        ['person-hors-perimetre'],
        'workspace-id',
      ),
    ).resolves.toEqual({ totalNumberOfThreads: 0, timelineThreads: [] });

    expect(
      timelineMessagingService.getAndCountMessageThreads,
    ).not.toHaveBeenCalled();
  });

  it('n’interroge la messagerie que sur les personnes du périmètre', async () => {
    countryScopeService.keepPersonIdsInScope.mockResolvedValue(['person-ci']);

    await service.getMessagesFromPersonIds(
      'workspace-member-id',
      ['person-ci', 'person-co'],
      'workspace-id',
    );

    expect(
      timelineMessagingService.getAndCountMessageThreads,
    ).toHaveBeenCalledWith(
      ['person-ci'],
      'workspace-id',
      0,
      expect.any(Number),
    );
  });

  it('couvre l’entrée par companyId : une société hors périmètre ne rend aucun fil', async () => {
    personRepository.find.mockResolvedValue([{ id: 'person-co' }]);
    countryScopeService.keepPersonIdsInScope.mockResolvedValue([]);

    await expect(
      service.getMessagesFromCompanyId(
        'workspace-member-id',
        'company-hors-perimetre',
        'workspace-id',
      ),
    ).resolves.toEqual({ totalNumberOfThreads: 0, timelineThreads: [] });

    expect(
      timelineMessagingService.getAndCountMessageThreads,
    ).not.toHaveBeenCalled();
  });
});
