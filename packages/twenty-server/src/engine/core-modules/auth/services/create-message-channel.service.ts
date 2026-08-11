import { Injectable } from '@nestjs/common';

import { v4 } from 'uuid';
import { EntityManager } from 'typeorm';

import {
  MessageChannelPendingGroupEmailsAction,
  MessageChannelSyncStage,
  MessageChannelSyncStatus,
  MessageChannelType,
  MessageChannelVisibility,
} from 'twenty-shared/types';
import { GlobalWorkspaceOrmManager } from 'src/engine/twenty-orm/global-workspace-datasource/global-workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';

export type CreateMessageChannelInput = {
  workspaceId: string;
  connectedAccountId: string;
  handle: string;
  messageVisibility?: MessageChannelVisibility;
  skipMessageChannelConfiguration?: boolean;
  transactionManager: EntityManager;
};

@Injectable()
export class CreateMessageChannelService {
  constructor(
    private readonly globalWorkspaceOrmManager: GlobalWorkspaceOrmManager,
  ) {}

  async createMessageChannel(
    input: CreateMessageChannelInput,
  ): Promise<string> {
    const {
      workspaceId,
      connectedAccountId,
      handle,
      messageVisibility,
      skipMessageChannelConfiguration,
      transactionManager,
    } = input;

    const authContext = buildSystemAuthContext(workspaceId);

    return this.globalWorkspaceOrmManager.executeInWorkspaceContext(
      async () => {
        const messageChannelRepo =
          transactionManager.getRepository(MessageChannelEntity);
        const newMessageChannelId = v4();

        await messageChannelRepo.save({
          id: newMessageChannelId,
          connectedAccountId,
          type: MessageChannelType.EMAIL,
          handle,
          // Snetor : défaut `METADATA` et non `SHARE_EVERYTHING`. Le bouton
          // « Connect with Microsoft/Google » de Settings → Accounts n'envoie AUCUNE
          // visibilité : ce fallback est donc le réglage effectif de la quasi-totalité des
          // comptes connectés. Un défaut partageant le corps des mails de tout le
          // workspace n'est pas tenable pour 250 commerciaux qui ne liront jamais ce
          // réglage. Le titulaire du compte reste exempté de la restriction
          // (`timeline-messaging.service.ts`, `apply-messages-visibility-restrictions.service.ts`) :
          // il voit son propre courrier en entier. Un choix explicite est respecté.
          visibility: messageVisibility || MessageChannelVisibility.METADATA,
          syncStatus: skipMessageChannelConfiguration
            ? MessageChannelSyncStatus.ONGOING
            : MessageChannelSyncStatus.NOT_SYNCED,
          syncStage: skipMessageChannelConfiguration
            ? MessageChannelSyncStage.MESSAGE_LIST_FETCH_PENDING
            : MessageChannelSyncStage.PENDING_CONFIGURATION,
          pendingGroupEmailsAction: MessageChannelPendingGroupEmailsAction.NONE,
          workspaceId,
        });

        return newMessageChannelId;
      },
      authContext,
    );
  }
}
