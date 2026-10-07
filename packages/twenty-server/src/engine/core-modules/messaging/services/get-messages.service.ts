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
    // 🔴 `targetFilter` (upstream, selects threads by target record) is neutralised for scoped
    // members below: this person-based scope is the only one this service applies.
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

    // Snetor — since v2.45 upstream removed `IS_MESSAGE_CALENDAR_TARGET_READ_ENABLED`: a
    // `targetFilter` is now resolved for every workspace that has the target objects, and it
    // selects threads by TARGET RECORD, ignoring `personIdsInScope`. A scoped member must keep
    // the person-based selection, otherwise an out-of-scope company with one in-scope contact
    // exposes all of its threads (trap 3 of twenty-fork-security-checks.md). Sentinel:
    // `get-messages.service.spec.ts`.
    const effectiveTargetFilter =
      isDefined(targetFilter) &&
      (await this.countryScopeService.isMemberScoped({
        workspaceMemberId,
        workspaceId,
      }))
        ? undefined
        : targetFilter;

    const { messageThreads, totalNumberOfThreads } =
      await this.timelineMessagingService.getAndCountMessageThreads(
        personIdsInScope,
        workspaceId,
        offset,
        pageSize,
        effectiveTargetFilter,
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
