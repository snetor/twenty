import { Test, type TestingModule } from '@nestjs/testing';

import { CountryScopeService } from 'src/engine/core-modules/country-scope/services/country-scope.service';
import { GetMessagesService } from 'src/engine/core-modules/messaging/services/get-messages.service';
import { TimelineMessagingService } from 'src/engine/core-modules/messaging/services/timeline-messaging.service';
import { RelatedPersonIdsService } from 'src/engine/core-modules/related-person-ids/services/related-person-ids.service';
import { MessageCalendarTargetReadinessService } from 'src/engine/core-modules/target/services/message-calendar-target-readiness.service';

// L'onglet Emails lit la messagerie en contexte système : le filtre du choke-point ORM ne
// s'y applique pas, et les trois resolvers acceptaient donc n'importe quel identifiant.
// Ces tests portent sur le seul endroit où les trois entrées se rejoignent.
describe('GetMessagesService — périmètre pays', () => {
  let service: GetMessagesService;

  const relatedPersonIdsService = { getRelatedPersonIds: jest.fn() };

  const timelineMessagingService = {
    getAndCountMessageThreads: jest.fn().mockResolvedValue({
      messageThreads: [],
      totalNumberOfThreads: 0,
    }),
    getThreadParticipantsByThreadId: jest.fn().mockResolvedValue({}),
    getThreadVisibilityByThreadId: jest.fn().mockResolvedValue({}),
  };

  const countryScopeService = { keepPersonIdsInScope: jest.fn() };

  // Ajouté par l'amont en v2.39.0. `resolveTargetFilter` rend `undefined` quand le drapeau
  // `IS_MESSAGE_CALENDAR_TARGET_READ_ENABLED` est éteint — c'est l'état d'un workspace
  // réel, et c'est celui que ces tests doivent refléter.
  //
  // 🔴 Ne pas le faire rendre un `targetFilter` sans avoir d'abord étendu le cloisonnement :
  // avec un `targetFilter`, la sélection se fait par l'enregistrement cible et non par les
  // personnes, donc hors de la portée que ce service applique.
  const messageCalendarTargetReadinessService = {
    resolveTargetFilter: jest.fn().mockResolvedValue(undefined),
  };

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
          provide: RelatedPersonIdsService,
          useValue: relatedPersonIdsService,
        },
        {
          provide: TimelineMessagingService,
          useValue: timelineMessagingService,
        },
        {
          provide: MessageCalendarTargetReadinessService,
          useValue: messageCalendarTargetReadinessService,
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
    ).resolves.toEqual({
      totalNumberOfThreads: 0,
      timelineThreads: [],
      relatedPersonIds: [],
    });

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

    // Le 5e argument est le `targetFilter` ajouté par l'amont en v2.39.0. `undefined` est
    // l'état d'un workspace réel (drapeau `IS_MESSAGE_CALENDAR_TARGET_READ_ENABLED`
    // éteint) — et c'est ce qui garantit que la sélection passe bien par les personnes du
    // périmètre, seule chose que ce service sait cloisonner.
    expect(
      timelineMessagingService.getAndCountMessageThreads,
    ).toHaveBeenCalledWith(
      ['person-ci'],
      'workspace-id',
      0,
      expect.any(Number),
      undefined,
    );
  });

  it('couvre l’entrée générique par enregistrement : une société hors périmètre ne rend aucun fil', async () => {
    relatedPersonIdsService.getRelatedPersonIds.mockResolvedValue([
      'person-co',
    ]);
    countryScopeService.keepPersonIdsInScope.mockResolvedValue([]);

    await expect(
      service.getMessagesFromObjectRecord(
        'workspace-member-id',
        'company',
        'company-hors-perimetre',
        'workspace-id',
      ),
    ).resolves.toEqual({
      totalNumberOfThreads: 0,
      timelineThreads: [],
      relatedPersonIds: [],
    });

    expect(
      timelineMessagingService.getAndCountMessageThreads,
    ).not.toHaveBeenCalled();
  });
});
