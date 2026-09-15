import { Injectable } from '@nestjs/common';

import { isDefined } from 'twenty-shared/utils';

import { CountryScopeService } from 'src/engine/core-modules/country-scope/services/country-scope.service';
import { TIMELINE_THREADS_DEFAULT_PAGE_SIZE } from 'src/engine/core-modules/messaging/constants/messaging.constants';
import { type TimelineThreadsWithTotalDTO } from 'src/engine/core-modules/messaging/dtos/timeline-threads-with-total.dto';
import { TimelineMessagingService } from 'src/engine/core-modules/messaging/services/timeline-messaging.service';
import { formatThreads } from 'src/engine/core-modules/messaging/utils/format-threads.util';
import { RelatedPersonIdsService } from 'src/engine/core-modules/related-person-ids/services/related-person-ids.service';
import { type TargetFilter } from 'src/engine/core-modules/target/utils/get-target-field-name-for-object-record.util';
import { MessageCalendarTargetReadinessService } from 'src/engine/core-modules/target/services/message-calendar-target-readiness.service';

@Injectable()
export class GetMessagesService {
  constructor(
    private readonly timelineMessagingService: TimelineMessagingService,
    private readonly relatedPersonIdsService: RelatedPersonIdsService,
    private readonly messageCalendarTargetReadinessService: MessageCalendarTargetReadinessService,
    private readonly countryScopeService: CountryScopeService,
  ) {}

  async getMessagesFromPersonIds(
    workspaceMemberId: string,
    personIds: string[],
    workspaceId: string,
    page = 1,
    pageSize: number = TIMELINE_THREADS_DEFAULT_PAGE_SIZE,
    targetFilter?: TargetFilter,
  ): Promise<TimelineThreadsWithTotalDTO> {
    const offset = (page - 1) * pageSize;

    // Snetor — cloisonnement par pays. Toutes les entrées de l'onglet Emails se
    // rejoignent ici (`getMessagesFromObjectRecord` délègue), et tout ce chemin s'exécute
    // en contexte système : le filtre du choke-point ORM ne s'y applique pas. Le périmètre
    // est donc posé à la main, au seul endroit qui les couvre toutes.
    //
    // 🔴 À RELIRE AVANT D'ALLUMER `IS_MESSAGE_CALENDAR_TARGET_READ_ENABLED`. La v2.39.0 a
    // introduit `targetFilter`, qui sélectionne les threads par l'enregistrement cible
    // (`messageThreadTarget.<fieldName> = recordId`) et NON par les personnes. Notre
    // périmètre, lui, ne porte que sur `personIds`. Tant que ce drapeau est éteint —
    // son seul `true` du dépôt est dans le seeder de développement, donc il est absent
    // d'un workspace réel — `resolveTargetFilter` rend `undefined` et le cloisonnement
    // reste complet. L'allumer sans étendre le périmètre à `targetFilter` ouvrirait
    // l'onglet Emails d'un enregistrement hors portée.
    //
    // Effet de bord assumé de l'early-return ci-dessous : avec le drapeau allumé, un
    // membre dont aucune personne liée n'est dans sa portée ne verrait aucun thread, même
    // ceux que `targetFilter` aurait légitimement remontés. Plus restrictif que l'amont,
    // donc sûr — mais c'est la fonctionnalité qui tombe, pas la confidentialité.
    const personIdsInScope =
      await this.countryScopeService.keepPersonIdsInScope({
        personIds,
        workspaceMemberId,
        workspaceId,
      });

    if (personIdsInScope.length === 0) {
      return {
        totalNumberOfThreads: 0,
        timelineThreads: [],
        relatedPersonIds: [],
      };
    }

    const { messageThreads, totalNumberOfThreads } =
      await this.timelineMessagingService.getAndCountMessageThreads(
        personIdsInScope,
        workspaceId,
        offset,
        pageSize,
        targetFilter,
      );

    if (!messageThreads) {
      return {
        totalNumberOfThreads: 0,
        timelineThreads: [],
        relatedPersonIds: personIdsInScope,
      };
    }

    const messageThreadIds = messageThreads.map(
      (messageThread) => messageThread.id,
    );

    const threadParticipantsByThreadId =
      await this.timelineMessagingService.getThreadParticipantsByThreadId(
        messageThreadIds,
        workspaceId,
      );

    const threadVisibilityByThreadId =
      await this.timelineMessagingService.getThreadVisibilityByThreadId(
        messageThreadIds,
        workspaceMemberId,
        workspaceId,
      );

    return {
      totalNumberOfThreads,
      timelineThreads: formatThreads(
        messageThreads,
        threadParticipantsByThreadId,
        threadVisibilityByThreadId,
      ),
      relatedPersonIds: personIdsInScope,
    };
  }

  async getMessagesFromObjectRecord(
    workspaceMemberId: string,
    objectNameSingular: string,
    recordId: string,
    workspaceId: string,
    page = 1,
    pageSize: number = TIMELINE_THREADS_DEFAULT_PAGE_SIZE,
  ): Promise<TimelineThreadsWithTotalDTO> {
    const personIds = await this.relatedPersonIdsService.getRelatedPersonIds({
      workspaceId,
      objectNameSingular,
      recordId,
    });
    const targetFilter =
      await this.messageCalendarTargetReadinessService.resolveTargetFilter({
        objectNameSingular,
        recordId,
        workspaceId,
      });

    if (!isDefined(targetFilter) && personIds.length === 0) {
      return {
        totalNumberOfThreads: 0,
        timelineThreads: [],
        relatedPersonIds: [],
      };
    }

    return this.getMessagesFromPersonIds(
      workspaceMemberId,
      personIds,
      workspaceId,
      page,
      pageSize,
      targetFilter,
    );
  }
}
