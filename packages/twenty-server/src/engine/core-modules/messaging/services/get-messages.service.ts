import { Injectable } from '@nestjs/common';

import { CountryScopeService } from 'src/engine/core-modules/country-scope/services/country-scope.service';
import { TIMELINE_THREADS_DEFAULT_PAGE_SIZE } from 'src/engine/core-modules/messaging/constants/messaging.constants';
import { type TimelineThreadsWithTotalDTO } from 'src/engine/core-modules/messaging/dtos/timeline-threads-with-total.dto';
import { TimelineMessagingService } from 'src/engine/core-modules/messaging/services/timeline-messaging.service';
import { formatThreads } from 'src/engine/core-modules/messaging/utils/format-threads.util';
import { GlobalWorkspaceOrmManager } from 'src/engine/twenty-orm/global-workspace-datasource/global-workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { type OpportunityWorkspaceEntity } from 'src/modules/opportunity/standard-objects/opportunity.workspace-entity';
import { type PersonWorkspaceEntity } from 'src/modules/person/standard-objects/person.workspace-entity';

@Injectable()
export class GetMessagesService {
  constructor(
    private readonly globalWorkspaceOrmManager: GlobalWorkspaceOrmManager,
    private readonly timelineMessagingService: TimelineMessagingService,
    private readonly countryScopeService: CountryScopeService,
  ) {}

  async getMessagesFromPersonIds(
    workspaceMemberId: string,
    personIds: string[],
    workspaceId: string,
    page = 1,
    pageSize: number = TIMELINE_THREADS_DEFAULT_PAGE_SIZE,
  ): Promise<TimelineThreadsWithTotalDTO> {
    const offset = (page - 1) * pageSize;

    // Snetor — cloisonnement par pays. Les trois entrées de l'onglet Emails
    // (`personId`, `companyId`, `opportunityId`) se rejoignent ici, et tout ce chemin
    // s'exécute en contexte système : le filtre du choke-point ORM ne s'y applique pas.
    // Le périmètre est donc posé à la main, au seul endroit qui les couvre toutes.
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
      };
    }

    const { messageThreads, totalNumberOfThreads } =
      await this.timelineMessagingService.getAndCountMessageThreads(
        personIdsInScope,
        workspaceId,
        offset,
        pageSize,
      );

    if (!messageThreads) {
      return {
        totalNumberOfThreads: 0,
        timelineThreads: [],
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
    };
  }

  async getMessagesFromCompanyId(
    workspaceMemberId: string,
    companyId: string,
    workspaceId: string,
    page = 1,
    pageSize: number = TIMELINE_THREADS_DEFAULT_PAGE_SIZE,
  ): Promise<TimelineThreadsWithTotalDTO> {
    const authContext = buildSystemAuthContext(workspaceId);

    return this.globalWorkspaceOrmManager.executeInWorkspaceContext(
      async () => {
        const personRepository =
          await this.globalWorkspaceOrmManager.getRepository<PersonWorkspaceEntity>(
            workspaceId,
            'person',
            { shouldBypassPermissionChecks: true },
          );
        const personIds = (
          await personRepository.find({
            where: {
              companyId,
            },
            select: {
              id: true,
            },
          })
        ).map((person) => person.id);

        if (personIds.length === 0) {
          return {
            totalNumberOfThreads: 0,
            timelineThreads: [],
          };
        }

        const messageThreads = await this.getMessagesFromPersonIds(
          workspaceMemberId,
          personIds,
          workspaceId,
          page,
          pageSize,
        );

        return messageThreads;
      },
      authContext,
    );
  }

  async getMessagesFromOpportunityId(
    workspaceMemberId: string,
    opportunityId: string,
    workspaceId: string,
    page = 1,
    pageSize: number = TIMELINE_THREADS_DEFAULT_PAGE_SIZE,
  ): Promise<TimelineThreadsWithTotalDTO> {
    const authContext = buildSystemAuthContext(workspaceId);

    return this.globalWorkspaceOrmManager.executeInWorkspaceContext(
      async () => {
        const opportunityRepository =
          await this.globalWorkspaceOrmManager.getRepository<OpportunityWorkspaceEntity>(
            workspaceId,
            'opportunity',
            { shouldBypassPermissionChecks: true },
          );

        const opportunity = await opportunityRepository.findOne({
          where: {
            id: opportunityId,
          },
          select: {
            companyId: true,
          },
        });

        if (!opportunity?.companyId) {
          return {
            totalNumberOfThreads: 0,
            timelineThreads: [],
          };
        }

        const messageThreads = await this.getMessagesFromCompanyId(
          workspaceMemberId,
          opportunity.companyId,
          workspaceId,
          page,
          pageSize,
        );

        return messageThreads;
      },
      authContext,
    );
  }
}
